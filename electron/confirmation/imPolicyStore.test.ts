import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runInTransaction } from '../database/transaction'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot, readImPolicySnapshot, restoreImPolicySnapshot, migrateLegacyImPolicySnapshot, switchToCurrentImStandard, rollbackImPolicyToVersion, reenableImStandardV3 } from './imPolicyStore'

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE policy_behavior_snapshots(domain TEXT PRIMARY KEY,policy_behavior_version TEXT NOT NULL,revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE policy_behavior_snapshot_history(history_id TEXT PRIMARY KEY,domain TEXT NOT NULL,policy_behavior_version TEXT NOT NULL,snapshot_json TEXT NOT NULL,archived_at INTEGER NOT NULL);
    CREATE TABLE policy_authorization_epochs(domain TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
    CREATE TABLE policy_deferred_todos(todo_id TEXT PRIMARY KEY,domain TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE policy_authorizations(authorization_id TEXT PRIMARY KEY,domain TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE policy_audit_events(event_id TEXT PRIMARY KEY,domain TEXT NOT NULL,event_json TEXT NOT NULL);`)
  db.exec(`CREATE TABLE deferred_todos(todo_id TEXT PRIMARY KEY,channel TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE deferred_resume_requests(request_id TEXT PRIMARY KEY,todo_id TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL);`)
  db.prepare("INSERT INTO policy_behavior_snapshots VALUES('im','v1',1,'{}',10)").run()
  db.prepare("INSERT INTO policy_authorization_epochs VALUES('im',1)").run()
  db.prepare("INSERT INTO policy_deferred_todos VALUES('todo-1','im','active')").run()
  db.prepare("INSERT INTO policy_authorizations VALUES('auth-1','im','active')").run()
  db.prepare("INSERT INTO deferred_todos VALUES('real-todo-1','wechat','pending',1),('real-todo-2','feishu','dispatching',1)").run()
  db.prepare("INSERT INTO deferred_resume_requests VALUES('real-request-1','real-todo-1','pending',1),('real-request-2','real-todo-2','dispatching',1)").run()
  return db
}

describe('IM policy snapshot atomic transaction', () => {
  it('rejects direct v3 writes through the generic policy snapshot writer', () => {
    const db = makeDb()
    expect(() => commitImPolicySnapshot(db, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v3',
      snapshot: { selectedPackage: 'standard' }, updatedAt: 20, eventId: 'unapproved-direct-v3' }))
      .toThrow('IM standard v3 can only be written by a release-gated startup migration or explicit re-enable')
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1'] })).toMatchObject({ revision: 1, policyBehaviorVersion: 'v1' })
    db.close()
  })

  it('rolls a v3 policy back with the v3 migration suppression in one audited revision', () => {
    const db = makeDb()
    db.prepare("UPDATE policy_behavior_snapshots SET policy_behavior_version='im-standard-v3',snapshot_json=? WHERE domain='im'")
      .run(JSON.stringify({ selectedPackage: 'standard' }))

    const result = rollbackImPolicyToVersion(db, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'], updatedAt: 30, eventId: 'rollback-v3' })

    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 2,
        snapshot: { automaticMigrationSuppressedVersions: ['im-standard-v3'] } })
    expect(JSON.parse((db.prepare("SELECT event_json FROM policy_audit_events WHERE event_id='rollback-v3'").get() as { event_json: string }).event_json))
      .toMatchObject({ kind: 'policy-behavior-version-rolled-back', actor: 'user', suppressedBehaviorVersion: 'im-standard-v3' })
    db.close()
  })

  it('preserves the migration suppression through ordinary writes and only explicit re-enable removes it', () => {
    const db = makeDb()
    rollbackImPolicyToVersion(db, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['v1', 'im-standard-v2'], updatedAt: 20, eventId: 'suppressed-seed' })

    const ordinary = commitImPolicySnapshot(db, { expectedRevision: 2, policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'loose' }, updatedAt: 30, eventId: 'ordinary-write' })
    expect(ordinary).toMatchObject({ status: 'committed', revision: 3 })
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['im-standard-v2'] }).snapshot)
      .toMatchObject({ selectedPackage: 'loose', automaticMigrationSuppressedVersions: ['im-standard-v3'] })

    expect(reenableImStandardV3(db, { expectedRevision: 3, releaseGate: { publishedV3Ready: true, fixedRuleSetVerified: true,
      restrictionMappingVerified: true }, updatedAt: 40, eventId: 'reenable-v3' }))
      .toMatchObject({ status: 'committed', revision: 4 })
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['im-standard-v2', 'im-standard-v3'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v3', revision: 4, snapshot: { automaticMigrationSuppressedVersions: [] } })
    db.close()
  })

  it('fails closed on corrupt suppression state and rolls back snapshot, revision, and audit on failure', () => {
    const db = makeDb()
    db.prepare("UPDATE policy_behavior_snapshots SET snapshot_json=? WHERE domain='im'").run(JSON.stringify({ automaticMigrationSuppressedVersions: 'im-standard-v3' }))
    expect(() => readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1'] })).toThrow('Invalid IM automatic migration suppression field')
    expect(() => commitImPolicySnapshot(db, { expectedRevision: 1, policyBehaviorVersion: 'v1', snapshot: {}, updatedAt: 20,
      eventId: 'corrupt-write' })).toThrow('Invalid IM automatic migration suppression field')
    for (const invalidSuppression of [null, ['im-standard-v3', 'im-standard-v3'], ['im-standard-future']]) {
      db.prepare("UPDATE policy_behavior_snapshots SET snapshot_json=? WHERE domain='im'").run(JSON.stringify({
        automaticMigrationSuppressedVersions: invalidSuppression
      }))
      expect(() => readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1'] }))
        .toThrow('Invalid IM automatic migration suppression field')
    }
    db.prepare("UPDATE policy_behavior_snapshots SET policy_behavior_version='im-standard-v3',snapshot_json='{}' WHERE domain='im'").run()
    expect(() => rollbackImPolicyToVersion(db, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 30, eventId: 'failed-rollback', beforeAudit: () => { throw new Error('audit failure') } }))
      .toThrow('audit failure')
    expect(db.prepare("SELECT policy_behavior_version,revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get())
      .toEqual({ policy_behavior_version: 'im-standard-v3', revision: 1, snapshot_json: '{}' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 0 })
    db.close()
  })

  it('rejects stale rollback revisions and refuses re-enable before the release gate passes', () => {
    const db = makeDb()
    db.prepare("UPDATE policy_behavior_snapshots SET policy_behavior_version='im-standard-v3',snapshot_json=? WHERE domain='im'")
      .run(JSON.stringify({ selectedPackage: 'standard' }))
    rollbackImPolicyToVersion(db, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 25, eventId: 'actual-rollback' })
    expect(rollbackImPolicyToVersion(db, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 30, eventId: 'stale-rollback' }))
      .toMatchObject({ status: 'conflict', currentRevision: 2 })
    expect(() => reenableImStandardV3(db, { expectedRevision: 2, releaseGate: { publishedV3Ready: true,
      fixedRuleSetVerified: true, restrictionMappingVerified: false }, updatedAt: 30, eventId: 'blocked-reenable' }))
      .toThrow('IM standard v3 release gate is not satisfied')
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['im-standard-v2', 'im-standard-v3'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 2, snapshot: { automaticMigrationSuppressedVersions: ['im-standard-v3'] } })
    db.close()
  })

  it('publishes authorization changes only after a successful revision commit', () => {
    const db = makeDb()
    const onCommitted = vi.fn()
    expect(commitDesktopPolicySnapshot(db, { expectedRevision: 1, policyBehaviorVersion: 'desktop-v1', snapshot: {},
      updatedAt: 20, eventId: 'desktop-commit', onCommitted })).toMatchObject({ status: 'conflict', currentRevision: 0 })
    expect(onCommitted).not.toHaveBeenCalled()
    expect(() => commitDesktopPolicySnapshot(db, { expectedRevision: 0, policyBehaviorVersion: 'desktop-v1', snapshot: {},
      updatedAt: 20, eventId: 'desktop-rollback', beforeAudit: () => { throw new Error('rollback') }, onCommitted })).toThrow('rollback')
    expect(onCommitted).not.toHaveBeenCalled()
    expect(commitDesktopPolicySnapshot(db, { expectedRevision: 0, policyBehaviorVersion: 'desktop-v1', snapshot: {},
      updatedAt: 20, eventId: 'desktop-success', onCommitted })).toMatchObject({ status: 'committed', revision: 1 })
    expect(onCommitted).toHaveBeenCalledOnce()
    expect(onCommitted).toHaveBeenCalledWith('desktop', 1)
    db.close()
  })

  it('commits snapshot, revision, epoch, invalidations, and audit together', () => {
    const db = makeDb()
    commitImPolicySnapshot(db, { policyBehaviorVersion: 'v2', snapshot: { allow: false }, updatedAt: 20, eventId: 'e1' })
    expect(db.prepare("SELECT policy_behavior_version,revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get()).toEqual({
      policy_behavior_version: 'v2', revision: 2, snapshot_json: '{"allow":false}'
    })
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 2 })
    expect(db.prepare("SELECT status FROM policy_deferred_todos WHERE todo_id='todo-1'").get()).toEqual({ status: 'invalidated' })
    expect(db.prepare("SELECT domain,status FROM policy_deferred_todos WHERE todo_id='real-todo-1'").get())
      .toEqual({ domain: 'im', status: 'invalidated' })
    expect(db.prepare("SELECT status FROM policy_authorizations WHERE authorization_id='auth-1'").get()).toEqual({ status: 'revoked' })
    expect(db.prepare("SELECT state FROM deferred_todos WHERE todo_id='real-todo-1'").get()).toEqual({ state: 'invalidated' })
    expect(db.prepare("SELECT state FROM deferred_resume_requests WHERE request_id='real-request-1'").get()).toEqual({ state: 'invalidated' })
    expect(db.prepare("SELECT state FROM deferred_todos WHERE todo_id='real-todo-2'").get()).toEqual({ state: 'dispatching' })
    expect(db.prepare("SELECT event_id FROM policy_audit_events").get()).toEqual({ event_id: 'e1' })
    const audit = JSON.parse((db.prepare("SELECT event_json FROM policy_audit_events WHERE event_id='e1'").get() as { event_json: string }).event_json)
    expect(audit).toMatchObject({ policyDomain: 'im', actor: 'user', eventKind: 'policy-snapshot-updated',
      previousRevision: 1, policyRevision: 2, policyBehaviorVersion: 'v2', invalidatedTodoIds: ['real-todo-1', 'todo-1'] })
    expect(db.prepare("SELECT history_id,policy_behavior_version,snapshot_json FROM policy_behavior_snapshot_history").get()).toEqual({ history_id: 'im:1', policy_behavior_version: 'v1', snapshot_json: '{}' })
    db.close()
  })

  it('rolls every policy mutation back when audit persistence fails', () => {
    const db = makeDb()
    expect(() => commitImPolicySnapshot(db, {
      policyBehaviorVersion: 'v2', snapshot: { allow: false }, updatedAt: 20, eventId: 'e1',
      beforeAudit: () => { throw new Error('injected audit failure') }
    })).toThrow('injected audit failure')
    expect(db.prepare("SELECT policy_behavior_version,revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get()).toEqual({
      policy_behavior_version: 'v1', revision: 1, snapshot_json: '{}'
    })
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 1 })
    expect(db.prepare("SELECT status FROM policy_deferred_todos WHERE todo_id='todo-1'").get()).toEqual({ status: 'active' })
    expect(db.prepare("SELECT status FROM policy_authorizations WHERE authorization_id='auth-1'").get()).toEqual({ status: 'active' })
    expect(db.prepare("SELECT state FROM deferred_todos WHERE todo_id='real-todo-1'").get()).toEqual({ state: 'pending' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 0 })
    db.close()
  })

  it('reads the shared im snapshot by pinned behavior version and rejects malformed data', () => {
    const db = makeDb()
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1', 'v2'] })).toEqual({
      domain: 'im', policyBehaviorVersion: 'v1', revision: 1, snapshot: {}
    })
    db.prepare("UPDATE policy_behavior_snapshots SET policy_behavior_version='v9' WHERE domain='im'").run()
    expect(() => readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1', 'v2'] })).toThrow(/Unknown policy behavior version/)
    db.prepare("UPDATE policy_behavior_snapshots SET policy_behavior_version='',snapshot_json='{' WHERE domain='im'").run()
    expect(() => readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1', 'v2'] })).toThrow()
    db.close()
  })

  it('rejects a stale expected revision without overwriting the winning snapshot', () => {
    const db = makeDb()
    commitImPolicySnapshot(db, { expectedRevision: 1, policyBehaviorVersion: 'v2', snapshot: { winner: true }, updatedAt: 20, eventId: 'e1' })
    expect(commitImPolicySnapshot(db, { expectedRevision: 1, policyBehaviorVersion: 'v2', snapshot: { stale: true }, updatedAt: 21, eventId: 'e2' })).toMatchObject({ status: 'conflict', currentRevision: 2 })
    expect(db.prepare("SELECT revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get()).toEqual({ revision: 2, snapshot_json: '{"winner":true}' })
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 1 })
    db.close()
  })

  it('rejects missing or malformed policy behavior snapshots after reopening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'im-policy-snapshot-'))
    const path = join(dir, 'policy.sqlite')
    try {
      let db = new DatabaseSync(path)
      db.exec(`CREATE TABLE policy_behavior_snapshots(domain TEXT PRIMARY KEY,policy_behavior_version TEXT NOT NULL,revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,updated_at INTEGER NOT NULL)`)
      db.prepare("INSERT INTO policy_behavior_snapshots VALUES('im','v1',1,'{}',10)").run()
      db.close()
      db = new DatabaseSync(path)
      expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1'] }).policyBehaviorVersion).toBe('v1')
      db.prepare("UPDATE policy_behavior_snapshots SET policy_behavior_version='',snapshot_json='{' WHERE domain='im'").run()
      db.close()
      db = new DatabaseSync(path)
      expect(() => readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1'] })).toThrow()
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores only a validated historical policy snapshot without reviving old approvals or todos', () => {
    const db = makeDb()
    db.prepare("INSERT INTO policy_behavior_snapshot_history VALUES('h1','im','v1','{\"restored\":true}',5)").run()
    db.prepare("UPDATE policy_deferred_todos SET status='invalidated'").run()
    db.prepare("UPDATE policy_authorizations SET status='revoked'").run()
    restoreImPolicySnapshot(db, { historyId: 'h1', supportedBehaviorVersions: ['v1', 'v2'], updatedAt: 30, eventId: 'restore-1' })
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1', 'v2'] })).toMatchObject({
      policyBehaviorVersion: 'v1', revision: 2, snapshot: { restored: true }
    })
    expect(db.prepare("SELECT status FROM policy_deferred_todos WHERE todo_id='todo-1'").get()).toEqual({ status: 'invalidated' })
    expect(db.prepare("SELECT status FROM policy_authorizations WHERE authorization_id='auth-1'").get()).toEqual({ status: 'revoked' })
    expect(db.prepare("SELECT state FROM deferred_todos WHERE todo_id='real-todo-1'").get()).toEqual({ state: 'invalidated' })
    expect(db.prepare("SELECT state FROM deferred_resume_requests WHERE request_id='real-request-1'").get()).toEqual({ state: 'invalidated' })
    expect(db.prepare("SELECT state FROM deferred_todos WHERE todo_id='real-todo-2'").get()).toEqual({ state: 'dispatching' })
    expect(db.prepare("SELECT state FROM deferred_resume_requests WHERE request_id='real-request-2'").get()).toEqual({ state: 'dispatching' })
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 2 })
    expect(db.prepare("SELECT event_id FROM policy_audit_events WHERE event_id='restore-1'").get()).toEqual({ event_id: 'restore-1' })
    const audit = JSON.parse((db.prepare("SELECT event_json FROM policy_audit_events WHERE event_id='restore-1'").get() as { event_json: string }).event_json)
    expect(audit).toMatchObject({ policyDomain: 'im', actor: 'system', eventKind: 'policy-snapshot-restored', previousRevision: 1,
      policyRevision: 2, policyBehaviorVersion: 'v1' })
    db.close()
  })

  it('migrates the frozen legacy snapshot atomically and can rerun idempotently', () => {
    const db = makeDb()
    const plan = { status: 'migrate' as const, domain: 'im' as const, policyBehaviorVersion: 'im-v1.6' as const, snapshot: { denyWrite: true } }
    expect(migrateLegacyImPolicySnapshot(db, { plan, updatedAt: 40, eventId: 'migration-1' })).toMatchObject({ status: 'committed', revision: 2 })
    expect(migrateLegacyImPolicySnapshot(db, { plan, updatedAt: 41, eventId: 'migration-2' })).toMatchObject({ status: 'already-migrated', revision: 2 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM policy_audit_events").get()).toEqual({ count: 1 })
    const audit = JSON.parse((db.prepare("SELECT event_json FROM policy_audit_events WHERE event_id='migration-1'").get() as { event_json: string }).event_json)
    expect(audit).toMatchObject({ policyDomain: 'im', actor: 'migration', eventKind: 'legacy-policy-migrated', previousRevision: 1,
      policyRevision: 2, policyBehaviorVersion: 'im-v1.6' })
    db.close()
  })

  it('rolls back legacy migration on any injected persistence failure', () => {
    const db = makeDb()
    const plan = { status: 'migrate' as const, domain: 'im' as const, policyBehaviorVersion: 'im-v1.6' as const, snapshot: { denyWrite: true } }
    expect(() => migrateLegacyImPolicySnapshot(db, { plan, updatedAt: 40, eventId: 'migration-1', beforeCommit: () => { throw new Error('migration write failed') } })).toThrow('migration write failed')
    expect(db.prepare("SELECT policy_behavior_version,revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get()).toEqual({ policy_behavior_version: 'v1', revision: 1, snapshot_json: '{}' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 0 })
    db.close()
  })

  it('requires explicit recorded user choice to switch the frozen behavior version', () => {
    const db = makeDb()
    expect(() => switchToCurrentImStandard(db, { userChoiceConfirmed: false, displayedDiffs: ['low-risk-create becomes automatic'], updatedAt: 50, eventId: 'switch-1' })).toThrow(/explicit user choice/)
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1', 'v2', 'im-standard-v2'] })).toMatchObject({ policyBehaviorVersion: 'v1', revision: 1 })
    const switched = switchToCurrentImStandard(db, { userChoiceConfirmed: true, displayedDiffs: ['low-risk-create becomes automatic'], updatedAt: 51, eventId: 'switch-2' })
    expect(switched).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(db, { supportedBehaviorVersions: ['v1', 'im-standard-v2'] })).toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 2 })
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 2 })
    expect(db.prepare("SELECT status FROM policy_deferred_todos WHERE todo_id='todo-1'").get()).toEqual({ status: 'invalidated' })
    expect(db.prepare("SELECT status FROM policy_authorizations WHERE authorization_id='auth-1'").get()).toEqual({ status: 'revoked' })
    db.close()
  })
})
