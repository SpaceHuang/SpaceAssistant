import { describe, expect, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'

describe('debug approval mismatch', () => {
  it('traces approval identity mismatch resolution', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'mismatched approval across watermark', model: 'test' })
    appendMessage(db, { id: 'mismatched-approval-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'mismatched-approval-invocation', turnId: 'mismatched-approval-turn', sequence: 1, schemaVersion: 1,
        eventId: 'mismatched-approval-context', idempotencyKey: 'mismatched-approval-context', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'mismatched-approval-user', role: 'user', content: 'question', timestamp: 1 }] } },
      { invocationId: 'mismatched-approval-invocation', turnId: 'mismatched-approval-turn', sequence: 2, schemaVersion: 1,
        eventId: 'mismatched-approval-wait', idempotencyKey: 'mismatched-approval-wait', kind: 'approval-waiting',
        payload: { approvalId: 'expected-approval-id', answerer: 'user', reasonCode: 'confirm', requestedAt: 2 } }
    ], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    expect(readSessionTranscriptProjection(db, session.id).source).toMatch(/^canonical:/)

    const appendRawEvent = (sequence: number, eventId: string, kind: string, payload: unknown) => {
      const allocated = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(Date.now()) as { lastInsertRowid: number | bigint }
      conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,
        created_at,session_id,commit_order,session_seq) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run('mismatched-approval-invocation', sequence, eventId, eventId, 'mismatched-approval-turn', kind, JSON.stringify(payload), Date.now(), session.id,
          Number(allocated.lastInsertRowid), sequence)
    }
    appendRawEvent(3, 'mismatched-approval-resolution', 'approval-resolved', { approvalId: 'different-approval-id', approved: false, outcome: 'denied', settledAt: 3 })
    appendRawEvent(4, 'mismatched-approval-terminal', 'invocation-completed', { status: 'completed' })
    conn.prepare('UPDATE agent_history_streams SET version=4 WHERE invocation_id=?').run('mismatched-approval-invocation')
    conn.prepare('UPDATE session_event_cursor SET next_seq=4 WHERE session_id=?').run(session.id)

    const diag: string[] = []
    diag.push(`view=${JSON.stringify(conn.prepare('SELECT pending_json, stream_version FROM canonical_invocation_pending_views WHERE invocation_id=?').get('mismatched-approval-invocation'))}`)
    diag.push(`cache=${JSON.stringify(conn.prepare("SELECT session_seq FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id))}`)
    let outcome = 'no-throw'
    try {
      const result = readSessionTranscriptProjection(db, session.id)
      outcome = `returned ${result.source}`
    } catch (error) {
      outcome = `threw ${error instanceof Error ? error.message : String(error)}`
    }
    diag.push(`outcome=${outcome}`)
    appendFileSync('debug-out.txt', diag.join('\n') + '\n')
    expect(true).toBe(true)
    db.close()
  })
})
