import type { ProjectionBuildSupervisorOptions } from '../application/projectionBuildSupervisor'

type ProjectionBuildSlice = Parameters<NonNullable<ProjectionBuildSupervisorOptions['onSlice']>>[0]

/** Keep bounded build-cost evidence in diagnostics; this payload contains no History or chat body data. */
export function projectionBuildSliceLogFields(slice: ProjectionBuildSlice) {
  return Object.freeze({
    durationMs: roundMs(slice.durationMs),
    nextSequence: slice.nextSequence,
    outcome: slice.outcome,
    yielded: slice.yielded,
    sourceRows: slice.sourceRows,
    sourceBytes: slice.sourceBytes,
    sourceSnapshotDurationMs: roundMs(slice.sourceSnapshotDurationMs),
    sourceWorkerDurationMs: roundMs(slice.sourceWorkerDurationMs),
    reducerWorkerDurationMs: roundMs(slice.reducerWorkerDurationMs),
    finalViewMaterializationDurationMs: roundMs(slice.finalViewMaterializationDurationMs),
    maxWorkerHeapUsedBytesAtExit: slice.maxWorkerHeapUsedBytesAtExit,
    maxProcessRssBytesAtExit: slice.maxProcessRssBytesAtExit,
    maxWorkerHeapUsedBytesPeakSampled: slice.maxWorkerHeapUsedBytesPeakSampled,
    maxProcessRssBytesPeakSampled: slice.maxProcessRssBytesPeakSampled,
    memorySampleIntervalMs: slice.memorySampleIntervalMs,
    workerSamples: slice.workerSamples,
  })
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}
