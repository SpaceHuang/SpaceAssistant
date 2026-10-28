import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { logAgentEvent } from '../agentLogger/agentLogger'

/**
 * P3-③ observation gate (plan §5 P3 ③ / R-06, R-07): a resident event-loop delay sampler so
 * any O(session) computation that blocks the main process shows up in the agent log as a
 * warning, with the thresholds the release gate needs. The histogram source is injectable so
 * tests can drive breaches without timing flakiness.
 */

export type EventLoopWatchdogOptions = {
  /** p99 or single-interval maximum delay above which a breach is logged. */
  thresholdMs?: number
  /** How often the histogram is inspected. */
  checkIntervalMs?: number
  histogram?: IntervalHistogram
  onBreach?: (p99Ms: number, maxMs: number) => void
}

export type EventLoopWatchdog = Readonly<{ stop: () => void }>

export function startEventLoopWatchdog(options: EventLoopWatchdogOptions = {}): EventLoopWatchdog {
  const thresholdMs = options.thresholdMs ?? 200
  const checkIntervalMs = options.checkIntervalMs ?? 30_000
  const onBreach = options.onBreach ?? ((p99Ms: number, maxMs: number) => {
    try {
      logAgentEvent('warn', 'eventloop.delay', { p99Ms: Math.round(p99Ms), maxMs: Math.round(maxMs), thresholdMs })
    } catch { /* Observation logging cannot change the sampled loop. */ }
  })

  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  const timer = setInterval(() => {
    const p99Ms = histogram.percentile(99) / 1e6
    const maxMs = histogram.max / 1e6
    if (p99Ms >= thresholdMs || maxMs >= thresholdMs) onBreach(p99Ms, maxMs)
    histogram.reset()
  }, checkIntervalMs)
  timer.unref?.()

  return {
    stop: () => {
      clearInterval(timer)
      histogram.disable()
    }
  }
}
