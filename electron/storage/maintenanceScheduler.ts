import { createLifecycleTaskHandle } from '../sessionStorage/lifecycle'
import type { MaintenanceReason } from '../sessionStorage/contracts'
import { recordMaintenanceFailure, recordMaintenanceSuccess, shouldRunMaintenance, type MaintenanceWatermarkInput } from './maintenanceWatermark'

export type MaintenanceJobResult = Readonly<{ success: boolean; scannedCount: number; processedCount: number; errorCode?: string }>
type MaintenanceRunContext = Readonly<{ reason: MaintenanceReason; signal: AbortSignal }>

export function toLocalDayString(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function nextLocalDayBoundary(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime()
}

export function createMaintenanceScheduler(input: {
  watermarkPath: string
  policyFingerprint(): string | Promise<string>
  rootFingerprint?(): string | undefined
  algorithmVersion: number
  run(context: MaintenanceRunContext): Promise<MaintenanceJobResult>
  now?: () => number
  retryDelayMs?: number
  maxRetryDelayMs?: number
  onResult?(result: MaintenanceJobResult | { success: true; skipped: true; scannedCount: 0; processedCount: 0 }): void
}) {
  const now = input.now ?? Date.now
  const retryDelay = input.retryDelayMs ?? 60_000
  const maxRetryDelay = input.maxRetryDelayMs ?? 60 * 60_000
  return Object.freeze({
    start() {
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let inFlight: Promise<void> | undefined
      let controller: AbortController | undefined
      let pendingReason: MaintenanceReason | undefined
      let retryCount = 0

      const schedule = (delay: number) => {
        if (stopped) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { void run() }, Math.max(0, delay))
      }
      const scheduleNextDay = () => schedule(Math.max(1, nextLocalDayBoundary(now()) - now()))
      const run = async () => {
        if (stopped || inFlight) return
        const reason = pendingReason ?? 'startup'
        pendingReason = undefined
        controller = new AbortController()
        inFlight = (async () => {
          let watermarkInput: MaintenanceWatermarkInput | undefined
          try {
            watermarkInput = {
              localDay: toLocalDayString(now()),
              policyFingerprint: await input.policyFingerprint(),
              rootFingerprint: input.rootFingerprint?.(),
              algorithmVersion: input.algorithmVersion
            }
            const forced = reason === 'policy-changed' || reason === 'scope-changed' || reason === 'capacity-pressure' || reason === 'retry'
            if (!forced && !await shouldRunMaintenance(input.watermarkPath, watermarkInput)) {
              input.onResult?.({ success: true, skipped: true, scannedCount: 0, processedCount: 0 })
              scheduleNextDay()
              return
            }
            const result = await input.run({ reason, signal: controller!.signal })
            input.onResult?.(result)
            if (result.success) {
              await recordMaintenanceSuccess(input.watermarkPath, watermarkInput, now())
              retryCount = 0
              scheduleNextDay()
            } else {
              await recordMaintenanceFailure(input.watermarkPath, watermarkInput, result.errorCode ?? 'MAINTENANCE_FAILED', now())
              retryCount += 1
              schedule(Math.min(maxRetryDelay, retryDelay * 2 ** Math.min(retryCount - 1, 10)))
            }
          } catch (error) {
            const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code : error instanceof Error ? error.name : 'MAINTENANCE_FAILED'
            if (watermarkInput) await recordMaintenanceFailure(input.watermarkPath, watermarkInput, failureCode, now()).catch(() => undefined)
            input.onResult?.({ success: false, scannedCount: 0, processedCount: 0, errorCode: failureCode })
            retryCount += 1
            schedule(Math.min(maxRetryDelay, retryDelay * 2 ** Math.min(retryCount - 1, 10)))
          } finally {
            inFlight = undefined
            controller = undefined
            if (pendingReason) schedule(0)
          }
        })()
        await inFlight
      }

      schedule(0)
      return createLifecycleTaskHandle(() => {
        stopped = true
        controller?.abort()
        if (timer) clearTimeout(timer)
      }, async () => { await inFlight }, (reason) => {
        if (stopped) return
        pendingReason = reason
        if (!inFlight) schedule(0)
      })
    }
  })
}
