import type { ProjectionBuildLimits } from '../domain/projectionBuild'
import type { ProjectionBuildBlobPort, ProjectionHistoryChunkReaderPort, ProjectionHistoryChunkReducerPort, ProjectionHistoryReducerPort } from './projectionBuildCoordinator'
import { runProjectionBuildSlice } from './projectionBuildCoordinator'
import type { ProjectionRebuildLease, SessionProjectionService } from './projectionService'
import type { ProjectionPreparationRequest } from '../public/ports'
import type { ProjectionWorkerSample } from '../domain/projectionSource'

export type ProjectionBuildWorkItem = Readonly<{ sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number }>
const MIN_PREPARATION_RETRY_MS = 1_000
type MaintenanceReason = 'startup' | 'window-ready' | 'policy-changed' | 'scope-changed' | 'capacity-pressure' | 'retry'
export type ProjectionBuildTaskHandle = Readonly<{ stop(): void; quiesce(): Promise<void>; request?(reason: MaintenanceReason): void }>
export type ProjectionBuildSupervisorOptions = Readonly<{
  service: SessionProjectionService
  listDueWork(): readonly ProjectionBuildWorkItem[]
  /** Earliest durable rejected retry deadline, or null when none is pending. */
  nextRetryAt?(): number | null
  dbPath: string
  readChunk: ProjectionHistoryChunkReaderPort
  historyReducer: ProjectionHistoryReducerPort
  reduceChunk?: ProjectionHistoryChunkReducerPort
  blobs: ProjectionBuildBlobPort
  limits: ProjectionBuildLimits
  maxChunksPerSlice: number
  /** Cooperative wall-clock budget; one synchronous chunk cannot be preempted, so it is measured then yielded. */
  sliceBudgetMs?: number
  monotonicNow?(): number
  onSlice?(input: Readonly<{ durationMs: number; nextSequence: number | null; outcome: string; yielded: boolean;
    sourceRows: number; sourceBytes: number; sourceSnapshotDurationMs: number; sourceWorkerDurationMs: number; reducerWorkerDurationMs: number;
    maxWorkerHeapUsedBytesAtExit: number | null; maxProcessRssBytesAtExit: number | null; workerSamples: number }>): void
  now(): number
  retryAfter?(): number
  onResult?(item: ProjectionBuildWorkItem, result: Awaited<ReturnType<typeof runProjectionBuildSlice>>): void
  onFailure?(code: 'PROJECTION_BUILD_DUE_WORK_SCAN_FAILED' | 'PROJECTION_BUILD_CLAIM_FAILED' |
    'PROJECTION_BUILD_STATE_UNAVAILABLE' | 'PROJECTION_BUILD_SUPERVISOR_FAILED' | 'PROJECTION_BUILD_STOP_CLEANUP_FAILED'): void
  resolveWorkItem?(input: ProjectionPreparationRequest): ProjectionBuildWorkItem | undefined
}>

/** One-at-a-time projection worker owner. quiesce resolves only after the bounded coordinator/worker returns. */
export function createProjectionBuildSupervisor(options: ProjectionBuildSupervisorOptions): Readonly<{
  start(): ProjectionBuildTaskHandle
  prepare(item: ProjectionBuildWorkItem): Promise<Awaited<ReturnType<typeof runProjectionBuildSlice>>>
}> {
  let active: Readonly<{ handle: ProjectionBuildTaskHandle; wake(reason: MaintenanceReason): void }> | undefined
  const requests = new Map<string, { item: ProjectionBuildWorkItem; resolve(value: Awaited<ReturnType<typeof runProjectionBuildSlice>>): void; reject(error: unknown): void }>()
  const suspendedLeases = new Map<string, ProjectionRebuildLease>()
  const suspendedItems = new Map<string, ProjectionBuildWorkItem>()
  const retryWorkItems = new Map<string, ProjectionBuildWorkItem>()
  const delayedRetryKeys = new Set<string>()
  const keyOf = (item: ProjectionBuildWorkItem) => JSON.stringify([item.sessionId, item.scopeKey])
  return Object.freeze({
    prepare(item) {
      const handle = active?.handle
      if (!handle) return Promise.reject(Object.assign(new Error('PROJECTION_PREPARATION_UNAVAILABLE'), {
        code: 'PROJECTION_PREPARATION_UNAVAILABLE' as const, retryAfter: options.now() + MIN_PREPARATION_RETRY_MS,
      }))
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
      handle.request?.('scope-changed')
      return promise
    },
    start() {
      if (active) return active.handle
      const controller = new AbortController()
      let stopped = false
      let wakeResolve: (() => void) | undefined
      let loopPromise: Promise<void>
      let dueScanFailed = false
      let retryWakeTimer: ReturnType<typeof setTimeout> | undefined
      const claimFailures = new Map<string, number>()
      const MIN_CLAIM_RETRY_MS = 1_000
      const MAX_CLAIM_RETRY_MS = 60_000
      const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
      const reportFailure = (code: Parameters<NonNullable<typeof options.onFailure>>[0]) => {
        try { options.onFailure?.(code) } catch { /* Failure reporting must not own the worker lifecycle. */ }
      }
      const wake = (_reason: MaintenanceReason = 'startup') => { wakeResolve?.(); wakeResolve = undefined }
      const nextWake = () => new Promise<void>((resolve) => { wakeResolve = resolve })
      const waitForWorkOrRetry = async () => {
        if (requests.size > 0) return
        let retryAt: number | null
        if (dueScanFailed) retryAt = options.now() + 1_000
        else {
          try { retryAt = options.nextRetryAt?.() ?? null }
          catch {
            if (!dueScanFailed) reportFailure('PROJECTION_BUILD_DUE_WORK_SCAN_FAILED')
            dueScanFailed = true
            retryAt = options.now() + 1_000
          }
        }
        if (retryWakeTimer) clearTimeout(retryWakeTimer)
        if (retryAt !== null) {
          await new Promise<void>((resolve) => {
            retryWakeTimer = setTimeout(() => { retryWakeTimer = undefined; resolve() }, Math.max(0, retryAt - options.now()))
            wakeResolve = () => { if (retryWakeTimer) clearTimeout(retryWakeTimer); retryWakeTimer = undefined; resolve() }
          })
        } else await nextWake()
        wakeResolve = undefined
      }
      const readDueWork = () => {
        try {
          const work = options.listDueWork()
          if (!Array.isArray(work)) throw new Error('PROJECTION_BUILD_DUE_WORK_INVALID')
          dueScanFailed = false
          return work
        }
        catch {
          if (!dueScanFailed) reportFailure('PROJECTION_BUILD_DUE_WORK_SCAN_FAILED')
          dueScanFailed = true
          return []
        }
      }
      const scheduleRetry = (item: ProjectionBuildWorkItem, lease?: ProjectionRebuildLease) => {
        const key = keyOf(item)
        if (lease) suspendedLeases.set(key, lease)
        suspendedItems.set(key, item)
        if (retryTimers.has(key)) return
        const failures = (claimFailures.get(key) ?? 0) + 1
        claimFailures.set(key, failures)
        const delay = Math.min(MAX_CLAIM_RETRY_MS, MIN_CLAIM_RETRY_MS * 2 ** Math.min(failures - 1, 16))
        delayedRetryKeys.add(key)
        retryTimers.set(key, setTimeout(() => {
          retryTimers.delete(key)
          delayedRetryKeys.delete(key)
          retryWorkItems.set(key, item)
          wake('retry')
        }, delay))
      }
      for (const [key, item] of suspendedItems) retryWorkItems.set(key, item)
      const runItem = async (item: ProjectionBuildWorkItem): Promise<boolean> => {
        const key = keyOf(item)
        const retryTimer = retryTimers.get(key)
        if (retryTimer) clearTimeout(retryTimer)
        retryTimers.delete(key)
        retryWorkItems.delete(key)
        const settleUnexpectedFailure = (error: unknown) => {
          try {
            const current = options.service.get(item.sessionId, item.scopeKey)
            const lease = suspendedLeases.get(key)
            if (lease) {
              options.service.reject(lease, { failureCaseJson: JSON.stringify({ case: 'CONTENT_UNAVAILABLE', caseId: 'SUPERVISOR_FAILED' }),
                attempts: (current?.attempts ?? 0) + 1, retryAfter: options.retryAfter?.() ?? options.now() + 60_000 })
              suspendedLeases.delete(key)
              suspendedItems.delete(key)
            }
          } catch {
            const lease = suspendedLeases.get(key)
            if (lease) scheduleRetry(item, lease)
          }
          requests.get(key)?.reject(error)
          requests.delete(key)
          return false
        }
        try {
        let lease = suspendedLeases.get(key)
        if (lease) {
          const state = options.service.get(item.sessionId, item.scopeKey)
          if (state?.status !== 'rebuilding' || state.sessionGeneration !== item.sessionGeneration ||
            state.processGeneration !== lease.processGeneration || state.rebuildToken !== lease.rebuildToken) lease = undefined
        }
        if (lease) {
          suspendedLeases.delete(key)
          suspendedItems.delete(key)
        } else {
          try {
            lease = options.service.beginRebuild({ sessionId: item.sessionId,
              sessionGeneration: item.sessionGeneration, scopeKey: item.scopeKey }) ?? undefined
          } catch {
            reportFailure('PROJECTION_BUILD_CLAIM_FAILED')
            scheduleRetry(item)
            requests.get(key)?.reject(new Error('PROJECTION_BUILD_CLAIM_FAILED'))
            requests.delete(key)
            return false
          }
        }
        if (!lease) {
          let state
          try { state = options.service.get(item.sessionId, item.scopeKey) }
          catch {
            reportFailure('PROJECTION_BUILD_STATE_UNAVAILABLE')
            scheduleRetry(item)
            return settleUnexpectedFailure(new Error('PROJECTION_BUILD_STATE_UNAVAILABLE'))
          }
          const error = state?.sessionGeneration === item.sessionGeneration && state.status === 'rejected' &&
            state.retryAfter !== null && state.retryAfter > options.now()
            ? Object.assign(new Error(`PROJECTION_BUILD_DEFERRED:${readFailureCaseId(state.failureCaseJson) ?? 'REJECTED'}`), {
              code: 'PROJECTION_BUILD_DEFERRED' as const, retryAfter: state.retryAfter,
            })
            : new Error('PROJECTION_BUILD_CLAIM_UNAVAILABLE')
          requests.get(key)?.reject(error)
          requests.delete(key)
          return false
        }
        claimFailures.delete(key)
        while (!stopped && !controller.signal.aborted) {
          const sliceStartedAt = options.monotonicNow?.() ?? performance.now()
          const sliceMetrics = { sourceRows: 0, sourceBytes: 0, sourceSnapshotDurationMs: 0, sourceWorkerDurationMs: 0, reducerWorkerDurationMs: 0,
            maxWorkerHeapUsedBytesAtExit: null as number | null, maxProcessRssBytesAtExit: null as number | null, workerSamples: 0 }
          const collectSample = (sample: ProjectionWorkerSample | undefined, owner: 'source' | 'reducer') => {
            if (!isWorkerSample(sample)) return
            if (owner === 'source') sliceMetrics.sourceWorkerDurationMs += sample.durationMs
            else sliceMetrics.reducerWorkerDurationMs += sample.durationMs
            sliceMetrics.maxWorkerHeapUsedBytesAtExit = Math.max(sliceMetrics.maxWorkerHeapUsedBytesAtExit ?? 0, sample.heapUsedBytesAtExit)
            sliceMetrics.maxProcessRssBytesAtExit = Math.max(sliceMetrics.maxProcessRssBytesAtExit ?? 0, sample.processRssBytesAtExit)
            sliceMetrics.workerSamples += 1
          }
          const readChunk: ProjectionHistoryChunkReaderPort = async (permit, readInput) => {
            const result = await options.readChunk(permit, readInput)
            if (result.kind === 'chunk') {
              sliceMetrics.sourceRows += result.events.length
              sliceMetrics.sourceBytes += result.byteLength
              sliceMetrics.sourceSnapshotDurationMs += result.snapshotDurationMs ?? 0
              collectSample(result.workerSample, 'source')
            }
            return result
          }
          const reduceChunk: ProjectionHistoryChunkReducerPort | undefined = options.reduceChunk
            ? async (...args) => {
              const result = await options.reduceChunk!(...args)
              collectSample(result.workerSample, 'reducer')
              return result
            }
            : undefined
          try {
            const result = await runProjectionBuildSlice({ service: options.service, lease, specVersion: item.specVersion,
              dbPath: options.dbPath, readChunk, historyReducer: options.historyReducer,
              reduceChunk,
              blobs: options.blobs, limits: options.limits, maxChunksPerSlice: options.maxChunksPerSlice,
              now: options.now, retryAfter: options.retryAfter, signal: controller.signal })
            try { options.onResult?.(item, result) } catch { /* Observability must not own the worker lifecycle. */ }
            const sliceDurationMs = Math.max(0, (options.monotonicNow?.() ?? performance.now()) - sliceStartedAt)
            const nextSequence = result.kind === 'checkpointed' || result.kind === 'published' ? result.checkpoint.nextSequence : null
            const sliceBudgetMs = options.sliceBudgetMs ?? Number.POSITIVE_INFINITY
            const yielded = result.kind === 'checkpointed' && sliceDurationMs >= sliceBudgetMs
            try { options.onSlice?.({ durationMs: sliceDurationMs, nextSequence, outcome: result.kind, yielded, ...sliceMetrics }) }
            catch { /* Metrics are observational and cannot own projection progress. */ }
            if (result.kind === 'publish-unknown') {
              scheduleRetry(item, lease)
              requests.get(key)?.resolve(result)
              requests.delete(key)
              return false
            }
            if (result.kind !== 'checkpointed') {
              requests.get(key)?.resolve(result)
              requests.delete(key)
              return true
            }
            if (yielded) {
              if (!options.service.releaseLease(lease)) {
                requests.get(key)?.resolve({ kind: 'lease-lost' })
                requests.delete(key)
                return true
              }
              retryWorkItems.set(key, item)
              await new Promise<void>((resolve) => setImmediate(resolve))
              return true
            }
          } catch {
            if (controller.signal.aborted) break
            reportFailure('PROJECTION_BUILD_SUPERVISOR_FAILED')
            let failureRecorded = false
            try {
              const current = options.service.get(item.sessionId, item.scopeKey)
              options.service.reject(lease, { failureCaseJson: JSON.stringify({ case: 'CONTENT_UNAVAILABLE', caseId: 'SUPERVISOR_FAILED' }),
                attempts: (current?.attempts ?? 0) + 1, retryAfter: options.retryAfter?.() ?? options.now() + 60_000 })
              failureRecorded = true
            } catch { /* A storage failure must not strand or crash the in-memory request queue. */ }
            if (!failureRecorded) scheduleRetry(item, lease)
            requests.get(key)?.reject(new Error('PROJECTION_BUILD_SUPERVISOR_FAILED'))
            requests.delete(key)
            return false
          }
        }
        if (stopped || controller.signal.aborted) {
          suspendedLeases.set(key, lease)
          suspendedItems.set(key, item)
        }
        requests.get(key)?.reject(controller.signal.reason ?? new Error('PROJECTION_BUILD_STOPPED'))
        requests.delete(key)
        return true
        } catch {
          reportFailure('PROJECTION_BUILD_SUPERVISOR_FAILED')
          return settleUnexpectedFailure(new Error('PROJECTION_BUILD_SUPERVISOR_FAILED'))
        }
      }
      loopPromise = (async () => {
        while (!stopped) {
          const requested = requests.values().next().value as { item: ProjectionBuildWorkItem } | undefined
          if (requested) { await runItem(requested.item); continue }
          const retryItem = retryWorkItems.values().next().value as ProjectionBuildWorkItem | undefined
          if (retryItem) { retryWorkItems.delete(keyOf(retryItem)); await runItem(retryItem); continue }
          const work = readDueWork().filter((item) => !delayedRetryKeys.has(keyOf(item)))
          if (!work.length) {
            await waitForWorkOrRetry()
            continue
          }
          let claimedAny = false
          for (const item of work) {
            if (stopped) break
            if (requests.has(keyOf(item))) continue
            claimedAny = await runItem(item) || claimedAny
          }
          if (!stopped && requests.size > 0) continue
          if (!stopped && (!claimedAny || readDueWork().length === 0)) await waitForWorkOrRetry()
        }
      })()
      const handle: ProjectionBuildTaskHandle = Object.freeze({
        stop: () => {
          stopped = true
          const error = new Error('PROJECTION_BUILD_STOPPED')
          controller.abort(error)
          for (const timer of retryTimers.values()) clearTimeout(timer)
          retryTimers.clear()
          delayedRetryKeys.clear()
          if (retryWakeTimer) clearTimeout(retryWakeTimer)
          retryWakeTimer = undefined
          for (const request of requests.values()) request.reject(error)
          requests.clear()
          wakeResolve?.(); wakeResolve = undefined
        },
        quiesce: async () => {
          await loopPromise
          for (const [key, lease] of suspendedLeases) {
            try {
              if (!options.service.releaseLease(lease)) continue
              suspendedLeases.delete(key)
              suspendedItems.delete(key)
              retryWorkItems.delete(key)
            } catch {
              reportFailure('PROJECTION_BUILD_STOP_CLEANUP_FAILED')
            }
          }
          for (const key of suspendedItems.keys()) {
            if (suspendedLeases.has(key)) continue
            suspendedItems.delete(key)
            retryWorkItems.delete(key)
          }
        },
        request: wake,
      })
      active = { handle, wake }
      const clearActive = () => { if (active?.handle === handle) active = undefined }
      void loopPromise.then(clearActive, clearActive)
      return handle
    }
  })
}

function isWorkerSample(sample: ProjectionWorkerSample | undefined): sample is ProjectionWorkerSample {
  return !!sample && Number.isFinite(sample.durationMs) && sample.durationMs >= 0 &&
    Number.isSafeInteger(sample.heapUsedBytesAtExit) && sample.heapUsedBytesAtExit >= 0 &&
    Number.isSafeInteger(sample.processRssBytesAtExit) && sample.processRssBytesAtExit >= 0
}

function readFailureCaseId(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const caseId = (parsed as { caseId?: unknown }).caseId
    return typeof caseId === 'string' && /^[A-Z0-9_]{1,80}$/.test(caseId) ? caseId : undefined
  } catch { return undefined }
}
