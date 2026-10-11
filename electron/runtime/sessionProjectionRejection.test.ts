import { describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { clearProjectionRejection, getProjectionRejection, readProjectionO1Metadata } from './sessionProjectionRejection'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'

/** Build a mismatched session: legacy holds [A, B] while canonical History folds to [A']. */
async function createMismatchedSession() {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: 'mismatch negative cache', model: 'test' })
  const conn = getDbConnection(db)
  appendMessage(db, { id: 'mismatch-user-a', sessionId: session.id, role: 'user', content: 'legacy-a', timestamp: 1, status: 'sent' })
  appendMessage(db, { id: 'mismatch-user-b', sessionId: session.id, role: 'user', content: 'legacy-b', timestamp: 2, status: 'sent' })
  const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
  await history.appendBatch([{
    invocationId: 'mismatch-invocation', turnId: 'mismatch-turn', sequence: 1, schemaVersion: 1,
    eventId: 'mismatch-context', idempotencyKey: 'mismatch-context', kind: 'invocation-context-committed',
    payload: { messages: [{ id: 'mismatch-user-a', role: 'user', content: 'legacy-a', timestamp: 1 }] }
  }], 0)
  return { db, conn, session, history }
}

describe('session projection rejection negative cache (P0-②)', () => {
  it('records a rejection verdict with O(1) metadata after the first full compare fails', async () => {
    const { db, session } = await createMismatchedSession()
    const o1 = readProjectionO1Metadata(db, session.id)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })

    const rejection = getProjectionRejection(db, session.id)
    expect(rejection).toMatchObject({
      sessionId: session.id,
      lastReason: 'legacy-mismatch',
      attempts: 1,
      eventCount: o1.eventCount,
      watermarkEventId: o1.watermarkEventId,
      watermarkInvocationId: o1.watermarkInvocationId,
      legacyMessageCount: o1.legacyMessageCount,
      legacyMaxRowid: o1.legacyMaxRowid
    })
    db.close()
  })

  it('routes the next read by the persisted verdict without repeating the full rebuild', async () => {
    const { db, session } = await createMismatchedSession()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')

    const second = readSessionTranscriptProjection(db, session.id)

    expect(second).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })
    expect(rebuildSpy).not.toHaveBeenCalled()
    rebuildSpy.mockRestore()
    db.close()
  })

  it('keeps routing by the verdict while the O(1) metadata is unchanged', async () => {
    const { db, session } = await createMismatchedSession()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')

    for (let round = 0; round < 3; round += 1) {
      expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })
    }

    expect(rebuildSpy).not.toHaveBeenCalled()
    expect(getProjectionRejection(db, session.id)?.attempts).toBe(1)
    rebuildSpy.mockRestore()
    db.close()
  })

  it('still degrades to legacy immediately when the O(1) metadata changed, flagging the verdict as stale', async () => {
    const { db, session } = await createMismatchedSession()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const before = getProjectionRejection(db, session.id)
    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')

    // 新输入改变 legacy 行数与 canonical 事件数：结论过期，但读路径必须立即走 legacy。
    appendMessage(db, { id: 'mismatch-user-c', sessionId: session.id, role: 'user', content: 'legacy-c', timestamp: 3, status: 'sent' })
    const after = readProjectionO1Metadata(db, session.id)
    expect(after.legacyMessageCount).toBe((before?.legacyMessageCount ?? 0) + 1)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })
    expect(rebuildSpy).not.toHaveBeenCalled()
    expect(getProjectionRejection(db, session.id)).toMatchObject({ staleMetadata: true })
    rebuildSpy.mockRestore()
    db.close()
  })

  it('does not record or consult rejections for canonical-backed sessions that cannot fall back to legacy', async () => {
    const { db, conn, session } = await createMismatchedSession()
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)

    expect(() => readSessionTranscriptProjection(db, session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getProjectionRejection(db, session.id)).toBeUndefined()
    db.close()
  })

  it('clears the verdict when an explicit action removes it', async () => {
    const { db, session } = await createMismatchedSession()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    expect(getProjectionRejection(db, session.id)).toBeDefined()

    clearProjectionRejection(db, session.id)

    expect(getProjectionRejection(db, session.id)).toBeUndefined()
    db.close()
  })
})
