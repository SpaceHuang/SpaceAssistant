import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../../../database/operations'
import { createMemoryAppDb } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { createSqliteProjectionStateStore } from './sessionProjectionStateStore'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'

describe('SQLite session projection state store', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('enumerates only due current-generation rows with valid canonical scope identities in stable order', () => {
    db = createMemoryAppDb()
    const first = createSession(db, { name: 'due projection first', model: 'test' })
    const second = createSession(db, { name: 'due projection second', model: 'test' })
    const store = createSqliteProjectionStateStore(db)
    const chatScope = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const searchScope = encodeProjectionScopeKey({ scope: 'searchCorpusV1', specVersion: 2 })
    const baselineScope = encodeProjectionScopeKey({ scope: 'apiBaselineV1', specVersion: 1 })
    const permanentScope = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    store.ensureInvalid({ sessionId: first.id, scopeKey: chatScope, sessionGeneration: first.generation, now: 1 })
    store.ensureInvalid({ sessionId: second.id, scopeKey: searchScope, sessionGeneration: second.generation, now: 1 })
    store.ensureInvalid({ sessionId: first.id, scopeKey: baselineScope, sessionGeneration: first.generation, now: 1 })
    store.ensureInvalid({ sessionId: second.id, scopeKey: permanentScope, sessionGeneration: second.generation, now: 1 })
    store.ensureInvalid({ sessionId: first.id, scopeKey: 'legacy-arbitrary-scope', sessionGeneration: first.generation, now: 1 })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_projection_state SET status='rejected',failure_case_json='{}',attempts=1,retry_after=50 WHERE session_id=? AND scope_key=?")
      .run(second.id, searchScope)
    conn.prepare("UPDATE session_projection_state SET status='rejected',failure_case_json='{}',attempts=1,retry_after=101 WHERE session_id=? AND scope_key=?")
      .run(first.id, chatScope)
    conn.prepare("UPDATE session_projection_state SET status='rejected',failure_case_json='{}',attempts=1,retry_after=? WHERE session_id=? AND scope_key=?")
      .run(Number.MAX_SAFE_INTEGER, second.id, permanentScope)

    expect(store.listDueWork(49)).toEqual([
      { sessionId: first.id, sessionGeneration: first.generation, scopeKey: baselineScope, specVersion: 1 },
    ])
    expect(store.listDueWork(50)).toEqual([
      { sessionId: first.id, sessionGeneration: first.generation, scopeKey: baselineScope, specVersion: 1 },
      { sessionId: second.id, sessionGeneration: second.generation, scopeKey: searchScope, specVersion: 2 },
    ])
    expect(store.listDueWork(200, 1)).toHaveLength(1)
    expect(store.listDueWork(200, 0)).toEqual([])
    expect(store.nextRetryAt(50)).toBe(101)
    expect(store.nextRetryAt(101)).toBeNull()
  })

  it('offers old-process rebuilding checkpoints for takeover while excluding the current process owner', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection takeover enumeration', model: 'test' })
    const store = createSqliteProjectionStateStore(db)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 1 })
    store.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation, now: 1 })
    store.transition({ sessionId: session.id, scopeKey, sessionGeneration: session.generation,
      command: { type: 'claim', processGeneration: 4, rebuildToken: 'old-process', now: 2 } })

    expect(store.listDueWork(3, 64, 4)).toEqual([])
    expect(store.listDueWork(3, 64, 5)).toEqual([
      { sessionId: session.id, sessionGeneration: session.generation, scopeKey, specVersion: 1 },
    ])
  })

  it('uses bounded indexed access paths for due work and history chunks on a synthetic isolated database', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection query plan sample', model: 'test' })
    const conn = getDbConnection(db)
    const store = createSqliteProjectionStateStore(db)
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 1 })
    store.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation, now: 1 })

    const duePlan = conn.prepare(`EXPLAIN QUERY PLAN SELECT session_id,session_generation,scope_key FROM session_projection_state
      WHERE status IN ('invalid','rejected') AND (retry_after IS NULL OR retry_after<=?)
        AND scope_key LIKE 'session-projection:%' ORDER BY COALESCE(retry_after,0),updated_at,session_id,scope_key LIMIT ?`).all(1, 64) as Array<{ detail: string }>
    const takeoverPlan = conn.prepare(`EXPLAIN QUERY PLAN SELECT session_id,session_generation,scope_key FROM session_projection_state
      WHERE status='rebuilding' AND process_generation<? AND scope_key LIKE 'session-projection:%'
      ORDER BY process_generation,session_id,scope_key LIMIT ?`).all(2, 64) as Array<{ detail: string }>
    const historyPlan = conn.prepare(`EXPLAIN QUERY PLAN SELECT invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,session_seq,commit_order,created_at
      FROM agent_history_events WHERE session_id=? AND session_seq>? AND session_seq<=? ORDER BY session_seq LIMIT ?`).all(session.id, 0, 100, 200) as Array<{ detail: string }>

    expect(duePlan.map(({ detail }) => detail).join('\n')).toContain('idx_session_projection_state_due')
    expect(takeoverPlan.map(({ detail }) => detail).join('\n')).toContain('idx_session_projection_state_rebuilding')
    expect(historyPlan.map(({ detail }) => detail).join('\n')).toContain('idx_agent_history_events_session_seq')
    expect(historyPlan.map(({ detail }) => detail).join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    expect(historyPlan.map(({ detail }) => detail).join('\n')).toContain('idx_agent_history_events_session_seq')
    expect(historyPlan.map(({ detail }) => detail).join('\n')).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  })

  it('persists claim and cache publication atomically, then invalidates proof and cache together', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection state store', model: 'test' })
    const store = createSqliteProjectionStateStore(db)
    const initial = store.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation, now: 1 })
    expect(initial).toMatchObject({ status: 'invalid', scopeKey: 'scope-a' })
    const sourceIdentityJson = store.readSourceIdentity(session.id, session.generation)!

    const rebuilding = store.transition({
      sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: { type: 'claim', processGeneration: 2, rebuildToken: 'token-a', now: 2 },
    })
    expect(rebuilding).toMatchObject({ status: 'rebuilding', processGeneration: 2, rebuildToken: 'token-a' })
    const source = JSON.parse(sourceIdentityJson) as { messageRevision: number; historyWatermark: unknown }

    const published = store.transition({
      sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: {
        type: 'publish', processGeneration: 2, rebuildToken: 'token-a', expectedSourceIdentityJson: sourceIdentityJson,
        historyWatermarkJson: JSON.stringify(source.historyWatermark ?? null), messageRevision: source.messageRevision, payloadGeneration: 'payload-a', payloadDigest: 'digest-a',
        validatedRangeJson: '{"from":0,"to":3}', now: 3,
      },
      cache: { sourceIdentityJson, payloadGeneration: 'payload-a', payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":3}', inlinePayload: '[{"id":"m1"}]' },
    })
    expect(published).toMatchObject({ status: 'valid', payloadGeneration: 'payload-a' })
    expect(getDbConnection(db).prepare('SELECT payload_digest,inline_payload FROM session_projection_cache WHERE session_id=? AND scope_key=?').get(session.id, 'scope-a'))
      .toEqual({ payload_digest: 'digest-a', inline_payload: '[{"id":"m1"}]' })

    const invalidated = store.invalidateInTransaction({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation, now: 4 })
    expect(invalidated).toMatchObject({ status: 'invalid', payloadDigest: null, rebuildToken: null })
    expect(getDbConnection(db).prepare('SELECT 1 FROM session_projection_cache WHERE session_id=? AND scope_key=?').get(session.id, 'scope-a')).toBeUndefined()
  })

  it('publishes a complete blob cache manifest with byte length and digest in the same transaction', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection blob publication', model: 'test' })
    const conn = getDbConnection(db)
    const store = createSqliteProjectionStateStore(db)
    store.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-blob', sessionGeneration: session.generation, now: 1 })
    const sourceIdentityJson = store.readSourceIdentity(session.id, session.generation)!
    const source = JSON.parse(sourceIdentityJson) as { messageRevision: number; historyWatermark: unknown }
    store.transition({ sessionId: session.id, scopeKey: 'scope-blob', sessionGeneration: session.generation,
      command: { type: 'claim', processGeneration: 2, rebuildToken: 'blob-token', now: 2 } })

    const published = store.transition({ sessionId: session.id, scopeKey: 'scope-blob', sessionGeneration: session.generation,
      command: { type: 'publish', processGeneration: 2, rebuildToken: 'blob-token', expectedSourceIdentityJson: sourceIdentityJson,
        historyWatermarkJson: JSON.stringify(source.historyWatermark ?? null), messageRevision: source.messageRevision,
        payloadGeneration: 'payload-blob', payloadDigest: 'a'.repeat(64), validatedRangeJson: '{"from":0,"to":4}', now: 3 },
      cache: { sourceIdentityJson, payloadGeneration: 'payload-blob', payloadDigest: 'a'.repeat(64),
        validatedRangeJson: '{"from":0,"to":4}', blobLocator: 'projection-00000000-0000-4000-8000-000000000001.blob', blobByteLength: 4096 } })

    expect(published).toMatchObject({ status: 'valid', payloadDigest: 'a'.repeat(64) })
    expect(conn.prepare('SELECT inline_payload,blob_locator,blob_byte_length,payload_digest FROM session_projection_cache WHERE session_id=? AND scope_key=?')
      .get(session.id, 'scope-blob')).toEqual({ inline_payload: null,
        blob_locator: 'projection-00000000-0000-4000-8000-000000000001.blob', blob_byte_length: 4096, payload_digest: 'a'.repeat(64) })
  })

  it('rolls back the state change when a required cache manifest cannot be published', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection publication rollback', model: 'test' })
    const conn = getDbConnection(db)
    const store = createSqliteProjectionStateStore(db)
    store.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation, now: 1 })
    const sourceIdentityJson = store.readSourceIdentity(session.id, session.generation)!
    const source = JSON.parse(sourceIdentityJson) as { messageRevision: number; historyWatermark: unknown }
    store.transition({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: { type: 'claim', processGeneration: 2, rebuildToken: 'token-a', now: 2 } })
    conn.exec(`CREATE TRIGGER reject_projection_manifest BEFORE INSERT ON session_projection_cache BEGIN SELECT RAISE(ABORT,'manifest rejected'); END`)

    expect(() => store.transition({
      sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: {
        type: 'publish', processGeneration: 2, rebuildToken: 'token-a', expectedSourceIdentityJson: store.readSourceIdentity(session.id, session.generation)!,
        historyWatermarkJson: JSON.stringify(source.historyWatermark ?? null), messageRevision: source.messageRevision, payloadGeneration: 'payload-a', payloadDigest: 'digest-a',
        validatedRangeJson: '{"from":0,"to":3}', now: 3,
      },
      cache: { sourceIdentityJson, payloadGeneration: 'payload-a', payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":3}', inlinePayload: '[]' },
    })).toThrow('manifest rejected')
    expect(store.get(session.id, 'scope-a')).toMatchObject({ status: 'rebuilding', rebuildToken: 'token-a' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_projection_cache WHERE session_id=?').get(session.id)).toEqual({ count: 0 })
  })

  it('does not accept a caller-supplied current source identity after messages change', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection source fence', model: 'test' })
    const store = createSqliteProjectionStateStore(db)
    store.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation, now: 1 })
    const sourceAtClaim = store.readSourceIdentity(session.id, session.generation)!
    const source = JSON.parse(sourceAtClaim) as { messageRevision: number; historyWatermark: unknown }
    store.transition({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: { type: 'claim', processGeneration: 2, rebuildToken: 'token-a', now: 2 } })
    appendMessage(db, { id: 'source-fence-message', sessionId: session.id, role: 'user', content: 'changed', timestamp: 3, status: 'sent' })
    expect(store.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null, sourceIdentityJson: null })

    expect(store.transition({
      sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: {
        type: 'publish', processGeneration: 2, rebuildToken: 'token-a', expectedSourceIdentityJson: sourceAtClaim,
        historyWatermarkJson: JSON.stringify(source.historyWatermark ?? null), messageRevision: source.messageRevision, payloadGeneration: 'payload-a', payloadDigest: 'digest-a',
        validatedRangeJson: '{"from":0,"to":0}', now: 4,
      },
      cache: { sourceIdentityJson: sourceAtClaim, payloadGeneration: 'payload-a', payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":0}', inlinePayload: '[]' },
    })).toBeNull()
    expect(store.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM session_projection_cache WHERE session_id=?').get(session.id)).toEqual({ count: 0 })
  })

  it('invalidates all session projection scopes in the canonical History write transaction', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection History invalidation', model: 'test' })
    const conn = getDbConnection(db)
    const store = createSqliteProjectionStateStore(db)
    store.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation, now: 1 })
    const sourceIdentityJson = store.readSourceIdentity(session.id, session.generation)!
    const source = JSON.parse(sourceIdentityJson) as { messageRevision: number; historyWatermark: unknown }
    store.transition({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: { type: 'claim', processGeneration: 2, rebuildToken: 'token-a', now: 2 } })
    store.transition({
      sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation,
      command: {
        type: 'publish', processGeneration: 2, rebuildToken: 'token-a', expectedSourceIdentityJson: sourceIdentityJson,
        historyWatermarkJson: JSON.stringify(source.historyWatermark ?? null), messageRevision: source.messageRevision,
        payloadGeneration: 'payload-a', payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":0}', now: 3,
      },
      cache: { sourceIdentityJson, payloadGeneration: 'payload-a', payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":0}', inlinePayload: '[]' },
    })
    expect(store.get(session.id, 'scope-a')).toMatchObject({ status: 'valid' })

    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'projection-invalidation-invocation', turnId: 'projection-invalidation-turn', sequence: 1, schemaVersion: 1,
      eventId: 'projection-invalidation-event', idempotencyKey: 'projection-invalidation-event',
      kind: 'invocation-context-committed', payload: { messages: [] },
    }], 0)
    expect(store.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', payloadDigest: null, sourceIdentityJson: null })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_projection_cache WHERE session_id=?').get(session.id)).toEqual({ count: 0 })
  })
})
