import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { getChatMessagePage, getMessageSkeletons, getMessages, type ChatMessagePage } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { SqliteAgentHistory } from './sqliteAgentHistory'

export type SessionTranscriptProjectionRead =
  | Readonly<{ source: 'canonical:L1' | 'canonical:L2'; messages: readonly Message[]; replayedEvents: number }>
  | Readonly<{ source: 'legacy'; messages: readonly Message[]; reason: string }>

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
  let canonical: ReturnType<SqliteAgentHistory['readCanonicalSessionTranscriptWithCache']>
  try {
    const history = new SqliteAgentHistory(getDbConnection(db))
    canonical = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
    if (canonical.kind === 'matched' && hasSessionProjectionEligibility(db, sessionId)) {
      const skeletons = getMessageSkeletons(db, sessionId)
      const projected = mergeCanonicalBodies(canonical.messages, skeletons)
      if (projected) return { source: `canonical:${canonical.source}`, messages: projected, replayedEvents: canonical.replayedEvents }
    }
  } catch {
    // A cache read is fail-soft; continue by validating the full legacy transcript below.
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
    return { source: 'legacy', messages: legacyMessages, reason: 'canonical-read-failed' }
  }
  if (canonical.kind === 'unavailable') return { source: 'legacy', messages: legacyMessages, reason: canonical.reason }
  const projected = mergeCanonicalBodies(canonical.messages, legacyMessages)
  return projected
    ? { source: `canonical:${canonical.source}`, messages: projected, replayedEvents: canonical.replayedEvents }
    : { source: 'legacy', messages: legacyMessages, reason: 'message-identity-mismatch' }
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
