import { threadId } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'
import { reduceProjectionHistoryChunkInWorker } from './projectionHistoryReducerWorkerClient'

describe('projection History reducer worker client', () => {
  it('folds and finalizes a bounded chunk off the main thread', async () => {
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const reducer = createProjectionScopeHistoryReducer()
    const events: ProjectionHistoryChunkEvent[] = [
      { invocationId: 'worker-invocation', sequence: 1, eventId: 'worker-context', idempotencyKey: 'worker-context',
        turnId: 'worker-turn', schemaVersion: 1, kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1,
        createdAt: 1, payloadJson: JSON.stringify({ messages: [{ id: 'worker-user', role: 'user', content: 'hello', timestamp: 1 }] }) },
      { invocationId: 'worker-invocation', sequence: 2, eventId: 'worker-terminal', idempotencyKey: 'worker-terminal',
        turnId: 'worker-turn', schemaVersion: 1, kind: 'invocation-completed', sessionSequence: 2, commitOrder: 2,
        createdAt: 2, payloadJson: JSON.stringify({ status: 'completed' }) },
    ]
    const messageFacts: ProjectionMessageFact[] = [{ id: 'worker-user', role: 'user', timestamp: 1, sequence: 0,
      queueScope: 'main', contentStorageState: 'legacy', writeMode: null, storedContent: 'hello' }]

    const result = await reduceProjectionHistoryChunkInWorker(reducer.createState(scopeKey), events, messageFacts, scopeKey, true)

    expect(result.stateJson).not.toBe(reducer.createState(scopeKey))
    expect(result.workerThreadId).toBeGreaterThan(0)
    expect(result.workerThreadId).not.toBe(threadId)
    expect(result.outputOperations).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'replace' })]))
    expect(result.finalizedOutputOperations).toEqual(expect.any(Array))
  })
})
