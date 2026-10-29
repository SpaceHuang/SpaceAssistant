import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createSession } from '../database/operations'
import { createDeferredTodoStore } from './deferredTodoStore'
import { commitImPolicySnapshot, readImPolicySnapshot, reenableImStandardV3, rollbackImPolicyToVersion,
  type ImStandardV3ReleaseGate } from './imPolicyStore'
import { ensureImPolicySnapshotAtStartup } from './legacyImConfigBoundary'

const releasedV3Gate: ImStandardV3ReleaseGate = {
  publishedV3Ready: true,
  fixedRuleSetVerified: true,
  restrictionMappingVerified: true
}

describe('IM policy v3 migration and rollback recovery', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => databases.splice(0).forEach((db) => db.close()))

  it('keeps rollback suppression across restarts, upgrade, ordinary writes, retries, and transaction failure', () => {
    const db = createMemoryAppDb('im-policy-migration-recovery')
    databases.push(db)
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'standard', remoteDenyOutbound: true }, updatedAt: 1, eventId: 'v2-seed' })
    const sessionId = createSession(db, { name: 'migration-recovery' }).id
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'pre-migration-todo', invocationId: 'pre-migration-invocation',
      channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1,
      rule: { ruleId: 'write', factsHash: 'a'.repeat(64) }, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: 2 }).todo

    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v3'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v3', revision: 2,
        snapshot: { selectedPackage: 'standard', remoteDenyOutbound: true, migrationSourceVersion: 'im-standard-v2' } })
    expect(conn.prepare('SELECT state FROM deferred_todos WHERE todo_id=?').get(todo.todoId)).toEqual({ state: 'invalidated' })

    expect(rollbackImPolicyToVersion(conn, { expectedRevision: 2, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 3, eventId: 'rollback-once' }))
      .toMatchObject({ status: 'committed', revision: 3 })
    for (let restart = 0; restart < 2; restart += 1) ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    // A same-series program upgrade runs the same startup boundary and must not erase suppression.
    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 3,
        snapshot: { automaticMigrationSuppressedVersions: ['im-standard-v3'], remoteDenyOutbound: true } })

    expect(commitImPolicySnapshot(conn, { expectedRevision: 3, policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'standard', remoteDenyOutbound: true, unrelatedPreference: 'saved' },
      updatedAt: 4, eventId: 'ordinary-config-save' })).toMatchObject({ status: 'committed', revision: 4 })
    expect(reenableImStandardV3(conn, { expectedRevision: 4, releaseGate: releasedV3Gate, updatedAt: 5, eventId: 'explicit-reenable' }))
      .toMatchObject({ status: 'committed', revision: 5 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v3'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v3', revision: 5,
        snapshot: { automaticMigrationSuppressedVersions: [], unrelatedPreference: 'saved' } })

    expect(rollbackImPolicyToVersion(conn, { expectedRevision: 5, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 6, eventId: 'rollback-twice' }))
      .toMatchObject({ status: 'committed', revision: 6 })
    const auditCountBeforeFailures = conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()
    expect(rollbackImPolicyToVersion(conn, { expectedRevision: 5, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 7, eventId: 'stale-rollback' }))
      .toMatchObject({ status: 'conflict', currentRevision: 6 })
    expect(() => rollbackImPolicyToVersion(conn, { expectedRevision: 6, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 8, eventId: 'crashed-rollback',
      beforeAudit: () => { throw new Error('simulated process failure before commit') } }))
      .toThrow('simulated process failure before commit')
    expect(conn.prepare("SELECT policy_behavior_version,revision,snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get())
      .toMatchObject({ policy_behavior_version: 'im-standard-v2', revision: 6,
        snapshot_json: expect.stringContaining('automaticMigrationSuppressedVersions') })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual(auditCountBeforeFailures)

    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 6,
        snapshot: { automaticMigrationSuppressedVersions: ['im-standard-v3'] } })
    expect(conn.prepare('SELECT state FROM deferred_todos WHERE todo_id=?').get(todo.todoId)).toEqual({ state: 'invalidated' })
  })
})
