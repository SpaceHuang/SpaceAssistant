import { it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ workers: [] as any[] }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    constructor(..._args: unknown[]) { super(); state.workers.push(this) }
    postMessage(message: any) {
      queueMicrotask(() => this.emit('message', { requestId: message.requestId, result: message.stateJson !== undefined
        ? { stateJson: '{}', outputOperations: [], resetOutput: false, workerThreadId: 1 }
        : message.messageIds !== undefined ? { messages: message.messageIds.map((id: string) => ({ id, role: 'user', content: 'body', timestamp: 1 })), workerThreadId: 1 }
          : { payload: '{}', byteLength: 2, payloadDigest: 'a'.repeat(64), workerThreadId: 1 } }))
    }
    terminate() { this.emit('exit', 1); return Promise.resolve(1) }
  } }
})
import { reduceProjectionHistoryChunkInWorker } from './projectionHistoryReducerWorkerClient'
import { materializeProjectionFinalViewInWorker } from './projectionFinalViewWorkerClient'
import { readPreparedChatBodiesInWorker } from './projectionChatBodyCacheWorkerClient'

for (const kind of ['reducer', 'final', 'chat-body-cache'] as const) it(`waits for actual worker exit: ${kind}`, async () => {
  let settled = false
  const promise = kind === 'reducer'
    ? reduceProjectionHistoryChunkInWorker('{}', [], [], 'scope', false)
    : kind === 'final' ? materializeProjectionFinalViewInWorker({ root: '/tmp', output: { locator: 'x', byteLength: 1, payloadDigest: 'a'.repeat(64) },
      identity: { sessionId: 's', sessionGeneration: 'g', scopeKey: 'scope', specVersion: 1, sourceIdentityJson: '{}' }, historyWatermarkJson: null })
      : readPreparedChatBodiesInWorker({ root: '/tmp', messageIds: ['m'], view: { sessionId: 's', sessionGeneration: 'g', scopeKey: 'scope',
        specVersion: 1, sourceIdentityJson: '{}', payloadGeneration: 'projection-x', payloadDigest: 'a'.repeat(64), validatedRangeJson: '{}',
        cachePresent: true, stateSourceIdentityJson: '{}', statePayloadGeneration: 'projection-x', statePayloadDigest: 'a'.repeat(64),
        stateValidatedRangeJson: '{}', inlinePayload: '{}' } })
  const observed = promise.then(() => { settled = true })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally {
    state.workers.at(-1)?.emit('exit', 0)
    await observed
  }
})
