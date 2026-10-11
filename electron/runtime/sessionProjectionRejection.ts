import { createHash } from 'node:crypto'
import type { AppDatabase } from '../database'
import type { Message } from '../../src/shared/domainTypes'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

/**
 * P0-② negative-cache verdict row (plan §5 ①/②, v4 M1). The synchronous read path consults
 * this row instead of re-paying the full canonical rebuild+compare. Keying follows M1: O(1)
 * metadata (event_count + watermark ids + legacy row count/max rowid) is checked first, then
 * the legacy body digest that getMessages already had in memory (cheap hash, no fold). A
 * canonical-side content fingerprint is only computed by the background revalidator (P0-③).
 */
export type ProjectionRejectionRow = Readonly<{
  sessionId: string
  sessionGeneration: string
  fingerprint: string
  watermarkEventId: string | null
  watermarkInvocationId: string | null
  eventCount: number
  legacyMessageCount: number
  legacyMaxRowid: number
  legacyDigest: string
  attempts: number
  retryAfter: number
  lastReason: string
  permanent: boolean
  staleMetadata: boolean
  updatedAt: number
}>

export type ProjectionO1Metadata = Readonly<{
  eventCount: number
  watermarkEventId: string | null
  watermarkInvocationId: string | null
  legacyMessageCount: number
  legacyMaxRowid: number
}>

const REJECTION_RETRY_BASE_MS = 30 * 1000
const REJECTION_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000

/** attempts=1 → 30s, then exponential; capped at the plan's 7-day ceiling. */
export function projectionRejectionBackoffDelayMs(attempts: number): number {
  if (attempts <= 1) return REJECTION_RETRY_BASE_MS
  return Math.min(REJECTION_RETRY_MAX_MS, REJECTION_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 12))
}

/**
 * Stable digest over the legacy bodies the read path already loaded. Only fields the exact
 * L2 comparison can see participate; key order is normalized so equivalent rows agree.
 */
export function computeLegacyProjectionDigest(messages: readonly Message[]): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]))
    : value
  const payload = JSON.stringify(messages.map((message) => stable(message)))
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** O(1) change-detection metadata for one session; every probe is an indexed COUNT/MAX lookup. */
export function readProjectionO1Metadata(db: AppDatabase, sessionId: string): ProjectionO1Metadata {
  const conn = getDbConnection(db)
  const row = conn.prepare(`SELECT
    (SELECT COUNT(*) FROM agent_history_events WHERE session_id=?) AS eventCount,
    (SELECT event_id FROM agent_history_events WHERE session_id=? ORDER BY session_seq DESC LIMIT 1) AS watermarkEventId,
    (SELECT invocation_id FROM agent_history_events WHERE session_id=? ORDER BY session_seq DESC LIMIT 1) AS watermarkInvocationId,
    (SELECT COUNT(*) FROM messages WHERE session_id=?) AS legacyMessageCount,
    (SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE session_id=?) AS legacyMaxRowid
  `).get(sessionId, sessionId, sessionId, sessionId, sessionId) as {
    eventCount: number; watermarkEventId: string | null; watermarkInvocationId: string | null
    legacyMessageCount: number; legacyMaxRowid: number
  }
  return {
    eventCount: Number(row.eventCount ?? 0),
    watermarkEventId: row.watermarkEventId ?? null,
    watermarkInvocationId: row.watermarkInvocationId ?? null,
    legacyMessageCount: Number(row.legacyMessageCount ?? 0),
    legacyMaxRowid: Number(row.legacyMaxRowid ?? 0)
  }
}

export function getProjectionRejection(db: AppDatabase, sessionId: string): ProjectionRejectionRow | undefined {
  const row = getDbConnection(db).prepare(`SELECT session_id, session_generation, fingerprint, watermark_event_id, watermark_invocation_id,
    event_count, legacy_message_count, legacy_max_rowid, legacy_digest, attempts, retry_after, last_reason, permanent, stale_metadata, updated_at
    FROM canonical_session_projection_rejections WHERE session_id=?`).get(sessionId) as {
    session_id: string; session_generation: string; fingerprint: string; watermark_event_id: string | null; watermark_invocation_id: string | null
    event_count: number; legacy_message_count: number; legacy_max_rowid: number; legacy_digest: string; attempts: number; retry_after: number
    last_reason: string; permanent: number; stale_metadata: number; updated_at: number
  } | undefined
  if (!row) return undefined
  return {
    sessionId: row.session_id,
    sessionGeneration: row.session_generation,
    fingerprint: row.fingerprint,
    watermarkEventId: row.watermark_event_id,
    watermarkInvocationId: row.watermark_invocation_id,
    eventCount: Number(row.event_count),
    legacyMessageCount: Number(row.legacy_message_count),
    legacyMaxRowid: Number(row.legacy_max_rowid),
    legacyDigest: row.legacy_digest,
    attempts: Number(row.attempts),
    retryAfter: Number(row.retry_after),
    lastReason: row.last_reason,
    permanent: Number(row.permanent) === 1,
    staleMetadata: Number(row.stale_metadata) === 1,
    updatedAt: Number(row.updated_at)
  }
}

/** Persist a fresh mismatch verdict; the full compare has already been paid by the caller. */
export function recordProjectionRejection(db: AppDatabase, sessionId: string, reason: string,
  o1: ProjectionO1Metadata, legacyDigest: string): void {
  const now = Date.now()
  const retryAfter = now + projectionRejectionBackoffDelayMs(1)
  getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_rejections(
    session_id, session_generation, fingerprint, watermark_event_id, watermark_invocation_id,
    event_count, legacy_message_count, legacy_max_rowid, legacy_digest, attempts, retry_after, last_reason, permanent, stale_metadata, updated_at
  ) VALUES(?, (SELECT generation FROM sessions WHERE id=?), '', ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    fingerprint='', watermark_event_id=excluded.watermark_event_id, watermark_invocation_id=excluded.watermark_invocation_id,
    event_count=excluded.event_count, legacy_message_count=excluded.legacy_message_count, legacy_max_rowid=excluded.legacy_max_rowid,
    legacy_digest=excluded.legacy_digest,
    attempts=canonical_session_projection_rejections.attempts + 1,
    retry_after=?, last_reason=excluded.last_reason, permanent=0, stale_metadata=0, updated_at=excluded.updated_at
  `).run(
    sessionId, sessionId, o1.watermarkEventId, o1.watermarkInvocationId, o1.eventCount, o1.legacyMessageCount, o1.legacyMaxRowid,
    legacyDigest, retryAfter, reason, now, retryAfter
  )
}

/** Flag a verdict whose keys no longer match live state; the background queue revalidates it. */
export function markProjectionRejectionStale(db: AppDatabase, sessionId: string): void {
  getDbConnection(db).prepare(`UPDATE canonical_session_projection_rejections
    SET stale_metadata=1, updated_at=? WHERE session_id=?`).run(Date.now(), sessionId)
}

export function clearProjectionRejection(db: AppDatabase, sessionId: string): void {
  getDbConnection(db).prepare('DELETE FROM canonical_session_projection_rejections WHERE session_id=?').run(sessionId)
}

export type ProjectionRejectionVerdict = 'hit' | 'stale'

/**
 * Consult the persisted verdict (v4 M1): a hit routes the read to legacy immediately; a stale
 * verdict (O(1) metadata drift or a changed legacy body) still routes to legacy immediately but
 * flags the row for background revalidation — the read path never waits on a full compare.
 */
export function consultProjectionRejection(db: AppDatabase, sessionId: string,
  legacyMessages: readonly Message[]): ProjectionRejectionVerdict | undefined {
  const rejection = getProjectionRejection(db, sessionId)
  if (!rejection) return undefined
  const o1 = readProjectionO1Metadata(db, sessionId)
  const metadataUnchanged = rejection.eventCount === o1.eventCount &&
    rejection.watermarkEventId === o1.watermarkEventId &&
    rejection.watermarkInvocationId === o1.watermarkInvocationId &&
    rejection.legacyMessageCount === o1.legacyMessageCount &&
    rejection.legacyMaxRowid === o1.legacyMaxRowid
  if (metadataUnchanged && rejection.legacyDigest === computeLegacyProjectionDigest(legacyMessages) && !rejection.staleMetadata) {
    return 'hit'
  }
  if (!rejection.staleMetadata) runInTransaction(getDbConnection(db), () => markProjectionRejectionStale(db, sessionId))
  return 'stale'
}
