type ForegroundJob<T> = {
  run(): Promise<T>
  resolve(value: T): void
  reject(error: Error): void
  signal?: AbortSignal
  abort?: () => void
  queuedAt: number
  onQueueWait?(durationMs: number): void
}

const MAX_PENDING_FOREGROUND_WORKERS = 16
const MAX_FOREGROUND_QUEUE_WAIT_MS = 30_000
const pending: Array<ForegroundJob<unknown>> = []
let active = false

/** Shares one one-shot Worker slot across page/cache reads and bounds waiting memory. */
export function withProjectionForegroundWorkerBudget<T>(run: () => Promise<T>, options: Readonly<{
  signal?: AbortSignal
  onQueueWait?(durationMs: number): void
}> = {}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason instanceof Error
    ? options.signal.reason : new Error('PROJECTION_FOREGROUND_WORKER_CANCELLED'))
  if (pending.length >= MAX_PENDING_FOREGROUND_WORKERS) {
    return Promise.reject(new Error('PROJECTION_FOREGROUND_WORKER_QUEUE_FULL'))
  }
  return new Promise<T>((resolve, reject) => {
    const job: ForegroundJob<T> = { run, resolve, reject, signal: options.signal,
      queuedAt: performance.now(), ...(options.onQueueWait ? { onQueueWait: options.onQueueWait } : {}) }
    job.abort = () => {
      const index = pending.indexOf(job as ForegroundJob<unknown>)
      if (index < 0) return
      pending.splice(index, 1)
      job.signal?.removeEventListener('abort', job.abort!)
      reject(job.signal?.reason instanceof Error ? job.signal.reason : new Error('PROJECTION_FOREGROUND_WORKER_CANCELLED'))
    }
    job.signal?.addEventListener('abort', job.abort, { once: true })
    pending.push(job as ForegroundJob<unknown>)
    pump()
  })
}

function pump(): void {
  if (active) return
  const job = pending.shift()
  if (!job) return
  active = true
  if (job.abort) job.signal?.removeEventListener('abort', job.abort)
  const queueWaitMs = performance.now() - job.queuedAt
  if (queueWaitMs > MAX_FOREGROUND_QUEUE_WAIT_MS) {
    job.reject(new Error('PROJECTION_FOREGROUND_WORKER_QUEUE_TIMEOUT'))
    active = false
    pump()
    return
  }
  try { job.onQueueWait?.(queueWaitMs) } catch { /* Diagnostics must not affect the read. */ }
  Promise.resolve().then(job.run).then(job.resolve, (error: unknown) => job.reject(error instanceof Error ? error : new Error('PROJECTION_FOREGROUND_WORKER_FAILED')))
    .finally(() => { active = false; pump() })
}
