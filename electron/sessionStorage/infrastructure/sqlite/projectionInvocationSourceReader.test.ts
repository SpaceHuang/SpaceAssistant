import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact, ProjectionHistoryChunkResult } from '../../domain/projectionSource'
import { createTempDatabase } from '../../../database/testHelpers'
import { createSession } from '../../../database/operations'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { iterateProjectionHistoryInvocations, readProjectionHistoryInvocationsInWorker } from './projectionInvocationSourceReader'

const event = (invocationId: string, sequence: number, sessionSequence: number): ProjectionHistoryChunkEvent => ({
  invocationId, sequence, eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`,
  turnId: `${invocationId}-turn`, schemaVersion: 1, kind: 'model-response-committed',
  payloadJson: JSON.stringify({ message: { id: invocationId === 'inv-a' ? 'a' : 'b' } }),
  sessionSequence, commitOrder: 1, createdAt: sessionSequence,
})
const fact = (id: string, sequence: number): ProjectionMessageFact => ({ id, role: 'user', timestamp: sequence,
  sequence, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: id })

describe('projection invocation source reader', () => {
  it('yields one invocation at a time when a page boundary splits event streams', async () => {
    const permit = { dbPath: '/tmp/db', sessionId: 'session', sessionGeneration: 'generation', scopeKey: 'source',
      specVersion: 1, sourceIdentityJson: '{}', connectionEpoch: 0, processGeneration: 0, rebuildToken: 'token' }
    const pages: ProjectionHistoryChunkResult[] = [
      { kind: 'chunk', permit, afterSessionSequence: 0, nextSessionSequence: 2,
        events: [event('inv-a', 1, 1), event('inv-a', 2, 2)], messageFacts: [fact('a', 0)], byteLength: 1, hasMore: true },
      { kind: 'chunk', permit, afterSessionSequence: 2, nextSessionSequence: 3,
        events: [event('inv-b', 1, 3)], messageFacts: [fact('b', 1)], byteLength: 1, hasMore: false },
    ]
    let reads = 0
    const invocations = iterateProjectionHistoryInvocations(async (afterSessionSequence) => {
      const page = pages[reads++]!
      expect(page.afterSessionSequence).toBe(afterSessionSequence)
      return page
    }, 0)

    await expect(invocations.next()).resolves.toMatchObject({ done: false, value: {
      events: [{ invocationId: 'inv-a' }, { invocationId: 'inv-a' }], messageFacts: [{ id: 'a' }],
    } })
    expect(reads).toBe(2)
    await expect(invocations.next()).resolves.toMatchObject({ done: false, value: {
      events: [{ invocationId: 'inv-b' }], messageFacts: [{ id: 'b' }],
    } })
    await expect(invocations.next()).resolves.toMatchObject({ done: true })
  })

  it('fails explicitly for unavailable source pages instead of silently truncating the locator input', async () => {
    const permit = { dbPath: '/tmp/db', sessionId: 'session', sessionGeneration: 'generation', scopeKey: 'source',
      specVersion: 1, sourceIdentityJson: '{}', connectionEpoch: 0, processGeneration: 0, rebuildToken: 'token' }
    const invocations = iterateProjectionHistoryInvocations(async () => ({ kind: 'deferred-large', permit,
      afterSessionSequence: 0, eventSequence: 1, observedByteLength: 512 * 1024 }), 0)

    await expect(invocations.next()).rejects.toThrow('PROJECTION_SOURCE_BACKFILL_PAGE_DEFERRED-LARGE')
  })

  it('reads canonical History in a Worker and groups invocation boundaries across one-row pages', async () => {
    const temp = createTempDatabase('projection-invocation-source-reader-')
    try {
      const conn = getDbConnection(temp.db)
      const session = createSession(temp.db, { name: 'worker source reader' })
      const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
      await history.appendBatch([
        { invocationId: 'reader-a', turnId: 'turn-a', sequence: 1, schemaVersion: 1, eventId: 'reader-a-1',
          idempotencyKey: 'reader-a-1', kind: 'model-request-started', payload: { requestId: 'a' } },
        { invocationId: 'reader-a', turnId: 'turn-a', sequence: 2, schemaVersion: 1, eventId: 'reader-a-2',
          idempotencyKey: 'reader-a-2', kind: 'invocation-completed', payload: { status: 'completed' } },
      ], 0)
      await history.appendBatch([
        { invocationId: 'reader-b', turnId: 'turn-b', sequence: 1, schemaVersion: 1, eventId: 'reader-b-1',
          idempotencyKey: 'reader-b-1', kind: 'model-request-started', payload: { requestId: 'b' } },
      ], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(conn, session.id, session.generation)!
      const invocations = readProjectionHistoryInvocationsInWorker({ maxRows: 1, permit: {
        dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
        scopeKey: 'source-backfill', specVersion: 1, sourceIdentityJson, connectionEpoch: 0,
        processGeneration: 0, rebuildToken: 'reader-token',
      } })

      const collected = []
      for await (const invocation of invocations) collected.push(invocation)
      expect(collected.map(({ events }) => events.map(({ invocationId, sequence }) => [invocationId, sequence])))
        .toEqual([[['reader-a', 1], ['reader-a', 2]], [['reader-b', 1]]])
    } finally { temp.cleanup() }
  })

  it('stages a single oversized History page in the Worker before returning its bounded source chunk', async () => {
    const temp = createTempDatabase('projection-invocation-source-reader-large-')
    const blobRoot = `${temp.dbPath}.blobs`
    try {
      const conn = getDbConnection(temp.db)
      const session = createSession(temp.db, { name: 'large worker source reader' })
      const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
      await history.appendBatch([{ invocationId: 'reader-large', turnId: 'turn-large', sequence: 1, schemaVersion: 1,
        eventId: 'reader-large-1', idempotencyKey: 'reader-large-1', kind: 'model-request-started',
        payload: { requestId: 'large', diagnostic: 'x'.repeat(300_000) } }], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(conn, session.id, session.generation)!
      const invocations = readProjectionHistoryInvocationsInWorker({ blobs: createSessionProjectionBlobStore(blobRoot), permit: {
        dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
        scopeKey: 'source-backfill', specVersion: 1, sourceIdentityJson, connectionEpoch: 0,
        processGeneration: 0, rebuildToken: 'reader-large-token',
      } })

      const collected = []
      for await (const invocation of invocations) collected.push(invocation)
      const [invocation] = collected
      expect(invocation?.events).toHaveLength(1)
      expect(invocation?.events[0]?.payloadJson).toContain('x'.repeat(1024))
    } finally {
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  })
})
