import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../../database/testHelpers'
import { createSession } from '../../database/operations'
import { createSqliteProjectionStateStore } from '../infrastructure/sqlite/sessionProjectionStateStore'
import { createProjectionService } from './projectionService'
import { runProjectionBuildSlice } from './projectionBuildCoordinator'

describe('projection reducer cancellation', () => {
  it('preserves resumable state when stopping during reducer work', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'reducer cancel' })
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'token', now: () => 1
      })
      const lease = service.beginRebuild({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-a' })!
      const controller = new AbortController()
      const result = await runProjectionBuildSlice({
        service, lease, specVersion: 1, dbPath: db.filePath,
        historyReducer: { createState: () => '{}', fold: () => { throw new Error('unused') }, finalize: () => ({ outputOperations: [] }) },
        readChunk: async (permit) => ({ kind: 'chunk', permit, afterSessionSequence: 0, nextSessionSequence: 1,
          hasMore: false, byteLength: 100, events: [{ invocationId: 'inv', turnId: 'turn', sequence: 1, eventId: 'event',
            idempotencyKey: 'event', schemaVersion: 1, kind: 'invocation-completed', payloadJson: '{}', sessionSequence: 1,
            commitOrder: 1, createdAt: 1 }] }),
        reduceChunk: async () => { controller.abort(); throw new Error('PROJECTION_REDUCER_WORKER_ABORTED') },
        blobs: { write: async () => { throw new Error('unused') } }, limits: { maxRows: 1, maxBytes: 4096 },
        maxChunksPerSlice: 1, now: () => 1, signal: controller.signal
      })
      expect(result.kind).toBe('checkpointed')
      expect(service.get(session.id, 'scope-a')?.status).not.toBe('rejected')
    } finally { db.close() }
  })

  it('schedules a retry for reducer worker failures instead of marking the spec unsupported', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'reducer worker failure' })
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'worker-failure-token', now: () => 1
      })
      const lease = service.beginRebuild({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-a' })!
      const result = await runProjectionBuildSlice({
        service, lease, specVersion: 1, dbPath: db.filePath,
        historyReducer: { createState: () => '{}', fold: () => { throw new Error('unused') }, finalize: () => ({ outputOperations: [] }) },
        readChunk: async (permit) => ({ kind: 'chunk', permit, afterSessionSequence: 0, nextSessionSequence: 1,
          hasMore: false, byteLength: 100, events: [{ invocationId: 'inv', turnId: 'turn', sequence: 1, eventId: 'event',
            idempotencyKey: 'event', schemaVersion: 1, kind: 'invocation-completed', payloadJson: '{}', sessionSequence: 1,
            commitOrder: 1, createdAt: 1 }] }),
        reduceChunk: async () => { throw new Error('PROJECTION_REDUCER_WORKER_TIMEOUT') },
        blobs: { write: async () => { throw new Error('unused') } }, limits: { maxRows: 1, maxBytes: 4096 },
        maxChunksPerSlice: 1, now: () => 1, retryAfter: () => 100
      })
      expect(result).toMatchObject({ kind: 'source-unavailable', reason: 'PROJECTION_REDUCER_WORKER_TIMEOUT' })
      expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rejected', retryAfter: 100,
        failureCaseJson: expect.stringContaining('WORKER_FAILED') })
    } finally { db.close() }
  })
})
