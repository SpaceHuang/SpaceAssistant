import type { DatabaseSync } from 'node:sqlite'

/** Capture the durable source facts which a projection rebuild must fence before publish. */
export function readProjectionSourceIdentity(conn: DatabaseSync, sessionId: string, sessionGeneration: string): string | null {
  const session = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
  if (!session || session.generation !== sessionGeneration) return null
  const cutover = conn.prepare(`SELECT message_revision,write_mode,cleanup_state
    FROM session_message_content_cutover WHERE session_id=?`).get(sessionId) as
    { message_revision: number; write_mode: string; cleanup_state: string } | undefined
  const watermark = conn.prepare(`SELECT session_seq,commit_order,event_id,invocation_id FROM agent_history_events
    WHERE session_id=? AND session_seq IS NOT NULL ORDER BY session_seq DESC LIMIT 1`).get(sessionId) as
    { session_seq: number; commit_order: number; event_id: string; invocation_id: string } | undefined
  const cursor = conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
  const bodySourceState = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(sessionId) as
    { source_revision: number } | undefined
  return JSON.stringify({
    // source_revision is transactionally bumped by History/stream insert, update and delete triggers.
    // It replaces serializing the full stream list on every page identity check.
    formatVersion: 2,
    sessionGeneration: session.generation,
    sourceRevision: bodySourceState?.source_revision ?? 0,
    messageRevision: cutover?.message_revision ?? null,
    bodyAuthority: cutover ? [cutover.write_mode, cutover.cleanup_state] : null,
    historyWatermark: watermark ? [watermark.session_seq, watermark.commit_order, watermark.event_id, watermark.invocation_id] : null,
    eventCursor: cursor?.next_seq ?? null,
  })
}
