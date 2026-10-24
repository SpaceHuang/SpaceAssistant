import type { AppDatabase } from '../../../database'
import { getDbConnection } from '../../../database/sqliteStore'
import {
  clearProjectionRejection, computeLegacyProjectionDigest, getProjectionRejection, listProjectionRejectionWork, recordProjectionRejection,
  projectionRejectionBackoffDelayMs, readProjectionO1Metadata
} from '../../sqliteRuntimeBindings'
import { logAgentEvent } from '../../../agentLogger/agentLogger'
import { drainSessionProjectionRevalidationQueue, enqueueSessionProjectionRevalidation } from '../../host/sessionProjectionRevalidationQueue'
import {
  computeCanonicalProjectionFingerprint as readCanonicalProjectionFingerprint,
  publishTranscriptParityProof,
  readLegacyProjectionMessages,
  refreshValidatedProjectionFastPath,
  validateCanonicalProjection
} from '../../sqliteRuntimeBindings'

/**
 * P0-③ background revalidation executor (plan §4 保障链 / §5 ③). Full rebuild+compare runs
 * here, budgeted and yielding between sessions, never inside a synchronous read. P0 keeps this
 * on the main process with task-level yields; P3 upgrades the execution to worker_threads.
 */

const PERMANENT_AFTER_ATTEMPTS = 5
const PERMANENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Aggregated canonical event-range fingerprint (v4 B1); only the revalidator computes it. */
export function computeCanonicalProjectionFingerprint(db: AppDatabase, sessionId: string): string {
  return readCanonicalProjectionFingerprint(db, sessionId)
}

function recordRevalidationFailure(db: AppDatabase, sessionId: string, reason: string): void {
  const existing = getProjectionRejection(db, sessionId)
  const o1 = readProjectionO1Metadata(db, sessionId)
  const legacyDigest = computeLegacyProjectionDigest(readLegacyProjectionMessages(db, sessionId))
  const fingerprint = computeCanonicalProjectionFingerprint(db, sessionId)
  const attempts = (existing?.attempts ?? 0) + 1
  const fingerprintUnchanged = Boolean(existing?.fingerprint) && existing!.fingerprint === fingerprint
  const permanent = existing?.permanent === true || (fingerprintUnchanged && attempts >= PERMANENT_AFTER_ATTEMPTS)
  const now = Date.now()
  const retryAfter = permanent ? now + PERMANENT_TTL_MS : now + projectionRejectionBackoffDelayMs(attempts)
  recordProjectionRejection(db, sessionId, reason, o1, legacyDigest, { fingerprint, permanent })
}

/** One full revalidate cycle for a session; a mismatch updates the verdict, a match clears it. */
function revalidateSession(db: AppDatabase, sessionId: string): string {
  const legacyMessages = readLegacyProjectionMessages(db, sessionId)
  if (legacyMessages.some(({ role }) => role !== 'user' && role !== 'assistant')) {
    // Sessions outside the projection's field contract never re-enter canonical reads; a stale
    // verdict would only keep forcing pointless background work (P0-④ explicit clear path).
    clearProjectionRejection(db, sessionId)
    return 'other'
  }
  const { verified } = validateCanonicalProjection(db, sessionId, legacyMessages.map(({ id, role, content, timestamp }) => ({
    id, role: role as 'user' | 'assistant', content, timestamp
  })))
  if (verified.kind === 'matched') {
    publishTranscriptParityProof(db, sessionId, verified, computeLegacyProjectionDigest(legacyMessages))
    clearProjectionRejection(db, sessionId)
    return 'matched'
  }
  // legacy-mismatch 与其他 unavailable（order/snapshot-invalid 等）都纳入退避治理：canonical
  // 流当前不可信，verdict 保持 + 指数退避重验，避免每个操作都触发全量 fold（review R1 延伸）。
  recordRevalidationFailure(db, sessionId, verified.reason)
  return verified.reason === 'legacy-mismatch' ? 'mismatch' : 'other:' + verified.reason
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
  let skipped = 0
  const entries = drainSessionProjectionRevalidationQueue(db)
  const requeue: typeof entries = []
  const sessionOutcomes: Array<{ sessionId: string; stale: boolean; outcome: string }> = []
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
    let outcome = 'threw'
    try { outcome = revalidateSession(db, entry.sessionId) } catch (error) { try { logAgentEvent('warn', 'session.transcript.revalidation', { sessionId: entry.sessionId.slice(0, 8), threw: error instanceof Error ? error.message : String(error) }) } catch { /* observability */ } }
    sessionOutcomes.push({ sessionId: entry.sessionId.slice(0, 8), stale: entry.stale, outcome })
    // 单片让步：分片之间把事件循环还给排队的 IPC / 定时器。
    await new Promise((resolve) => setImmediate(resolve))
  }
  for (const entry of requeue) enqueueSessionProjectionRevalidation(db, entry.sessionId, { stale: entry.stale })
  try { logAgentEvent('info', 'session.transcript.revalidation', { drained: entries.length, revalidated, deferred: requeue.length, skipped, sessions: sessionOutcomes }) } catch { /* observability */ }
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
    if (refreshValidatedProjectionFastPath(db, sessionId)) {
      clearProjectionRejection(db, sessionId)
      return true
    }
  } catch { /* fall through to the queue */ }
  enqueueSessionProjectionRevalidation(db, sessionId)
  try { logAgentEvent('info', 'session.transcript.revalidation', { checkpoint: sessionId, enqueued: true }) } catch { /* observability */ }
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

export function startSessionProjectionRevalidationDrain(db: AppDatabase, intervalMs = 60_000, now: () => number = Date.now): { stop: () => void } {
  const enqueuePersistedDueWork = () => {
    for (const entry of listProjectionRejectionWork(db, now())) enqueueSessionProjectionRevalidation(db, entry.sessionId, { stale: entry.stale })
  }
  enqueuePersistedDueWork()
  // Recover due persisted work on startup; waiting for the first interval can defer it by a minute.
  void runDueSessionProjectionRevalidations(db, { now: now() }).catch(() => undefined)
  const timer = setInterval(() => {
    enqueuePersistedDueWork()
    void runDueSessionProjectionRevalidations(db, { now: now() }).catch(() => undefined)
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
