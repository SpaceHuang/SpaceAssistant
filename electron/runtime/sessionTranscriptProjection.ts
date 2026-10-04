import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { getApiContextBaseline as getStoredApiContextBaseline, getChatMessagePage, getMessage as getStoredMessage, getMessageSkeletons, getMessages, getMessagesPageWithSequence as getStoredMessagesPageWithSequence, getSearchCorpusPage as getStoredSearchCorpusPage, getTurnContext as getStoredTurnContext, iterateRecentTurnRoutingMessageCandidates, resolveRetryContext as resolveStoredRetryContext, type ApiContextBaselineResult, type ChatMessagePage, type MessageSearchHit, type MessagesPageWithSequence, type RetryContextTarget, type SearchCorpusPage } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { SqliteAgentHistory } from './sqliteAgentHistory'

export type SessionTranscriptProjectionRead =
  | Readonly<{ source: 'canonical:L1' | 'canonical:L2'; messages: readonly Message[]; replayedEvents: number }>
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

function hasSessionProjectionEligibility(db: AppDatabase, sessionId: string): boolean {
  try {
    return getDbConnection(db).prepare(`SELECT 1 FROM canonical_session_projection_eligibility eligibility
      JOIN sessions ON sessions.id=eligibility.session_id AND sessions.generation=eligibility.session_generation
      WHERE eligibility.session_id=?`).get(sessionId) !== undefined
  } catch { return false }
}

function markSessionProjectionEligible(db: AppDatabase, sessionId: string, generation: string): boolean {
  try {
    const result = getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_eligibility(session_id, session_generation, validated_at)
      VALUES(?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET session_generation=excluded.session_generation, validated_at=excluded.validated_at`)
      .run(sessionId, generation, Date.now())
    return Number(result.changes) > 0
  } catch { return false }
}

/** Read the complete transcript through the cache staircase, falling back per session on any ambiguity. */
export function readSessionTranscriptProjection(db: AppDatabase, sessionId: string): SessionTranscriptProjectionRead {
  const cutover = getDbConnection(db).prepare(`SELECT write_mode FROM session_message_content_cutover WHERE session_id=?`)
    .get(sessionId) as { write_mode: string } | undefined
  const hasCanonicalBackedRows = getDbConnection(db).prepare(`SELECT 1 FROM messages
    WHERE session_id=? AND content_storage_state IN ('canonical-backed-dual-write','canonical-backed-only') LIMIT 1`).get(sessionId) !== undefined
  let canonical: ReturnType<SqliteAgentHistory['readCanonicalSessionTranscriptWithCache']>
  try {
    const history = new SqliteAgentHistory(getDbConnection(db))
    canonical = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
    if (canonical.kind === 'matched' && cutover?.write_mode === 'canonical') {
      history.validateCanonicalSessionSourceTruthSpills(sessionId)
      const projected = mergeCanonicalBackedBodies(db, sessionId, canonical.messages)
      if (projected) return { source: `canonical:${canonical.source}`, messages: projected, replayedEvents: canonical.replayedEvents }
      if (hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return { source: 'legacy', messages: getMessages(db, sessionId, Number.MAX_SAFE_INTEGER), reason: 'canonical-backed-identity-mismatch' }
    }
    if (canonical.kind === 'matched' && hasSessionProjectionEligibility(db, sessionId)) {
      const skeletons = getMessageSkeletons(db, sessionId)
      const projected = mergeCanonicalBodies(canonical.messages, skeletons)
      if (projected) return { source: `canonical:${canonical.source}`, messages: projected, replayedEvents: canonical.replayedEvents }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE') throw error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SPILL_CONTENT_UNAVAILABLE') {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE', { cause: error })
    }
    // A cache read is fail-soft; continue by validating the full legacy transcript below.
  }

  // A canonical-backed session can rebuild a disposable L1 projection from History alone. Requiring
  // a legacy body as the L2 oracle here would reject the exact session whose body was reclaimed.
  if (hasCanonicalBackedRows && cutover?.write_mode === 'canonical') {
    try {
      const history = new SqliteAgentHistory(getDbConnection(db))
      const authoritative = history.readCanonicalSessionTranscriptForShadow(sessionId)
      if (authoritative.kind !== 'matched') throw new Error('canonical transcript unavailable')
      const projected = mergeCanonicalBackedBodies(db, sessionId, authoritative.messages)
      if (!projected) throw new Error('canonical transcript does not match message skeletons')
      history.writeCanonicalSessionCache({ ...authoritative, cacheKey: 'transcript', value: JSON.stringify(authoritative.messages) })
      return { source: 'canonical:L2', messages: projected, replayedEvents: authoritative.eventCount }
    } catch {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
  }

  const legacyMessages = getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
  if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) {
    return { source: 'legacy', messages: legacyMessages, reason: 'field-not-eligible' }
  }
  try {
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn)
    canonical = runInTransaction(conn, () => {
      const verified = history.readCanonicalSessionTranscript(sessionId, legacyMessages.map(({ id, role, content, timestamp }) => ({
        id, role: role as 'user' | 'assistant', content, timestamp
      })))
      if (verified.kind !== 'matched') return verified
      if (history.writeCanonicalSessionCache({ ...verified, cacheKey: 'transcript', value: JSON.stringify(verified.messages) })) {
        markSessionProjectionEligible(db, sessionId, verified.sessionGeneration)
      }
      return { kind: 'matched' as const, source: 'L2' as const, messages: verified.messages, replayedEvents: verified.eventCount, watermark: verified }
    })
  } catch {
    if (hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    return { source: 'legacy', messages: legacyMessages, reason: 'canonical-read-failed' }
  }
  if (canonical.kind === 'unavailable') {
    if (hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    return { source: 'legacy', messages: legacyMessages, reason: canonical.reason }
  }
  const projected = mergeCanonicalBodies(canonical.messages, legacyMessages)
  if (!projected && hasCanonicalBackedRows) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  return projected
    ? { source: `canonical:${canonical.source}`, messages: projected, replayedEvents: canonical.replayedEvents }
    : { source: 'legacy', messages: legacyMessages, reason: 'message-identity-mismatch' }
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
  const storedMessages = getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
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

/** Resolve one persisted message body from the canonical session projection when its row is canonical-backed. */
export function getProjectedMessage(db: AppDatabase, messageId: string): Message | undefined {
  const stored = getStoredMessage(db, messageId)
  if (!stored) return undefined
  return projectSelectedMessages(db, [stored])[0]
}

/** Resolve a sequence-selected context in one transcript read, retaining selection/order from SQLite. */
export function getProjectedTurnContext(
  db: AppDatabase,
  sessionId: string,
  boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined,
  excludeMessageIds: string[]
): Message[] {
  const selected = getStoredTurnContext(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
  return projectSelectedMessages(db, selected)
}

/** Preserve the legacy ascending sequence/limit/offset contract for whole-session consumers. */
export function getProjectedMessages(db: AppDatabase, sessionId: string, limit = 500, offset = 0): Message[] {
  return projectSelectedMessages(db, getMessages(db, sessionId, limit, offset))
}

/** Preserve the API context baseline's latest-N window and sequence ordering for renderer readers. */
export function getProjectedApiContextBaseline(db: AppDatabase, sessionId: string, limit = 500): ApiContextBaselineResult {
  const baseline = getStoredApiContextBaseline(db, sessionId, limit)
  const projected = projectSelectedMessages(db, baseline.entries.map(({ message }) => message))
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
  if (limit === 0) return []
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const selectedDescending: Array<{ role: 'user' | 'assistant'; content: string }> = []
    let canonicalById: Map<string, Message> | undefined
    for (const candidate of iterateRecentTurnRoutingMessageCandidates(db, sessionId, boundarySequence, excludeMessageIds)) {
      let content = candidate.message.content
      if (candidate.contentStorageState === 'canonical-backed-dual-write' || candidate.contentStorageState === 'canonical-backed-only') {
        if (candidate.writeMode !== 'canonical') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        if (!canonicalById) {
          const transcript = readSessionTranscriptProjection(db, sessionId)
          if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
          canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
        }
        const resolved = canonicalById.get(candidate.message.id)
        if (!resolved) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        content = resolved.content
      } else if (candidate.contentStorageState !== 'legacy') {
        throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      }
      if (!content.trim()) continue
      selectedDescending.push({ role: candidate.message.role as 'user' | 'assistant', content })
      if (limit > 0 && selectedDescending.length >= limit) break
    }
    return selectedDescending.reverse()
  })
}

function projectSelectedMessages(db: AppDatabase, selected: readonly Message[]): Message[] {
  if (selected.length === 0) return []
  const conn = getDbConnection(db)
  // Lightweight IPC test ports can omit SQLite; production AppDatabase always supplies prepare().
  if (typeof conn.prepare !== 'function') return [...selected]
  const sessionIds = new Set(selected.map(({ sessionId }) => sessionId))
  if (sessionIds.size !== 1) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  const sessionId = selected[0]!.sessionId
  const ids = selected.map(({ id }) => id)
  const states = conn.prepare(`SELECT messages.id,messages.content_storage_state,cutover.write_mode
    FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
    WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, ...ids) as Array<{ id: string; content_storage_state: string; write_mode: string | null }>
  const stateById = new Map(states.map((row) => [row.id, row]))
  for (const message of selected) {
    const state = stateById.get(message.id)
    if (!state || (state.content_storage_state !== 'legacy' &&
      !['canonical-backed-dual-write', 'canonical-backed-only'].includes(state.content_storage_state))) {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
    if (state.content_storage_state !== 'legacy' && state.write_mode !== 'canonical') {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
  }
  const backedIds = new Set(states.filter((row) => row.content_storage_state !== 'legacy').map(({ id }) => id))
  if (backedIds.size === 0) return [...selected]
  const transcript = readSessionTranscriptProjection(db, sessionId)
  if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
  return selected.map((message) => {
    if (!backedIds.has(message.id)) return message
    const resolved = canonicalById.get(message.id)
    if (!resolved) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    return resolved
  })
}

/** Retry selection preserves turn/sequence rules, then resolves both bodies before returning context. */
export function resolveProjectedRetryContext(
  db: AppDatabase,
  sessionId: string,
  failedAssistantMessageId: string
): RetryContextTarget | null {
  const selected = resolveStoredRetryContext(db, sessionId, failedAssistantMessageId, { allowEmptyContent: true })
  if (!selected) return null
  const [failedAssistant, currentUser] = projectSelectedMessages(db, [selected.failedAssistant.message, selected.currentUser.message])
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
  const page = getStoredMessagesPageWithSequence(db, sessionId, fromSequence, pageSize)
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
  const page = getStoredSearchCorpusPage(db, sessionId, fromSequence, pageSize)
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
    results.push({ messageId: candidate.id, sessionId: candidate.session_id, content, sessionName: candidate.session_name })
    if (limit > 0 && results.length >= limit) break
  }
  return results
}

function mergeCanonicalBodies(canonicalMessages: readonly import('../../src/shared/api').ClaudeChatMessageWithBlocks[],
  skeletons: readonly Message[]): Message[] | undefined {
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

/** Best-effort terminal/session-disposition checkpoint; it never performs an L2 full legacy scan. */
export function refreshSessionTranscriptProjectionCache(db: AppDatabase, sessionId: string): boolean {
  try {
    const history = new SqliteAgentHistory(getDbConnection(db))
    const canonical = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
    const skeletons = getMessageSkeletons(db, sessionId)
    if (canonical.kind === 'matched' && hasSessionProjectionEligibility(db, sessionId) && mergeCanonicalBodies(canonical.messages, skeletons)) return true
    const legacyMessages = getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
    if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) return false
    const verified = history.readCanonicalSessionTranscript(sessionId, legacyMessages.map(({ id, role, content, timestamp }) => ({
      id, role: role as 'user' | 'assistant', content, timestamp
    })))
    if (verified.kind !== 'matched' || !mergeCanonicalBodies(verified.messages, skeletons)) return false
    const conn = getDbConnection(db)
    return runInTransaction(conn, () => history.writeCanonicalSessionCache({ ...verified, cacheKey: 'transcript', value: JSON.stringify(verified.messages) }) &&
      markSessionProjectionEligible(db, sessionId, verified.sessionGeneration))
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
  const page = getChatMessagePage(db, sessionId, beforeSequence, limit)
  if (page.entries.length === 0) return page
  if (hasSessionProjectionEligibility(db, sessionId)) {
    try {
      const cached = new SqliteAgentHistory(getDbConnection(db)).readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
      if (cached.kind === 'matched') {
        const canonicalById = new Map(cached.messages.map((message) => [message.id, message]))
        const projected = page.entries.map((entry) => {
          const canonical = canonicalById.get(entry.message.id)
          if (!canonical || canonical.id !== entry.message.id || canonical.role !== entry.message.role || typeof canonical.content !== 'string' || typeof canonical.timestamp !== 'number') return undefined
          return { ...entry, message: { ...entry.message, id: canonical.id, role: canonical.role, content: canonical.content, timestamp: canonical.timestamp } }
        })
        if (projected.every((entry) => entry !== undefined)) return { ...page, entries: projected }
      }
    } catch { /* The marker is disposable; any cache ambiguity falls through to exact L2. */ }
  }
  // Page-local ID matches are insufficient: an older message outside this cursor page
  // may be missing from canonical History. L2 proves eligibility for the whole session.
  const transcript = readSessionTranscriptProjection(db, sessionId)
  if (transcript.source === 'legacy') return page
  const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
  const entries = page.entries.map((entry) => {
    const canonical = canonicalById.get(entry.message.id)
    return canonical ? { ...entry, message: canonical } : entry
  })
  return { ...page, entries }
}
