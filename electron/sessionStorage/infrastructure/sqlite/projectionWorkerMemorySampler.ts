import { getHeapStatistics } from 'node:v8'

export const PROJECTION_WORKER_MEMORY_SAMPLE_INTERVAL_MS = 10

export type ProjectionWorkerMemorySample = Readonly<{
  heapUsedBytesAtExit: number
  processRssBytesAtExit: number
  heapUsedBytesPeakSampled: number
  processRssBytesPeakSampled: number
  memorySampleIntervalMs: number
}>

/** Samples isolate heap and process RSS while a bounded worker request is active; sampled peaks are not absolute peaks. */
export function createProjectionWorkerMemorySampler(): Readonly<{
  finish(): ProjectionWorkerMemorySample
}> {
  let peakHeap = 0
  let peakRss = 0
  const sample = () => {
    peakHeap = Math.max(peakHeap, getHeapStatistics().used_heap_size)
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }
  sample()
  const timer = setInterval(sample, PROJECTION_WORKER_MEMORY_SAMPLE_INTERVAL_MS)
  timer.unref()
  let finished: ProjectionWorkerMemorySample | undefined
  return Object.freeze({
    finish() {
      if (finished) return finished
      sample()
      clearInterval(timer)
      const heapUsedBytesAtExit = getHeapStatistics().used_heap_size
      const processRssBytesAtExit = process.memoryUsage.rss()
      peakHeap = Math.max(peakHeap, heapUsedBytesAtExit)
      peakRss = Math.max(peakRss, processRssBytesAtExit)
      finished = Object.freeze({ heapUsedBytesAtExit, processRssBytesAtExit,
        heapUsedBytesPeakSampled: peakHeap, processRssBytesPeakSampled: peakRss,
        memorySampleIntervalMs: PROJECTION_WORKER_MEMORY_SAMPLE_INTERVAL_MS })
      return finished
    },
  })
}
