import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession } from '../../database/operations'
import { createMemoryAppDb } from '../../database/testHelpers'
import { getDbConnection } from '../../database/sqliteStore'
import { createSqliteProjectionStateStore } from '../infrastructure/sqlite/sessionProjectionStateStore'
import type { ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult } from '../domain/projectionSource'
import { createProjectionService } from './projectionService'
import { runProjectionBuildSlice, type ProjectionBuildBlobPort, type ProjectionHistoryChunkReaderPort,
  type ProjectionHistoryReducerPort } from './projectionBuildCoordinator'
import type { SessionProjectionService } from './projectionService'
import { createCanonicalSessionSnapshotFoldSession } from '../../runtime/canonicalHistory'
import { createProjectionScopeHistoryReducer } from '../infrastructure/sqlite/projectionScopeHistoryReducer'
import { createProjectionBuildCheckpoint } from '../domain/projectionBuild'

describe('projection build coordinator', () => {
  let foldedMessageFacts: unknown[] = []
  const historyReducer: ProjectionHistoryReducerPort = {
    createState: () => JSON.stringify({ invocationId: null, lastSequence: 0 }),
    fold: (_stateJson, events, messageFacts) => {
      foldedMessageFacts.push(...(messageFacts ?? []))
      const last = events.at(-1)
      return { stateJson: JSON.stringify({ invocationId: last?.invocationId ?? null, lastSequence: last?.sequence ?? 0 }),
        outputOperations: [{ type: events.some((event) => event.kind === 'transcript-compacted') ? 'replace' : 'append',
          messages: events.map((event) => ({ role: 'user', id: event.eventId, content: event.eventId })) }],
        resetOutput: events.some((event) => event.kind === 'transcript-compacted') }
    },
    finalize: () => ({ outputOperations: [{ type: 'append', messages: [{ role: 'assistant', id: 'finalized', content: 'done' }] }] }),
  }
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('rejects an invalid build budget instead of leaving its claimed lease rebuilding', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection invalid build budget', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'invalid-budget-token', now: () => 1 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async () => { throw new Error('invalid budget must fail before source reads') }, historyReducer,
      blobs: { write: async () => { throw new Error('invalid budget must fail before writes') } }, limits: { maxRows: 0, maxBytes: 512 },
      maxChunksPerSlice: 1, now: () => 1 })
    expect(result).toMatchObject({ kind: 'chunk-invalid', reason: 'invalid-build-budget-or-scope' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rejected', failureCaseJson: expect.stringContaining('BUILD_BUDGET_INVALID') })
  })

  it('persists a verified chunk checkpoint and resumes it under a newer process lease', async () => {
    foldedMessageFacts = []
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection build slice', model: 'test' })
    let now = 1
    let token = 0
    const serviceFor = (processGeneration: number, connectionEpoch: number) => createProjectionService(createSqliteProjectionStateStore(db!), {
      processGeneration: () => processGeneration, connectionEpoch: () => connectionEpoch,
      createToken: () => `slice-token-${++token}`, now: () => now,
    })
    const firstService = serviceFor(1, 1)
    firstService.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const firstLease = firstService.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const writes: Array<{ payload: string; locator: string }> = []
    const blobs: ProjectionBuildBlobPort = { write: async (payload) => {
    const byteLength = new TextEncoder().encode(payload).byteLength
      const payloadDigest = createHash('sha256').update(payload).digest('hex')
      const locator = `projection-00000000-0000-4000-8000-${String(writes.length + 1).padStart(12, '0')}.blob`
      writes.push({ payload, locator })
      return { locator, byteLength, payloadDigest, release: async () => undefined }
    }, readVerified: async ({ locator, byteLength, payloadDigest }) => {
      const node = writes.find((item) => item.locator === locator)
      if (!node || new TextEncoder().encode(node.payload).byteLength !== byteLength ||
        createHash('sha256').update(node.payload).digest('hex') !== payloadDigest) throw new Error('projection blob verification failed')
      return node.payload
    } }
    const makeChunk: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      const event = { invocationId: 'inv-1', sequence: 1, eventId: 'event-1', idempotencyKey: 'key-1', turnId: 'turn-1',
        schemaVersion: 1, kind: 'invocation-context-committed', payloadJson: '{"messages":[{"role":"user","content":"hello"}]}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: 1,
        events: [event], messageFacts: [{ id: 'source-message', role: 'user', timestamp: 4, sequence: 0, queueScope: 'desktop',
          contentStorageState: 'legacy', writeMode: null, storedContent: 'source body' }],
        byteLength: new TextEncoder().encode(JSON.stringify(event)).byteLength, hasMore: false }
    }
    const firstSlice = await runProjectionBuildSlice({ service: firstService, lease: firstLease, specVersion: 1,
      dbPath: db.filePath, readChunk: makeChunk, historyReducer, blobs, limits: { maxRows: 2, maxBytes: 32 * 1024 }, maxChunksPerSlice: 1, now: () => now })
    expect(firstSlice).toMatchObject({ kind: 'checkpointed', checkpoint: { nextSequence: 1, processedRows: 1,
      historyReducerStateJson: expect.any(String), outputManifest: { locator: 'projection-00000000-0000-4000-8000-000000000001.blob' } } })
    expect(JSON.parse((firstSlice as Extract<typeof firstSlice, { kind: 'checkpointed' }>).checkpoint.historyReducerStateJson!))
      .toMatchObject({ invocationId: 'inv-1', lastSequence: 1 })
    expect(foldedMessageFacts).toEqual([{ id: 'source-message', role: 'user', timestamp: 4, sequence: 0, queueScope: 'desktop',
      contentStorageState: 'legacy', writeMode: null, storedContent: 'source body' }])
    expect(JSON.parse(writes[0]!.payload)).toMatchObject({
      outputManifest: { operations: [{ type: 'append', messages: [{ id: 'event-1' }] }, { type: 'append', messages: [{ id: 'finalized' }] }] }
    })
    expect(firstService.readCheckpoint(session.id, 'scope-a')).not.toBeNull()

    now = 2
    const nextService = serviceFor(2, 2)
    const nextLease = nextService.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    let resumedAt: number | undefined
    const finish: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      resumedAt = input.afterSessionSequence
      return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
    }
    const resumed = await runProjectionBuildSlice({ service: nextService, lease: nextLease, specVersion: 1,
      dbPath: db.filePath, readChunk: finish, historyReducer, blobs, limits: { maxRows: 2, maxBytes: 32 * 1024 }, maxChunksPerSlice: 1, now: () => now })
    if (resumed.kind !== 'published') throw new Error(JSON.stringify(resumed))
    expect(resumed).toMatchObject({ kind: 'published', checkpoint: { nextSequence: 1, processGeneration: 2, rebuildToken: nextLease.rebuildToken }, state: { status: 'valid' } })
    expect(resumedAt).toBe(1)
    expect(nextService.readCheckpoint(session.id, 'scope-a')).toBeNull()
    const cache = getDbConnection(db).prepare('SELECT inline_payload,blob_locator,blob_byte_length,payload_digest FROM session_projection_cache WHERE session_id=? AND scope_key=?').get(session.id, 'scope-a')
    expect(JSON.parse((cache as { inline_payload: string }).inline_payload)).toMatchObject({ formatVersion: 1, scopeKey: 'scope-a',
      specVersion: 1, sessionId: session.id, sessionGeneration: session.generation,
      messages: [{ role: 'user', id: 'event-1' }, { role: 'assistant', id: 'finalized' }] })
    expect(cache).toMatchObject({ blob_locator: null, blob_byte_length: null })
    expect(firstService.saveCheckpoint(firstLease, JSON.stringify({}))).toBe(false)
  })

  it('externalizes oversized reducer state and restores it from the checkpoint blob after takeover', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection large reducer checkpoint', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'large-state-token', now: () => 1 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const stored = new Map<string, string>()
    const verifiedReads: string[] = []
    let sequence = 0
    const blobs: ProjectionBuildBlobPort = {
      write: async (payload) => {
        const bytes = Buffer.from(payload)
        const locator = `projection-00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}.blob`
        const payloadDigest = createHash('sha256').update(bytes).digest('hex')
        stored.set(locator, payload)
        return { locator, byteLength: bytes.byteLength, payloadDigest, release: async () => undefined }
      },
      readVerified: async ({ locator, byteLength, payloadDigest }) => {
        const payload = stored.get(locator)
        if (!payload || Buffer.byteLength(payload) !== byteLength || createHash('sha256').update(payload).digest('hex') !== payloadDigest) {
          throw new Error('blob verification failed')
        }
        verifiedReads.push(payload)
        return payload
      },
    }
    const oversizedState = JSON.stringify({ body: 'x'.repeat(70 * 1024) })
    const reducer: ProjectionHistoryReducerPort = { createState: () => '{}',
      fold: () => ({ stateJson: oversizedState, outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) }
    const read: ProjectionHistoryChunkReaderPort = async (permit, input) => ({ kind: 'chunk', permit,
      afterSessionSequence: input.afterSessionSequence, nextSessionSequence: 1,
      events: [{ sessionSequence: 1, eventId: 'large-state-event', eventType: 'test', payloadJson: '{}', commitOrder: 1, createdAt: 1 }],
      messageFacts: [], byteLength: 64, hasMore: true })

    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: read, historyReducer: reducer, blobs, limits: { maxRows: 2, maxBytes: 32 * 1024 }, maxChunksPerSlice: 1, now: () => 1 })
    expect(result).toMatchObject({ kind: 'checkpointed', checkpoint: { nextSequence: 1, historyReducerStateJson: null,
      historyReducerStateBlob: { byteLength: Buffer.byteLength(oversizedState), payloadDigest: expect.any(String),
        sessionId: session.id, scopeKey: 'scope-a' } } })
    const chunkPayload = [...stored.values()].map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .find((payload) => payload.formatVersion === 2)
    expect(chunkPayload).toBeDefined()
    expect(chunkPayload).not.toHaveProperty('historyReducerStateJson')

    const finish: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      expect(input.afterSessionSequence).toBe(1)
      return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
    }
    const resumedService = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 2,
      connectionEpoch: () => 2, createToken: () => 'large-state-token-2', now: () => 2 })
    const resumedLease = resumedService.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const resumed = await runProjectionBuildSlice({ service: resumedService, lease: resumedLease, specVersion: 1,
      dbPath: db.filePath, readChunk: finish, historyReducer: reducer, blobs, limits: { maxRows: 2, maxBytes: 32 * 1024 }, maxChunksPerSlice: 1, now: () => 2 })
    expect(resumed).toMatchObject({ kind: 'published' })
    expect(verifiedReads).toContain(oversizedState)
  })

  it('writes stable message identity facts to a blob and binds the manifest to the same checkpoint CAS', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection stable ID index', model: 'test' })
    const serviceFor = (processGeneration: number) => createProjectionService(createSqliteProjectionStateStore(db!), {
      processGeneration: () => processGeneration, connectionEpoch: () => processGeneration,
      createToken: () => `stable-index-token-${processGeneration}`, now: () => 3,
    })
    const service = serviceFor(1)
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const stored = new Map<string, string>()
    const makeBlob = (payload: string, index: number) => {
      const locator = `projection-00000000-0000-4000-8000-${String(index).padStart(12, '0')}.blob`
      stored.set(locator, payload)
      return { locator, byteLength: new TextEncoder().encode(payload).byteLength,
        payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }
    }
    const blobs: ProjectionBuildBlobPort = {
      write: async (payload) => makeBlob(payload, stored.size + 1),
      writeMany: async (payloads) => payloads.map((payload, index) => makeBlob(payload, stored.size + index + 1)),
      readVerified: async ({ locator, byteLength, payloadDigest }) => {
        const payload = stored.get(locator)
        if (payload === undefined || new TextEncoder().encode(payload).byteLength !== byteLength ||
          createHash('sha256').update(payload).digest('hex') !== payloadDigest) throw new Error('projection blob verification failed')
        return payload
      },
    }
    const readChunk: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      const sequence = input.afterSessionSequence + 1
      const event = { invocationId: 'inv-index', sequence, eventId: `event-index-${sequence}`, idempotencyKey: `key-index-${sequence}`, turnId: 'turn-index',
        schemaVersion: 1, kind: 'model-response-committed', payloadJson: '{}', sessionSequence: sequence, commitOrder: sequence, createdAt: sequence }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: sequence,
        events: [event], messageFacts: [], byteLength: new TextEncoder().encode(JSON.stringify(event)).byteLength, hasMore: true }
    }

    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk,
      historyReducer, blobs, limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1, now: () => 3 })
    expect(result).toMatchObject({ kind: 'checkpointed', checkpoint: { stableIdIndexManifest: {
      sessionId: session.id, scopeKey: 'scope-a', itemCount: 1,
    } } })
    const checkpoint = (result as Extract<typeof result, { kind: 'checkpointed' }>).checkpoint
    const indexPayload = await blobs.readVerified!(checkpoint.stableIdIndexManifest!)
    expect(JSON.parse(indexPayload)).toMatchObject({ formatVersion: 1, sessionId: session.id,
      scopeKey: 'scope-a', sourceIdentityJson: lease.sourceIdentityJson, ids: ['event-index-1'] })
    expect(service.readCheckpoint(session.id, 'scope-a')).toContain(checkpoint.stableIdIndexManifest!.locator)
    const foldSession = createCanonicalSessionSnapshotFoldSession(JSON.stringify({ formatVersion: 1, sessionId: 'fold-session',
      lastSessionSeq: 1, lastCommitOrder: 1, messageCount: 1 }),
    [{ id: 'event-index-1', role: 'user', content: 'first' }] as never, indexPayload)
    expect(foldSession.fold({ sessionId: 'fold-session', invocationId: 'fold-next', sessionSeq: 2, commitOrder: 2,
      messages: [{ id: 'event-index-1', role: 'user', content: 'updated' }, { id: 'event-index-2', role: 'assistant', content: 'next' }] } as never)
      .map((operation) => operation.type)).toEqual(['upsert', 'append'])

    const reopenedService = serviceFor(2)
    const reopenedLease = reopenedService.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const resumed = await runProjectionBuildSlice({ service: reopenedService, lease: reopenedLease, specVersion: 1,
      dbPath: db.filePath, readChunk, historyReducer, blobs, limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1, now: () => 3 })
    expect(resumed).toMatchObject({ kind: 'checkpointed', checkpoint: { nextSequence: 2, processGeneration: 2,
      stableIdIndexManifest: { itemCount: 2 } } })
    const resumedCheckpoint = (resumed as Extract<typeof resumed, { kind: 'checkpointed' }>).checkpoint
    expect(JSON.parse(await blobs.readVerified!(resumedCheckpoint.stableIdIndexManifest!))).toMatchObject({
      ids: ['event-index-1', 'event-index-2'], entries: [
        { id: 'event-index-1', role: 'user', ordinal: 0 }, { id: 'event-index-2', role: 'user', ordinal: 1 },
      ],
    })
  })

  it('releases the staged blob fence when checkpoint CAS loses its lease', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection checkpoint CAS loss', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'cas-loss-token', now: () => 2,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    let saveAttempts = 0
    const failingCasService: SessionProjectionService = { ...service, saveCheckpoint: (candidateLease, checkpointJson) => {
      saveAttempts += 1
      return saveAttempts === 1 && service.saveCheckpoint(candidateLease, checkpointJson)
    } }
    let released = false
    const blobs: ProjectionBuildBlobPort = { write: async (payload) => ({
      locator: 'cas-loss.blob', byteLength: new TextEncoder().encode(payload).byteLength,
      payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => { released = true },
    }) }
    const reader: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      const event = { invocationId: 'cas-inv', sequence: 1, eventId: 'cas-event', idempotencyKey: 'cas-key', turnId: 'cas-turn',
        schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: 1,
        events: [event], messageFacts: [], byteLength: new TextEncoder().encode(JSON.stringify(event)).byteLength, hasMore: false }
    }

    const result = await runProjectionBuildSlice({ service: failingCasService, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: reader, historyReducer, blobs, limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toEqual({ kind: 'lease-lost' })
    expect(released).toBe(true)
  })

  it('invalidates an incompatible checkpoint so the same process can rebuild from the start', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection incompatible checkpoint', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'incompatible-checkpoint-token', now: () => 2 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const incompatible = createProjectionBuildCheckpoint({ sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
      scopeKey: lease.scopeKey, specVersion: 2, sourceIdentityJson: lease.sourceIdentityJson,
      processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken, startSequence: 0, historyReducerStateJson: '{}' })
    expect(service.saveCheckpoint(lease, JSON.stringify(incompatible))).toBe(true)
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async () => { throw new Error('incompatible checkpoint must not reach source') }, historyReducer,
      blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 512 },
      maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toEqual({ kind: 'checkpoint-invalid' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null })
    expect(service.readCheckpoint(session.id, 'scope-a')).toBeNull()
  })

  it('clears a checkpoint with no reducer state so the scope can restart cleanly', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection reducer state missing', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'missing-reducer-state-token', now: () => 2 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const checkpoint = createProjectionBuildCheckpoint({ sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
      scopeKey: lease.scopeKey, specVersion: 1, sourceIdentityJson: lease.sourceIdentityJson,
      processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken, startSequence: 0, historyReducerStateJson: null })
    expect(service.saveCheckpoint(lease, JSON.stringify(checkpoint))).toBe(true)
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
        nextSessionSequence: 1, events: [{ invocationId: 'missing-state-inv', sequence: 1, eventId: 'missing-state-event',
          idempotencyKey: 'missing-state-key', turnId: 'missing-state-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}',
          sessionSequence: 1, commitOrder: 1, createdAt: 1 }], messageFacts: [], byteLength: 128, hasMore: false }), historyReducer,
      blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 512 },
      maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toEqual({ kind: 'checkpoint-invalid' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null })
    expect(service.readCheckpoint(session.id, 'scope-a')).toBeNull()
  })

  it('invalidates a checkpoint when the reducer worker detects a corrupt stable-ID index', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection corrupt stable index', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'corrupt-stable-index-token', now: () => 2 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const event = { invocationId: 'corrupt-index-inv', sequence: 1, eventId: 'corrupt-index-event',
      idempotencyKey: 'corrupt-index-key', turnId: 'corrupt-index-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}',
      sessionSequence: 1, commitOrder: 1, createdAt: 1 }
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
        nextSessionSequence: 1, events: [event], messageFacts: [], byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: false }),
      historyReducer, reduceChunk: async () => { throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID') },
      blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 4096 },
      maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toEqual({ kind: 'checkpoint-invalid' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null })
    expect(service.readCheckpoint(session.id, 'scope-a')).toBeNull()
  })

  it('records reducer output segment overflow as deferred-large instead of retrying an unbounded build', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection output segment limit', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'output-segment-limit-token', now: () => 2 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const event = { invocationId: 'segment-limit-inv', sequence: 1, eventId: 'segment-limit-event',
      idempotencyKey: 'segment-limit-key', turnId: 'segment-limit-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}',
      sessionSequence: 1, commitOrder: 1, createdAt: 1 }
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
        nextSessionSequence: 1, events: [event], messageFacts: [], byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: false }),
      historyReducer, reduceChunk: async () => { throw new Error('PROJECTION_REDUCER_OUTPUT_SEGMENT_LIMIT_EXCEEDED') },
      blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 4096 },
      maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toEqual({ kind: 'deferred-large', eventSequence: 1 })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rejected', retryAfter: Number.MAX_SAFE_INTEGER,
      failureCaseJson: expect.stringContaining('DEFERRED_LARGE') })
  })

  it('passes reducer state blob references to the worker without reading large state in the coordinator', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection worker state read', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'worker-state-read-token', now: () => 2 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const initial = createProjectionBuildCheckpoint({ sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
      scopeKey: lease.scopeKey, specVersion: 1, sourceIdentityJson: lease.sourceIdentityJson,
      processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken, startSequence: 0, historyReducerStateJson: null })
    const stateRef = { locator: 'projection-00000000-0000-4000-8000-000000000099.blob', byteLength: 80 * 1024,
      payloadDigest: 'a'.repeat(64), sessionId: lease.sessionId, scopeKey: lease.scopeKey, sourceIdentityJson: lease.sourceIdentityJson }
    expect(service.saveCheckpoint(lease, JSON.stringify({ ...initial, historyReducerStateBlob: stateRef }))).toBe(true)
    let receivedStateReference: unknown
    const event = { invocationId: 'worker-state-inv', sequence: 1, eventId: 'worker-state-event',
      idempotencyKey: 'worker-state-key', turnId: 'worker-state-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}',
      sessionSequence: 1, commitOrder: 1, createdAt: 1 }
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
        nextSessionSequence: 1, events: [event], messageFacts: [], byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: true }),
      historyReducer, reduceChunk: async (_state, _events, _facts, _scope, _finalize, _signal, _stagedChunk, staging) => {
        receivedStateReference = staging?.context.priorReducerState
        return { stateJson: '{"lastSequence":1}', outputOperations: [{ type: 'append', messages: [] }], resetOutput: false }
      },
      blobs: { root: '/projection-artifacts', withWorkerStaging: async (run) => run(async () => {
        throw new Error('inline reducer result should not promote artifacts')
      }, { root: '/projection-artifacts', tempLocator: '.projection-00000000-0000-4000-8000-000000000098.tmp',
        allocate: (count) => Array.from({ length: count }, (_, index) => `.projection-00000000-0000-4000-8000-${String(index).padStart(12, '0')}.tmp`) }),
      readVerified: async () => { throw new Error('coordinator must not read reducer state blob') },
      write: async (payload) => ({ locator: 'projection-00000000-0000-4000-8000-000000000100.blob',
        byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }) },
      limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toMatchObject({ kind: 'checkpointed', checkpoint: { nextSequence: 1 } })
    expect(receivedStateReference).toEqual(stateRef)
  })

  it('rejects a missing output blob reader instead of leaving the lease rebuilding', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection output reader missing', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'output-reader-missing-token', now: () => 2 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const blobs: ProjectionBuildBlobPort = { write: async (payload) => ({ locator: 'output-reader.blob', byteLength: Buffer.byteLength(payload),
      payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }) }
    const event = { invocationId: 'reader-inv', sequence: 1, eventId: 'reader-event', idempotencyKey: 'reader-key', turnId: 'reader-turn',
      schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
    const chunk: ProjectionHistoryChunkReaderPort = async (permit, input) => input.afterSessionSequence === 0
      ? { kind: 'chunk', permit, afterSessionSequence: 0, nextSessionSequence: 1, events: [event], messageFacts: [],
        byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: true }
      : { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
    const checkpointed = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: chunk,
      historyReducer, blobs, limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 2 })
    expect(checkpointed.kind).toBe('checkpointed')
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: chunk,
      historyReducer, blobs, limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 2 })
    expect(result).toMatchObject({ kind: 'source-unavailable', reason: 'projection-output-reader-unavailable' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rejected', failureCaseJson: expect.stringContaining('PROJECTION_OUTPUT_READER_UNAVAILABLE') })
  })

  it('publishes an oversized materialized view blob and keeps its cache manifest referenced', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection oversized materialized view', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'oversize-view-token', now: () => 3,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const persisted = new Map<string, string>()
    let blobWrites = 0
    const blobs: ProjectionBuildBlobPort = {
      write: async (payload) => {
        blobWrites += 1
        const locator = `projection-00000000-0000-4000-8000-${String(persisted.size + 1).padStart(12, '0')}.blob`
        persisted.set(locator, payload)
        return { locator, byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => { throw new Error('staging cleanup failed') } }
      },
      readVerified: async ({ locator, byteLength, payloadDigest }) => {
        const payload = persisted.get(locator)
        if (!payload || Buffer.byteLength(payload) !== byteLength || createHash('sha256').update(payload).digest('hex') !== payloadDigest) throw new Error('blob mismatch')
        return payload
      },
      materializeFinalView: async (_output, identity, historyWatermarkJson) => {
        const payload = JSON.stringify({ formatVersion: 1, scopeKey: identity.scopeKey, specVersion: identity.specVersion,
          sessionId: identity.sessionId, sessionGeneration: identity.sessionGeneration, sourceIdentityJson: identity.sourceIdentityJson,
          historyWatermarkJson, messages: [
            { role: 'user', id: 'large', content: 'x'.repeat(230 * 1024) },
            { role: 'assistant', id: 'large-final', content: 'y'.repeat(30 * 1024) },
          ] })
        const locator = `projection-00000000-0000-4000-8000-${String(persisted.size + 1).padStart(12, '0')}.blob`
        const payloadDigest = createHash('sha256').update(payload).digest('hex')
        persisted.set(locator, payload)
        return { byteLength: Buffer.byteLength(payload), payloadDigest, blob: { locator, byteLength: Buffer.byteLength(payload),
          payloadDigest, release: async () => { throw new Error('staging cleanup failed') } } }
      },
    }
    const largeReducer: ProjectionHistoryReducerPort = { ...historyReducer, fold: (_state, events) => ({
      stateJson: JSON.stringify({ cursor: events.at(-1)?.sessionSequence }), resetOutput: false,
      outputOperations: [{ type: 'append', messages: [{ role: 'user', id: 'large', content: 'x'.repeat(230 * 1024) }] }],
    }), finalize: () => ({ outputOperations: [{ type: 'append', messages: [{ role: 'assistant', id: 'large-final', content: 'y'.repeat(30 * 1024) }] }] }) }
    const chunk: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      if (input.afterSessionSequence > 0) return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
      const event = { invocationId: 'large-inv', sequence: 1, eventId: 'large-event', idempotencyKey: 'large-key', turnId: 'large-turn',
        schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: 1,
        events: [event], messageFacts: [], byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: false }
    }
    const built = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: chunk, historyReducer: largeReducer,
      blobs, limits: { maxRows: 1, maxBytes: 256 * 1024 }, maxChunksPerSlice: 1, now: () => 3 })
    if (built.kind !== 'checkpointed') throw new Error(JSON.stringify(built))
    const writesBeforeFinalView = blobWrites
    const published = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: chunk, historyReducer: largeReducer,
      blobs, limits: { maxRows: 1, maxBytes: 256 * 1024 }, maxChunksPerSlice: 1, now: () => 3 })
    expect(blobWrites).toBe(writesBeforeFinalView)
    expect(published).toMatchObject({ kind: 'published' })
    const state = service.get(session.id, 'scope-a')
    expect(state).toMatchObject({ status: 'valid' })
    const cache = getDbConnection(db).prepare('SELECT inline_payload,blob_locator,blob_byte_length,payload_digest FROM session_projection_cache WHERE session_id=? AND scope_key=?').get(session.id, 'scope-a') as
      { inline_payload: string | null; blob_locator: string | null; blob_byte_length: number | null; payload_digest: string }
    expect(cache).toMatchObject({ inline_payload: null, blob_byte_length: expect.any(Number), payload_digest: state?.payloadDigest })
    expect(JSON.parse(persisted.get(cache.blob_locator!)!).messages.map((message: { content: string }) => message.content.length))
      .toEqual([230 * 1024, 30 * 1024])
  })

  it('preserves a committed checkpoint result when staged blob release throws', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection blob release after publish', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'release-after-publish-token', now: () => 5 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-release', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-release', sessionGeneration: session.generation })!
    const reader: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      const event = { invocationId: 'release-inv', sequence: 1, eventId: 'release-event', idempotencyKey: 'release-key', turnId: 'release-turn',
        schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: 1, events: [event],
        messageFacts: [], byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: true }
    }
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: reader,
      historyReducer: { ...historyReducer, createState: () => '{}', finalize: () => ({ outputOperations: [{ type: 'append', messages: [] }] }) },
      blobs: { write: async (payload) => ({ locator: 'release-after-publish.blob', byteLength: Buffer.byteLength(payload),
        payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => { throw new Error('cleanup failed') } }) },
      limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 1, now: () => 5 })
    expect(result).toMatchObject({ kind: 'checkpointed' })
    expect(service.get(session.id, 'scope-release')).toMatchObject({ status: 'rebuilding' })
  })

  it('reconciles an unknown publish commit to published when the durable state proves success', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection unknown publish committed', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'unknown-publish-committed', now: () => 6 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-unknown', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-unknown', sessionGeneration: session.generation })!
    const uncertainService: SessionProjectionService = { ...service, publish: (candidate, output) => {
      service.publish(candidate, output)
      const error = new Error('commit result unknown')
      error.name = 'TransactionCommitUnknownError'
      throw error
    } }
    const result = await runProjectionBuildSlice({ service: uncertainService, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }),
      historyReducer: { ...historyReducer, createState: () => '{}', finalize: () => ({ outputOperations: [] }) },
      blobs: { write: async () => { throw new Error('inline result should not write blob') } },
      limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 1, now: () => 6 })
    expect(result).toMatchObject({ kind: 'published', state: { status: 'valid' } })
  })

  it('returns publish-unknown when commit outcome cannot be proven from durable state', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection unknown publish unresolved', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
      connectionEpoch: () => 1, createToken: () => 'unknown-publish-unresolved', now: () => 6 })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-unknown', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-unknown', sessionGeneration: session.generation })!
    const uncertainService: SessionProjectionService = { ...service, publish: () => {
      const error = new Error('commit result unknown')
      error.name = 'TransactionCommitUnknownError'
      throw error
    } }
    const result = await runProjectionBuildSlice({ service: uncertainService, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }),
      historyReducer: { ...historyReducer, createState: () => '{}', finalize: () => ({ outputOperations: [] }) },
      blobs: { write: async () => { throw new Error('inline result should not write blob') } },
      limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 1, now: () => 6 })
    expect(result).toMatchObject({ kind: 'publish-unknown' })
    expect(service.get(session.id, 'scope-unknown')).toMatchObject({ status: 'rebuilding', rebuildToken: lease.rebuildToken })
  })

  it('finalizes one invocation before folding the next invocation in the same bounded source chunk', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection invocation boundary', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'invocation-boundary-token', now: () => 4,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    let persistedPayload = ''
    const events = [
      { invocationId: 'inv-1', sequence: 1, eventId: 'context-1', idempotencyKey: 'context-1', turnId: 'turn-1', schemaVersion: 1,
        kind: 'invocation-context-committed', payloadJson: '{"messages":[{"role":"user","content":"first"}]}', sessionSequence: 1, commitOrder: 1, createdAt: 1 },
      { invocationId: 'inv-1', sequence: 2, eventId: 'done-1', idempotencyKey: 'done-1', turnId: 'turn-1', schemaVersion: 1,
        kind: 'invocation-completed', payloadJson: '{"status":"completed"}', sessionSequence: 2, commitOrder: 2, createdAt: 2 },
      { invocationId: 'inv-2', sequence: 1, eventId: 'context-2', idempotencyKey: 'context-2', turnId: 'turn-2', schemaVersion: 1,
        kind: 'invocation-context-committed', payloadJson: '{"messages":[{"role":"user","content":"second"}]}', sessionSequence: 3, commitOrder: 3, createdAt: 3 },
    ]
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async (permit, input) => ({ kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence,
        nextSessionSequence: 3, events, messageFacts: [], byteLength: new TextEncoder().encode(JSON.stringify(events)).byteLength, hasMore: false }),
      historyReducer,
      blobs: { write: async (payload) => { persistedPayload = payload; return { locator: 'invocations.blob',
        byteLength: new TextEncoder().encode(payload).byteLength, payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined } } },
      limits: { maxRows: 3, maxBytes: 32 * 1024 }, maxChunksPerSlice: 1, now: () => 4 })

    expect(result).toMatchObject({ kind: 'checkpointed', checkpoint: { nextSequence: 3, historyReducerStateJson: expect.any(String) } })
    expect(JSON.parse((result as Extract<typeof result, { kind: 'checkpointed' }>).checkpoint.historyReducerStateJson!))
      .toMatchObject({ invocationId: 'inv-2', lastSequence: 1 })
    expect(JSON.parse(persistedPayload)).toMatchObject({ sourceComplete: true,
      outputManifest: { formatVersion: 1, parent: null,
        operations: [{ type: 'append', messages: expect.any(Array) }, { type: 'append', messages: [{ id: 'finalized' }] }] } })
  })

  it('persists an append chain and cuts the prior manifest chain when a later delta replaces output', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection output manifest chain', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'output-chain-token', now: () => 8,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const payloads: string[] = []
    const blobs: ProjectionBuildBlobPort = { write: async (payload) => {
      payloads.push(payload)
      return { locator: `node-${payloads.length}.blob`, byteLength: new TextEncoder().encode(payload).byteLength,
        payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }
    } }
    const readChunk: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      const sequence = input.afterSessionSequence + 1
      if (sequence > 3) return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
      const kind = sequence === 1 ? 'invocation-context-committed' : sequence === 2 ? 'transcript-compacted' : 'model-response-committed'
      const event = { invocationId: 'inv-chain', sequence, eventId: `chain-${sequence}`, idempotencyKey: `chain-${sequence}`,
        turnId: 'turn-chain', schemaVersion: 1, kind, payloadJson: '{}', sessionSequence: sequence, commitOrder: sequence, createdAt: sequence }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: sequence,
        events: [event], messageFacts: [], byteLength: new TextEncoder().encode(JSON.stringify(event)).byteLength, hasMore: sequence < 3 }
    }
    let checkpoint: Extract<Awaited<ReturnType<typeof runProjectionBuildSlice>>, { kind: 'checkpointed' }>['checkpoint'] | undefined
    for (let index = 0; index < 3; index += 1) {
      const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk,
        historyReducer, blobs, limits: { maxRows: 1, maxBytes: 8192 }, maxChunksPerSlice: 1, now: () => 8 })
      expect(result.kind).toBe('checkpointed')
      checkpoint = (result as Extract<typeof result, { kind: 'checkpointed' }>).checkpoint
    }

    const nodes = payloads.map((payload) => JSON.parse(payload))
    expect(nodes[0].outputManifest.parent).toBeNull()
    expect(nodes[1].outputManifest.parent).toBeNull()
    expect(nodes[2].outputManifest.parent).toEqual({
      locator: 'node-2.blob',
      byteLength: new TextEncoder().encode(payloads[1]!).byteLength,
      payloadDigest: createHash('sha256').update(payloads[1]!).digest('hex'),
    })
    expect(checkpoint!.outputManifest!.locator).toBe('node-3.blob')
  })

  it('rejects oversize source events through rejected metadata without creating a checkpoint chunk', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection deferred source', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'deferred-token', now: () => 5,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const reader: ProjectionHistoryChunkReaderPort = async (permit, input): Promise<ProjectionHistoryChunkResult> => ({
      kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence, eventSequence: 7,
    })
    const blobs: ProjectionBuildBlobPort = { write: async () => { throw new Error('must not write oversized payload') } }
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: reader,
      historyReducer, blobs, limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 2, now: () => 5, retryAfter: () => 60 })
    expect(result).toMatchObject({ kind: 'deferred-large', eventSequence: 7 })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rejected', retryAfter: Number.MAX_SAFE_INTEGER,
      failureCaseJson: expect.stringContaining('DEFERRED_LARGE') })
    expect(service.readCheckpoint(session.id, 'scope-a')).toBeNull()
  })

  it('clears only its own rebuilding state when a worker reports source drift', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection drift coordinator', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'drift-slice-token', now: () => 5,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const reader: ProjectionHistoryChunkReaderPort = async (permit, input) => ({
      kind: 'source-drift', permit, afterSessionSequence: input.afterSessionSequence,
    })
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: reader,
      historyReducer, blobs: { write: async () => { throw new Error('must not write') } }, limits: { maxRows: 1, maxBytes: 512 },
      maxChunksPerSlice: 1, now: () => 5 })
    expect(result).toEqual({ kind: 'source-drift' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null })
  })

  it('rejects a blob whose persisted bytes or digest do not match before advancing the cursor', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection blob receipt mismatch', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'blob-slice-token', now: () => 5,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const reader: ProjectionHistoryChunkReaderPort = async (permit, input) => {
      const event = { invocationId: 'blob-inv', sequence: 1, eventId: 'blob-event', idempotencyKey: 'blob-key', turnId: 'blob-turn',
        schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
      return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: 1,
        events: [event], messageFacts: [], byteLength: new TextEncoder().encode(JSON.stringify(event)).byteLength, hasMore: false }
    }
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath, readChunk: reader,
      historyReducer,
      blobs: { write: async (payload) => ({ locator: 'unverified.projection', byteLength: new TextEncoder().encode(payload).byteLength, payloadDigest: '0'.repeat(64), release: async () => undefined }) },
      limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 5, retryAfter: () => 100 })
    expect(result).toMatchObject({ kind: 'blob-write-failed', reason: 'blob-verification-failed' })
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rejected', failureCaseJson: expect.stringContaining('DERIVED_BLOB_VERIFICATION_FAILED') })
    expect(service.readCheckpoint(session.id, 'scope-a')).toBeNull()
  })

  it('rejects scopes without a matching output reducer and backs off without publishing valid', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection unsupported scope', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'unsupported-token', now: () => 5,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-unsupported', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-unsupported', sessionGeneration: session.generation })!
    const result = await runProjectionBuildSlice({ service, lease, specVersion: 1, dbPath: db.filePath,
      readChunk: async () => { throw new Error('unsupported scope must fail before source reads') },
      historyReducer: createProjectionScopeHistoryReducer(), blobs: { write: async () => { throw new Error('no blob expected') } },
      limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 1, now: () => 5 })
    expect(result).toMatchObject({ kind: 'chunk-invalid', reason: 'PROJECTION_SPEC_UNSUPPORTED' })
    expect(service.get(session.id, 'scope-unsupported')).toMatchObject({ status: 'rejected', retryAfter: Number.MAX_SAFE_INTEGER })
    expect(service.readCheckpoint(session.id, 'scope-unsupported')).toBeNull()
  })
})
