import { getDbConnection, type AppDatabase } from '../../../database/sqliteStore'
import type { LifecycleTaskHandle, LifecycleTaskRegistration } from '../../host/ports'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { logAgentEvent } from '../../../agentLogger/agentLogger'

const GC_BATCH_SIZE = 64
const GC_RETRY_MS = 5_000
const GC_IDLE_MS = 60_000

export type ProjectionBlobGcTaskOptions = Readonly<{
  batchSize?: number
  retryMs?: number
  idleMs?: number
  collectGarbage?: ReturnType<typeof createSessionProjectionBlobStore>['collectGarbage']
}>

/** Bounded, retryable lifecycle owner for orphan projection blob reclamation. */
export function createProjectionBlobGcTask(db: AppDatabase, root: string, options: ProjectionBlobGcTaskOptions = {}): LifecycleTaskRegistration {
  const blobs = createSessionProjectionBlobStore(root)
  const collectGarbage = options.collectGarbage ?? blobs.collectGarbage
  const batchSize = options.batchSize ?? GC_BATCH_SIZE
  let cursor: string | undefined
  return Object.freeze({
    taskId: 'session-projection-blob-gc',
    category: 'pending-reclamation',
    start(): LifecycleTaskHandle {
      let stopped = false
      let running: Promise<void> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let wakeRequested = false
      let nextDelay = options.idleMs ?? GC_IDLE_MS
      let failureAttempts = 0
      const schedule = (delay: number) => {
        if (stopped || timer) return
        timer = setTimeout(() => { timer = undefined; run() }, delay)
        timer.unref?.()
      }
      const run = () => {
        if (stopped || running) { wakeRequested = true; return }
        wakeRequested = false
        running = collectGarbage(getDbConnection(db), { afterLocator: cursor, maxEntries: batchSize })
          .then((result) => {
            failureAttempts = 0
            cursor = result.nextLocator
            nextDelay = result.nextLocator ? 0 : options.idleMs ?? GC_IDLE_MS
          })
          .catch((error: unknown) => {
            failureAttempts += 1
            cursor = undefined
            nextDelay = options.retryMs ?? Math.min(60_000, GC_RETRY_MS * 2 ** Math.min(failureAttempts - 1, 4))
            try { logAgentEvent('warn', 'session.projection.blob_gc_failed', {
              attempt: failureAttempts, reason: error instanceof Error ? error.name : 'unknown'
            }) } catch { /* logging cannot own GC retries */ }
          })
          .finally(() => {
            running = undefined
            schedule(wakeRequested ? 0 : nextDelay)
          })
      }
      run()
      return Object.freeze({
        stop() { stopped = true; if (timer) clearTimeout(timer); timer = undefined },
        async quiesce() { if (timer) clearTimeout(timer); timer = undefined; await running },
        request() { if (timer) clearTimeout(timer); timer = undefined; run() }
      })
    }
  })
}
