import { describe, expect, it, vi } from 'vitest'
import { measureSerialAdmission, nearestRankP95 } from './sessionLedgerAdmissionBenchmark'

describe('session ledger admission benchmark helpers', () => {
  it('uses nearest-rank p95 and refuses a missing or undersized sample', async () => {
    expect(nearestRankP95([8, 1, 7, 2, 6, 3, 5, 4, 9, 10])).toBe(10)
    expect(() => nearestRankP95([])).toThrow('SESSION_LEDGER_BENCHMARK_SAMPLES_REQUIRED')
    await expect(measureSerialAdmission(async () => undefined, { warmup: 0, samples: 199 }))
      .rejects.toThrow('SESSION_LEDGER_BENCHMARK_SAMPLE_COUNT_INVALID')
  })

  it('runs warmup and measured samples serially and reports the exact sample count', async () => {
    const runAdmission = vi.fn(async () => undefined)
    const result = await measureSerialAdmission(runAdmission, { warmup: 3, samples: 200 })
    expect(runAdmission).toHaveBeenCalledTimes(203)
    expect(result.sampleCount).toBe(200)
    expect(result.warmupCount).toBe(3)
    expect(result.quantile).toBe('nearest-rank-p95')
    expect(Number.isFinite(result.p95Ms)).toBe(true)
  })
})
