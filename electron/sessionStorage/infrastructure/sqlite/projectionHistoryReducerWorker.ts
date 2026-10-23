import { parentPort, threadId } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import type { ProjectionPendingHistoryChunkManifestRef } from '../../domain/projectionBuild'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'

if (!parentPort) throw new Error('projection history reducer worker requires a parent port')

parentPort.once('message', (message: {
  requestId: string
  stateJson: string
  events: readonly ProjectionHistoryChunkEvent[]
  messageFacts: readonly ProjectionMessageFact[]
  scopeKey: string
  finalize: boolean
  stagedChunk?: Readonly<{ root: string; manifest: ProjectionPendingHistoryChunkManifestRef }>
}) => {
  void (async () => {
    const startedAt = performance.now()
    const reducer = createProjectionScopeHistoryReducer()
    let events = message.events
    let messageFacts = message.messageFacts
    if (message.stagedChunk) {
      const { root, manifest } = message.stagedChunk
      if (manifest.scopeKey !== message.scopeKey || !/^projection-[0-9a-f-]{36}\.blob$/.test(manifest.locator) ||
        path.basename(manifest.locator) !== manifest.locator) throw new Error('PROJECTION_PENDING_CHUNK_REFERENCE_INVALID')
      let bytes: Buffer
      try { bytes = await fs.readFile(path.join(path.resolve(root), manifest.locator)) }
      catch { throw new Error('PROJECTION_PENDING_CHUNK_UNAVAILABLE') }
      if (bytes.byteLength !== manifest.byteLength || createHash('sha256').update(bytes).digest('hex') !== manifest.payloadDigest) {
        throw new Error('PROJECTION_PENDING_CHUNK_DIGEST_MISMATCH')
      }
      let payload: { events?: unknown; messageFacts?: unknown }
      try { payload = JSON.parse(bytes.toString('utf8')) as typeof payload }
      catch { throw new Error('PROJECTION_PENDING_CHUNK_INVALID_JSON') }
      if (!Array.isArray(payload.events) || !Array.isArray(payload.messageFacts) || payload.events.length !== manifest.rowCount ||
        payload.events.some((event, index) => !event || typeof event !== 'object' ||
          (event as ProjectionHistoryChunkEvent).sessionSequence !== manifest.fromSequence + index + 1) ||
        (payload.events.at(-1) as ProjectionHistoryChunkEvent | undefined)?.sessionSequence !== manifest.nextSequence) {
        throw new Error('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
      }
      events = payload.events as ProjectionHistoryChunkEvent[]
      messageFacts = payload.messageFacts as ProjectionMessageFact[]
    }
    const folded = reducer.fold(message.stateJson, events, messageFacts, message.scopeKey)
    const finalizedOutputOperations = message.finalize
      ? reducer.finalize(folded.stateJson, message.scopeKey).outputOperations
      : undefined
    parentPort!.postMessage({ requestId: message.requestId, result: { ...folded,
      ...(finalizedOutputOperations ? { finalizedOutputOperations } : {}), workerThreadId: threadId,
      workerSample: { durationMs: Math.max(0, performance.now() - startedAt),
        heapUsedBytesAtExit: getHeapStatistics().used_heap_size, processRssBytesAtExit: process.memoryUsage.rss() } } })
    parentPort!.close()
  })().catch((error) => {
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_REDUCER_FAILED' })
    parentPort!.close()
  })
})
