import type { AppDatabase } from '../database'
import { openSqliteDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import type {
  SessionStorageCleanupProductionBoundary,
  SessionStorageCleanupProductionStep,
} from '../runtime/sessionStorageCleanupProduction'

export type SessionMessageContentCleanupMaintenanceSummary = Readonly<{
  status: 'blocked' | 'idle' | 'processed'
  scanned: number
  writeStopped: number
  pendingStarted: number
  batches: number
  completed: number
  ineligible: number
  failed: number
  gateReason?: string
}>

export type SessionMessageContentCleanupMaintenanceOptions = Readonly<{
  batchSize?: number
  maxSessionsPerRun?: number
  maxBatchesPerSession?: number
}>

type CleanupCandidate = Readonly<{ session_id: string; cleanup_state: string }>

const DEFAULT_OPTIONS = {
  batchSize: 100,
  maxSessionsPerRun: 2,
  maxBatchesPerSession: 1,
} as const

function runStep(
  db: AppDatabase,
  sessionId: string,
  boundary: SessionStorageCleanupProductionBoundary,
  step: SessionStorageCleanupProductionStep,
): ReturnType<SessionStorageCleanupProductionBoundary> {
  return boundary(db, sessionId, step)
}

/** 每轮先验 gate，再按 session 的持久 cleanup_state 有界续跑。 */
export function runSessionMessageContentCleanupMaintenance(
  db: AppDatabase,
  boundary: SessionStorageCleanupProductionBoundary,
  options: SessionMessageContentCleanupMaintenanceOptions = {},
): SessionMessageContentCleanupMaintenanceSummary {
  const gate = boundary.checkGate()
  if (!gate.allowed) {
    return {
      status: 'blocked', scanned: 0, writeStopped: 0, pendingStarted: 0,
      batches: 0, completed: 0, ineligible: 0, failed: 0, gateReason: gate.reason,
    }
  }
  const scope = boundary.checkAuthorizationScope(db)
  if (!scope.allowed) {
    return {
      status: 'blocked', scanned: 0, writeStopped: 0, pendingStarted: 0,
      batches: 0, completed: 0, ineligible: 0, failed: 0, gateReason: scope.reason,
    }
  }

  const batchSize = options.batchSize ?? DEFAULT_OPTIONS.batchSize
  const maxSessionsPerRun = options.maxSessionsPerRun ?? DEFAULT_OPTIONS.maxSessionsPerRun
  const maxBatchesPerSession = options.maxBatchesPerSession ?? DEFAULT_OPTIONS.maxBatchesPerSession
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 ||
    !Number.isSafeInteger(maxSessionsPerRun) || maxSessionsPerRun < 1 || maxSessionsPerRun > 100 ||
    !Number.isSafeInteger(maxBatchesPerSession) || maxBatchesPerSession < 1 || maxBatchesPerSession > 100) {
    throw new RangeError('session content cleanup maintenance limits are invalid')
  }

  const placeholders = scope.sessionIds.map(() => '?').join(',')
  const authorizedCandidates = getDbConnection(db).prepare(`SELECT cutover.session_id,cutover.cleanup_state
    FROM session_message_content_cutover cutover
    JOIN sessions ON sessions.id=cutover.session_id
    WHERE cutover.session_id IN (${placeholders}) AND cutover.write_mode='canonical'
      AND cutover.cleanup_state IN ('retained','write-stopped','pending')
    ORDER BY cutover.updated_at,cutover.session_id`).all(...scope.sessionIds) as CleanupCandidate[]
  const candidates: CleanupCandidate[] = []
  let scopeIneligible = 0
  for (const candidate of authorizedCandidates) {
    const authorization = boundary.checkSessionAuthorization(db, candidate.session_id)
    if (!authorization.allowed) {
      if (authorization.reason === 'session-snapshot-mismatch' || authorization.reason === 'session-not-authorized') {
        scopeIneligible += 1
        continue
      }
      return {
        status: 'blocked', scanned: 0, writeStopped: 0, pendingStarted: 0,
        batches: 0, completed: 0, ineligible: scopeIneligible, failed: 0, gateReason: authorization.reason,
      }
    }
    if (candidates.length >= maxSessionsPerRun) continue
    candidates.push(candidate)
  }
  const summary = {
    status: candidates.length || scopeIneligible ? 'processed' as const : 'idle' as const,
    scanned: authorizedCandidates.length,
    writeStopped: 0,
    pendingStarted: 0,
    batches: 0,
    completed: 0,
    ineligible: scopeIneligible,
    failed: 0,
  }

  candidateLoop: for (const candidate of candidates) {
    let state = candidate.cleanup_state
    try {
      if (state === 'retained') {
        const certification = runStep(db, candidate.session_id, boundary, { kind: 'certify' })
        if (certification.status === 'blocked') {
          if (certification.scopeReason === 'session-snapshot-mismatch' || certification.scopeReason === 'session-not-authorized') {
            summary.ineligible += 1
            continue candidateLoop
          }
          return { ...summary, status: 'blocked', gateReason: certification.scopeReason ?? certification.gate.reason }
        }
        if (certification.result !== true) { summary.ineligible += 1; continue }
        const result = runStep(db, candidate.session_id, boundary, { kind: 'write-stop' })
        if (result.status === 'blocked') {
          if (result.scopeReason === 'session-snapshot-mismatch' || result.scopeReason === 'session-not-authorized') {
            summary.ineligible += 1
            continue candidateLoop
          }
          return { ...summary, status: 'blocked', gateReason: result.scopeReason ?? result.gate.reason }
        }
        if (result.result !== true) { summary.ineligible += 1; continue }
        summary.writeStopped += 1
        state = 'write-stopped'
      }

      if (state === 'write-stopped') {
        const result = runStep(db, candidate.session_id, boundary, { kind: 'begin' })
        if (result.status === 'blocked') {
          if (result.scopeReason === 'session-snapshot-mismatch' || result.scopeReason === 'session-not-authorized') {
            summary.ineligible += 1
            continue candidateLoop
          }
          return { ...summary, status: 'blocked', gateReason: result.scopeReason ?? result.gate.reason }
        }
        if (result.result !== true) { summary.ineligible += 1; continue }
        summary.pendingStarted += 1
        state = 'pending'
      }

      if (state !== 'pending') continue
      for (let batch = 0; batch < maxBatchesPerSession; batch += 1) {
        const result = runStep(db, candidate.session_id, boundary, { kind: 'batch', batchSize })
        if (result.status === 'blocked') {
          if (result.scopeReason === 'session-snapshot-mismatch' || result.scopeReason === 'session-not-authorized') {
            summary.ineligible += 1
            break
          }
          return { ...summary, status: 'blocked', gateReason: result.scopeReason ?? result.gate.reason }
        }
        if (typeof result.result === 'boolean') { summary.failed += 1; break }
        if (result.result.status === 'ineligible') { summary.ineligible += 1; break }
        summary.batches += 1
        if (result.result.status === 'complete') {
          if (db.filePath === ':memory:') {
            summary.failed += 1
            break
          }
          const verificationDb = openSqliteDatabase(db.filePath)
          let verified: ReturnType<SessionStorageCleanupProductionBoundary>
          try {
            verified = runStep(verificationDb, candidate.session_id, boundary, { kind: 'verify-complete' })
          } finally {
            verificationDb.close()
          }
          if (verified.status === 'blocked') {
            if (verified.scopeReason === 'session-snapshot-mismatch' || verified.scopeReason === 'session-not-authorized') {
              summary.ineligible += 1
              break
            }
            return { ...summary, status: 'blocked', gateReason: verified.scopeReason ?? verified.gate.reason }
          }
          if (verified.result === true) summary.completed += 1
          else summary.ineligible += 1
          break
        }
      }
    } catch {
      // Each session is an independent unit; persisted state and retry bookkeeping remain authoritative.
      summary.failed += 1
    }
  }

  return summary
}

export type ScheduleSessionMessageContentCleanupOptions = SessionMessageContentCleanupMaintenanceOptions & Readonly<{
  initialDelayMs?: number
  intervalMs?: number
  onResult?: (summary: SessionMessageContentCleanupMaintenanceSummary | 'failed') => void
}>

/** Start the background cleaner only after startup; each run is bounded and can be stopped at shutdown. */
export function scheduleSessionMessageContentCleanupMaintenance(
  db: AppDatabase,
  boundary: SessionStorageCleanupProductionBoundary,
  options: ScheduleSessionMessageContentCleanupOptions = {},
): () => void {
  let stopped = false
  let running = false
  let interval: ReturnType<typeof setInterval> | undefined
  let initial: ReturnType<typeof setTimeout> | undefined
  const run = (): void => {
    if (stopped || running) return
    running = true
    try {
      const summary = runSessionMessageContentCleanupMaintenance(db, boundary, options)
      options.onResult?.(summary)
      if (summary.status === 'blocked' && /^(authorization-|profile-|session-)/.test(summary.gateReason ?? '')) {
        stopped = true
        if (initial) clearTimeout(initial)
        if (interval) clearInterval(interval)
      }
    } catch {
      options.onResult?.('failed')
    } finally {
      running = false
    }
  }
  initial = setTimeout(run, options.initialDelayMs ?? 60_000)
  interval = setInterval(run, options.intervalMs ?? 15 * 60_000)
  initial.unref?.()
  interval.unref?.()
  return () => {
    stopped = true
    clearTimeout(initial)
    clearInterval(interval)
  }
}
