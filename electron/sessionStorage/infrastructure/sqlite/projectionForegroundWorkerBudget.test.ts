import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ workers: [] as Array<{ emit(event: string, ...args: unknown[]): boolean }> }))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { Worker: class extends Emitter {
    constructor(..._args: unknown[]) { super(); state.workers.push(this) }
    unref() { return this }
    postMessage(message: { requestId: string; messageIds?: string[]; fragments?: Array<{ id: string }> }) {
      const ids = message.messageIds ?? message.fragments?.map(({ id }) => id) ?? []
      queueMicrotask(() => this.emit('message', { requestId: message.requestId,
        result: { messages: ids.map((id) => ({ id, role: 'user', content: `body:${id}`, timestamp: 1 })), workerThreadId: 1 } }))
    }
    terminate() { this.emit('exit', 1); return Promise.resolve(1) }
  } }
})

import { readPreparedChatBodiesInWorker } from './projectionChatBodyCacheWorkerClient'
import { readProjectionSourceChatBodiesInWorker } from './projectionSourceChatBodyWorkerClient'
import { withProjectionForegroundWorkerBudget } from './projectionForegroundWorkerBudget'

describe('projection foreground worker budget', () => {
  afterEach(() => { for (const worker of state.workers) worker.emit('exit', 0); state.workers.splice(0) })

  it('serializes cache-page and cold-source workers until each worker exits', async () => {
    const cacheRead = readPreparedChatBodiesInWorker({ root: '/tmp', messageIds: ['cache-message'], view: {
      sessionId: 'budget-session', sessionGeneration: 'budget-generation', scopeKey: 'chatBodyV1', specVersion: 4,
      sourceIdentityJson: '{}', payloadGeneration: 'projection-budget', payloadDigest: 'a'.repeat(64), validatedRangeJson: '{}',
      cachePresent: true, stateSourceIdentityJson: '{}', statePayloadGeneration: 'projection-budget', statePayloadDigest: 'a'.repeat(64),
      stateValidatedRangeJson: '{}', inlinePayload: 'x'.repeat(256 * 1024 + 1),
    } })
    const sourceRead = readProjectionSourceChatBodiesInWorker({ root: '/tmp', sessionId: 'budget-session',
      sessionGeneration: 'budget-generation', sourceRevision: 1, expectedMessageIds: ['source-message'], sourceTruthSpills: [],
      fragments: [{ id: 'source-message', sequence: 0, locator: 'projection-123e4567-e89b-12d3-a456-426614174000.blob',
        byteLength: 1, sha256: 'b'.repeat(64) }] })

    await vi.waitFor(() => expect(state.workers).toHaveLength(1))
    expect(state.workers).toHaveLength(1)
    expect(state.workers[0]!.emit('exit', 0)).toBe(true)
    await vi.waitFor(() => expect(state.workers).toHaveLength(2))
    expect(state.workers).toHaveLength(2)
    state.workers[1]!.emit('exit', 0)

    await expect(Promise.all([cacheRead, sourceRead])).resolves.toMatchObject([
      { messages: [{ id: 'cache-message', content: 'body:cache-message' }] },
      { messages: [{ id: 'source-message', content: 'body:source-message' }] },
    ])
  })

  it('bounds queued foreground work and lets a cancelled waiter leave without stopping its neighbor', async () => {
    let releaseActive!: () => void
    let started = 0
    const active = withProjectionForegroundWorkerBudget(() => new Promise<void>((resolve) => { releaseActive = resolve }))
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf('function'))
    const controller = new AbortController()
    const cancelled = withProjectionForegroundWorkerBudget(async () => { started += 1 }, { signal: controller.signal })
    const queued = Array.from({ length: 15 }, () => withProjectionForegroundWorkerBudget(async () => { started += 1 }))
    await expect(withProjectionForegroundWorkerBudget(async () => { started += 1 })).rejects.toThrow('PROJECTION_FOREGROUND_WORKER_QUEUE_FULL')

    controller.abort(new Error('caller cancelled'))
    await expect(cancelled).rejects.toThrow('caller cancelled')
    releaseActive()
    await expect(Promise.all([active, ...queued])).resolves.toHaveLength(16)
    expect(started).toBe(15)
  })
})
