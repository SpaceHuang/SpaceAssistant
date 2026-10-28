import { describe, expect, it, vi } from 'vitest'
import { startEventLoopWatchdog } from './eventLoopWatchdog'

function fakeHistogram(percentile99Ms: number, maxMs = 0) {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn((p: number) => (p === 99 ? percentile99Ms * 1e6 : 0)),
    max: maxMs * 1e6
  } as unknown as import('node:perf_hooks').IntervalHistogram
}

describe('event loop watchdog (P3-③)', () => {
  it('logs a warning when the p99 delay crosses the threshold', async () => {
    const onBreach = vi.fn()
    const watchdog = startEventLoopWatchdog({
      thresholdMs: 200, checkIntervalMs: 10,
      histogram: fakeHistogram(350), onBreach
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    watchdog.stop()
    expect(onBreach).toHaveBeenCalledWith(expectCloseTo(350), expectCloseTo(0))
  })

  it('logs a single long stall even when it does not move p99 above the threshold', async () => {
    const onBreach = vi.fn()
    const watchdog = startEventLoopWatchdog({
      thresholdMs: 200, checkIntervalMs: 10,
      histogram: fakeHistogram(40, 14_000), onBreach
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    watchdog.stop()
    expect(onBreach).toHaveBeenCalledWith(expectCloseTo(40), expectCloseTo(14_000))
  })

  it('stays silent while the loop is within budget', async () => {
    const onBreach = vi.fn()
    const watchdog = startEventLoopWatchdog({
      thresholdMs: 200, checkIntervalMs: 10,
      histogram: fakeHistogram(40), onBreach
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    watchdog.stop()
    expect(onBreach).not.toHaveBeenCalled()
  })

  it('stops sampling and disables the histogram on stop', async () => {
    const histogram = fakeHistogram(0)
    const watchdog = startEventLoopWatchdog({ checkIntervalMs: 10, histogram, onBreach: vi.fn() })
    watchdog.stop()
    expect(histogram.disable).toHaveBeenCalled()
    const breaches = vi.fn()
    const second = startEventLoopWatchdog({ checkIntervalMs: 10, histogram, onBreach: breaches })
    await new Promise((resolve) => setTimeout(resolve, 30))
    second.stop()
    expect(breaches).not.toHaveBeenCalled()
  })
})

function expectCloseTo(expected: number): { asymmetricMatch: (actual: number) => boolean } {
  return {
    asymmetricMatch: (actual: number) => Math.abs(actual - expected) < 1
  }
}
