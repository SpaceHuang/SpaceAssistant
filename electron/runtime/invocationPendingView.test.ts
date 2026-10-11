import { describe, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'

function appendRawEvent(conn: ReturnType<typeof getDbConnection>, sessionId: string, invocationId: string,
  sequence: number, eventId: string, kind: string, payload: unknown): void {
  const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as
    { lastInsertRowid: number | bigint }
  const turnId = invocationId.replace(/-invocation$/, '-turn')
  conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
    created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
    .run(invocationId, sequence, eventId, eventId, turnId, kind, JSON.stringify(payload), Date.now(), sessionId,
      Number(allocated.lastInsertRowid), sequence)
}

/** Eligible session whose cached seed is one event behind the live stream. */
async function createStaleCacheSession(label: string) {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: `${label} pending view`, model: 'test' })
  const conn = getDbConnection(db)
  appendMessage(db, { id: `${label}-user`, sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
  const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
  await history.appendBatch([{
    invocationId: `${label}-invocation`, turnId: `${label}-turn`, sequence: 1, schemaVersion: 1,
    eventId: `${label}-context`, idempotencyKey: `${label}-context`, kind: 'invocation-context-committed',
    payload: { messages: [{ id: `${label}-user`, role: 'user', content: 'question', timestamp: 1 }] }
  }], 0)
  // 推进缓存到当前 watermark（模拟上一轮的写路径推进），随后把尾部追加在缓存之外。
  expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)
  return { db, conn, session, history }
}

describe('per-invocation pending tool/approval view (P1-②)', () => {
  it('maintains the pending view inside the append transaction', async () => {
    const { db, conn, session, history } = await createStaleCacheSession('maintain')
    await history.appendBatch([
      { invocationId: 'maintain-invocation', turnId: 'maintain-turn', sequence: 2, schemaVersion: 1,
        eventId: 'maintain-response', idempotencyKey: 'maintain-response', kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: '', id: 'maintain-assistant', timestamp: 2,
          toolCalls: [{ id: 'maintain-call-1', name: 'lookup', input: { q: 1 } }] } } },
      { invocationId: 'maintain-invocation', turnId: 'maintain-turn', sequence: 3, schemaVersion: 1,
        eventId: 'maintain-start', idempotencyKey: 'maintain-start', kind: 'tool-call-started',
        payload: { toolCallId: 'maintain-call-1' } }
    ], 1)

    const view = conn.prepare('SELECT pending_json, stream_version FROM canonical_invocation_pending_views WHERE invocation_id=?')
      .get('maintain-invocation') as { pending_json: string; stream_version: number } | undefined
    expect(view?.stream_version).toBe(3)
    const pending = JSON.parse(view?.pending_json ?? '{}') as { pending: Array<[string, string]> }
    expect(pending.pending).toContainEqual(['maintain-call-1', 'started'])
    db.close()
  })

  it('resolves a finished tool from the view without re-reading the whole stream on the next L1 tail', async () => {
    const { db, conn, session, history } = await createStaleCacheSession('resolve')
    await history.appendBatch([
      { invocationId: 'resolve-invocation', turnId: 'resolve-turn', sequence: 2, schemaVersion: 1,
        eventId: 'resolve-response', idempotencyKey: 'resolve-response', kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: '', id: 'resolve-assistant', timestamp: 2,
          toolCalls: [{ id: 'resolve-call-1', name: 'lookup', input: { q: 1 } }] } } }
    ], 1)
    // 缓存推进到 response（写路径已做），随后在缓存之外追加 dispatch+result，让缓存再次落后。
    history.readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
    appendRawEvent(conn, session.id, 'resolve-invocation', 3, 'resolve-start', 'tool-call-started',
      { toolCallId: 'resolve-call-1' })
    appendRawEvent(conn, session.id, 'resolve-invocation', 4, 'resolve-finish', 'tool-call-finished',
      { toolCallId: 'resolve-call-1', success: true, result: { success: true, data: 'found' } })
    conn.prepare('UPDATE agent_history_streams SET version=4 WHERE invocation_id=?').run('resolve-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=4 WHERE session_id=?').run(session.id)

    const readSyncSpy = vi.spyOn(SqliteAgentHistory.prototype, 'readSync')
    const dbg = (label: string) => { appendFileSync('debug-out.txt',
      label + ' view=' + JSON.stringify(conn.prepare('SELECT stream_version FROM canonical_invocation_pending_views WHERE invocation_id=?').get('resolve-invocation')) +
      ' cache=' + JSON.stringify(conn.prepare("SELECT session_seq FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id)) +
      ' cursor=' + JSON.stringify(conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(session.id)) + '\n') }
    dbg('t2-pre')
    const read = history.readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
    dbg('t2-post read=' + read.kind)
    expect(read.kind).toBe('matched')
    // P1-②: the tail validation consults the pending view instead of re-reading the full stream.
    expect(readSyncSpy).not.toHaveBeenCalled()
    readSyncSpy.mockRestore()
    db.close()
  })

  it('still rejects a contradictory tail when the view says the tool was never proposed', async () => {
    const { db, conn, session } = await createStaleCacheSession('reject')
    appendRawEvent(conn, session.id, 'reject-invocation', 2, 'reject-finish', 'tool-call-finished',
      { toolCallId: 'reject-unknown-call', success: true, result: { success: true } })
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('reject-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=2 WHERE session_id=?').run(session.id)

    const read = new SqliteAgentHistory(conn).readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
    expect(read).toMatchObject({ kind: 'unavailable', reason: 'legacy-mismatch' })
    db.close()
  })

  it('falls back to the full-stream validation when no view exists', async () => {
    const { db, conn, session, history } = await createStaleCacheSession('fallback')
    await history.appendBatch([
      { invocationId: 'fallback-invocation', turnId: 'fallback-turn', sequence: 2, schemaVersion: 1,
        eventId: 'fallback-response', idempotencyKey: 'fallback-response', kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: '', id: 'fallback-assistant', timestamp: 2,
          toolCalls: [{ id: 'fallback-call-1', name: 'lookup', input: { q: 1 } }] } } }
    ], 1)
    history.readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
    conn.prepare('DELETE FROM canonical_invocation_pending_views WHERE invocation_id=?').run('fallback-invocation')
    appendRawEvent(conn, session.id, 'fallback-invocation', 3, 'fallback-start', 'tool-call-started',
      { toolCallId: 'fallback-call-1' })
    appendRawEvent(conn, session.id, 'fallback-invocation', 4, 'fallback-finish', 'tool-call-finished',
      { toolCallId: 'fallback-call-1', success: true, result: { success: true, data: 'found' } })
    conn.prepare('UPDATE agent_history_streams SET version=4 WHERE invocation_id=?').run('fallback-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=4 WHERE session_id=?').run(session.id)

    const read = history.readCanonicalSessionTranscriptWithCache(session.id, 'transcript')
    expect(read).toMatchObject({ kind: 'matched' })
    db.close()
  })
})
