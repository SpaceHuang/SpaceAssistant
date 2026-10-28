export type SessionLedgerAdmissionMeasurement = Readonly<{
  sampleCount: number
  warmupCount: number
  quantile: 'nearest-rank-p95'
  p95Ms: number
  durationsMs: readonly number[]
}>

export function nearestRankP95(values: readonly number[]): number {
  if (values.length === 0) throw new Error('SESSION_LEDGER_BENCHMARK_SAMPLES_REQUIRED')
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!
}

/** Runs one admission call at a time; missing/undersized samples cannot be reported as a pass. */
export async function measureSerialAdmission(runAdmission: () => Promise<unknown>, options: {
  warmup: number
  samples: number
}): Promise<SessionLedgerAdmissionMeasurement> {
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0 ||
      !Number.isSafeInteger(options.samples) || options.samples < 200) {
    throw new Error('SESSION_LEDGER_BENCHMARK_SAMPLE_COUNT_INVALID')
  }
  for (let index = 0; index < options.warmup; index += 1) await runAdmission()
  const durationsMs: number[] = []
  for (let index = 0; index < options.samples; index += 1) {
    const startedAt = performance.now()
    await runAdmission()
    durationsMs.push(performance.now() - startedAt)
  }
  if (durationsMs.length !== options.samples) throw new Error('SESSION_LEDGER_BENCHMARK_SAMPLE_COUNT_MISMATCH')
  return Object.freeze({ sampleCount: durationsMs.length, warmupCount: options.warmup,
    quantile: 'nearest-rank-p95', p95Ms: nearestRankP95(durationsMs), durationsMs: Object.freeze(durationsMs) })
}
