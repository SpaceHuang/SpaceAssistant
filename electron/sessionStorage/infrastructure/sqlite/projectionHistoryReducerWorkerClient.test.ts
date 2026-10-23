import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
    expect(result.workerSample).toEqual(expect.objectContaining({ durationMs: expect.any(Number),
      heapUsedBytesAtExit: expect.any(Number), processRssBytesAtExit: expect.any(Number) }))
    expect(result.outputOperations).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'replace' })]))
    expect(result.finalizedOutputOperations).toEqual(expect.any(Array))
  })

  it('loads and validates a durable staged source chunk inside the reducer worker', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-pending-reducer-'))
    try {
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const events: ProjectionHistoryChunkEvent[] = [{ invocationId: 'staged-invocation', sequence: 1,
        eventId: 'staged-context', idempotencyKey: 'staged-context', turnId: 'staged-turn', schemaVersion: 1,
        kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
        payloadJson: JSON.stringify({ messages: [
          { id: 'staged-user', role: 'user', content: 'from staged blob', timestamp: 1 },
          { id: 'staged-assistant', role: 'assistant', content: 'canonical body', timestamp: 2 },
        ] }) },
      { invocationId: 'staged-invocation', sequence: 2, eventId: 'staged-terminal', idempotencyKey: 'staged-terminal',
        turnId: 'staged-turn', schemaVersion: 1, kind: 'invocation-completed', sessionSequence: 2, commitOrder: 2,
        createdAt: 2, payloadJson: JSON.stringify({ status: 'completed' }) }]
      const messageFacts: ProjectionMessageFact[] = [
        { id: 'staged-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop',
          contentStorageState: 'legacy', writeMode: null, storedContent: 'from staged blob' },
        { id: 'staged-assistant', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop',
          contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
      ]
      const bytes = Buffer.from(JSON.stringify({ events, messageFacts }))
      const locator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, locator), bytes, { mode: 0o600 })
      const result = await reduceProjectionHistoryChunkInWorker(createProjectionScopeHistoryReducer().createState(scopeKey), [], [],
        scopeKey, true, undefined, { root, manifest: { locator, byteLength: bytes.byteLength,
          payloadDigest: createHash('sha256').update(bytes).digest('hex'), sessionId: 'session-staged', scopeKey,
          sourceIdentityJson: '{"source":1}', fromSequence: 0, nextSequence: 2, rowCount: 2,
          sourceBytes: bytes.byteLength, hasMore: false } })
      expect(JSON.parse(result.stateJson)).toMatchObject({ lastSequence: 1 })
      expect(result.outputOperations).toEqual([{ type: 'replace', messages: [
        { id: 'staged-user', role: 'user', content: 'from staged blob', timestamp: 1 },
        { id: 'staged-assistant', role: 'assistant', content: 'canonical body', timestamp: 2 },
      ] }])
      await expect(reduceProjectionHistoryChunkInWorker(createProjectionScopeHistoryReducer().createState(scopeKey), [], [],
        scopeKey, true, undefined, { root, manifest: { locator, byteLength: bytes.byteLength, payloadDigest: '0'.repeat(64),
          sessionId: 'session-staged', scopeKey, sourceIdentityJson: '{"source":1}', fromSequence: 0, nextSequence: 2,
          rowCount: 2, sourceBytes: bytes.byteLength, hasMore: false } }))
        .rejects.toThrow('PROJECTION_PENDING_CHUNK_DIGEST_MISMATCH')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('stages reducer manifest and stable-ID index on disk without returning large operations over IPC', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-reducer-artifacts-'))
    try {
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const reducer = createProjectionScopeHistoryReducer()
      const content = 'large-canonical-output'.repeat(16 * 1024)
      const events: ProjectionHistoryChunkEvent[] = [{ invocationId: 'artifact-invocation', sequence: 1,
        eventId: 'artifact-context', idempotencyKey: 'artifact-context', turnId: 'artifact-turn', schemaVersion: 1,
        kind: 'invocation-context-committed', sessionSequence: 1, commitOrder: 1, createdAt: 1,
        payloadJson: JSON.stringify({ messages: [{ id: 'artifact-user', role: 'user', content, timestamp: 1 }] }) },
      { invocationId: 'artifact-invocation', sequence: 2, eventId: 'artifact-terminal', idempotencyKey: 'artifact-terminal',
        turnId: 'artifact-turn', schemaVersion: 1, kind: 'invocation-completed', sessionSequence: 2, commitOrder: 2,
        createdAt: 2, payloadJson: JSON.stringify({ status: 'completed' }) }]
      const locator = () => `.projection-${randomUUID()}.tmp`
      const facts: ProjectionMessageFact[] = [{ id: 'artifact-user', role: 'user', timestamp: 1, sequence: 0,
        queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: content }]
      const result = await reduceProjectionHistoryChunkInWorker(reducer.createState(scopeKey), events, facts, scopeKey, true,
        undefined, undefined, { root, outputManifestTempLocator: locator(), stableIdIndexTempLocator: locator(),
          reducerStateTempLocator: locator(), context: { sessionId: 'artifact-session', sessionGeneration: 'generation-1',
            scopeKey, specVersion: 3, sourceIdentityJson: '{"source":1}', parentOutputManifest: null, priorStableIdIndex: null } })

      expect('stagedArtifacts' in result).toBe(true)
      if (!('stagedArtifacts' in result)) throw new Error('expected staged reducer artifacts')
      expect('outputOperations' in result).toBe(false)
      const manifest = result.stagedArtifacts.outputManifest
      const bytes = await fs.readFile(path.join(root, manifest.tempLocator))
      expect(bytes.byteLength).toBe(manifest.byteLength)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.payloadDigest)
      expect(bytes.byteLength).toBeGreaterThan(256 * 1024)
      expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ sessionId: 'artifact-session',
        outputManifest: { operations: [{ type: 'replace', messages: [{ id: 'artifact-user', content }] }] } })
      const indexBytes = await fs.readFile(path.join(root, result.stagedArtifacts.stableIdIndex.tempLocator))
      expect(JSON.parse(indexBytes.toString('utf8'))).toMatchObject({ ids: ['artifact-user'] })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('terminates the worker and waits for exit when the maintenance signal aborts', async () => {
    const controller = new AbortController()
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const work = reduceProjectionHistoryChunkInWorker('{}', [], [], scopeKey, false, controller.signal)
    controller.abort()
    await expect(work).rejects.toThrow('PROJECTION_REDUCER_WORKER_ABORTED')
  })
})
