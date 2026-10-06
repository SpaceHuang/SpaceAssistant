import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { getMessages } from '../database/operations'
import { classifySessionProjectionMigrationScope } from './sessionProjectionMigrationInventory'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'

export type LegacySessionProjectionBaselineResult =
  | Readonly<{ kind: 'migrated' | 'already-migrated'; messageCount: number }>
  | Readonly<{ kind: 'rejected'; reason: 'session-missing' | 'out-of-scope' | 'empty-session' | 'history-conflict' |
    'unsupported-role' | 'unsupported-status' | 'cleanup-fenced' | 'skeleton-changed' | 'scope-changed' }>

const CANONICAL_STATUSES = new Set(['sent', 'completed', 'failed', 'cancelled'])

/** Seed a history-absent product transcript from legacy bodies without changing its message skeleton. */
export async function backfillLegacySessionProjectionBaseline(
  db: AppDatabase,
  sessionId: string,
  options: { now?: number } = {}
): Promise<LegacySessionProjectionBaselineResult> {
  const conn = getDbConnection(db)
  const session = conn.prepare('SELECT generation,ownership,visibility FROM sessions WHERE id=?').get(sessionId) as
    { generation: string; ownership: string | null; visibility: string | null } | undefined
  if (!session) return { kind: 'rejected', reason: 'session-missing' }
  if (classifySessionProjectionMigrationScope(session.ownership, session.visibility) !== 'product') {
    return { kind: 'rejected', reason: 'out-of-scope' }
  }
  const cutover = conn.prepare('SELECT write_mode,cleanup_state,message_revision FROM session_message_content_cutover WHERE session_id=?')
    .get(sessionId) as { write_mode: string; cleanup_state: string; message_revision: number } | undefined
  if (!cutover || ['write-stopped', 'pending', 'complete'].includes(cutover.cleanup_state)) {
    return { kind: 'rejected', reason: 'cleanup-fenced' }
  }
  if (cutover.write_mode !== 'legacy') return { kind: 'rejected', reason: 'history-conflict' }

  const history = new SqliteAgentHistory(conn, 1, () => options.now ?? Date.now(), sessionId)
  const messages = getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
  const nonLegacyRows = conn.prepare(`SELECT 1 FROM messages WHERE session_id=? AND content_storage_state<>'legacy' LIMIT 1`).get(sessionId)
  if (nonLegacyRows) return { kind: 'rejected', reason: 'history-conflict' }
  const existing = conn.prepare(`SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?`).get(sessionId) as { count: number }
  if (existing.count > 0) {
    const read = readSessionTranscriptProjection(db, sessionId)
    return read.source.startsWith('canonical:')
      ? { kind: 'already-migrated', messageCount: read.messages.length }
      : { kind: 'rejected', reason: 'history-conflict' }
  }
  if (messages.length === 0) return { kind: 'rejected', reason: 'empty-session' }
  if (messages.some((message) => message.role !== 'user' && message.role !== 'assistant')) {
    return { kind: 'rejected', reason: 'unsupported-role' }
  }
  if (messages.some((message) => !CANONICAL_STATUSES.has(message.status) ||
    (message.role === 'user' && message.status !== 'sent'))) {
    return { kind: 'rejected', reason: 'unsupported-status' }
  }
  const cursor = conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number } | undefined
  if ((cursor?.next_seq ?? 0) !== 0) return { kind: 'rejected', reason: 'history-conflict' }

  const baseline = messages.map((message) => ({
    id: message.id, role: message.role as 'user' | 'assistant', content: message.content, timestamp: message.timestamp
  }))
  const invocationId = `legacy-baseline-${sessionId}-${session.generation}`
  const event = {
    invocationId, turnId: `legacy-baseline-turn-${session.generation}`, sequence: 1,
    schemaVersion: 1, eventId: `legacy-baseline-event-${session.generation}`,
    idempotencyKey: `legacy-baseline-key-${session.generation}`, kind: 'invocation-context-committed' as const,
    payload: { messages: baseline, canonicalWriteFence: {
      sessionGeneration: session.generation, sessionSeq: -1, commitOrder: -1,
      watermarkEventId: null, watermarkInvocationId: null, skeletonRevision: cutover.message_revision,
      sessionOwnership: session.ownership, sessionVisibility: session.visibility
    } }
  }
  try {
    await history.appendBatch([event], 0)
  } catch (error) {
    if (error instanceof Error && error.message.includes('message skeleton revision')) {
      return { kind: 'rejected', reason: 'skeleton-changed' }
    }
    if (error instanceof Error && error.message.includes('session scope')) {
      return { kind: 'rejected', reason: 'scope-changed' }
    }
    throw error
  }

  const projected = readSessionTranscriptProjection(db, sessionId)
  if (projected.source === 'legacy') return { kind: 'rejected', reason: 'history-conflict' }
  return { kind: 'migrated', messageCount: projected.messages.length }
}
