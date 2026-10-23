import { parentPort } from 'node:worker_threads'
import { getHeapStatistics } from 'node:v8'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readProjectionHistoryChunk, type ProjectionHistoryChunkPermit } from './projectionHistoryChunkReader'

if (!parentPort) throw new Error('projection history worker requires a parent port')

parentPort.once('message', (message: {
  requestId: string
  permit: ProjectionHistoryChunkPermit
  input: { afterSessionSequence: number; maxRows: number; maxBytes: number; staging?: { root: string; tempLocator: string } }
}) => {
  void (async () => {
    const startedAt = performance.now()
    let result = readProjectionHistoryChunk(message.permit, { ...message.input, allowOversizedChunk: !!message.input.staging })
    if (result.kind === 'chunk' && result.byteLength > message.input.maxBytes && message.input.staging) {
      const root = path.resolve(message.input.staging.root)
      const tempLocator = message.input.staging.tempLocator
      if (!/^\.projection-[0-9a-f-]{36}\.tmp$/.test(tempLocator) || path.basename(tempLocator) !== tempLocator) {
        throw new Error('PROJECTION_HISTORY_STAGE_LOCATOR_INVALID')
      }
      const payload = JSON.stringify({ events: result.events, messageFacts: result.messageFacts })
      const bytes = Buffer.from(payload, 'utf8')
      if (bytes.byteLength > 32 * 1024 * 1024) {
        result = { kind: 'deferred-large', permit: result.permit, afterSessionSequence: result.afterSessionSequence,
          eventSequence: result.events[0]?.sessionSequence, observedByteLength: result.byteLength,
          observedEventRows: result.events.length, reason: 'staged-source-payload-exceeds-worker-budget' }
      } else {
      const file = await fs.open(path.join(root, tempLocator), 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      result = { kind: 'staged-chunk', permit: result.permit, afterSessionSequence: result.afterSessionSequence,
        nextSessionSequence: result.nextSessionSequence, rowCount: result.events.length, sourceByteLength: result.byteLength,
        hasMore: result.hasMore, stagedBlob: { tempLocator, byteLength: bytes.byteLength, payloadDigest } }
      }
    }
    const workerSample = { durationMs: Math.max(0, performance.now() - startedAt),
      heapUsedBytesAtExit: getHeapStatistics().used_heap_size, processRssBytesAtExit: process.memoryUsage.rss() }
    parentPort!.postMessage({ requestId: message.requestId, result, workerSample })
    parentPort!.close()
  })().catch((error) => {
    parentPort!.postMessage({ requestId: message.requestId, error: error instanceof Error ? error.message : 'PROJECTION_HISTORY_WORKER_FAILED' })
    parentPort!.close()
  })
})
