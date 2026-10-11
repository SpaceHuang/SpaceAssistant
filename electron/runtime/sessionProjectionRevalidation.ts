import { createHash } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getMessages, getMessageSkeletons } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import {
  clearProjectionRejection, computeLegacyProjectionDigest, getProjectionRejection,
  projectionRejectionBackoffDelayMs, readProjectionO1Metadata
} from './sessionProjectionRejection'
import { drainSessionProjectionRevalidationQueue, enqueueSessionProjectionRevalidation } from './sessionProjectionRevalidationQueue'
import { hasSessionProjectionEligibility, markSessionProjectionEligible, refreshSessionTranscriptProjectionFastPath } from './sessionTranscriptProjection'

/**
 * P0-③ background revalidation executor (plan §4 保障链 / §5 ③). Full rebuild+compare runs
 * here, budgeted and yielding between sessions, never inside a synchronous read. P0 keeps this
 * on the main process with task-level yields; P3 upgrades the execution to worker_threads.
 */

const PERMANENT_AFTER_ATTEMPTS = 5
const PERMANENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Aggregated canonical event-range fingerprint (v4 B1); only the revalidator computes it. */
export function computeCanonicalProjectionFingerprint(db: AppDatabase, sessionId: string): string {
  const hash = createHash('sha256')
  for (const row of getDbConnection(db).prepare(
    'SELECT payload_json FROM agent_history_events WHERE session_id=? ORDER BY session_seq ASC'
  ).iterate(sessionId) as Iterable<{ payload_json: string }>) {
    hash.update(row.payload_json).update('\n')
  }
  return hash.digest('hex')
}

function recordRevalidationFailure(db: AppDatabase, sessionId: string): void {
  const existing = getProjectionRejection(db, sessionId)
  const o1 = readProjectionO1Metadata(db, sessionId)
  const legacyDigest = computeLegacyProjectionDigest(getMessages(db, sessionId, Number.MAX_SAFE_INTEGER))
  const fingerprint = computeCanonicalProjectionFingerprint(db, sessionId)
  const attempts = (existing?.attempts ?? 0) + 1
  const fingerprintUnchanged = Boolean(existing?.fingerprint) && existing!.fingerprint === fingerprint
  const permanent = existing?.permanent === true || (fingerprintUnchanged && attempts >= PERMANENT_AFTER_ATTEMPTS)
  const now = Date.now()
  const retryAfter = permanent ? now + PERMANENT_TTL_MS : now + projectionRejectionBackoffDelayMs(attempts)
  getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_rejections(
    session_id, session_generation, fingerprint, watermark_event_id, watermark_invocation_id,
    event_count, legacy_message_count, legacy_max_rowid, legacy_digest, attempts, retry_after, last_reason,
    permanent, stale_metadata, updated_at
  ) VALUES(?, (SELECT generation FROM sessions WHERE id=?), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy-mismatch', ?, 0, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    fingerprint=excluded.fingerprint, watermark_event_id=excluded.watermark_event_id, watermark_invocation_id=excluded.watermark_invocation_id,
    event_count=excluded.event_count, legacy_message_count=excluded.legacy_message_count, legacy_max_rowid=excluded.legacy_max_rowid,
    legacy_digest=excluded.legacy_digest, attempts=excluded.attempts, retry_after=excluded.retry_after,
    last_reason=excluded.last_reason, permanent=excluded.permanent, stale_metadata=0, updated_at=excluded.updated_at
  `).run(
    sessionId, sessionId, fingerprint, o1.watermarkEventId, o1.watermarkInvocationId, o1.eventCount,
    o1.legacyMessageCount, o1.legacyMaxRowid, legacyDigest, attempts, retryAfter, permanent ? 1 : 0, now
  )
}

/** One full revalidate cycle for a session; a mismatch updates the verdict, a match clears it. */
function revalidateSession(db: AppDatabase, sessionId: string): void {
  const legacyMessages = getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
  if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) {
    // Sessions outside the projection's field contract never re-enter canonical reads; a stale
    // verdict would only keep forcing pointless background work (P0-④ explicit clear path).
    clearProjectionRejection(db, sessionId)
    return
  }
  const history = new SqliteAgentHistory(getDbConnection(db))
  const verified = history.readCanonicalSessionTranscript(sessionId, legacyMessages.map(({ id, role, content, timestamp }) => ({
    id, role: role as 'user' | 'assistant', content, timestamp
  })))
  if (verified.kind === 'matched') {
    const granted = history.writeCanonicalSessionCache({ ...verified, cacheKey: 'transcript', value: JSON.stringify(verified.messages) })
    if (granted) markSessionProjectionEligible(db, sessionId, verified.sessionGeneration)
    clearProjectionRejection(db, sessionId)
    return
  }
  if (verified.reason === 'legacy-mismatch') recordRevalidationFailure(db, sessionId)
}

export type RevalidationRunResult = Readonly<{ revalidated: number; deferred: number; skipped: number }>

/**
 * Consume the queue. Each session is one shard; the event loop is yielded between shards so
 * queued IPC/timers interleave (单片让步). Entries whose backoff has not expired are skipped
 * (not re-queued): the next stale/terminal event re-enqueues them.
 */
export async function runDueSessionProjectionRevalidations(db: AppDatabase,
  options: { maxSessions?: number; now?: number } = {}): Promise<RevalidationRunResult> {
  const maxSessions = Math.max(1, options.maxSessions ?? 4)
  const now = options.now ?? Date.now()
  let revalidated = 0
  let deferred = 0
  let skipped = 0
  const entries = drainSessionProjectionRevalidationQueue(db)
  const requeue: typeof entries = []
  for (let index = 0; index < entries.length; index += 1) {
    if (revalidated >= maxSessions) {
      // 预算耗尽：未处理的会话保留在队列，下轮 runDue 继续（分片间不丢任务）。
      requeue.push(...entries.slice(index))
      break
    }
    const entry = entries[index]!
    const rejection = getProjectionRejection(db, entry.sessionId)
    // 例行登记（终态/显式刷新）受退避门控（含 permanent 的 7 天 TTL）；内容变化（stale）强制立即重验。
    // S2: 退避未到期的条目重新入队（而不是丢弃），保证永久化/TTL 在后续 drain 中仍然可达。
    if (!entry.stale && rejection && now < rejection.retryAfter) {
      skipped += 1
      requeue.push(entry)
      continue
    }
    revalidated += 1
    revalidateSession(db, entry.sessionId)
    // 单片让步：分片之间把事件循环还给排队的 IPC / 定时器。
    await new Promise((resolve) => setImmediate(resolve))
  }
  for (const entry of requeue) enqueueSessionProjectionRevalidation(db, entry.sessionId, { stale: entry.stale })
  return { revalidated, deferred: requeue.length, skipped }
}

/**
 * Terminal/session-disposition checkpoint for turn end (claudeStreamHandlers finally): the cheap
 * L1 fast path stays synchronous; anything else enqueues background revalidation and kicks the
 * queue consumer (fire-and-forget, yielding shards) so the verdict is refreshed without ever
 * blocking the terminal path or a read (P0-③ async revalidation).
 */
export function checkpointSessionTranscriptProjection(db: AppDatabase, sessionId: string): boolean {
  try {
    if (refreshSessionTranscriptProjectionFastPath(db, sessionId)) {
      clearProjectionRejection(db, sessionId)
      return true
    }
  } catch { /* fall through to the queue */ }
  enqueueSessionProjectionRevalidation(db, sessionId)
  void runDueSessionProjectionRevalidations(db).catch(() => { /* revalidation is best-effort */ })
  return false
}

/**
 * S1: production drain for the revalidation queue. Startup owns one resident interval
 * (unref'd so it cannot hold the process open); every tick consumes due entries. Returns a
 * stop handle; tests can also drive drainOnce directly for deterministic timing.
 */
export function drainOnceSessionProjectionRevalidations(db: AppDatabase): void {
  void runDueSessionProjectionRevalidations(db).catch(() => { /* revalidation is best-effort */ })
}

export function startSessionProjectionRevalidationDrain(db: AppDatabase, intervalMs = 60_000): { stop: () => void } {
  const timer = setInterval(() => drainOnceSessionProjectionRevalidations(db), intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
