import type { StorageLifecycleControl, MaintenanceState } from './contracts'

export type LifecycleTaskHandle = Readonly<{
  stop(): void
  quiesce(): Promise<void>
  request?(reason: import('./contracts').MaintenanceReason): void
}>
export type LifecycleTaskRegistration = Readonly<{
  taskId: string
  category: NonNullable<MaintenanceState['category']>
  start(): LifecycleTaskHandle | undefined
}>

/** Host-owned coordinator for existing maintenance schedulers; task policy remains with each existing owner. */
export function createStorageLifecycleControl(input: {
  tasks: readonly LifecycleTaskRegistration[]
  initialize?(): Promise<void>
  quiesce?(): Promise<void>
}): StorageLifecycleControl {
  let stopped = false
  let allowed = false
  const records = input.tasks.map((task) => ({ task, handle: undefined as LifecycleTaskHandle | undefined, paused: false,
    lastError: undefined as string | undefined, retryTimer: undefined as ReturnType<typeof setTimeout> | undefined }))
  let stopping: Promise<{ status: 'quiescent' | 'deadline-exceeded' }> | undefined
  const ensureStarted = (record: typeof records[number]) => {
    if (stopped || record.paused || !allowed || record.handle || record.retryTimer) return false
    try {
      record.handle = record.task.start()
      record.lastError = undefined
    } catch (error) {
      record.lastError = error instanceof Error ? error.name : 'TASK_START_FAILED'
      record.retryTimer = setTimeout(() => {
        record.retryTimer = undefined
        ensureStarted(record)
      }, 5_000)
      return false
    }
    if (!record.handle) return false
    return true
  }
  const select = (category?: NonNullable<MaintenanceState['category']>) => records.filter((record) => !category || record.task.category === category)
  return Object.freeze({
    initialize: async ({ signal }: { signal?: AbortSignal } = {}) => {
      if (signal?.aborted) throw signal.reason ?? new Error('ABORTED')
      await input.initialize?.()
      if (signal?.aborted) throw signal.reason ?? new Error('ABORTED')
    },
    requestMaintenance: (request: Parameters<StorageLifecycleControl['requestMaintenance']>[0]) => {
      if (stopped) return { status: 'not-needed' as const }
      const { category } = request
      const targets = select(category)
      if (!targets.length) return { status: 'not-needed' as const }
      const active = targets.filter(({ handle, paused }) => handle && !paused)
      for (const record of active) record.handle?.request?.(request.reason)
      const scheduled = targets.some((record) => ensureStarted(record))
      if (!scheduled && (active.length > 0 || targets.every(({ paused }) => paused))) return { status: 'coalesced' as const }
      return scheduled ? { status: 'scheduled' as const } : { status: 'not-needed' as const }
    },
    allowBackgroundWork: () => { if (!stopped) { allowed = true; records.forEach(ensureStarted) } },
    pauseMaintenance: async (request: Parameters<StorageLifecycleControl['pauseMaintenance']>[0] = {}) => {
      const { category } = request
      const targets = select(category)
      for (const record of targets) {
        record.paused = true
        if (record.retryTimer) clearTimeout(record.retryTimer)
        record.retryTimer = undefined
        record.handle?.stop()
      }
      await Promise.all(targets.map((record) => record.handle?.quiesce() ?? Promise.resolve()))
      for (const record of targets) record.handle = undefined
    },
    resumeMaintenance: (request: Parameters<StorageLifecycleControl['resumeMaintenance']>[0] = {}) => {
      if (stopped) return
      const { category } = request
      for (const record of select(category)) { record.paused = false; ensureStarted(record) }
    },
    inspectMaintenance: () => Object.freeze(records.map(({ task, handle, paused, lastError }) => Object.freeze({
      taskId: task.taskId, category: task.category,
      status: paused ? 'paused' as const : handle ? 'scheduled' as const : lastError ? 'failed' as const : 'idle' as const,
      scannedCount: 0, processedCount: 0, ...(lastError ? { lastErrorCode: lastError } : {})
    }))),
    stop: ({ deadlineMs }: { deadlineMs: number }) => {
      if (stopping) return stopping
      stopped = true
      const active = records.map((record) => record.handle).filter((handle): handle is LifecycleTaskHandle => !!handle)
      for (const record of records) {
        if (record.retryTimer) clearTimeout(record.retryTimer)
        record.retryTimer = undefined
        record.handle?.stop()
        record.handle = undefined
      }
      if (!active.length && !input.quiesce) {
        stopping = Promise.resolve({ status: 'quiescent' as const })
        return stopping
      }
      stopping = Promise.race([
        Promise.all([...active.map((handle) => handle.quiesce()), input.quiesce?.() ?? Promise.resolve()]).then(() => ({ status: 'quiescent' as const })),
        new Promise<{ status: 'deadline-exceeded' }>((resolve) => setTimeout(() => resolve({ status: 'deadline-exceeded' }), Math.max(0, deadlineMs)))
      ]).then((result) => result)
      return stopping
    }
  })
}

/** Adapt one already-authorized scheduler; calling stop is synchronous and quiescence is owner-defined. */
export function createLifecycleTaskHandle(
  stop: () => void,
  quiesce: () => Promise<void> = () => Promise.resolve(),
  request?: (reason: import('./contracts').MaintenanceReason) => void
): LifecycleTaskHandle {
  return Object.freeze({ stop, quiesce, ...(request ? { request } : {}) })
}
