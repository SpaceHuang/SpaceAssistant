import { parentPort, threadId } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'

if (!parentPort) throw new Error('projection history reducer worker requires a parent port')

parentPort.once('message', (message: {
  requestId: string
  stateJson: string
  events: readonly ProjectionHistoryChunkEvent[]
  messageFacts: readonly ProjectionMessageFact[]
  scopeKey: string
  finalize: boolean
}) => {
  const startedAt = performance.now()
  try {
    const reducer = createProjectionScopeHistoryReducer()
    const folded = reducer.fold(message.stateJson, message.events, message.messageFacts, message.scopeKey)
    const finalizedOutputOperations = message.finalize
      ? reducer.finalize(folded.stateJson, message.scopeKey).outputOperations
      : undefined
    parentPort!.postMessage({ requestId: message.requestId, result: { ...folded,
      ...(finalizedOutputOperations ? { finalizedOutputOperations } : {}), workerThreadId: threadId,
      workerSample: { durationMs: Math.max(0, performance.now() - startedAt),
        heapUsedBytesAtExit: getHeapStatistics().used_heap_size, processRssBytesAtExit: process.memoryUsage.rss() } } })
  } catch (error) {
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_REDUCER_FAILED' })
  } finally {
    parentPort!.close()
  }
})
