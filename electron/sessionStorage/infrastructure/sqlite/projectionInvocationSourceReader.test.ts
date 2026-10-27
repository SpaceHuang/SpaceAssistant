import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact, ProjectionHistoryChunkResult } from '../../domain/projectionSource'
import { createTempDatabase } from '../../../database/testHelpers'
import { appendMessage, createSession } from '../../../database/operations'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { projectionSourceEventDigest } from './projectionSourceDependencyReader'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { reduceAndPublishProjectionInvocationChatBodySourcesInWorker } from './projectionHistoryReducerWorkerClient'
import { iterateProjectionHistoryInvocations, readProjectionHistoryInvocationsInWorker,
  type ProjectionInvocationSourceInput } from './projectionInvocationSourceReader'

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

  it('releases source segment files when invocation assembly rejects a malformed page', async () => {
    const permit = { dbPath: '/tmp/db', sessionId: 'session', sessionGeneration: 'generation', scopeKey: 'source',
      specVersion: 1, sourceIdentityJson: '{}', connectionEpoch: 0, processGeneration: 0, rebuildToken: 'token' }
    let released = 0
    const page = { kind: 'chunk' as const, permit, afterSessionSequence: 0, nextSessionSequence: 2,
      events: [event('inv-a', 1, 1)], messageFacts: [], byteLength: 1, hasMore: false,
      sourceSegmentResources: { invocationId: 'inv-a', release: async () => { released += 1 } } }
    const invocations = iterateProjectionHistoryInvocations(async () => page, 0)

    await expect(invocations.next()).rejects.toThrow('PROJECTION_SOURCE_BACKFILL_PAGE_ORDER_INVALID')
    expect(released).toBe(1)
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
      const invocations = readProjectionHistoryInvocationsInWorker({ maxRows: 1, blobs: createSessionProjectionBlobStore(`${temp.dbPath}.blobs`), permit: {
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

  it('preserves the stored-event digest when a source-truth spill is hydrated for reduction', async () => {
    const temp = createTempDatabase('projection-invocation-source-reader-spill-')
    const blobRoot = `${temp.dbPath}.blobs`
    try {
      const conn = getDbConnection(temp.db)
      const session = createSession(temp.db, { name: 'source digest spill' })
      const content = 'spill-body-'.repeat(9_000)
      appendMessage(temp.db, { id: 'spill-source-user', sessionId: session.id, role: 'user', content, timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
      await history.appendBatch([{ invocationId: 'reader-spill', turnId: 'turn-spill', sequence: 1, schemaVersion: 1,
        eventId: 'reader-spill-1', idempotencyKey: 'reader-spill-1', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'spill-source-user', role: 'user', content, timestamp: 1 }] } }], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(conn, session.id, session.generation)!
      const invocations = readProjectionHistoryInvocationsInWorker({ blobs: createSessionProjectionBlobStore(blobRoot), permit: {
        dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
        scopeKey: 'source-backfill', specVersion: 1, sourceIdentityJson, connectionEpoch: 0,
        processGeneration: 0, rebuildToken: 'reader-spill-token',
      } })
      let readInvocation: ProjectionInvocationSourceInput | undefined
      for await (const item of invocations) { readInvocation = item; break }
      const stored = conn.prepare('SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,commit_order,created_at,payload_json FROM agent_history_events WHERE event_id=?')
        .get('reader-spill-1') as Parameters<typeof projectionSourceEventDigest>[0]

      expect(readInvocation?.events[0]?.payloadJson).toContain(content.slice(0, 1024))
      expect(readInvocation?.events[0]?.sourceDigest).toBe(projectionSourceEventDigest(stored))
    } finally {
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  })

  it('reads a segmented large context into one bounded source page without deferring the session forever', async () => {
    const temp = createTempDatabase('projection-invocation-source-reader-segmented-')
    const blobRoot = `${temp.dbPath}.blobs`
    try {
      const conn = getDbConnection(temp.db)
      const session = createSession(temp.db, { name: 'segmented source reader' })
      const content = 'segmented-body-'.repeat(400_000)
      appendMessage(temp.db, { id: 'segmented-user', sessionId: session.id, role: 'user', content, timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
      await history.appendBatch([{ invocationId: 'reader-segmented', turnId: 'turn-segmented', sequence: 1, schemaVersion: 1,
        eventId: 'reader-segmented-1', idempotencyKey: 'reader-segmented-1', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'segmented-user', role: 'user', content, timestamp: 1 }] } }], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(conn, session.id, session.generation)!
      const invocations = readProjectionHistoryInvocationsInWorker({ blobs: createSessionProjectionBlobStore(blobRoot), permit: {
        dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
        scopeKey: 'source-backfill', specVersion: 1, sourceIdentityJson, connectionEpoch: 0,
        processGeneration: 0, rebuildToken: 'reader-segmented-token',
      } })
      let readInvocation: ProjectionInvocationSourceInput | undefined
      for await (const item of invocations) { readInvocation = item; break }
      const stored = conn.prepare('SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,commit_order,created_at,payload_json FROM agent_history_events WHERE event_id=?')
        .get('reader-segmented-1') as Parameters<typeof projectionSourceEventDigest>[0]

      expect(readInvocation?.events[0]?.payloadJson).toContain(content.slice(0, 1_024))
      expect(readInvocation?.messageFacts[0]?.storedContent).toBe(content)
      expect(readInvocation?.events[0]?.sourceDigest).toBe(projectionSourceEventDigest(stored))
    } finally {
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  })

  it('passes source pages above 32 MiB to the source Worker as verified segment references', async () => {
    const temp = createTempDatabase('projection-invocation-source-reader-over-32m-')
    const blobRoot = `${temp.dbPath}.blobs`
    try {
      const conn = getDbConnection(temp.db)
      const session = createSession(temp.db, { name: 'over 32 MiB segmented source reader' })
      const content = 'x'.repeat(17 * 1024 * 1024)
      appendMessage(temp.db, { id: 'segmented-over-limit', sessionId: session.id, role: 'user', content, timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
      await history.appendBatch([{ invocationId: 'reader-over-limit', turnId: 'turn-over-limit', sequence: 1, schemaVersion: 1,
        eventId: 'reader-over-limit-1', idempotencyKey: 'reader-over-limit-1', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'segmented-over-limit', role: 'user', content, timestamp: 1 }] } }], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(conn, session.id, session.generation)!
      const invocations = readProjectionHistoryInvocationsInWorker({ blobs: createSessionProjectionBlobStore(blobRoot), permit: {
        dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
        scopeKey: 'source-backfill', specVersion: 1, sourceIdentityJson, connectionEpoch: 0,
        processGeneration: 0, rebuildToken: 'reader-over-limit-token',
      } })
      const iterator = invocations[Symbol.asyncIterator]()
      const first = await iterator.next()
      const invocation = first.value as ProjectionInvocationSourceInput | undefined
      const eventPayload = invocation?.events[0]?.payload as { kind?: unknown; root?: unknown; messageSegments?: unknown[] } | undefined
      expect(first.done).toBe(false)
      expect(eventPayload?.kind).toBe('source-segmented-history-event')
      expect(invocation?.messageFacts).toHaveLength(0)
      expect(invocation?.events[0]?.payloadJson.length).toBeLessThan(1_000)
      expect(JSON.stringify(invocation).length).toBeLessThan(20_000)
      expect(Array.isArray(eventPayload?.messageSegments)).toBe(true)
      for (const segment of eventPayload!.messageSegments as Array<{ locator: string; byteLength: number; payloadDigest: string }>) {
        const bytes = await fs.readFile(path.join(eventPayload!.root as string, segment.locator))
        expect(bytes.byteLength).toBe(segment.byteLength)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(segment.payloadDigest)
      }
      const sourceRoot = eventPayload!.root as string
      const identity = JSON.parse(sourceIdentityJson) as { sourceRevision: number; historyWatermark: unknown }
      const backfill = await reduceAndPublishProjectionInvocationChatBodySourcesInWorker({ events: invocation!.events,
        messageFacts: invocation!.messageFacts, blobs: createSessionProjectionBlobStore(blobRoot),
        context: { sessionId: session.id, sessionGeneration: session.generation, sourceRevision: identity.sourceRevision,
          sourceIdentityJson, historyWatermarkJson: JSON.stringify(identity.historyWatermark), reducerSpecVersion: 1 },
        publish: async (source, artifacts) => {
          expect(source.messages.map(({ id, sequence }) => [id, sequence])).toEqual([['segmented-over-limit', 0]])
          const fragment = artifacts?.fragmentsByMessage.get('segmented-over-limit')
          expect(fragment).toBeDefined()
          const payload = JSON.parse(await fs.readFile(path.join(blobRoot, fragment!.locator), 'utf8'))
          return { byteLength: payload.message.content.length,
            digest: createHash('sha256').update(payload.message.content).digest('hex') }
        } })
      expect(backfill.byteLength).toBe(content.length)
      expect(backfill.digest).toBe(createHash('sha256').update(content).digest('hex'))
      await iterator.return?.()
      await expect(fs.lstat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  })
})
