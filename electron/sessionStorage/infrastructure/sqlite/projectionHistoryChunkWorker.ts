import { parentPort } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { readProjectionHistoryChunk, type ProjectionHistoryChunkPermit } from './projectionHistoryChunkReader'

if (!parentPort) throw new Error('projection history worker requires a parent port')

parentPort.once('message', (message: {
  requestId: string
  permit: ProjectionHistoryChunkPermit
  input: { afterSessionSequence: number; maxRows: number; maxBytes: number }
}) => {
  const startedAt = performance.now()
  const result = readProjectionHistoryChunk(message.permit, message.input)
  const workerSample = { durationMs: Math.max(0, performance.now() - startedAt),
    heapUsedBytesAtExit: getHeapStatistics().used_heap_size, processRssBytesAtExit: process.memoryUsage.rss() }
  parentPort!.postMessage({ requestId: message.requestId, result, workerSample })
  parentPort!.close()
})
