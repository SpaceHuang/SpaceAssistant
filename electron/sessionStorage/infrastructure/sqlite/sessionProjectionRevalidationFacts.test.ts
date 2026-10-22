import { afterEach, describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../../../database/operations'
import { createMemoryAppDb } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { hasCurrentProjectionEligibility, publishTranscriptParityProof } from './sessionProjectionRevalidationFacts'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'

describe('SQLite projection revalidation facts', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('does not grant transcript eligibility from a generation-only fact', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection eligibility facts', model: 'test' })
    const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    getDbConnection(db).prepare(`INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,updated_at)
      VALUES(?,?,?,'invalid',1)`).run(session.id, scopeKey, session.generation)
    expect(hasCurrentProjectionEligibility(db, session.id)).toBe(false)
    getDbConnection(db).prepare("UPDATE sessions SET generation='replacement-generation' WHERE id=?").run(session.id)
    expect(hasCurrentProjectionEligibility(db, session.id)).toBe(false)
  })

  it('publishes a source-fenced transcript parity proof through ProjectionService', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'transcript parity scope', model: 'test' })
    appendMessage(db, { id: 'parity-user', sessionId: session.id, role: 'user', content: 'body', timestamp: 10, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'parity-invocation', turnId: 'parity-turn', sequence: 1, schemaVersion: 1,
      eventId: 'parity-event', idempotencyKey: 'parity-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'parity-user', role: 'user', content: 'body', timestamp: 10 }] },
    }], 0)
    const verified = history.readCanonicalSessionTranscript(session.id, [
      { id: 'parity-user', role: 'user', content: 'body', timestamp: 10 },
    ])
    expect(verified.kind).toBe('matched')
    if (verified.kind !== 'matched') return
    expect(publishTranscriptParityProof(db, session.id, verified, 'b'.repeat(64))).toBe(true)
    const scope = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    expect(getDbConnection(db).prepare(`SELECT state.status,cache.inline_payload FROM session_projection_state state
      JOIN session_projection_cache cache USING(session_id,scope_key) WHERE state.session_id=? AND state.scope_key=?`)
      .get(session.id, scope)).toMatchObject({ status: 'valid', inline_payload: expect.stringContaining('parityDigest') })
  })

  it('does not promote generation-only eligibility to transcript parity proof', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'no generation promotion', model: 'test' })
    const scope = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    expect(getDbConnection(db).prepare('SELECT status FROM session_projection_state WHERE session_id=? AND scope_key=?')
      .get(session.id, scope)).toBeUndefined()
  })

})
