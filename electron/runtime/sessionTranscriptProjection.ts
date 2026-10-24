import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { consultProjectionRejection, clearProjectionRejection, computeLegacyProjectionDigest, readProjectionO1Metadata, recordProjectionRejection } from '../sessionStorage/sqliteRuntimeBindings'
import { enqueueSessionProjectionRevalidation } from '../sessionStorage/host/sessionProjectionRevalidationQueue'
import { resolveSelectedMessageBodies, hasCurrentProjectionEligibility, publishTranscriptParityProof, refreshValidatedProjectionFastPath,
  selectRecentTurnRoutingMessages, selectTurnContext }
  from '../sessionStorage/sqliteRuntimeBindings'
import {
  readLegacyApiContextBaseline, readLegacyChatMessagePage, readLegacyMessage, readLegacyMessageSkeletons,
  readLegacyMessages, readLegacyMessagesPageWithSequence, readLegacySearchCorpusPage, readLegacyRetryContext,
  type ApiContextBaselineResult, type ChatMessagePage, type MessageSearchHit, type MessagesPageWithSequence,
  type RetryContextTarget, type SearchCorpusPage,
} from '../sessionStorage/sqliteRuntimeBindings'

export type SessionTranscriptProjectionRead =
  | Readonly<{ source: 'canonical:L2'; messages: readonly Message[]; replayedEvents: number }>
  | Readonly<{ source: 'legacy'; messages: readonly Message[]; reason: string }>

function sqliteLikeContainsLiteral(value: string, query: string): boolean {
  if (query.length === 0) return true
  const foldAscii = (code: number): number => code >= 65 && code <= 90 ? code + 32 : code
  const first = query.charCodeAt(0)
  const firstFolded = foldAscii(first)
  const alternate = firstFolded >= 97 && firstFolded <= 122 ? firstFolded === first ? firstFolded - 32 : firstFolded : first
  let from = 0
  while (from <= value.length - query.length) {
    const exact = value.indexOf(query[0]!, from)
    const alternateIndex = alternate === first ? -1 : value.indexOf(String.fromCharCode(alternate), from)
    const candidate = exact < 0 ? alternateIndex : alternateIndex < 0 ? exact : Math.min(exact, alternateIndex)
    if (candidate < 0 || candidate > value.length - query.length) return false
    let matches = true
    for (let index = 0; index < query.length; index += 1) {
      if (foldAscii(value.charCodeAt(candidate + index)) !== foldAscii(query.charCodeAt(index))) {
        matches = false
        break
      }
    }
    if (matches) return true
    from = candidate + 1
  }
  return false
}

export function hasSessionProjectionEligibility(db: AppDatabase, sessionId: string): boolean {
  return hasCurrentProjectionEligibility(db, sessionId)
}

/** Read the complete transcript from source facts; the retired transcript L1 is never consulted or rebuilt. */
function readSessionTranscriptProjectionImpl(db: AppDatabase, sessionId: string): SessionTranscriptProjectionRead {
  const cutover = getDbConnection(db).prepare(`SELECT write_mode FROM session_message_content_cutover WHERE session_id=?`)
    .get(sessionId) as { write_mode: string } | undefined
  const hasCanonicalBackedRows = getDbConnection(db).prepare(`SELECT 1 FROM messages
    WHERE session_id=? AND content_storage_state IN ('canonical-backed-dual-write','canonical-backed-only') LIMIT 1`).get(sessionId) !== undefined
  const legacySnapshot = hasCanonicalBackedRows && cutover?.write_mode === 'canonical'
    ? undefined
    : readLegacyMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
  // Consult persisted rejection before History replay. Stale O(1) metadata still routes to legacy and queues revalidation.
  if (legacySnapshot?.every(({ role }) => role === 'user' || role === 'assistant')) {
    const rejectionVerdict = consultProjectionRejection(db, sessionId, legacySnapshot)
    if (rejectionVerdict) {
      if (rejectionVerdict === 'stale') enqueueSessionProjectionRevalidation(db, sessionId, { stale: true })
      return { source: 'legacy', messages: legacySnapshot, reason: 'projection-rejected' }
    }
  }
  const canonicalMode = hasCanonicalBackedRows && cutover?.write_mode === 'canonical'
  const legacyMessages = canonicalMode ? undefined : legacySnapshot ?? readLegacyMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
  if (legacyMessages?.some(({ role }) => role !== 'user' && role !== 'assistant')) {
    return { source: 'legacy', messages: legacyMessages, reason: 'field-not-eligible' }
  }
  let canonical: ReturnType<SqliteAgentHistory['readCanonicalSessionTranscript']> |
    ReturnType<SqliteAgentHistory['readCanonicalSessionTranscriptForShadow']> | undefined
  try {
    const history = new SqliteAgentHistory(getDbConnection(db))
    if (canonicalMode) {
      canonical = history.readCanonicalSessionTranscriptForShadow(sessionId)
    } else {
      const conn = getDbConnection(db)
      canonical = runInTransaction(conn, () => {
        const verified = history.readCanonicalSessionTranscript(sessionId, legacyMessages!.map(({ id, role, content, timestamp }) => ({
          id, role: role as 'user' | 'assistant', content, timestamp
        })))
        if (verified.kind === 'matched') {
          publishTranscriptParityProof(db, sessionId, verified, computeLegacyProjectionDigest(legacyMessages!))
        }
        return verified
      })
    }
    if (canonical.kind === 'matched' && canonicalMode) {
      history.validateCanonicalSessionSourceTruthSpills(sessionId)
      const projected = mergeCanonicalBackedBodies(db, sessionId, canonical.messages)
      if (projected) return { source: 'canonical:L2', messages: projected, replayedEvents: canonical.eventCount }
      if (hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return { source: 'legacy', messages: readLegacyMessages(db, sessionId, Number.MAX_SAFE_INTEGER), reason: 'canonical-backed-identity-mismatch' }
    }
    if (canonical.kind === 'matched') {
      const projected = mergeCanonicalBodies(canonical.messages, readLegacyMessageSkeletons(db, sessionId))
      if (projected) return { source: 'canonical:L2', messages: projected, replayedEvents: canonical.eventCount }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE') throw error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SPILL_CONTENT_UNAVAILABLE') {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE', { cause: error })
    }
    // Source replay failures retain the existing legacy fallback for non-canonical sessions.
  }
  if (canonicalMode) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  if (!legacyMessages) return { source: 'legacy', messages: [], reason: 'canonical-read-failed' }
  if (!canonical || canonical.kind === 'unavailable') {
    const reason = canonical?.kind === 'unavailable' ? canonical.reason : 'canonical-read-failed'
    // 任何 canonical 不可用形态（legacy-mismatch / snapshot-invalid / order-invalid …）都落
    // 负缓存 verdict：canonical 流当前不可信，读路径按结论路由（legacy 直返），后台重验裁决。
    // 仅 session-missing（会话不存在）不落。可回退 legacy 的会话（无 canonical-backed 行）才能落。
    if (reason !== 'session-missing' && reason !== 'history-absent' && !hasCanonicalBackedRows) {
      recordProjectionRejection(db, sessionId, reason, readProjectionO1Metadata(db, sessionId),
        computeLegacyProjectionDigest(legacyMessages))
    }
    if (hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    return { source: 'legacy', messages: legacyMessages, reason }
  }
  const projected = mergeCanonicalBodies(canonical.messages, legacyMessages)
  if (!projected && hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  return projected
    ? { source: 'canonical:L2', messages: projected, replayedEvents: canonical.eventCount }
    : { source: 'legacy', messages: legacyMessages, reason: 'message-identity-mismatch' }
}

/** Record the selected read owner and latency without retaining transcript content or arbitrary errors. */
export function readSessionTranscriptProjection(db: AppDatabase, sessionId: string): SessionTranscriptProjectionRead {
  const startedAt = performance.now()
  try {
    const result = readSessionTranscriptProjectionImpl(db, sessionId)
    try {
      logAgentEvent('info', 'session.transcript.read', {
        sessionId, consumer: 'transcript', source: result.source,
        outcome: result.source.startsWith('canonical:') ? 'canonical' : 'legacy',
        reason: result.source === 'legacy' ? result.reason : undefined,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt))
      })
    } catch { /* Observation logging cannot change a transcript read. */ }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    try {
      logAgentEvent('error', 'session.transcript.read', {
        sessionId, consumer: 'transcript', source: 'unavailable', outcome: 'failed',
        errorCode: message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE' ? message : 'TRANSCRIPT_READ_FAILED',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt))
      })
    } catch { /* Observation logging cannot change a transcript read. */ }
    throw error
  }
}

/**
 * Canonical write authority plus each row's explicit storage state authorizes reconstruction after
 * its legacy copy is cleared. Dual-write rows still require an exact body match; only rows explicitly
 * marked canonical-backed-only may omit that comparison.
 */
function mergeCanonicalBackedBodies(
  db: AppDatabase,
  sessionId: string,
  canonicalMessages: readonly import('../../src/shared/api').ClaudeChatMessageWithBlocks[]
): Message[] | undefined {
  const rows = getDbConnection(db).prepare(`SELECT id,content_storage_state,status FROM messages
    WHERE session_id=? ORDER BY sequence ASC`).all(sessionId) as Array<{ id: string; content_storage_state: string; status: string }>
  const storedMessages = readLegacyMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
  if (rows.length !== storedMessages.length) return undefined
  const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]))
  if (canonicalById.size !== canonicalMessages.length) return undefined
  const storedById = new Map(storedMessages.map((message) => [message.id, message]))
  const rowById = new Map(rows.map((row) => [row.id, row]))
  if (storedById.size !== rows.length || canonicalMessages.some((message) => typeof message.id !== 'string' || !rowById.has(message.id))) return undefined

  const projected: Message[] = []
  for (const stored of storedMessages) {
    const row = rowById.get(stored.id)
    if (!row) return undefined
    const canonical = canonicalById.get(stored.id)
    if (row.content_storage_state === 'canonical-backed-only' || row.content_storage_state === 'canonical-backed-dual-write') {
      if (!canonical || typeof canonical.id !== 'string' || (stored.role !== 'user' && stored.role !== 'assistant') || canonical.role !== stored.role ||
        typeof canonical.content !== 'string' || typeof canonical.timestamp !== 'number' || canonical.timestamp !== stored.timestamp ||
        !['sent', 'completed', 'failed', 'cancelled'].includes(row.status)) return undefined
      if (row.content_storage_state === 'canonical-backed-dual-write' && canonical.content !== stored.content) return undefined
      projected.push({ ...stored, id: canonical.id, role: canonical.role, content: canonical.content, timestamp: canonical.timestamp })
      continue
    }
    if (row.content_storage_state !== 'legacy') return undefined
    if (!canonical) {
      projected.push(stored)
      continue
    }
    if (canonical.role !== stored.role || canonical.content !== stored.content || canonical.timestamp !== stored.timestamp) return undefined
    projected.push({ ...stored, content: canonical.content, timestamp: canonical.timestamp })
  }
  return projected
}

/** Read-only inventory check for a canonical-owned session; it never seeds projection caches. */
export function canonicalBackedSessionProjectionMatches(
  db: AppDatabase,
  sessionId: string,
  canonicalMessages: readonly import('../../src/shared/api').ClaudeChatMessageWithBlocks[]
): boolean {
  return mergeCanonicalBackedBodies(db, sessionId, canonicalMessages) !== undefined
}

/** Resolve one persisted message body from the canonical session projection when its row is canonical-backed. */
export function getProjectedMessage(db: AppDatabase, messageId: string): Message | undefined {
  const stored = readLegacyMessage(db, messageId)
  if (!stored) return undefined
  return resolveSelectedMessageBodies(db, [stored], (id) => readSessionTranscriptProjection(db, id))[0]
}

/** Resolve a sequence-selected context in one transcript read, retaining selection/order from SQLite. */
export function getProjectedTurnContext(
  db: AppDatabase,
  sessionId: string,
  boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined,
  excludeMessageIds: string[]
): Message[] {
  const selected = selectTurnContext(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
  return resolveSelectedMessageBodies(db, selected, (id) => readSessionTranscriptProjection(db, id))
}

/** Preserve the legacy ascending sequence/limit/offset contract for whole-session consumers. */
export function getProjectedMessages(db: AppDatabase, sessionId: string, limit = 500, offset = 0): Message[] {
  return resolveSelectedMessageBodies(db, readLegacyMessages(db, sessionId, limit, offset), (id) => readSessionTranscriptProjection(db, id))
}

/** Preserve the API context baseline's latest-N window and sequence ordering for renderer readers. */
export function getProjectedApiContextBaseline(db: AppDatabase, sessionId: string, limit = 500): ApiContextBaselineResult {
  const baseline = readLegacyApiContextBaseline(db, sessionId, limit)
  const projected = resolveSelectedMessageBodies(db, baseline.entries.map(({ message }) => message), (id) => readSessionTranscriptProjection(db, id))
  const projectedById = new Map(projected.map((message) => [message.id, message]))
  return {
    ...baseline,
    entries: baseline.entries.map((entry) => {
      const message = projectedById.get(entry.message.id)
      if (!message) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return { ...entry, message }
    })
  }
}

/** Preserve route-window selection while allowing canonical-backed-only bodies to qualify. */
export function getProjectedRecentTurnRoutingMessages(
  db: AppDatabase,
  sessionId: string,
  limit = 50,
  boundarySequence?: number,
  excludeMessageIds: string[] = []
): Array<{ role: 'user' | 'assistant'; content: string }> {
  let canonicalById: Map<string, Message> | undefined
  return selectRecentTurnRoutingMessages(db, {
    sessionId, limit, boundarySequence, excludeMessageIds,
    resolveBody: (candidate) => {
      if (candidate.contentStorageState === 'canonical-backed-dual-write' || candidate.contentStorageState === 'canonical-backed-only') {
        if (candidate.writeMode !== 'canonical') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        if (!canonicalById) {
          const transcript = readSessionTranscriptProjection(db, sessionId)
          if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
        }
        const resolved = canonicalById.get(candidate.message.id)
        if (!resolved) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        return resolved.content
      }
      if (candidate.contentStorageState !== 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return candidate.message.content
    }
  })
}

/** Retry selection preserves turn/sequence rules, then resolves both bodies before returning context. */
export function resolveProjectedRetryContext(
  db: AppDatabase,
  sessionId: string,
  failedAssistantMessageId: string
): RetryContextTarget | null {
  const selected = readLegacyRetryContext(db, sessionId, failedAssistantMessageId, { allowEmptyContent: true })
  if (!selected) return null
  const [failedAssistant, currentUser] = resolveSelectedMessageBodies(db, [selected.failedAssistant.message, selected.currentUser.message], (id) => readSessionTranscriptProjection(db, id))
  if (!failedAssistant || failedAssistant.sessionId !== sessionId || failedAssistant.role !== 'assistant' || failedAssistant.status !== 'failed' ||
    !currentUser || currentUser.sessionId !== sessionId || currentUser.role !== 'user' || !currentUser.content.trim()) return null
  return {
    ...selected,
    failedAssistant: { ...selected.failedAssistant, message: failedAssistant },
    currentUser: { ...selected.currentUser, message: currentUser }
  }
}

/** Sequence-page counterpart used by exports and capabilities; preserves cursor and sequence-gap contracts. */
export function getProjectedMessagesPageWithSequence(
  db: AppDatabase,
  sessionId: string,
  fromSequence: number,
  pageSize: number
): MessagesPageWithSequence {
  const page = readLegacyMessagesPageWithSequence(db, sessionId, fromSequence, pageSize)
  if (page.rows.length === 0) return page
  const conn = getDbConnection(db)
  if (typeof conn.prepare !== 'function') return page
  const ids = page.rows.map(({ message }) => message.id)
  const states = conn.prepare(`SELECT messages.id,messages.content_storage_state,cutover.write_mode FROM messages
    LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
    WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, ...ids) as Array<{ id: string; content_storage_state: string; write_mode: string | null }>
  const stateById = new Map(states.map((row) => [row.id, row.content_storage_state]))
  if (states.some((row) => row.content_storage_state !== 'legacy' && row.write_mode !== 'canonical')) {
    throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  }
  if (!page.rows.some(({ message }) => stateById.get(message.id) !== 'legacy')) return page
  const transcript = readSessionTranscriptProjection(db, sessionId)
  if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  const messagesById = new Map(transcript.messages.map((message) => [message.id, message]))
  return {
    ...page,
    rows: page.rows.map((entry) => {
      if (stateById.get(entry.message.id) === 'legacy') return entry
      const message = messagesById.get(entry.message.id)
      if (!message) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return { ...entry, message }
    })
  }
}

/** Search corpus counterpart; retains the ascending sequence cursor and filters queued rows in SQL. */
export function getProjectedSearchCorpusPage(
  db: AppDatabase,
  sessionId: string,
  fromSequence: number,
  pageSize?: number
): SearchCorpusPage {
  const page = readLegacySearchCorpusPage(db, sessionId, fromSequence, pageSize)
  if (page.entries.length === 0) return page
  const conn = getDbConnection(db)
  if (typeof conn.prepare !== 'function') return page
  const ids = page.entries.map(({ message }) => message.id)
  const states = conn.prepare(`SELECT messages.id,messages.content_storage_state,cutover.write_mode
    FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
    WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, ...ids) as Array<{ id: string; content_storage_state: string; write_mode: string | null }>
  const backedIds = new Set(states.filter((row) => row.write_mode === 'canonical' &&
    ['canonical-backed-dual-write', 'canonical-backed-only'].includes(row.content_storage_state)).map(({ id }) => id))
  if (states.some((row) => ['canonical-backed-dual-write', 'canonical-backed-only'].includes(row.content_storage_state) && row.write_mode !== 'canonical')) {
    throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  }
  if (backedIds.size === 0) return page
  const transcript = readSessionTranscriptProjection(db, sessionId)
  if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  const messagesById = new Map(transcript.messages.map((message) => [message.id, message]))
  return {
    ...page,
    entries: page.entries.map((entry) => {
      if (!backedIds.has(entry.message.id)) return entry
      const message = messagesById.get(entry.message.id)
      if (!message) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return { ...entry, message }
    })
  }
}

/** Search legacy matches plus every canonical-backed row, then apply SQLite LIKE to its authoritative body. */
export function searchProjectedMessages(db: AppDatabase, query: string, activeProfileId: string, limit = 50): MessageSearchHit[] {
  const q = query.trim()
  if (!q || limit === 0) return []
  const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const likePattern = `%${escaped}%`
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const candidates = conn.prepare(`SELECT m.id,m.session_id,m.content,m.content_storage_state,cutover.write_mode,
        s.name AS session_name,m.timestamp
      FROM messages m
      JOIN sessions s ON s.id=m.session_id
      LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=m.session_id
      WHERE (m.content LIKE ? ESCAPE '\\' OR
        m.content_storage_state IN ('canonical-backed-dual-write','canonical-backed-only'))
        AND (s.work_dir_profile_id IS NULL OR s.work_dir_profile_id=?)
      AND (s.ownership IS NULL OR s.ownership!='internal')
      ORDER BY m.timestamp DESC`).iterate(likePattern, activeProfileId) as Iterable<{
        id: string; session_id: string; content: string; content_storage_state: string; write_mode: string | null
        session_name: string; timestamp: number
      }>
    const transcriptBySession = new Map<string, Map<string, Message>>()
    const results: MessageSearchHit[] = []
    for (const candidate of candidates) {
      let content = candidate.content
      let canonicalBacked = false
      if (['canonical-backed-dual-write', 'canonical-backed-only'].includes(candidate.content_storage_state)) {
        canonicalBacked = true
        if (candidate.write_mode !== 'canonical') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        let messagesById = transcriptBySession.get(candidate.session_id)
        if (!messagesById) {
          const transcript = readSessionTranscriptProjection(db, candidate.session_id)
          if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          messagesById = new Map(transcript.messages.map((message) => [message.id, message]))
          transcriptBySession.set(candidate.session_id, messagesById)
        }
        const projected = messagesById.get(candidate.id)
        if (!projected) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        content = projected.content
      }
      // Legacy candidates were already selected by SQLite LIKE above. Canonical bodies are in
      // the detached transcript cache, so preserve SQLite's ASCII-only LIKE folding without
      // binding each potentially multi-megabyte body back through SQLite once per hit.
      if (canonicalBacked && !sqliteLikeContainsLiteral(content, q)) continue
      results.push({ messageId: candidate.id, sessionId: candidate.session_id, content, sessionName: candidate.session_name,
        ...(canonicalBacked ? { requiresProjectionPreparation: true } : {}) })
      if (limit > 0 && results.length >= limit) break
    }
    return results
  })
}

function mergeCanonicalBodies(canonicalMessages: readonly import('../../src/shared/api').ClaudeChatMessageWithBlocks[],
  skeletons: ReadonlyArray<Omit<Message, 'content'>>): Message[] | undefined {
  if (canonicalMessages.length !== skeletons.length) return undefined
  const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]))
  const projected: Message[] = []
  for (const legacy of skeletons) {
    const message = canonicalById.get(legacy.id)
    if (!message || message.id !== legacy.id || message.role !== legacy.role || typeof message.content !== 'string' ||
      typeof message.timestamp !== 'number') return undefined
    // Canonical owns stable identity, role, body and timestamp. UI/control fields remain on
    // the legacy message skeleton until their individual mappings pass the P-2 field matrix.
    projected.push({ ...legacy, id: message.id, role: message.role, content: message.content, timestamp: message.timestamp })
  }
  return projected
}

/**
 * Cheap L1 fast path only: a matched cached projection with live eligibility. Never performs
 * an L2 full legacy scan; the terminal checkpoint and the explicit refresh build on it.
 */
export function refreshSessionTranscriptProjectionFastPath(db: AppDatabase, sessionId: string): boolean {
  return refreshValidatedProjectionFastPath(db, sessionId)
}

/** Best-effort source-fenced parity proof refresh; it never reads or writes the retired transcript cache. */
export function refreshSessionTranscriptParityProof(db: AppDatabase, sessionId: string): boolean {
  try {
    const history = new SqliteAgentHistory(getDbConnection(db))
    if (refreshSessionTranscriptProjectionFastPath(db, sessionId)) {
      // A live matched projection supersedes any earlier mismatch verdict (P0-④ explicit clear).
      clearProjectionRejection(db, sessionId)
      return true
    }
    const legacyMessages = readLegacyMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
    if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) return false
    const verified = history.readCanonicalSessionTranscript(sessionId, legacyMessages.map(({ id, role, content, timestamp }) => ({
      id, role: role as 'user' | 'assistant', content, timestamp
    })))
    if (verified.kind !== 'matched' || !mergeCanonicalBodies(verified.messages, readLegacyMessageSkeletons(db, sessionId))) {
      if (verified.kind === 'unavailable' && verified.reason === 'legacy-mismatch') {
        recordProjectionRejection(db, sessionId, verified.reason, readProjectionO1Metadata(db, sessionId),
          computeLegacyProjectionDigest(legacyMessages))
        // P0-③: a failed checkpoint registers background revalidation instead of letting the
        // next read re-pay the full compare.
        enqueueSessionProjectionRevalidation(db, sessionId)
      }
      return false
    }
    const conn = getDbConnection(db)
    return runInTransaction(conn, () => {
      const published = publishTranscriptParityProof(db, sessionId, verified, computeLegacyProjectionDigest(legacyMessages))
      if (published) clearProjectionRejection(db, sessionId)
      return published
    })
  } catch {
    return false
  }
}


/** Preserve the existing cursor/page contract while sourcing eligible message bodies from canonical History. */
export function getProjectedChatMessagePage(
  db: AppDatabase,
  sessionId: string,
  beforeSequence: number | null | undefined,
  limit?: number
): ChatMessagePage {
  const page = readLegacyChatMessagePage(db, sessionId, beforeSequence, limit)
  if (page.entries.length === 0) return page
  const conn = getDbConnection(db)
  const writeMode = conn.prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?')
    .get(sessionId) as { write_mode: string } | undefined
  if (writeMode?.write_mode !== 'canonical' && hasCurrentProjectionEligibility(db, sessionId)) {
    const pageIds = page.entries.map(({ message }) => message.id)
    const states = conn.prepare(`SELECT id,content_storage_state FROM messages WHERE session_id=? AND id IN (${pageIds.map(() => '?').join(',')})`)
      .all(sessionId, ...pageIds) as Array<{ id: string; content_storage_state: string }>
    if (states.length === pageIds.length && states.every(({ content_storage_state }) => content_storage_state === 'legacy')) return page
  }
  // Page-local cache hits cannot prove the body source for every requested ID. The transcript
  // reader validates the legacy cache against the complete legacy view, or replays History for
  // canonical-backed bodies, before we apply this page's cursor selection.
  const transcript = readSessionTranscriptProjection(db, sessionId)
  if (transcript.source === 'legacy') return page
  const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
  const entries = page.entries.map((entry) => {
    const canonical = canonicalById.get(entry.message.id)
    return canonical ? { ...entry, message: canonical } : entry
  })
  return { ...page, entries }
}
