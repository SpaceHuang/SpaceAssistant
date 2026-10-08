import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { createLifecycleTaskHandle } from '../sessionStorage/lifecycle'
import { runSpillReferenceBackfillBatch } from './spillReferenceBackfill'
import { runSpillReferenceReconciliationBatch } from './spillReferenceReconciliation'

/** Host-owned backfill/reconciliation poller registered through StorageLifecycleControl. */
export function scheduleSpillReferenceBackfill(db: AppDatabase, options: {
  retryDelayMs?: number
  generationRestartDelayMs?: number
  idleDelayMs?: number
  onResult?: (result: { task: 'backfill' | 'reconciliation'; status: string; processed: number; error?: string }) => void
} = {}) {
  const controller = new AbortController()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let wakePending = false
  const schedule = (delay: number) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void run() }, Math.max(0, delay))
  }
  const run = async () => {
    if (stopped || inFlight) return
    inFlight = (async () => {
      try {
        const conn = getDbConnection(db)
        const backfill = await runSpillReferenceBackfillBatch(conn, { signal: controller.signal })
        options.onResult?.({ task: 'backfill', status: backfill.status, processed: backfill.processedOwners, ...(backfill.error ? { error: backfill.error } : {}) })
        if (backfill.status === 'failed' || backfill.status === 'paused') {
          schedule(options.retryDelayMs ?? 5 * 60_000)
          return
        }
        if (backfill.retryRequired) {
          schedule(options.generationRestartDelayMs ?? 30_000)
          return
        }
        if (backfill.processedOwners > 0) {
          schedule(0)
          return
        }
        const reconciliation = await runSpillReferenceReconciliationBatch(conn, { signal: controller.signal })
        options.onResult?.({ task: 'reconciliation', status: reconciliation.status, processed: reconciliation.checkedOwners,
          ...(reconciliation.error ? { error: reconciliation.error } : {}) })
        if (reconciliation.status === 'failed' || reconciliation.status === 'paused') schedule(options.retryDelayMs ?? 5 * 60_000)
        else if (reconciliation.status === 'running' && reconciliation.restartRequired) schedule(options.generationRestartDelayMs ?? 30_000)
        else if (reconciliation.status === 'running') schedule(0)
        else schedule(options.idleDelayMs ?? 30 * 60_000)
      } catch (error) {
        options.onResult?.({ task: 'backfill', status: 'failed', processed: 0, error: error instanceof Error ? error.message : 'unknown-error' })
        schedule(options.retryDelayMs ?? 5 * 60_000)
      } finally {
        inFlight = undefined
        if (wakePending) {
          wakePending = false
          schedule(0)
        }
      }
    })()
    await inFlight
  }
  schedule(0)
  return createLifecycleTaskHandle(() => {
    stopped = true
    controller.abort()
    if (timer) clearTimeout(timer)
  }, async () => { await inFlight }, () => {
    if (stopped) return
    if (inFlight) wakePending = true
    else schedule(0)
  })
}
