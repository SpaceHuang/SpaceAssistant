import type { ProjectionBuildLimits } from '../domain/projectionBuild'
import type { ProjectionBuildBlobPort, ProjectionHistoryChunkReaderPort, ProjectionHistoryReducerPort } from './projectionBuildCoordinator'
import { runProjectionBuildSlice } from './projectionBuildCoordinator'
import type { SessionProjectionService } from './projectionService'
import type { ProjectionPreparationRequest } from '../public/ports'

export type ProjectionBuildWorkItem = Readonly<{ sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number }>
type MaintenanceReason = 'startup' | 'window-ready' | 'policy-changed' | 'scope-changed' | 'capacity-pressure' | 'retry'
export type ProjectionBuildTaskHandle = Readonly<{ stop(): void; quiesce(): Promise<void>; request?(reason: MaintenanceReason): void }>
export type ProjectionBuildSupervisorOptions = Readonly<{
  service: SessionProjectionService
  listDueWork(): readonly ProjectionBuildWorkItem[]
  dbPath: string
  readChunk: ProjectionHistoryChunkReaderPort
  historyReducer: ProjectionHistoryReducerPort
  blobs: ProjectionBuildBlobPort
  limits: ProjectionBuildLimits
  maxChunksPerSlice: number
  now(): number
  retryAfter?(): number
  onResult?(item: ProjectionBuildWorkItem, result: Awaited<ReturnType<typeof runProjectionBuildSlice>>): void
  resolveWorkItem?(input: ProjectionPreparationRequest): ProjectionBuildWorkItem | undefined
}>

/** One-at-a-time projection worker owner. quiesce resolves only after the bounded coordinator/worker returns. */
export function createProjectionBuildSupervisor(options: ProjectionBuildSupervisorOptions): Readonly<{
  start(): ProjectionBuildTaskHandle
  prepare(item: ProjectionBuildWorkItem): Promise<Awaited<ReturnType<typeof runProjectionBuildSlice>>>
}> {
  let active: Readonly<{ handle: ProjectionBuildTaskHandle; wake(reason: MaintenanceReason): void }> | undefined
  const requests = new Map<string, { item: ProjectionBuildWorkItem; resolve(value: Awaited<ReturnType<typeof runProjectionBuildSlice>>): void; reject(error: unknown): void }>()
  const keyOf = (item: ProjectionBuildWorkItem) => JSON.stringify([item.sessionId, item.scopeKey])
  return Object.freeze({
    prepare(item) {
      const key = keyOf(item)
      const existing = requests.get(key)
      if (existing) return new Promise((resolve, reject) => {
        const priorResolve = existing.resolve
        const priorReject = existing.reject
        existing.resolve = (value) => { priorResolve(value); resolve(value) }
        existing.reject = (error) => { priorReject(error); reject(error) }
      })
      const promise = new Promise<Awaited<ReturnType<typeof runProjectionBuildSlice>>>((resolve, reject) => {
        requests.set(key, { item, resolve, reject })
      })
      const handle = active?.handle
      if (!handle) return Promise.reject(new Error('PROJECTION_BUILD_TASK_NOT_RUNNING'))
      handle.request?.('scope-changed')
      return promise
    },
    start() {
      if (active) return active.handle
      const controller = new AbortController()
      let stopped = false
      let wakeResolve: (() => void) | undefined
      let loopPromise: Promise<void>
      const wake = (_reason: MaintenanceReason = 'startup') => { wakeResolve?.(); wakeResolve = undefined }
      const nextWake = () => new Promise<void>((resolve) => { wakeResolve = resolve })
      const runItem = async (item: ProjectionBuildWorkItem): Promise<boolean> => {
        const key = keyOf(item)
        const lease = options.service.beginRebuild({ sessionId: item.sessionId,
          sessionGeneration: item.sessionGeneration, scopeKey: item.scopeKey })
        if (!lease) {
          requests.get(key)?.reject(new Error('PROJECTION_BUILD_CLAIM_UNAVAILABLE'))
          requests.delete(key)
          return false
        }
        while (!stopped && !controller.signal.aborted) {
          const result = await runProjectionBuildSlice({ service: options.service, lease, specVersion: item.specVersion,
            dbPath: options.dbPath, readChunk: options.readChunk, historyReducer: options.historyReducer,
            blobs: options.blobs, limits: options.limits, maxChunksPerSlice: options.maxChunksPerSlice,
            now: options.now, retryAfter: options.retryAfter, signal: controller.signal })
          options.onResult?.(item, result)
          if (result.kind !== 'checkpointed') {
            requests.get(key)?.resolve(result)
            requests.delete(key)
            return true
          }
        }
        requests.get(key)?.reject(controller.signal.reason ?? new Error('PROJECTION_BUILD_STOPPED'))
        requests.delete(key)
        return true
      }
      loopPromise = (async () => {
        while (!stopped) {
          const requested = requests.values().next().value as { item: ProjectionBuildWorkItem } | undefined
          if (requested) { await runItem(requested.item); continue }
          const work = options.listDueWork()
          if (!work.length) { await nextWake(); continue }
          let claimedAny = false
          for (const item of work) {
            if (stopped) break
            if (requests.has(keyOf(item))) continue
            claimedAny = await runItem(item) || claimedAny
          }
          if (!stopped && requests.size > 0) continue
          if (!stopped && (!claimedAny || options.listDueWork().length === 0)) await nextWake()
        }
      })()
      const handle: ProjectionBuildTaskHandle = Object.freeze({
        stop: () => {
          stopped = true
          const error = new Error('PROJECTION_BUILD_STOPPED')
          controller.abort(error)
          for (const request of requests.values()) request.reject(error)
          requests.clear()
          wakeResolve?.(); wakeResolve = undefined
        },
        quiesce: async () => { await loopPromise },
        request: wake,
      })
      active = { handle, wake }
      void loopPromise.finally(() => { if (active?.handle === handle) active = undefined })
      return handle
    }
  })
}
