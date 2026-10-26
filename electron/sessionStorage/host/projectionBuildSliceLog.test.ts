import { describe, expect, it } from 'vitest'
import { projectionBuildSliceLogFields } from './projectionBuildSliceLog'

describe('projection build slice log fields', () => {
  it('preserves bounded cost and sampled memory evidence without chat payloads', () => {
    expect(projectionBuildSliceLogFields({ durationMs: 3.14159, nextSequence: 12, outcome: 'checkpointed', yielded: true,
      sourceRows: 200, sourceBytes: 17_500_000, sourceSnapshotDurationMs: 1.234,
      sourceWorkerDurationMs: 70.126, reducerWorkerDurationMs: 104.987, finalViewMaterializationDurationMs: 220.456,
      maxWorkerHeapUsedBytesAtExit: 76_000_000, maxProcessRssBytesAtExit: 920_000_000,
      maxWorkerHeapUsedBytesPeakSampled: 80_000_000, maxProcessRssBytesPeakSampled: 925_000_000,
      memorySampleIntervalMs: 10, workerSamples: 3 })).toEqual({
      durationMs: 3.14, nextSequence: 12, outcome: 'checkpointed', yielded: true,
      sourceRows: 200, sourceBytes: 17_500_000, sourceSnapshotDurationMs: 1.23,
      sourceWorkerDurationMs: 70.13, reducerWorkerDurationMs: 104.99, finalViewMaterializationDurationMs: 220.46,
      maxWorkerHeapUsedBytesAtExit: 76_000_000, maxProcessRssBytesAtExit: 920_000_000,
      maxWorkerHeapUsedBytesPeakSampled: 80_000_000, maxProcessRssBytesPeakSampled: 925_000_000,
      memorySampleIntervalMs: 10, workerSamples: 3,
    })
  })
})
