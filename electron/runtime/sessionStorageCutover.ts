import { createHash } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getConfigValue, getRecentTurnRoutingMessages, getSessionMessageRevisionSnapshot, getTurnContext, setConfigValue } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { fieldDifferences, readCanonicalTurnContextCandidate, shadowAcceptedTurnContext, shadowTurnRoutingInput,
  type CanonicalTurnContextCandidate, type TurnRouteInput } from './sessionStorageShadow'
import { queueInputFingerprint } from '../queueInputFingerprint'

const API_READ_PROTOCOL_VERSION = 1
export const CANONICAL_API_READ_FEATURE_CONFIG_KEY = 'config.sessionStorageCanonicalApiRead'

type EligibilityRow = Readonly<{
  sessionGeneration: string
  messageRevision: number
  apiReadMode: string
  writeMode: string
  cleanupState: string
  eligibleSessionGeneration: string
  skeletonRevision: number
  canonicalSessionSeq: number
  canonicalCommitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
  protocolVersion: number
}>

type CanonicalWatermark = Readonly<{
  sessionGeneration: string
  sessionSeq: number
  commitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
}>

export type CanonicalApiReadCertification = Readonly<{
  status: 'eligible' | 'ineligible'
  reason?: string
  apiReadMode: 'canonical' | 'legacy' | 'revalidation-required'
  apiDifferenceCount?: number
  routeDifferenceCount?: number
  watermark?: CanonicalWatermark
}>

export type CanonicalApiReadFence = Readonly<{
  sessionGeneration: string
  messageRevision: number
  canonicalSessionSeq: number
  canonicalCommitOrder: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
}>

type CleanupProgressRow = Readonly<{
  session_generation: string
  session_message_revision: number
  canonical_session_seq: number
  canonical_commit_order: number
  watermark_event_id: string | null
  watermark_invocation_id: string | null
  next_sequence: number
  after_message_id: string | null
  cleaned_message_count: number
  scan_complete: number
  source_manifest_sha256: string | null
  verified_at: number | null
  verification_sha256: string | null
}>

const writeStoppedDatabaseBySession = new Map<string, WeakRef<AppDatabase>>()
const lastCleanupWriteDatabaseBySession = new Map<string, WeakRef<AppDatabase>>()

function cleanupManifestSha256(db: AppDatabase, sessionId: string): string | undefined {
  const conn = getDbConnection(db)
  const session = conn.prepare('SELECT message_count,preview FROM sessions WHERE id=?').get(sessionId) as
    { message_count: number; preview: string | null } | undefined
  if (!session) return undefined
  const messages = conn.prepare(`SELECT id,session_id,role,tool_use,tool_calls,thinking,content_segments,skill_hints,
      attachments,images_delivered_to_api,status,schema_version,timestamp,sequence
    FROM messages WHERE session_id=? ORDER BY sequence,id`).all(sessionId)
  const turns = conn.prepare(`SELECT turn_id,request_id,session_id,assistant_message_id,user_message_id,state,
      created_at,updated_at FROM turns WHERE session_id=? ORDER BY turn_id`).all(sessionId)
  const queueReceipts = conn.prepare(`SELECT request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at
    FROM queue_input_requests WHERE session_id=? ORDER BY request_id`).all(sessionId)
  const queueEntries = conn.prepare(`SELECT turn_id,owner_id,generation,status,enqueued_at,updated_at
    FROM session_execution_queue WHERE session_id=? ORDER BY turn_id`).all(sessionId)
  const foreignKeyViolations = conn.prepare('PRAGMA foreign_key_check').all()
  const canonical = new SqliteAgentHistory(conn, 1, Date.now, sessionId).readCanonicalSessionTranscriptForShadow(sessionId)
  if (canonical.kind !== 'matched') return undefined
  const canonicalBodies = canonical.messages.map(({ id, role, timestamp, content }) => ({ id, role, timestamp, content }))
  const value = JSON.stringify({
    session: { id: sessionId, messageCount: session.message_count, preview: session.preview },
    messages, turns, queueReceipts, queueEntries, foreignKeyViolations, canonicalBodies
  })
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function cleanupProgressCursorIsConsistent(
  conn: ReturnType<typeof getDbConnection>,
  sessionId: string,
  progress: Pick<CleanupProgressRow, 'next_sequence' | 'after_message_id' | 'cleaned_message_count' | 'scan_complete'>
): boolean {
  if (!Number.isSafeInteger(progress.cleaned_message_count) || progress.cleaned_message_count < 0 ||
    !Number.isSafeInteger(progress.next_sequence) || progress.next_sequence < 0 ||
    (progress.scan_complete !== 0 && progress.scan_complete !== 1)) return false
  const counts = conn.prepare(`SELECT COUNT(*) AS total, MIN(sequence) AS first_sequence,
      SUM(CASE WHEN content_storage_state='canonical-backed-only' THEN 1 ELSE 0 END) AS cleared,
      SUM(CASE WHEN content_storage_state='canonical-backed-only' AND content!='' THEN 1 ELSE 0 END) AS nonempty_cleared,
      SUM(CASE WHEN content_storage_state NOT IN ('canonical-backed-only','canonical-backed-dual-write') THEN 1 ELSE 0 END) AS unknown_state,
      SUM(CASE WHEN content_storage_state='canonical-backed-only' AND
        (sequence>? OR (sequence=? AND (? IS NULL OR id>?))) THEN 1 ELSE 0 END) AS cleared_after_cursor,
      SUM(CASE WHEN content_storage_state='canonical-backed-dual-write' AND
        (sequence<? OR (sequence=? AND ? IS NOT NULL AND id<=?)) THEN 1 ELSE 0 END) AS uncleared_before_cursor
    FROM messages WHERE session_id=?`).get(
      progress.next_sequence, progress.next_sequence, progress.after_message_id, progress.after_message_id ?? '',
      progress.next_sequence, progress.next_sequence, progress.after_message_id, progress.after_message_id, sessionId
    ) as { total: number; first_sequence: number | null; cleared: number | null; nonempty_cleared: number | null; unknown_state: number | null;
      cleared_after_cursor: number | null; uncleared_before_cursor: number | null }
  const total = Number(counts.total)
  const cleared = Number(counts.cleared ?? 0)
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(cleared) || cleared !== progress.cleaned_message_count ||
    Number(counts.nonempty_cleared ?? 0) !== 0 || Number(counts.unknown_state ?? 0) !== 0 ||
    Number(counts.cleared_after_cursor ?? 0) !== 0 || Number(counts.uncleared_before_cursor ?? 0) !== 0 ||
    (progress.scan_complete === 1 && cleared !== total) ||
    (progress.scan_complete === 0 && total > 0 && cleared === total)) return false
  if (cleared === 0) return progress.next_sequence === Number(counts.first_sequence ?? 0) && progress.after_message_id === null
  if (!progress.after_message_id) return false
  const anchor = conn.prepare(`SELECT content,content_storage_state FROM messages
    WHERE session_id=? AND sequence=? AND id=?`).get(sessionId, progress.next_sequence, progress.after_message_id) as
    { content: string; content_storage_state: string } | undefined
  return anchor?.content === '' && anchor.content_storage_state === 'canonical-backed-only'
}

function revokeEligibility(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  conn.prepare('DELETE FROM canonical_session_api_context_eligibility WHERE session_id=?').run(sessionId)
  conn.prepare(`UPDATE session_message_content_cutover SET
    api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
    updated_at=? WHERE session_id=?`).run(Date.now(), sessionId)
}

function canonicalApiReadFeatureEnabled(db: AppDatabase): boolean {
  return getConfigValue(db, CANONICAL_API_READ_FEATURE_CONFIG_KEY) === 'true'
}

/** The global kill switch forces all per-session API reads back to the retained legacy copy. */
function disableCanonicalReadForSession(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  if (!conn.prepare(`SELECT 1 FROM canonical_session_api_context_eligibility WHERE session_id=? UNION ALL
      SELECT 1 FROM session_message_content_cutover WHERE session_id=? AND api_read_mode!='legacy' LIMIT 1`).get(sessionId, sessionId)) return
  conn.prepare('DELETE FROM canonical_session_api_context_eligibility WHERE session_id=?').run(sessionId)
  conn.prepare(`UPDATE session_message_content_cutover SET api_read_mode='legacy',updated_at=?
    WHERE session_id=? AND api_read_mode!='legacy'`).run(Date.now(), sessionId)
}

/** Enter the persisted write-stop fence only after checking that no queued or active turn can still write bodies. */
export function markSessionMessageContentWriteStopped(db: AppDatabase, sessionId: string): boolean {
  return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const eligible = conn.prepare(`SELECT sessions.generation,cutover.session_generation,
        cutover.write_mode,cutover.cleanup_state,cutover.message_revision
      FROM sessions JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
      WHERE sessions.id=?`).get(sessionId) as {
        generation: string; session_generation: string; write_mode: string; cleanup_state: string; message_revision: number
      } | undefined
    if (!eligible || eligible.generation !== eligible.session_generation || eligible.write_mode !== 'canonical' || eligible.cleanup_state !== 'retained') return false

    const activeControl = conn.prepare(`
      SELECT 1 FROM session_execution_claims WHERE session_id=?
      UNION ALL SELECT 1 FROM session_execution_queue WHERE session_id=?
        AND status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')
      UNION ALL SELECT 1 FROM turns WHERE session_id=?
        AND state NOT IN ('completed','failed','cancelled','interrupted')
      UNION ALL SELECT 1 FROM messages WHERE session_id=? AND status IN ('queued','streaming')
      LIMIT 1`).get(sessionId, sessionId, sessionId, sessionId)
    if (activeControl) return false

    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const transcript = history.readCanonicalSessionTranscriptForShadow(sessionId)
    if (transcript.kind !== 'matched' || transcript.sessionGeneration !== eligible.generation || transcript.eventCount === 0) return false
    const cache = history.readCanonicalSessionCache({ ...transcript, cacheKey: 'transcript' })
    if (cache.kind !== 'hit') return false
    try {
      const cached = JSON.parse(cache.value) as typeof transcript.messages
      if (!Array.isArray(cached) || cached.length !== transcript.messages.length || cached.some((message, index) => {
        const folded = transcript.messages[index]
        return !folded || !message || message.id !== folded.id || message.role !== folded.role ||
          message.timestamp !== folded.timestamp || message.content !== folded.content
      })) return false
    } catch { return false }

    const rows = conn.prepare(`SELECT id,role,content,status,timestamp,content_storage_state FROM messages
      WHERE session_id=? ORDER BY sequence,id`).all(sessionId) as Array<{
        id: string; role: string; content: string; status: string; timestamp: number; content_storage_state: string
      }>
    const terminalStatuses = new Set(['sent','completed','failed','cancelled'])
    const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
    if (rows.length === 0 || rows.some((row) => {
      const body = canonicalById.get(row.id)
      return row.content_storage_state !== 'canonical-backed-dual-write' || !terminalStatuses.has(row.status) ||
        (row.role !== 'user' && row.role !== 'assistant') || !body || body.role !== row.role ||
        body.content !== row.content || body.timestamp !== row.timestamp
    }) || canonicalById.size !== rows.length) return false

    const firstSequence = Number((conn.prepare('SELECT MIN(sequence) AS sequence FROM messages WHERE session_id=?')
      .get(sessionId) as { sequence: number | null }).sequence)
    if (!Number.isSafeInteger(firstSequence) || firstSequence < 0) return false
    const sourceManifestSha256 = cleanupManifestSha256(db, sessionId)
    if (!sourceManifestSha256) return false

    conn.prepare(`INSERT INTO session_message_content_cleanup_progress(
      session_id,session_generation,session_message_revision,canonical_session_seq,canonical_commit_order,
      watermark_event_id,watermark_invocation_id,next_sequence,after_message_id,cleaned_message_count,
      scan_complete,source_manifest_sha256,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      session_generation=excluded.session_generation,session_message_revision=excluded.session_message_revision,
      canonical_session_seq=excluded.canonical_session_seq,canonical_commit_order=excluded.canonical_commit_order,
      watermark_event_id=excluded.watermark_event_id,watermark_invocation_id=excluded.watermark_invocation_id,
      next_sequence=excluded.next_sequence,after_message_id=NULL,cleaned_message_count=0,scan_complete=0,
      source_manifest_sha256=excluded.source_manifest_sha256,verified_at=NULL,verification_sha256=NULL,
      updated_at=excluded.updated_at`)
      .run(sessionId, eligible.generation, eligible.message_revision, transcript.sessionSeq, transcript.commitOrder,
        transcript.watermarkEventId, transcript.watermarkInvocationId, firstSequence, null, 0, 0,
        sourceManifestSha256, Date.now())

    const changed = conn.prepare(`UPDATE session_message_content_cutover SET cleanup_state='write-stopped',updated_at=?
      WHERE session_id=? AND session_generation=? AND message_revision=? AND write_mode='canonical' AND cleanup_state='retained'`)
      .run(Date.now(), sessionId, eligible.generation, eligible.message_revision)
    if (Number(changed.changes) === 1) writeStoppedDatabaseBySession.set(sessionId, new WeakRef(db))
    return Number(changed.changes) === 1
  })
}

/** Advance a fenced, write-stopped session to resumable pending cleanup after rechecking its persisted fence. */
export function beginSessionMessageContentCleanup(db: AppDatabase, sessionId: string): boolean {
  return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const state = conn.prepare(`SELECT sessions.generation,cutover.session_generation,cutover.message_revision,
        cutover.cleanup_state,progress.session_generation AS progress_generation,
        progress.session_message_revision AS progress_revision,progress.canonical_session_seq,
        progress.canonical_commit_order,progress.watermark_event_id,progress.watermark_invocation_id
      FROM sessions JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
      LEFT JOIN session_message_content_cleanup_progress progress ON progress.session_id=sessions.id
      WHERE sessions.id=?`).get(sessionId) as ({
        generation: string; session_generation: string; message_revision: number; cleanup_state: string
        progress_generation: string | null; progress_revision: number | null; canonical_session_seq: number | null
        canonical_commit_order: number | null; watermark_event_id: string | null; watermark_invocation_id: string | null
      } | undefined)
    if (!state || state.cleanup_state !== 'write-stopped' || state.generation !== state.session_generation ||
      state.generation !== state.progress_generation || state.message_revision !== state.progress_revision) return false

    const activeControl = conn.prepare(`
      SELECT 1 FROM session_execution_claims WHERE session_id=?
      UNION ALL SELECT 1 FROM session_execution_queue WHERE session_id=?
        AND status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')
      UNION ALL SELECT 1 FROM turns WHERE session_id=?
        AND state NOT IN ('completed','failed','cancelled','interrupted')
      UNION ALL SELECT 1 FROM messages WHERE session_id=? AND status IN ('queued','streaming')
      LIMIT 1`).get(sessionId, sessionId, sessionId, sessionId)
    if (activeControl) return false

    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const transcript = history.readCanonicalSessionTranscriptForShadow(sessionId)
    if (transcript.kind !== 'matched' || transcript.sessionGeneration !== state.generation ||
      transcript.sessionSeq !== state.canonical_session_seq || transcript.commitOrder !== state.canonical_commit_order ||
      transcript.watermarkEventId !== state.watermark_event_id || transcript.watermarkInvocationId !== state.watermark_invocation_id) return false
    const progress = conn.prepare(`SELECT * FROM session_message_content_cleanup_progress WHERE session_id=?`)
      .get(sessionId) as CleanupProgressRow | undefined
    if (!progress || progress.verified_at !== null || progress.verification_sha256 !== null ||
      !progress.source_manifest_sha256 || cleanupManifestSha256(db, sessionId) !== progress.source_manifest_sha256) return false
    const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
    const rows = conn.prepare(`SELECT id,role,content,status,timestamp,content_storage_state FROM messages
      WHERE session_id=? ORDER BY sequence,id`).all(sessionId) as Array<{
        id: string; role: string; content: string; status: string; timestamp: number; content_storage_state: string
      }>
    if (!rows.length || rows.length !== canonicalById.size || rows.some((row) => {
      const body = canonicalById.get(row.id)
      return row.content_storage_state !== 'canonical-backed-dual-write' ||
        !['sent','completed','failed','cancelled'].includes(row.status) ||
        !body || body.role !== row.role || body.content !== row.content || body.timestamp !== row.timestamp
    })) return false

    const changed = conn.prepare(`UPDATE session_message_content_cutover SET cleanup_state='pending',updated_at=?
      WHERE session_id=? AND session_generation=? AND message_revision=? AND cleanup_state='write-stopped'`)
      .run(Date.now(), sessionId, state.generation, state.message_revision)
    return Number(changed.changes) === 1
  })
}

export type SessionMessageContentCleanupBatchResult = Readonly<{
  status: 'advanced' | 'complete' | 'ineligible'
  cleanedMessageCount: number
  nextSequence?: number
  afterMessageId?: string | null
  reason?: 'session-or-progress-missing' | 'fence-changed' | 'active-control' | 'history-unavailable' | 'message-mismatch'
}>

/** Clear one bounded, resumable batch for a pending session; callers must gate this until Phase 5.5 reviews pass. */
export function clearNextSessionMessageContentBatch(
  db: AppDatabase,
  sessionId: string,
  batchSize = 100
): SessionMessageContentCleanupBatchResult {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('session content cleanup batch size must be between 1 and 1000')
  }
  try {
    return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const state = conn.prepare(`SELECT sessions.generation,cutover.session_generation AS cutover_generation,
        cutover.message_revision AS cutover_message_revision,cutover.write_mode,cutover.cleanup_state,progress.*
      FROM sessions JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
      JOIN session_message_content_cleanup_progress progress ON progress.session_id=sessions.id
      WHERE sessions.id=?`).get(sessionId) as ({
        generation: string; cutover_generation: string; cutover_message_revision: number; write_mode: string; cleanup_state: string
      } & CleanupProgressRow) | undefined
    const ineligible = (reason: NonNullable<SessionMessageContentCleanupBatchResult['reason']>): SessionMessageContentCleanupBatchResult => {
      conn.prepare(`UPDATE session_message_content_cleanup_progress SET attempts=attempts+1,last_error=?,updated_at=?
        WHERE session_id=? AND EXISTS (SELECT 1 FROM session_message_content_cutover
          WHERE session_id=? AND cleanup_state='pending')`).run(reason, Date.now(), sessionId, sessionId)
      return { status: 'ineligible', cleanedMessageCount: 0, reason }
    }
    if (!state || state.cleanup_state !== 'pending' || state.write_mode !== 'canonical') return ineligible('session-or-progress-missing')
    if (state.generation !== state.cutover_generation || state.generation !== state.session_generation ||
      state.session_message_revision !== state.cutover_message_revision) return ineligible('fence-changed')
    if (state.session_message_revision !== state.cutover_message_revision || !state.source_manifest_sha256) return ineligible('fence-changed')
    if (!cleanupProgressCursorIsConsistent(conn, sessionId, state)) return ineligible('fence-changed')

    const activeControl = conn.prepare(`
      SELECT 1 FROM session_execution_claims WHERE session_id=?
      UNION ALL SELECT 1 FROM session_execution_queue WHERE session_id=?
        AND status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')
      UNION ALL SELECT 1 FROM turns WHERE session_id=?
        AND state NOT IN ('completed','failed','cancelled','interrupted')
      UNION ALL SELECT 1 FROM messages WHERE session_id=? AND status IN ('queued','streaming')
      LIMIT 1`).get(sessionId, sessionId, sessionId, sessionId)
    if (activeControl) return ineligible('active-control')

    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    if (!history.isGlobalCommitCursorContiguous()) return ineligible('history-unavailable')
    try {
      history.validateCanonicalSessionSourceTruthSpills(sessionId)
    } catch {
      return ineligible('history-unavailable')
    }
    const projected = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
    if (projected.kind !== 'matched' || projected.watermark.sessionGeneration !== state.generation ||
      projected.watermark.sessionSeq !== state.canonical_session_seq || projected.watermark.commitOrder !== state.canonical_commit_order ||
      projected.watermark.watermarkEventId !== state.watermark_event_id || projected.watermark.watermarkInvocationId !== state.watermark_invocation_id) {
      return ineligible('history-unavailable')
    }
    const canonicalById = new Map(projected.messages.map((message) => [message.id, message]))
    const rows = conn.prepare(`SELECT id,role,content,status,timestamp,sequence,content_storage_state FROM messages
      WHERE session_id=? AND (sequence>? OR (sequence=? AND (? IS NULL OR id>?)))
      ORDER BY sequence,id LIMIT ?`).all(sessionId, state.next_sequence, state.next_sequence,
      state.after_message_id, state.after_message_id ?? '', batchSize) as Array<{
        id: string; role: string; content: string; status: string; timestamp: number; sequence: number; content_storage_state: string
      }>

    if (rows.some((row) => row.content_storage_state !== 'canonical-backed-dual-write' ||
      !canonicalById.has(row.id) || canonicalById.get(row.id)?.content !== row.content ||
      canonicalById.get(row.id)?.role !== row.role || canonicalById.get(row.id)?.timestamp !== row.timestamp ||
      !['sent','completed','failed','cancelled'].includes(row.status))) return ineligible('message-mismatch')

    if (cleanupManifestSha256(db, sessionId) !== state.source_manifest_sha256) return ineligible('fence-changed')

    for (const row of rows) {
      const changed = conn.prepare(`UPDATE messages SET content='',content_storage_state='canonical-backed-only'
        WHERE id=? AND session_id=? AND sequence=? AND content=? AND content_storage_state='canonical-backed-dual-write'`)
        .run(row.id, sessionId, row.sequence, row.content)
      if (Number(changed.changes) !== 1) throw new Error('session content cleanup message CAS failed')
    }
    const last = rows[rows.length - 1]
    const remaining = Number((conn.prepare(`SELECT COUNT(*) AS count FROM messages
      WHERE session_id=? AND (content_storage_state!='canonical-backed-only' OR content!='')`).get(sessionId) as { count: number }).count)
    const scanComplete = remaining === 0 ? 1 : 0
    if (last) {
      const advanced = conn.prepare(`UPDATE session_message_content_cleanup_progress SET next_sequence=?,after_message_id=?,
        cleaned_message_count=cleaned_message_count+?,scan_complete=?,last_error=NULL,updated_at=?
        WHERE session_id=? AND session_generation=? AND session_message_revision=? AND next_sequence=?
          AND after_message_id IS ? AND scan_complete=0`)
        .run(last.sequence, last.id, rows.length, scanComplete, Date.now(), sessionId, state.generation,
          state.cutover_message_revision, state.next_sequence, state.after_message_id)
      if (Number(advanced.changes) !== 1) throw new Error('session content cleanup progress CAS failed')
    } else {
      const advanced = conn.prepare(`UPDATE session_message_content_cleanup_progress SET scan_complete=1,last_error=NULL,updated_at=?
        WHERE session_id=? AND session_generation=? AND session_message_revision=? AND next_sequence=?
          AND after_message_id IS ? AND scan_complete=0 AND NOT EXISTS (
            SELECT 1 FROM messages WHERE session_id=? AND (content_storage_state!='canonical-backed-only' OR content!='')
          )`)
        .run(Date.now(), sessionId, state.generation, state.cutover_message_revision, state.next_sequence,
          state.after_message_id, sessionId)
      if (Number(advanced.changes) !== 1) throw new Error('session content cleanup progress CAS failed')
    }
    const progress = conn.prepare(`SELECT next_sequence,after_message_id,cleaned_message_count,scan_complete
      FROM session_message_content_cleanup_progress WHERE session_id=?`).get(sessionId) as {
        next_sequence: number; after_message_id: string | null; cleaned_message_count: number; scan_complete: number
      }
    lastCleanupWriteDatabaseBySession.set(sessionId, new WeakRef(db))
    return { status: progress.scan_complete === 1 ? 'complete' : 'advanced', cleanedMessageCount: rows.length,
      nextSequence: progress.next_sequence, afterMessageId: progress.after_message_id }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown cleanup batch error'
    try {
      runInTransaction(getDbConnection(db), () => {
        getDbConnection(db).prepare(`UPDATE session_message_content_cleanup_progress SET attempts=attempts+1,last_error=?,updated_at=?
          WHERE session_id=? AND EXISTS (SELECT 1 FROM session_message_content_cutover
            WHERE session_id=? AND cleanup_state='pending')`).run(message, Date.now(), sessionId, sessionId)
      })
    } catch { /* Preserve the original batch failure; progress cursor remains atomic with the rolled-back batch. */ }
    throw error
  }
}

/** Record final verification only on a reopened database handle, then atomically mark the session complete. */
export function verifyAndCompleteSessionMessageContentCleanup(db: AppDatabase, sessionId: string): boolean {
  return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const state = conn.prepare(`SELECT sessions.generation,cutover.session_generation AS cutover_generation,
        cutover.message_revision AS cutover_message_revision,cutover.cleanup_state,cutover.write_mode,progress.*
      FROM sessions JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
      JOIN session_message_content_cleanup_progress progress ON progress.session_id=sessions.id
      WHERE sessions.id=?`).get(sessionId) as ({
        generation: string; cutover_generation: string; cutover_message_revision: number; cleanup_state: string; write_mode: string
      } & CleanupProgressRow) | undefined
    if (!state || state.cleanup_state !== 'pending' || state.write_mode !== 'canonical' || state.scan_complete !== 1 ||
      state.generation !== state.cutover_generation || state.generation !== state.session_generation ||
      state.cutover_message_revision !== state.session_message_revision || !state.source_manifest_sha256 ||
      !cleanupProgressCursorIsConsistent(conn, sessionId, state)) return false
    const previousHandle = writeStoppedDatabaseBySession.get(sessionId)?.deref()
    const lastWriteHandle = lastCleanupWriteDatabaseBySession.get(sessionId)?.deref()
    if (previousHandle === db || lastWriteHandle === db) return false
    const activeControl = conn.prepare(`
      SELECT 1 FROM session_execution_claims WHERE session_id=?
      UNION ALL SELECT 1 FROM session_execution_queue WHERE session_id=?
        AND status IN ('queued','claimed','executing','transcript_committed','commit_uncertain')
      UNION ALL SELECT 1 FROM turns WHERE session_id=?
        AND state NOT IN ('completed','failed','cancelled','interrupted')
      UNION ALL SELECT 1 FROM messages WHERE session_id=? AND status IN ('queued','streaming')
      LIMIT 1`).get(sessionId, sessionId, sessionId, sessionId)
    if (activeControl) return false
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const projected = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
    if (projected.kind !== 'matched' || projected.watermark.sessionGeneration !== state.generation ||
      projected.watermark.sessionSeq !== state.canonical_session_seq || projected.watermark.commitOrder !== state.canonical_commit_order ||
      projected.watermark.watermarkEventId !== state.watermark_event_id || projected.watermark.watermarkInvocationId !== state.watermark_invocation_id) return false
    const canonicalById = new Map(projected.messages.map((message) => [message.id, message]))
    const rows = conn.prepare(`SELECT id,role,content,status,timestamp,sequence,content_storage_state FROM messages
      WHERE session_id=? ORDER BY sequence,id`).all(sessionId) as Array<{
        id: string; role: string; content: string; status: string; timestamp: number; sequence: number; content_storage_state: string
      }>
    if (rows.length !== canonicalById.size || rows.some((row) => {
      const body = canonicalById.get(row.id)
      return !body || row.content !== '' || row.content_storage_state !== 'canonical-backed-only' ||
        row.role !== body.role || row.timestamp !== body.timestamp ||
        !['sent','completed','failed','cancelled'].includes(row.status)
    })) return false
    const finalManifest = cleanupManifestSha256(db, sessionId)
    if (!finalManifest || finalManifest !== state.source_manifest_sha256) return false
    const verificationSha256 = createHash('sha256').update(JSON.stringify({
      sessionId, generation: state.generation, messageRevision: state.cutover_message_revision,
      sessionSeq: projected.watermark.sessionSeq, commitOrder: projected.watermark.commitOrder,
      watermarkEventId: projected.watermark.watermarkEventId, watermarkInvocationId: projected.watermark.watermarkInvocationId,
      manifest: finalManifest, messageCount: rows.length
    }), 'utf8').digest('hex')
    const now = Date.now()
    const verified = conn.prepare(`UPDATE session_message_content_cleanup_progress SET verified_at=?,verification_sha256=?,updated_at=?
      WHERE session_id=? AND session_generation=? AND session_message_revision=? AND scan_complete=1 AND source_manifest_sha256=?`)
      .run(now, verificationSha256, now, sessionId, state.generation, state.session_message_revision, state.source_manifest_sha256)
    if (Number(verified.changes) !== 1) return false
    const changed = conn.prepare(`UPDATE session_message_content_cutover SET cleanup_state='complete',updated_at=?
      WHERE session_id=? AND session_generation=? AND message_revision=? AND cleanup_state='pending' AND write_mode='canonical'`)
      .run(now, sessionId, state.generation, state.cutover_message_revision)
    return Number(changed.changes) === 1
  })
}

/** Persist the Phase 5.3 rollout kill switch. Disabling also immediately revokes every session fence. */
export function setCanonicalApiReadFeatureEnabled(db: AppDatabase, enabled: boolean): void {
  runInTransaction(getDbConnection(db), () => {
    setConfigValue(db, CANONICAL_API_READ_FEATURE_CONFIG_KEY, enabled ? 'true' : 'false')
    if (!enabled) {
      getDbConnection(db).prepare('DELETE FROM canonical_session_api_context_eligibility').run()
      getDbConnection(db).prepare(`UPDATE session_message_content_cutover SET api_read_mode='legacy',updated_at=?
        WHERE api_read_mode!='legacy'`).run(Date.now())
    }
  })
}

function readEligibility(db: AppDatabase, sessionId: string): EligibilityRow | undefined {
  return getDbConnection(db).prepare(`SELECT sessions.generation AS sessionGeneration,
      cutover.message_revision AS messageRevision, cutover.api_read_mode AS apiReadMode,
      cutover.write_mode AS writeMode, cutover.cleanup_state AS cleanupState,
      eligibility.session_generation AS eligibleSessionGeneration,
      eligibility.skeleton_revision AS skeletonRevision,
      eligibility.canonical_session_seq AS canonicalSessionSeq,
      eligibility.canonical_commit_order AS canonicalCommitOrder,
      eligibility.watermark_event_id AS watermarkEventId,
      eligibility.watermark_invocation_id AS watermarkInvocationId,
      eligibility.protocol_version AS protocolVersion
    FROM sessions
    JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id
    LEFT JOIN canonical_session_api_context_eligibility eligibility ON eligibility.session_id=sessions.id
    WHERE sessions.id=?`).get(sessionId) as EligibilityRow | undefined
}

function readCanonicalState(db: AppDatabase, sessionId: string): Readonly<{ watermark?: CanonicalWatermark; cacheValidated: boolean }> {
  const history = new SqliteAgentHistory(getDbConnection(db))
  const canonical = history.readCanonicalSessionTranscriptForShadow(sessionId)
  if (canonical.kind !== 'matched' || canonical.eventCount === 0) return { cacheValidated: false }
  const cache = history.readCanonicalSessionCache({ ...canonical, cacheKey: 'transcript' })
  const watermark: CanonicalWatermark = {
    sessionGeneration: canonical.sessionGeneration,
    sessionSeq: canonical.sessionSeq,
    commitOrder: canonical.commitOrder,
    watermarkEventId: canonical.watermarkEventId,
    watermarkInvocationId: canonical.watermarkInvocationId
  }
  if (cache.kind !== 'hit') return { watermark, cacheValidated: false }
  try {
    const cached = JSON.parse(cache.value) as typeof canonical.messages
    const cacheValidated = Array.isArray(cached) && cached.length === canonical.messages.length && cached.every((message, index) => {
      const folded = canonical.messages[index]
      return !!folded && !!message && message.id === folded.id && message.role === folded.role &&
        message.timestamp === folded.timestamp && message.content === folded.content
    })
    return { watermark, cacheValidated }
  } catch { return { watermark, cacheValidated: false } }
}

function sameWatermark(a: CanonicalWatermark | undefined, b: CanonicalWatermark | undefined): boolean {
  return !!a && !!b && a.sessionGeneration === b.sessionGeneration && a.sessionSeq === b.sessionSeq &&
    a.commitOrder === b.commitOrder && a.watermarkEventId === b.watermarkEventId &&
    a.watermarkInvocationId === b.watermarkInvocationId
}

function eligibilityMatches(row: EligibilityRow | undefined, watermark: CanonicalWatermark | undefined): row is EligibilityRow {
  return !!row && !!watermark && row.apiReadMode === 'canonical' && (row.writeMode === 'legacy' || row.writeMode === 'canonical') && row.cleanupState === 'retained' &&
    row.eligibleSessionGeneration === row.sessionGeneration && row.sessionGeneration === watermark.sessionGeneration &&
    row.skeletonRevision === row.messageRevision && row.canonicalSessionSeq === watermark.sessionSeq &&
    row.canonicalCommitOrder === watermark.commitOrder && row.watermarkEventId === watermark.watermarkEventId &&
    row.watermarkInvocationId === watermark.watermarkInvocationId && row.protocolVersion === API_READ_PROTOCOL_VERSION
}

function toFence(row: EligibilityRow, watermark: CanonicalWatermark): CanonicalApiReadFence {
  return {
    sessionGeneration: row.sessionGeneration,
    messageRevision: row.messageRevision,
    canonicalSessionSeq: watermark.sessionSeq,
    canonicalCommitOrder: watermark.commitOrder,
    watermarkEventId: watermark.watermarkEventId,
    watermarkInvocationId: watermark.watermarkInvocationId
  }
}

/** Certify the complete session corpus, not a boundary-limited request, then grant the API/route read fence atomically. */
export function certifyCanonicalSessionApiRead(db: AppDatabase, sessionId: string): CanonicalApiReadCertification {
  return runInTransaction(getDbConnection(db), () => {
    const initial = getSessionMessageRevisionSnapshot(db, sessionId)
    const state = readEligibility(db, sessionId)
    if (!initial || !state) return { status: 'ineligible', reason: 'session-or-cutover-state-missing', apiReadMode: 'legacy' }
    if ((state.writeMode !== 'legacy' && state.writeMode !== 'canonical') || state.cleanupState !== 'retained') {
      revokeEligibility(db, sessionId)
      return { status: 'ineligible', reason: 'write-or-cleanup-phase-not-eligible', apiReadMode: state.apiReadMode === 'canonical' ? 'revalidation-required' : 'legacy' }
    }

    const allApiMessages = getTurnContext(db, sessionId, undefined, undefined, [])
    const apiShadow = shadowAcceptedTurnContext(db, sessionId, allApiMessages)
    const allRouteMessages = getRecentTurnRoutingMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
    const routeInput = { userInput: '', recentMessages: allRouteMessages, sessionId }
    const routeShadow = shadowTurnRoutingInput(db, {
      sessionId,
      mode: 'create-user',
      routeInput,
      boundarySequence: undefined,
      excludeMessageIds: [],
      limit: Number.MAX_SAFE_INTEGER
    } satisfies TurnRouteInput<typeof routeInput>)
    const watermark = apiShadow.canonicalWatermark
    const routeWatermark = routeShadow.canonicalWatermark
    const current = getSessionMessageRevisionSnapshot(db, sessionId)
    if (apiShadow.status !== 'matched' || routeShadow.status !== 'matched' || !watermark || !sameWatermark(watermark, routeWatermark) || !current ||
      current.generation !== initial.generation || current.messageRevision !== initial.messageRevision ||
      watermark.sessionGeneration !== initial.generation) {
      revokeEligibility(db, sessionId)
      return {
        status: 'ineligible',
        reason: !watermark ? 'canonical-watermark-unavailable' : apiShadow.status !== 'matched' ? 'api-context-not-matched' :
          routeShadow.status !== 'matched' ? 'turn-routing-not-matched' : 'session-fence-changed',
        apiReadMode: state.apiReadMode === 'canonical' ? 'revalidation-required' : 'legacy',
        apiDifferenceCount: apiShadow.differenceCount,
        routeDifferenceCount: routeShadow.differenceCount
      }
    }

    const canonicalSnapshot = new SqliteAgentHistory(getDbConnection(db)).readCanonicalSessionTranscriptForShadow(sessionId)
    if (canonicalSnapshot.kind !== 'matched' || canonicalSnapshot.eventCount === 0 ||
      canonicalSnapshot.sessionSeq !== watermark.sessionSeq || canonicalSnapshot.commitOrder !== watermark.commitOrder ||
      canonicalSnapshot.watermarkEventId !== watermark.watermarkEventId ||
      canonicalSnapshot.watermarkInvocationId !== watermark.watermarkInvocationId ||
      !new SqliteAgentHistory(getDbConnection(db)).writeCanonicalSessionCache({
        ...canonicalSnapshot, cacheKey: 'transcript', value: JSON.stringify(canonicalSnapshot.messages)
      })) {
      revokeEligibility(db, sessionId)
      return { status: 'ineligible', reason: 'canonical-cache-seed-failed', apiReadMode: state.apiReadMode === 'canonical' ? 'revalidation-required' : 'legacy',
        apiDifferenceCount: apiShadow.differenceCount, routeDifferenceCount: routeShadow.differenceCount }
    }

    const now = Date.now()
    getDbConnection(db).prepare(`INSERT INTO canonical_session_api_context_eligibility(
      session_id,session_generation,skeleton_revision,canonical_session_seq,canonical_commit_order,
      watermark_event_id,watermark_invocation_id,validated_at,protocol_version
    ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      session_generation=excluded.session_generation,skeleton_revision=excluded.skeleton_revision,
      canonical_session_seq=excluded.canonical_session_seq,canonical_commit_order=excluded.canonical_commit_order,
      watermark_event_id=excluded.watermark_event_id,watermark_invocation_id=excluded.watermark_invocation_id,
      validated_at=excluded.validated_at,protocol_version=excluded.protocol_version`)
      .run(sessionId, initial.generation, initial.messageRevision, watermark.sessionSeq, watermark.commitOrder,
        watermark.watermarkEventId, watermark.watermarkInvocationId, now, API_READ_PROTOCOL_VERSION)
    const changed = getDbConnection(db).prepare(`UPDATE session_message_content_cutover SET
      session_generation=?,api_read_mode='canonical',updated_at=?
      WHERE session_id=? AND session_generation=? AND message_revision=? AND write_mode IN ('legacy','canonical') AND cleanup_state='retained'`)
      .run(initial.generation, now, sessionId, initial.generation, initial.messageRevision)
    if (Number(changed.changes) !== 1) {
      revokeEligibility(db, sessionId)
      return { status: 'ineligible', reason: 'session-fence-changed', apiReadMode: 'revalidation-required',
        apiDifferenceCount: apiShadow.differenceCount, routeDifferenceCount: routeShadow.differenceCount }
    }
    return { status: 'eligible', apiReadMode: 'canonical', apiDifferenceCount: apiShadow.differenceCount,
      routeDifferenceCount: routeShadow.differenceCount, watermark }
  })
}

/** Resolve one accepted API request only while its session-wide generation/revision/watermark fence remains exact. */
export function readCanonicalApiContextIfEligible(
  db: AppDatabase,
  sessionId: string,
  boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined,
  excludeMessageIds: string[],
  acceptedInput?: Readonly<{ messageId: string; fingerprint: string }>
): CanonicalTurnContextCandidate | undefined {
  return runInTransaction(getDbConnection(db), () => {
    if (!canonicalApiReadFeatureEnabled(db)) {
      disableCanonicalReadForSession(db, sessionId)
      return undefined
    }
    let row = readEligibility(db, sessionId)
    if (!row || row.apiReadMode !== 'canonical') {
      if (certifyCanonicalSessionApiRead(db, sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, sessionId)
    }
    let candidate = readCanonicalTurnContextCandidate(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
    if (candidate.status !== 'available' || !candidate.messages) {
      revokeEligibility(db, sessionId)
      return undefined
    }
    if (!candidate.canonicalCacheValidated || !eligibilityMatches(row, candidate.canonicalWatermark)) {
      revokeEligibility(db, sessionId)
      if (certifyCanonicalSessionApiRead(db, sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, sessionId)
      candidate = readCanonicalTurnContextCandidate(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
      if (!row || candidate.status !== 'available' || !candidate.messages || !candidate.canonicalCacheValidated ||
        !eligibilityMatches(row, candidate.canonicalWatermark)) {
        revokeEligibility(db, sessionId)
        return undefined
      }
    }
    if (acceptedInput) {
      const accepted = candidate.messages.find((message) => message.id === acceptedInput.messageId && message.role === 'user')
      if (!accepted || queueInputFingerprint({ text: accepted.content, attachments: accepted.attachments }) !== acceptedInput.fingerprint) {
        revokeEligibility(db, sessionId)
        return undefined
      }
    }
    if (!candidate.messages) {
      revokeEligibility(db, sessionId)
      return undefined
    }
    return candidate
  })
}

/** Resolve the request-specific route input only under a certified session fence and exact per-request shadow match. */
export function readCanonicalTurnRoutingInputIfEligible<T extends Readonly<{
  userInput: string
  recentMessages: readonly { role: 'user' | 'assistant'; content: string }[]
}>>(
  db: AppDatabase,
  input: TurnRouteInput<T>
): T | undefined {
  return readCanonicalTurnRoutingInputWithFenceIfEligible(db, input)?.routeInput
}

/** Same certified route read as above, returning its exact snapshot fence for post-await validation. */
export function readCanonicalTurnRoutingInputWithFenceIfEligible<T extends Readonly<{
  userInput: string
  recentMessages: readonly { role: 'user' | 'assistant'; content: string }[]
}>>(
  db: AppDatabase,
  input: TurnRouteInput<T>
): Readonly<{ routeInput: T; fence: CanonicalApiReadFence }> | undefined {
  return runInTransaction(getDbConnection(db), () => {
    if (!canonicalApiReadFeatureEnabled(db)) {
      disableCanonicalReadForSession(db, input.sessionId)
      return undefined
    }
    let row = readEligibility(db, input.sessionId)
    if (!row || row.apiReadMode !== 'canonical') {
      if (certifyCanonicalSessionApiRead(db, input.sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, input.sessionId)
    }
    let report = shadowTurnRoutingInput(db, input)
    if (report.status !== 'matched' || !report.candidate || fieldDifferences(input.routeInput, report.candidate).length > 0) {
      revokeEligibility(db, input.sessionId)
      return undefined
    }
    if (!report.canonicalCacheValidated || !eligibilityMatches(row, report.canonicalWatermark)) {
      revokeEligibility(db, input.sessionId)
      if (certifyCanonicalSessionApiRead(db, input.sessionId).status !== 'eligible') return undefined
      row = readEligibility(db, input.sessionId)
      report = shadowTurnRoutingInput(db, input)
      if (!row || report.status !== 'matched' || !report.candidate || !report.canonicalCacheValidated ||
        !eligibilityMatches(row, report.canonicalWatermark) || fieldDifferences(input.routeInput, report.candidate).length > 0) {
        revokeEligibility(db, input.sessionId)
        return undefined
      }
    }
    if (!report.canonicalWatermark || !row) return undefined
    return { routeInput: report.candidate, fence: toFence(row, report.canonicalWatermark) }
  })
}

/** Async route preparation must not freeze configuration derived from a canonical snapshot that changed meanwhile. */
export function isCanonicalApiReadFenceCurrent(db: AppDatabase, sessionId: string, fence: CanonicalApiReadFence): boolean {
  return runInTransaction(getDbConnection(db), () => {
    if (!canonicalApiReadFeatureEnabled(db)) {
      disableCanonicalReadForSession(db, sessionId)
      return false
    }
    const row = readEligibility(db, sessionId)
    const current = readCanonicalState(db, sessionId)
    const watermark = current.watermark
    if (!watermark || !current.cacheValidated || !eligibilityMatches(row, watermark) || row.sessionGeneration !== fence.sessionGeneration ||
      row.messageRevision !== fence.messageRevision || watermark.sessionSeq !== fence.canonicalSessionSeq ||
      watermark.commitOrder !== fence.canonicalCommitOrder || watermark.watermarkEventId !== fence.watermarkEventId ||
      watermark.watermarkInvocationId !== fence.watermarkInvocationId) {
      revokeEligibility(db, sessionId)
      return false
    }
    return true
  })
}
