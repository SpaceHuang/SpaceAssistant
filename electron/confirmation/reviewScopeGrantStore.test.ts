import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase, type AppDatabase } from '../database'
import { rollbackReviewScopeGrantsV125, runMigrations } from '../database/migrations'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from '../database/schema'
import { ReviewScopeGrantStore } from './reviewScopeGrantStore'
import { ReviewScopeCache } from './reviewScopeCache'

const databases: AppDatabase[] = []
const open = () => {
  const db = openSqliteDatabase(':memory:')
  databases.push(db)
  const conn = getDbConnection(db)
  conn.prepare("INSERT INTO policy_authorization_epochs(domain,epoch) VALUES('desktop',7)").run()
  return conn
}
const identity = (overrides: Record<string, unknown> = {}) => ({
  lane: 'desktop' as const, subjectId: 'profile-a', domain: 'desktop' as const,
  policyRevision: 4, policyEpoch: 7, policyVersion: 'policy-v3', capability: 'file-write',
  source: 'agent' as const, scope: { workDir: '/work', target: '/work/a.txt' }, sessionId: 'session-a',
  ...overrides
})

afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('ReviewScopeGrantStore', () => {
  it('defaults to session lifetime and stores a validated lifetime for future approvals', () => {
    const store = new ReviewScopeGrantStore(open(), { now: () => 10_000 })
    expect(store.getDefaultLifetime()).toBe('session')
    expect(store.setDefaultLifetime('7d')).toBe(true)
    expect(store.getDefaultLifetime()).toBe('7d')
    expect(store.setDefaultLifetime('forever' as never)).toBe(false)
    expect(store.getDefaultLifetime()).toBe('7d')
  })

  it('migrates v124 metadata and grant storage atomically to v125', () => {
    const db = open()
    db.exec(`DROP TABLE review_scope_grants;
      DELETE FROM schema_meta WHERE key IN ('${SCHEMA_META_KEYS.reviewScopeDefaultLifetime}','${SCHEMA_META_KEYS.reviewScopeWallFloorMs}');
      UPDATE schema_meta SET value='124' WHERE key='${SCHEMA_META_KEYS.schemaVersion}';`)
    runMigrations(db)
    expect(DB_SCHEMA_VERSION).toBe(125)
    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '125' })
    expect(db.prepare("SELECT value FROM schema_meta WHERE key='review_scope_default_lifetime'").get()).toEqual({ value: 'session' })
    expect(db.prepare("SELECT value FROM schema_meta WHERE key='review_scope_wall_floor_ms'").get()).toMatchObject({ value: expect.stringMatching(/^\d+$/) })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_scope_grants'").get()).toBeTruthy()
  })

  it('rolls back only schema 125 and upgrades again without restoring old grants', () => {
    const db = open()
    db.exec(`DROP TRIGGER IF EXISTS review_scope_grants_epoch_invalidation; DROP TABLE IF EXISTS review_scope_grants;
      DELETE FROM schema_meta WHERE key IN ('${SCHEMA_META_KEYS.reviewScopeDefaultLifetime}','${SCHEMA_META_KEYS.reviewScopeWallFloorMs}');
      UPDATE schema_meta SET value='124' WHERE key='${SCHEMA_META_KEYS.schemaVersion}';`)
    runMigrations(db)
    const store = new ReviewScopeGrantStore(db)
    expect(store.grant({ ...identity(), lifetime: '24h' })).toBe(true)
    rollbackReviewScopeGrantsV125(db)
    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '124' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_scope_grants'").get()).toBeUndefined()
    runMigrations(db)
    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '125' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_scope_grants').get()).toEqual({ count: 0 })
  })

  it('matches durable grants across sessions, survives store recreation, and expires at the original deadline', () => {
    const db = open()
    let now = Date.now() + 1_000
    const first = new ReviewScopeGrantStore(db, { now: () => now })
    expect(first.grant({ ...identity(), lifetime: '24h' })).toBe(true)
    expect(first.lookup(identity({ sessionId: 'session-b' }))).toMatchObject({ source: 'agent', lifetime: '24h' })

    const restarted = new ReviewScopeGrantStore(db, { now: () => now })
    expect(restarted.lookup(identity({ sessionId: 'session-c' }))).toMatchObject({ source: 'agent' })
    now += 86_400_000
    expect(restarted.lookup(identity({ sessionId: 'session-c' }))).toBeNull()
  })

  it('enforces volatile lifetimes by session or process and never restores them after restart', () => {
    const db = open()
    const store = new ReviewScopeGrantStore(db)
    expect(store.grant({ ...identity(), lifetime: 'session' })).toBe(true)
    expect(store.lookup(identity())).toMatchObject({ lifetime: 'session' })
    expect(store.lookup(identity({ sessionId: 'session-b' }))).toBeNull()
    expect(store.grant({ ...identity({ capability: 'grep' }), lifetime: 'process' })).toBe(true)
    expect(store.lookup(identity({ capability: 'grep', sessionId: 'session-b' }))).toMatchObject({ lifetime: 'process' })
    const restarted = new ReviewScopeGrantStore(db)
    expect(restarted.lookup(identity())).toBeNull()
    expect(restarted.lookup(identity({ capability: 'grep', sessionId: 'session-b' }))).toBeNull()
  })

  it('restores seven-day grants without extending their original expiration', () => {
    const db = open()
    let now = Date.now() + 1_000
    const store = new ReviewScopeGrantStore(db, { now: () => now })
    expect(store.grant({ ...identity(), lifetime: '7d' })).toBe(true)
    now += 6 * 86_400_000
    const restarted = new ReviewScopeGrantStore(db, { now: () => now })
    expect(restarted.lookup(identity())).toMatchObject({ lifetime: '7d', expiresAtMs: expect.any(Number) })
    now += 86_400_000
    expect(restarted.lookup(identity())).toBeNull()
  })

  it('connects durable scope lookup across messages and the edit_file/write_file pair', () => {
    const db = open()
    const firstStore = new ReviewScopeGrantStore(db, { now: () => Date.now() + 1_000 })
    const firstCache = new ReviewScopeCache({ grantStore: firstStore })
    const firstScope = {
      lane: 'desktop' as const, sessionId: 'session-a', subjectId: 'profile-a',
      authorizationDomain: { id: 'desktop', revision: 4, epoch: 7 }, toolName: 'edit_file' as const, operation: 'edit' as const,
      objects: [{ role: 'target', value: '/work/a.txt' }], environment: '/work', policyVersion: 'policy-v3',
      exactParameters: { replaceAll: false }, taskConstraint: 'first request', approvalLifetime: '24h' as const
    }
    const digest = firstCache.candidateDigest(firstScope)
    expect(firstCache.grant({ scope: firstScope, source: 'agent', scopeCandidateDigest: digest, lifetime: '24h' })).toBe(true)

    const restartedCache = new ReviewScopeCache({ grantStore: new ReviewScopeGrantStore(db, { now: () => Date.now() + 1_000 }) })
    const nextScope = { ...firstScope, sessionId: 'session-b', toolName: 'write_file' as const, operation: 'write' as const,
      exactParameters: { content: 'changed and longer body' }, taskConstraint: 'different follow-up task' }
    expect(restartedCache.lookup(nextScope)).toMatchObject({ state: 'active', source: 'agent' })
  })

  it('persists only a remote directory disclosure digest for cross-session listing reuse', () => {
    const db = open()
    db.prepare("INSERT INTO policy_authorization_epochs(domain,epoch) VALUES('im',4)").run()
    const cache = new ReviewScopeCache({ grantStore: new ReviewScopeGrantStore(db) })
    const scope = {
      lane: 'feishu' as const, sessionId: 'remote-a', subjectId: 'owner-a',
      authorizationDomain: { id: 'im', revision: 2, epoch: 4 }, toolName: 'list_work_dirs' as const, operation: 'list' as const,
      objects: [{ role: 'disclosure', value: 'a'.repeat(64) }], environment: 'remote-work-dir-disclosure',
      policyVersion: 'im-standard-v2', exactParameters: {}, taskConstraint: '', approvalLifetime: '24h' as const
    }
    const digest = cache.candidateDigest(scope)
    expect(cache.grant({ scope, source: 'user', scopeCandidateDigest: digest, lifetime: '24h' })).toBe(true)
    const restarted = new ReviewScopeCache({ grantStore: new ReviewScopeGrantStore(db) })
    expect(restarted.lookup({ ...scope, sessionId: 'remote-b' })).toMatchObject({ source: 'user', state: 'active' })
    expect(restarted.lookup({ ...scope, subjectId: 'owner-b' })).toBeNull()
    expect(restarted.lookup({ ...scope, objects: [{ role: 'disclosure', value: 'b'.repeat(64) }] })).toBeNull()
  })

  it('only lets a durable recursive grep grant cover a true child root with identical query options', () => {
    const store = new ReviewScopeGrantStore(open(), { now: () => Date.now() + 1_000 })
    const base = identity({ capability: 'grep', scope: { workDir: '/work', objects: [{ role: 'root', value: '/work/project' }], query: { pattern: 'needle', includeIgnored: false, engine: 'walk', engineFingerprint: 'e'.repeat(64), ignoreDigest: 'c'.repeat(64) } } })
    expect(store.grant({ ...base, lifetime: '24h' })).toBe(true)
    const child = { ...base, scope: { workDir: '/work', objects: [{ role: 'root', value: '/work/project/lib' }], query: { pattern: 'needle', includeIgnored: false, engine: 'walk', engineFingerprint: 'e'.repeat(64), ignoreDigest: 'd'.repeat(64) } } }
    expect(store.lookupGrepAncestor(child)).toMatchObject({ source: 'agent', lifetime: '24h', scope: base.scope })
    expect(store.lookupGrepAncestor({ ...child, scope: { ...child.scope, objects: [{ role: 'root', value: '/work/project-other' }] } })).toBeNull()
    expect(store.lookupGrepAncestor({ ...child, scope: { ...child.scope, query: { pattern: 'other', includeIgnored: false, ignoreDigest: 'c'.repeat(64) } } })).toBeNull()
  })

  it('restores an inherited grep parent scope through a newly created cache', () => {
    const db = open()
    const store = new ReviewScopeGrantStore(db, { now: () => Date.now() + 1_000 })
    const parent = {
      lane: 'desktop' as const, sessionId: 'session-a', subjectId: 'profile-a',
      authorizationDomain: { id: 'desktop', revision: 4, epoch: 7 }, toolName: 'grep' as const, operation: 'search' as const,
      objects: [{ role: 'root', value: '/work/project' }], environment: '/work', policyVersion: 'policy-v3',
      exactParameters: { pattern: 'needle', engine: 'walk', engineFingerprint: 'e'.repeat(64), ignoreDigest: 'c'.repeat(64),
        includeIgnored: false, extraExcludeDirNames: [] }, taskConstraint: '', approvalLifetime: '24h' as const
    }
    const firstCache = new ReviewScopeCache({ grantStore: store })
    const digest = firstCache.candidateDigest(parent)
    expect(firstCache.grant({ scope: parent, source: 'user', scopeCandidateDigest: digest, lifetime: '24h' })).toBe(true)

    const restartedCache = new ReviewScopeCache({ grantStore: new ReviewScopeGrantStore(db, { now: () => Date.now() + 1_000 }) })
    const child = { ...parent, objects: [{ role: 'root', value: '/work/project/lib' }],
      exactParameters: { ...parent.exactParameters, ignoreDigest: 'd'.repeat(64) } }
    expect(restartedCache.lookup(child)).toMatchObject({ source: 'user', inheritedParentScope: {
      root: '/work/project', ignoreDigest: 'c'.repeat(64), engine: 'walk', engineFingerprint: 'e'.repeat(64)
    } })
  })

  it('binds durable grants to subject, authorization epoch, policy version, capability, and exact scope', () => {
    const store = new ReviewScopeGrantStore(open(), { now: () => Date.now() + 1_000 })
    expect(store.grant({ ...identity(), lifetime: '7d' })).toBe(true)
    expect(store.lookup(identity({ subjectId: 'profile-b' }))).toBeNull()
    expect(store.lookup(identity({ policyEpoch: 8 }))).toBeNull()
    expect(store.lookup(identity({ policyVersion: 'policy-v4' }))).toBeNull()
    expect(store.lookup(identity({ capability: 'grep' }))).toBeNull()
    expect(store.lookup(identity({ scope: { workDir: '/work', target: '/work/b.txt' } }))).toBeNull()
  })

  it('fails closed when the current authorization epoch is missing', () => {
    const db = open()
    const store = new ReviewScopeGrantStore(db)
    db.prepare("DELETE FROM policy_authorization_epochs WHERE domain='desktop'").run()
    expect(store.grant({ ...identity(), lifetime: '24h' })).toBe(false)
    expect(store.lookup(identity())).toBeNull()
  })

  it('invalidates durable approvals when the wall clock moves behind its committed floor', () => {
    const db = open()
    let now = Date.now() + 1_000
    const store = new ReviewScopeGrantStore(db, { now: () => now })
    expect(store.grant({ ...identity(), lifetime: '7d' })).toBe(true)
    now -= 1
    expect(store.lookup(identity())).toBeNull()
    now += 1
    expect(new ReviewScopeGrantStore(db, { now: () => now }).lookup(identity())).toBeNull()
  })

  it('removes persisted approvals in the policy epoch transaction', () => {
    const db = open()
    const store = new ReviewScopeGrantStore(db, { now: () => Date.now() + 1_000 })
    expect(store.grant({ ...identity(), lifetime: '7d' })).toBe(true)
    db.prepare("UPDATE policy_authorization_epochs SET epoch=epoch+1 WHERE domain='desktop'").run()
    expect(store.lookup(identity())).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_scope_grants').get()).toEqual({ count: 0 })
  })

  it('clears session grants when a session is deleted while retaining process grants', () => {
    const store = new ReviewScopeGrantStore(open(), { now: () => Date.now() + 1_000 })
    expect(store.grant({ ...identity(), lifetime: 'session' })).toBe(true)
    expect(store.grant({ ...identity({ capability: 'grep' }), lifetime: 'process' })).toBe(true)
    store.clearSession('desktop', 'session-a')
    expect(store.lookup(identity())).toBeNull()
    expect(store.lookup(identity({ capability: 'grep' }))).toMatchObject({ lifetime: 'process' })
  })

  it('clears all grants atomically and advances authorization epochs to stale outstanding permits', () => {
    const db = open()
    db.prepare("INSERT INTO policy_authorization_epochs(domain,epoch) VALUES('im',3)").run()
    const store = new ReviewScopeGrantStore(db)
    expect(store.grant({ ...identity(), lifetime: '24h' })).toBe(true)
    expect(store.grant({ ...identity({ capability: 'grep' }), lifetime: 'process' })).toBe(true)
    expect(store.clearAll()).toBe(true)
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='desktop'").get()).toEqual({ epoch: 8 })
    expect(db.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 4 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_scope_grants').get()).toEqual({ count: 0 })
    expect(store.lookup(identity())).toBeNull()
    expect(store.lookup(identity({ capability: 'grep' }))).toBeNull()
  })

  it('does not claim clear-all succeeded when its database transaction aborts', () => {
    const db = open()
    const store = new ReviewScopeGrantStore(db)
    expect(store.grant({ ...identity(), lifetime: '24h' })).toBe(true)
    db.exec(`CREATE TRIGGER fail_review_epoch BEFORE UPDATE ON policy_authorization_epochs
      BEGIN SELECT RAISE(ABORT, 'injected'); END;`)
    expect(store.clearAll()).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM review_scope_grants').get()).toEqual({ count: 1 })
    expect(store.lookup(identity())).toMatchObject({ lifetime: '24h' })
  })
})
