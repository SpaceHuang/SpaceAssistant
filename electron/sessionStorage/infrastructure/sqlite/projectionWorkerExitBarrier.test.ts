import { it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ workers: [] as any[] }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    constructor(..._args: unknown[]) { super(); state.workers.push(this) }
    postMessage(message: any) {
      queueMicrotask(() => this.emit('message', { requestId: message.requestId, result: message.stateJson !== undefined
        ? { stateJson: '{}', outputOperations: [], resetOutput: false, workerThreadId: 1 }
        : { payload: '{}', byteLength: 2, payloadDigest: 'a'.repeat(64), workerThreadId: 1 } }))
    }
    terminate() { this.emit('exit', 1); return Promise.resolve(1) }
  } }
})
import { reduceProjectionHistoryChunkInWorker } from './projectionHistoryReducerWorkerClient'
import { materializeProjectionFinalViewInWorker } from './projectionFinalViewWorkerClient'

for (const kind of ['reducer', 'final'] as const) it(`waits for actual worker exit: ${kind}`, async () => {
  let settled = false
  const promise = kind === 'reducer'
    ? reduceProjectionHistoryChunkInWorker('{}', [], [], 'scope', false)
    : materializeProjectionFinalViewInWorker({ root: '/tmp', output: { locator: 'x', byteLength: 1, payloadDigest: 'a'.repeat(64) },
      identity: { sessionId: 's', sessionGeneration: 'g', scopeKey: 'scope', specVersion: 1, sourceIdentityJson: '{}' }, historyWatermarkJson: null })
  const observed = promise.then(() => { settled = true })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally {
    state.workers.at(-1)?.emit('exit', 0)
    await observed
  }
})
