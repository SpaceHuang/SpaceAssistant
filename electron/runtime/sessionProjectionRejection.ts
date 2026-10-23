import { createHash } from 'node:crypto'
import type { AppDatabase } from '../database'
import type { Message } from '../../src/shared/domainTypes'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { encodeChatBodyV1 } from '../sessionStorage/domain/projectionSpec'
import { currentProcessGeneration } from '../database/processGeneration'
import { randomUUID } from 'node:crypto'
import { encodeProjectionScopeKey } from '../sessionStorage/domain/scopeKey'
import { createProjectionService, createSqliteProjectionStateStore } from '../sessionStorage/sqliteRuntimeBindings'

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
  const payload = encodeChatBodyV1(messages)
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
  const conn = getDbConnection(db)
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const state = createSqliteProjectionStateStore(db).get(sessionId, scopeKey)
  if (state?.status !== 'rejected' || !state.failureCaseJson || state.retryAfter === null) return undefined
  let failure: Record<string, unknown>
  try { failure = JSON.parse(state.failureCaseJson) as Record<string, unknown> } catch { return undefined }
  return {
    sessionId, sessionGeneration: state.sessionGeneration,
    fingerprint: typeof failure.fingerprint === 'string' ? failure.fingerprint : '',
    watermarkEventId: typeof failure.watermarkEventId === 'string' ? failure.watermarkEventId : null,
    watermarkInvocationId: typeof failure.watermarkInvocationId === 'string' ? failure.watermarkInvocationId : null,
    eventCount: Number(failure.eventCount ?? 0), legacyMessageCount: Number(failure.legacyMessageCount ?? 0),
    legacyMaxRowid: Number(failure.legacyMaxRowid ?? 0), legacyDigest: String(failure.legacyDigest ?? ''),
    attempts: state.attempts, retryAfter: state.retryAfter, lastReason: String(failure.lastReason ?? 'unknown'),
    permanent: failure.permanent === true, staleMetadata: failure.staleMetadata === true, updatedAt: state.updatedAt,
  }
}

/** Persisted rejection rows are the recovery source for the process-local revalidation queue. */
export function listProjectionRejectionWork(db: AppDatabase, now = Date.now(), limit = 4): Array<{ sessionId: string; stale: boolean }> {
  const boundedLimit = Math.max(1, Math.min(64, Math.trunc(limit)))
  const conn = getDbConnection(db)
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const store = createSqliteProjectionStateStore(db)
  return store.listDueWork(now, 256, currentProcessGeneration(conn)).filter((work) => work.scopeKey === scopeKey)
    .flatMap((work) => {
      const state = store.get(work.sessionId, scopeKey)
      return state?.status === 'rejected' ? [{ sessionId: work.sessionId, stale: (() => {
        try { return (JSON.parse(state.failureCaseJson ?? '{}') as Record<string, unknown>).staleMetadata === true } catch { return false }
      })() }]
        : state?.status === 'invalid' && state.failureCaseJson?.includes('"staleMetadata":true')
          ? [{ sessionId: work.sessionId, stale: true }] : []
    }).slice(0, boundedLimit)
}

/** Persist a fresh mismatch verdict; the full compare has already been paid by the caller. */
export function recordProjectionRejection(db: AppDatabase, sessionId: string, reason: string,
  o1: ProjectionO1Metadata, legacyDigest: string, metadata: { fingerprint?: string; permanent?: boolean } = {}): void {
  const now = Date.now()
  const existing = getProjectionRejection(db, sessionId)
  const attempts = (existing?.attempts ?? 0) + 1
  const retryAfter = now + (metadata.permanent ? REJECTION_RETRY_MAX_MS : projectionRejectionBackoffDelayMs(attempts))
  // S6: drop the session's cached transcript so no warm L1 hit can bypass the verdict before
  // the background revalidator re-adjudicates the divergence.
  getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(sessionId)
  publishRejectedState(db, sessionId, { fingerprint: metadata.fingerprint ?? '', watermarkEventId: o1.watermarkEventId,
    watermarkInvocationId: o1.watermarkInvocationId, eventCount: o1.eventCount, legacyMessageCount: o1.legacyMessageCount,
    legacyMaxRowid: o1.legacyMaxRowid, legacyDigest, lastReason: reason, permanent: metadata.permanent === true, staleMetadata: false }, attempts, retryAfter)
}

/** Flag a verdict whose keys no longer match live state; the background queue revalidates it. */
export function markProjectionRejectionStale(db: AppDatabase, sessionId: string): void {
  const conn = getDbConnection(db)
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const store = createSqliteProjectionStateStore(db)
  const state = store.get(sessionId, scopeKey)
  if (!state || state.status !== 'rejected' || !state.failureCaseJson) return
  let failure: Record<string, unknown>
  try { failure = JSON.parse(state.failureCaseJson) as Record<string, unknown> } catch { return }
  failure.staleMetadata = true
  const service = createProjectionService(store, { processGeneration: () => currentProcessGeneration(conn), connectionEpoch: () => 0,
    createToken: randomUUID, now: Date.now })
  service.scheduleRejectedRetry({ sessionId, scopeKey, sessionGeneration: state.sessionGeneration,
    failureCaseJson: JSON.stringify(failure), retryAfter: Date.now() })
}

export function clearProjectionRejection(db: AppDatabase, sessionId: string): void {
  const store = createSqliteProjectionStateStore(db)
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const state = store.get(sessionId, scopeKey)
  if (state?.status === 'rejected') store.invalidateInTransaction({ sessionId, scopeKey, sessionGeneration: state.sessionGeneration, now: Date.now() })
}

function publishRejectedState(db: AppDatabase, sessionId: string, failure: Record<string, unknown>, attempts: number, retryAfter: number): void {
  const conn = getDbConnection(db)
  const session = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
  if (!session) return
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const store = createSqliteProjectionStateStore(db)
  const service = createProjectionService(store, { processGeneration: () => currentProcessGeneration(conn), connectionEpoch: () => 0,
    createToken: randomUUID, now: Date.now })
  const current = store.get(sessionId, scopeKey)
  if (current?.status === 'valid' || current?.status === 'rejected') {
    store.invalidateInTransaction({ sessionId, scopeKey, sessionGeneration: session.generation, now: Date.now() })
  } else if (!current) service.ensureInvalid({ sessionId, scopeKey, sessionGeneration: session.generation })
  const lease = service.beginRebuild({ sessionId, scopeKey, sessionGeneration: session.generation })
  if (!lease) return
  service.reject(lease, { failureCaseJson: JSON.stringify(failure), attempts, retryAfter })
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
