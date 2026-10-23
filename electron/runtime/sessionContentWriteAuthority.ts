import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { toCanonicalModelMessages } from './canonicalHistory'
import { createSessionCommitService } from '../sessionStorage/host/sessionCommitService'
import { createSqliteSessionApiRouteProjectionFence } from '../sessionStorage/sqliteRuntimeBindings'

export type CanonicalWriteAuthorityResult = Readonly<{
  status: 'enabled' | 'ineligible'
  reason?: 'session-or-cutover-state-missing' | 'read-fence-not-current' | 'session-not-sealed' |
    'canonical-transcript-mismatch' | 'write-mode-conflict'
  migratedMessageCount: number
}>

/** Move one fully certified, sealed session to canonical write authority while preserving rollback copies. */
export function enableCanonicalSessionWriteAuthority(db: AppDatabase, sessionId: string): CanonicalWriteAuthorityResult {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const state = conn.prepare(`SELECT sessions.generation,cutover.session_generation AS cutover_generation,
        cutover.message_revision,cutover.api_read_mode,cutover.write_mode,cutover.cleanup_state
      FROM sessions JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
      WHERE sessions.id=?`).get(sessionId) as {
        generation: string; cutover_generation: string; message_revision: number; api_read_mode: string; write_mode: string; cleanup_state: string
      } | undefined
    const ineligible = (reason: NonNullable<CanonicalWriteAuthorityResult['reason']>): CanonicalWriteAuthorityResult =>
      ({ status: 'ineligible', reason, migratedMessageCount: 0 })
    if (!state) return ineligible('session-or-cutover-state-missing')
    if (state.write_mode !== 'legacy' && state.write_mode !== 'canonical') return ineligible('write-mode-conflict')
    if (state.cutover_generation !== state.generation || state.api_read_mode !== 'canonical' || state.cleanup_state !== 'retained') {
      return ineligible('read-fence-not-current')
    }

    const transcript = new SqliteAgentHistory(conn, 1, Date.now, sessionId).readCanonicalSessionTranscriptForShadow(sessionId)
    if (transcript.kind !== 'matched' || transcript.eventCount === 0 ||
      transcript.sessionGeneration !== state.generation ||
      !createSqliteSessionApiRouteProjectionFence(db).isCurrent({ sessionId, sessionGeneration: state.generation,
        messageRevision: state.message_revision, historyWatermarkJson: JSON.stringify([
          transcript.sessionSeq, transcript.commitOrder, transcript.watermarkEventId, transcript.watermarkInvocationId
        ]) })) return ineligible('read-fence-not-current')
    const rows = conn.prepare(`SELECT id,role,content,status,timestamp,content_storage_state FROM messages
      WHERE session_id=? ORDER BY sequence,id`).all(sessionId) as Array<{
        id: string; role: string; content: string; status: string; timestamp: number; content_storage_state: string
      }>
    const terminalStatuses = new Set(['sent','completed','failed','cancelled'])
    const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
    if (rows.length === 0 || rows.some((row) => {
      const body = canonicalById.get(row.id)
      return (row.role !== 'user' && row.role !== 'assistant') || !terminalStatuses.has(row.status) ||
        row.content_storage_state === 'canonical-backed-only' || !body || body.role !== row.role ||
        body.content !== row.content || body.timestamp !== row.timestamp
    }) || canonicalById.size !== rows.length) return ineligible('session-not-sealed')

    if (state.write_mode === 'legacy') {
      const changed = conn.prepare(`UPDATE session_message_content_cutover
        SET write_mode='canonical',updated_at=? WHERE session_id=? AND session_generation=?
        AND message_revision=? AND api_read_mode='canonical' AND write_mode='legacy' AND cleanup_state='retained'`)
        .run(Date.now(), sessionId, state.generation, state.message_revision)
      if (Number(changed.changes) !== 1) return ineligible('read-fence-not-current')
    }
    const migrated = conn.prepare(`UPDATE messages SET content_storage_state='canonical-backed-dual-write'
      WHERE session_id=? AND content_storage_state='legacy'`).run(sessionId)
    const count = Number(migrated.changes)
    const stillLegacy = conn.prepare("SELECT 1 FROM messages WHERE session_id=? AND content_storage_state='legacy' LIMIT 1").get(sessionId)
    if (stillLegacy) throw new Error('canonical write authority migration left an unmigrated legacy message')
    return { status: 'enabled', migratedMessageCount: count }
  })
}

/** Append a full canonical context replacement and mirror it to SQLite in one commit. */
export async function writeCanonicalBackedMessageContent(db: AppDatabase, messageId: string, content: string): Promise<boolean> {
  const conn = getDbConnection(db)
  const row = conn.prepare(`SELECT messages.session_id,messages.role,messages.status,messages.timestamp,messages.content,
      messages.content_storage_state,cutover.write_mode
    FROM messages JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
    WHERE messages.id=?`).get(messageId) as {
      session_id: string; role: string; status: string; timestamp: number; content: string; content_storage_state: string; write_mode: string
    } | undefined
  if (!row || row.write_mode !== 'canonical' || row.content_storage_state !== 'canonical-backed-dual-write' ||
    (row.role !== 'user' && row.role !== 'assistant') || !['sent','completed','failed','cancelled'].includes(row.status)) return false
  const history = new SqliteAgentHistory(conn, 1, Date.now, row.session_id)
  const transcript = history.readCanonicalSessionTranscriptForShadow(row.session_id)
  if (transcript.kind !== 'matched') return false
  const targetIndex = transcript.messages.findIndex((message) => message.id === messageId && message.role === row.role)
  if (targetIndex < 0 || typeof transcript.messages[targetIndex]?.content !== 'string' ||
    transcript.messages[targetIndex]?.content !== row.content) return false
  const edited = transcript.messages.map((message, index) => index === targetIndex ? { ...message, content } : message)
  const canonicalMessages = toCanonicalModelMessages(edited)
  const invocationId = randomUUID()
  const turnId = (conn.prepare('SELECT turn_id FROM turns WHERE session_id=? AND assistant_message_id=? ORDER BY created_at DESC LIMIT 1')
    .get(row.session_id, messageId) as { turn_id: string } | undefined)?.turn_id ?? `message-edit-${invocationId}`
  const now = Date.now()
  const commitService = createSessionCommitService({ sessionId: row.session_id, invocationId, turnId, history })
  await commitService.reviseCanonicalMessage({
    messages: canonicalMessages,
    canonicalWriteFence: {
        sessionGeneration: transcript.sessionGeneration, sessionSeq: transcript.sessionSeq, commitOrder: transcript.commitOrder,
        watermarkEventId: transcript.watermarkEventId, watermarkInvocationId: transcript.watermarkInvocationId
    },
    completedAt: now
  }, 0)
  return true
}
