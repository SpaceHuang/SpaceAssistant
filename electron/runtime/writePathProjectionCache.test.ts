import { describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'
import { encodeProjectionScopeKey } from '../sessionStorage/domain/scopeKey'

/** Grant the fast path once (exact L2 match), then keep appending through the write path. */
async function createEligibleSession(label: string) {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: `${label} write-path cache`, model: 'test' })
  const conn = getDbConnection(db)
  const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
  await history.appendBatch([{
    invocationId: `${label}-invocation`, turnId: `${label}-turn`, sequence: 1, schemaVersion: 1,
    eventId: `${label}-context`, idempotencyKey: `${label}-context`, kind: 'invocation-context-committed',
    payload: { messages: [{ id: `${label}-user`, role: 'user', content: 'first question', timestamp: 1 }] }
  }], 0)
  appendMessage(db, { id: `${label}-user`, sessionId: session.id, role: 'user', content: 'first question', timestamp: 1, status: 'sent' })
  expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L2')
  return { db, conn, session, history }
}

describe('retired transcript projection cache (P1-①)', () => {
  it('keeps appends independent of transcript cache and parity eligibility', async () => {
    const { db, session, history } = await createEligibleSession('advance')
    appendMessage(db, { id: 'advance-user-2', sessionId: session.id, role: 'user', content: 'second question', timestamp: 2, status: 'sent' })

    await history.appendBatch([{
      invocationId: 'advance-invocation', turnId: 'advance-turn', sequence: 2, schemaVersion: 1,
      eventId: 'advance-context-2', idempotencyKey: 'advance-context-2', kind: 'invocation-context-committed',
      payload: { requiredUserMessage: { id: 'advance-user-2', message: { role: 'user', id: 'advance-user-2', content: 'second question', timestamp: 2 } },
        messages: [
          { id: 'advance-user', role: 'user', content: 'first question', timestamp: 1 },
          { id: 'advance-user-2', role: 'user', content: 'second question', timestamp: 2 }
        ] }
    }], 1)

    expect(getDbConnection(db).prepare(
      "SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'"
    ).get(session.id)).toBeUndefined()
    expect(getDbConnection(db).prepare("SELECT status FROM session_projection_state WHERE session_id=? AND scope_key=? AND status='valid'")
      .get(session.id, encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 }))).toBeUndefined()
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'advance-user', content: 'first question' }, { id: 'advance-user-2', content: 'second question' },
    ] })
    db.close()
  })

  it('requires L2 parity validation after an append until a fresh proof is published', async () => {
    const { db, session, history } = await createEligibleSession('warm')
    appendMessage(db, { id: 'warm-user-2', sessionId: session.id, role: 'user', content: 'second question', timestamp: 2, status: 'sent' })
    await history.appendBatch([{
      invocationId: 'warm-invocation', turnId: 'warm-turn', sequence: 2, schemaVersion: 1,
      eventId: 'warm-context-2', idempotencyKey: 'warm-context-2', kind: 'invocation-context-committed',
      payload: { requiredUserMessage: { id: 'warm-user-2', message: { role: 'user', id: 'warm-user-2', content: 'second question', timestamp: 2 } },
        messages: [
          { id: 'warm-user', role: 'user', content: 'first question', timestamp: 1 },
          { id: 'warm-user-2', role: 'user', content: 'second question', timestamp: 2 }
        ] }
    }], 1)

    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'warm-user', content: 'first question' },
      { id: 'warm-user-2', content: 'second question' }
    ] })
    expect(rebuildSpy).toHaveBeenCalledOnce()
    rebuildSpy.mockRestore()
    db.close()
  })

  it('replays the same canonical transcript on repeated reads without materializing a cache', async () => {
    const { db, session, history } = await createEligibleSession('equivalence')
    const conn = getDbConnection(db)
    appendMessage(db, { id: 'equivalence-user-2', sessionId: session.id, role: 'user', content: 'second question', timestamp: 2, status: 'sent' })
    await history.appendBatch([{
      invocationId: 'equivalence-invocation', turnId: 'equivalence-turn', sequence: 2, schemaVersion: 1,
      eventId: 'equivalence-context-2', idempotencyKey: 'equivalence-context-2', kind: 'invocation-context-committed',
      payload: { requiredUserMessage: { id: 'equivalence-user-2', message: { role: 'user', id: 'equivalence-user-2', content: 'second question', timestamp: 2 } },
        messages: [
          { id: 'equivalence-user', role: 'user', content: 'first question', timestamp: 1 },
          { id: 'equivalence-user-2', role: 'user', content: 'second question', timestamp: 2 }
        ] }
    }], 1)
    const first = readSessionTranscriptProjection(db, session.id)
    const second = readSessionTranscriptProjection(db, session.id)
    expect(first).toMatchObject({ source: 'canonical:L2', messages: [
      { id: 'equivalence-user', content: 'first question' }, { id: 'equivalence-user-2', content: 'second question' },
    ] })
    expect(second).toEqual(first)
    expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toBeUndefined()
    db.close()
  })

  it('leaves the write path untouched when the cache cannot be advanced safely', async () => {
    const { db, session, history } = await createEligibleSession('fallback')
    const conn = getDbConnection(db)
    // 缓存被清（落后）：写路径不得失败，也不得凭空授予 eligibility。
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    conn.prepare('DELETE FROM session_projection_state WHERE session_id=? AND scope_key=?').run(session.id,
      encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 }))
    appendMessage(db, { id: 'fallback-user-2', sessionId: session.id, role: 'user', content: 'second question', timestamp: 2, status: 'sent' })
    await expect(history.appendBatch([{
      invocationId: 'fallback-invocation', turnId: 'fallback-turn', sequence: 2, schemaVersion: 1,
      eventId: 'fallback-context-2', idempotencyKey: 'fallback-context-2', kind: 'invocation-context-committed',
      payload: { requiredUserMessage: { id: 'fallback-user-2', message: { role: 'user', id: 'fallback-user-2', content: 'second question', timestamp: 2 } },
        messages: [
          { id: 'fallback-user', role: 'user', content: 'first question', timestamp: 1 },
          { id: 'fallback-user-2', role: 'user', content: 'second question', timestamp: 2 }
        ] }
    }], 1)).resolves.toMatchObject({ version: 2 })

    expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))
      .toBeUndefined()
    expect(conn.prepare('SELECT 1 FROM session_projection_state WHERE session_id=? AND scope_key=?').get(session.id,
      encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })))
      .toBeUndefined()
    db.close()
  })
})
