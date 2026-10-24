import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { clearProjectionRejection, getProjectionRejection, readProjectionO1Metadata } from '../sessionStorage/infrastructure/sqlite/sessionProjectionRejection'
import { getProjectedChatMessagePage, getProjectedMessagesPageWithSequence, readSessionTranscriptProjection } from '../sessionStorage/infrastructure/sqlite/sessionTranscriptProjection'
import { computeLegacyProjectionDigest } from '../sessionStorage/infrastructure/sqlite/sessionProjectionRejection'

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
  it('uses the chatBodyV1 fields for its revalidation digest', () => {
    const message = { id: 'm1', sessionId: 's1', role: 'assistant' as const, content: 'body', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    expect(computeLegacyProjectionDigest([{ ...message, status: 'failed' }])).toBe(computeLegacyProjectionDigest([message]))
    expect(computeLegacyProjectionDigest([{ ...message, content: 'edited' }])).not.toBe(computeLegacyProjectionDigest([message]))
  })

  it('hashes only chatBodyV1 fields, so status changes do not invalidate the body digest', () => {
    const message = { id: 'm1', sessionId: 's1', role: 'assistant' as const, content: 'body', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    expect(computeLegacyProjectionDigest([{ ...message, status: 'failed' }])).toBe(computeLegacyProjectionDigest([message]))
    expect(computeLegacyProjectionDigest([{ ...message, content: 'edited' }])).not.toBe(computeLegacyProjectionDigest([message]))
  })

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

  it('does not delete the legacy transcript cache when the new parity state rejects it', async () => {
    const { db, conn, session, history } = await createMismatchedSession()
    const canonical = history.readCanonicalSessionTranscriptForShadow(session.id)
    if (canonical.kind !== 'matched') throw new Error('expected canonical History transcript')
    const legacyPayload = JSON.stringify(canonical.messages)
    conn.prepare(`INSERT INTO canonical_session_projection_cache(session_id,cache_key,cache_version,session_generation,session_seq,
      commit_order,watermark_event_id,watermark_invocation_id,event_count,value,value_sha256,updated_at)
      VALUES(?,?,1,?,?,?,?,?,?,?,?,?)`).run(session.id, 'transcript', canonical.sessionGeneration, canonical.sessionSeq,
      canonical.commitOrder, canonical.watermarkEventId, canonical.watermarkInvocationId, canonical.eventCount, legacyPayload,
      createHash('sha256').update(legacyPayload, 'utf8').digest('hex'), Date.now())
    const cacheBefore = conn.prepare("SELECT value,value_sha256 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
      .get(session.id)

    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'legacy-mismatch' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })
    expect(conn.prepare("SELECT value,value_sha256 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
      .get(session.id)).toEqual(cacheBefore)
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

describe('first-screen entry regression on a mismatched session (P0-⑦)', () => {
  it('keeps the chat message page fast after the first full compare establishes the verdict', async () => {
    const { db, session } = await createMismatchedSession('first-screen')
    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')

    // 首屏第一次分页：负缓存未命中，付一次全款建立结论。
    const firstPage = getProjectedChatMessagePage(db, session.id, null, 20)
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
    expect(firstPage.entries.map(({ message }) => message.content)).toEqual(['legacy-a', 'legacy-b'])

    // 首屏重放 / 会话切回：结论直返，不再全量重建。
    const secondPage = getProjectedChatMessagePage(db, session.id, null, 20)
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
    expect(secondPage.entries.map(({ message }) => message.content)).toEqual(['legacy-a', 'legacy-b'])
    rebuildSpy.mockRestore()
    db.close()
  })

  it('returns legacy sequence pages directly for sessions without canonical-backed rows', async () => {
    const { db, session } = await createMismatchedSession('seq-page')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')

    // 会话切换路径：无 canonical-backed 行的分页经内联守卫快速返回，零全量重建。
    const page = getProjectedMessagesPageWithSequence(db, session.id, 0, 20)
    expect(page.rows.map(({ message }) => message.content)).toEqual(['legacy-a', 'legacy-b'])
    expect(rebuildSpy).not.toHaveBeenCalled()
    rebuildSpy.mockRestore()
    db.close()
  })
})

describe('negative cache covers non-mismatch unavailable kinds (install-shipping fix)', () => {
  it('caches a snapshot-invalid stream so repeated opens stop re-paying the full rebuild', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'snapshot-invalid session', model: 'test' })
    const user = appendMessage(db, { id: 'si-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' }).message
    const assistant = appendMessage(db, { id: 'si-assistant', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' }).message
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'si-invocation', turnId: 'si-turn', sequence: 1, schemaVersion: 1,
        eventId: 'si-context', idempotencyKey: 'si-context', kind: 'invocation-context-committed',
        payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
      { invocationId: 'si-invocation', turnId: 'si-turn', sequence: 2, schemaVersion: 1,
        eventId: 'si-conflict', idempotencyKey: 'si-conflict', kind: 'tool-call-finished',
        payload: { toolCallId: 'si-call', success: true, result: { success: false, error: 'contradictory result' } } }
    ], 0)
    // canonical 流处于 snapshot-invalid（completed tool terminal 与 result success 矛盾）。

    const rebuildSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readCanonicalSessionTranscript')
    const first = readSessionTranscriptProjection(db, session.id)
    expect(first).toMatchObject({ source: 'legacy', reason: 'snapshot-invalid' })
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
    expect(getProjectionRejection(db, session.id)).toMatchObject({ lastReason: 'snapshot-invalid' })

    // 第二次读（重开/刷新会话）：负缓存直返，不再重付全量 rebuild+对比。
    const second = readSessionTranscriptProjection(db, session.id)
    expect(second).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })
    expect(rebuildSpy).toHaveBeenCalledTimes(1)
    rebuildSpy.mockRestore()
    db.close()
  })
})

describe('ProjectionSpec.chatBodyV1 digest', () => {
  it('does not invalidate a body digest when only display status changes', async () => {
    const { computeLegacyProjectionDigest } = await import('../sessionStorage/infrastructure/sqlite/sessionProjectionRejection')
    const message = { id: 'm1', sessionId: 's1', role: 'assistant' as const, content: 'body', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    expect(computeLegacyProjectionDigest([{ ...message, status: 'failed' }])).toBe(computeLegacyProjectionDigest([message]))
  })
})
