import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { buildSessionProjectionMigrationInventory } from './sessionProjectionMigrationInventory'
import {
  cancelSessionProjectionMigration,
  getSessionProjectionMigrationRun,
  pauseSessionProjectionMigration,
  resumeSessionProjectionMigration,
  runSessionProjectionMigrationBatch,
  startSessionProjectionMigration,
  type SessionProjectionMigrationExecutionReport,
  type SessionProjectionMigrationItemOutcome,
  type SessionProjectionMigrationRun,
} from './sessionProjectionMigration'

export type SessionProjectionMigrationCoordinatorOptions = Readonly<{
  /** Must be explicitly enabled by the owning application operation; defaults closed. */
  executionEnabled?: () => boolean
  now?: () => number
}>

export type SessionProjectionMigrationCoordinatorRunOptions = Readonly<{
  runId?: string
  knownSessionIds?: readonly string[]
  batchSize?: number
  maxBatches?: number
  rateLimitMs?: number
  now?: number
}>

export type SessionProjectionMigrationCoordinatorScheduleOptions = Readonly<{
  batchSize?: number
  rateLimitMs?: number
  initialDelayMs?: number
  intervalMs?: number
  onReport?: (report: SessionProjectionMigrationExecutionReport) => void
  onError?: (error: unknown) => void
}>

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_BATCHES_PER_CALL = 1
const DEFAULT_RATE_LIMIT_MS = 25

function emptyReport(run: SessionProjectionMigrationRun): SessionProjectionMigrationExecutionReport {
  return { run, batchCount: 0, processedCount: 0, successCount: 0, failureCount: 0, skippedCount: 0, outcomes: [] }
}

function yieldToMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Application-level entry for explicit, bounded migration work. No run starts during construction. */
export class SessionProjectionMigrationCoordinator {
  private readonly executionEnabled: () => boolean
  private readonly now: () => number
  private readonly scheduledRuns = new Map<string, () => void>()
  private readonly activeTicks = new Set<Promise<void>>()

  constructor(private readonly db: AppDatabase, options: SessionProjectionMigrationCoordinatorOptions = {}) {
    this.executionEnabled = options.executionEnabled ?? (() => false)
    this.now = options.now ?? Date.now
  }

  private assertExecutionEnabled(): void {
    if (!this.executionEnabled()) throw new Error('session projection migration execution is disabled')
  }

  private findActiveRun(): SessionProjectionMigrationRun | undefined {
    const row = getDbConnection(this.db).prepare(`SELECT run_id FROM session_projection_migration_runs
      WHERE status IN ('running','paused','needs_retry') AND cancelled_at IS NULL ORDER BY created_at DESC,run_id DESC LIMIT 1`)
      .get() as { run_id: string } | undefined
    return row ? getSessionProjectionMigrationRun(this.db, row.run_id) : undefined
  }

  /** Snapshot and persist a cohort exactly once; repeated application starts reuse its durable active run. */
  createRun(options: Pick<SessionProjectionMigrationCoordinatorRunOptions, 'runId' | 'knownSessionIds' | 'now'> = {}): SessionProjectionMigrationRun {
    this.assertExecutionEnabled()
    const requestedId = options.runId
    if (requestedId) {
      const existing = getDbConnection(this.db).prepare('SELECT 1 AS present FROM session_projection_migration_runs WHERE run_id=?')
        .get(requestedId)
      if (existing) return getSessionProjectionMigrationRun(this.db, requestedId)
    } else {
      const active = this.findActiveRun()
      if (active) return active
    }

    const runId = requestedId ?? randomUUID()
    const inventory = buildSessionProjectionMigrationInventory(this.db,
      options.knownSessionIds ? { knownSessionIds: options.knownSessionIds } : {})
    try {
      return startSessionProjectionMigration(this.db, inventory, { runId, now: options.now ?? this.now() })
    } catch (error) {
      // A second main-process caller may have won the active-run race after this census.
      if (!requestedId) {
        const active = this.findActiveRun()
        if (active) return active
      }
      throw error
    }
  }

  /** Run at most a small number of bounded batches, yielding between them so normal session work continues. */
  async run(runId: string, options: Omit<SessionProjectionMigrationCoordinatorRunOptions, 'runId' | 'knownSessionIds'> = {}): Promise<SessionProjectionMigrationExecutionReport> {
    this.assertExecutionEnabled()
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES_PER_CALL
    const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS
    if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) {
      throw new RangeError('maxBatches must be an integer from 1 to 20')
    }
    let run = getSessionProjectionMigrationRun(this.db, runId)
    if (!['running', 'needs_retry'].includes(run.status)) return emptyReport(run)

    let batchCount = 0
    const outcomes: SessionProjectionMigrationItemOutcome[] = []
    while (batchCount < maxBatches && ['running', 'needs_retry'].includes(run.status)) {
      if (!this.executionEnabled()) break
      const batch = await runSessionProjectionMigrationBatch(this.db, runId, {
        batchSize, rateLimitMs, now: (options.now ?? this.now()) + batchCount,
      })
      batchCount += 1
      outcomes.push(...batch.outcomes)
      run = batch
      if (batch.processedCount === 0 || batch.status !== 'running') break
      if (batchCount < maxBatches) await yieldToMainLoop()
    }
    return {
      run, batchCount, processedCount: outcomes.length,
      successCount: outcomes.filter(({ outcome }) => outcome === 'success').length,
      failureCount: outcomes.filter(({ outcome }) => outcome === 'failure').length,
      skippedCount: outcomes.filter(({ outcome }) => outcome === 'skipped').length,
      outcomes,
    }
  }

  /** Create/reuse a cohort and advance one bounded call; startup itself never invokes this method. */
  async start(options: SessionProjectionMigrationCoordinatorRunOptions = {}): Promise<SessionProjectionMigrationExecutionReport> {
    const run = this.createRun(options)
    if (run.status === 'paused' || run.status === 'needs_attention' || run.status === 'completed' || run.status === 'cancelled') {
      return emptyReport(run)
    }
    return this.run(run.runId, options)
  }

  /** Schedule recurring, single-batch ticks for an explicitly created run; construction never starts work. */
  schedule(runId: string, options: SessionProjectionMigrationCoordinatorScheduleOptions = {}): () => void {
    this.assertExecutionEnabled()
    const run = getSessionProjectionMigrationRun(this.db, runId)
    if (!['running', 'needs_retry'].includes(run.status)) return () => undefined
    const existing = this.scheduledRuns.get(runId)
    if (existing) return existing

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS
    const initialDelayMs = options.initialDelayMs ?? 0
    const intervalMs = options.intervalMs ?? 5_000
    if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 60_000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60 * 60_000) {
      throw new RangeError('migration coordinator schedule delay is invalid')
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
      !Number.isFinite(rateLimitMs) || rateLimitMs < 0 || rateLimitMs > 60_000) {
      throw new RangeError('migration coordinator batch options are invalid')
    }

    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      this.scheduledRuns.delete(runId)
    }
    const queueNext = (delayMs: number): void => {
      if (stopped) return
      timer = setTimeout(() => {
        const activeTick = tick()
        this.activeTicks.add(activeTick)
        void activeTick.then(
          () => this.activeTicks.delete(activeTick),
          () => this.activeTicks.delete(activeTick),
        )
      }, delayMs)
      timer.unref?.()
    }
    const tick = async (): Promise<void> => {
      if (stopped || running) return
      if (!this.executionEnabled()) {
        stop()
        return
      }
      running = true
      try {
        const report = await this.run(runId, { batchSize, maxBatches: 1, rateLimitMs })
        try {
          options.onReport?.(report)
        } catch (error) {
          try { options.onError?.(error) } catch (callbackError) {
            console.error('[sessionProjectionMigration] report/error callback failed:', callbackError)
          }
        }
        if (!['running', 'needs_retry'].includes(report.run.status)) stop()
        else queueNext(intervalMs)
      } catch (error) {
        try { options.onError?.(error) } catch (callbackError) {
          console.error('[sessionProjectionMigration] error callback failed:', callbackError)
        }
        queueNext(intervalMs)
      } finally {
        running = false
      }
    }
    this.scheduledRuns.set(runId, stop)
    queueNext(initialDelayMs)
    return stop
  }

  pause(runId: string, now = this.now()): SessionProjectionMigrationRun {
    return pauseSessionProjectionMigration(this.db, runId, now)
  }

  resume(runId: string, now = this.now()): SessionProjectionMigrationRun {
    this.assertExecutionEnabled()
    return resumeSessionProjectionMigration(this.db, runId, now)
  }

  /** Stop future claims durably; any currently claimed bounded item may finish before this call takes effect. */
  cancel(runId: string, now = this.now()): SessionProjectionMigrationRun {
    return cancelSessionProjectionMigration(this.db, runId, now)
  }

  async shutdown(): Promise<void> {
    for (const stop of this.scheduledRuns.values()) stop()
    while (this.activeTicks.size > 0) {
      await Promise.allSettled([...this.activeTicks])
    }
  }
}
