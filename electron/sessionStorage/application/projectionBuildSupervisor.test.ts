import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSession } from '../../database/operations'
import { createMemoryAppDb } from '../../database/testHelpers'
import { getDbConnection } from '../../database/sqliteStore'
import { createSqliteProjectionStateStore } from '../infrastructure/sqlite/sessionProjectionStateStore'
import { createProjectionService } from './projectionService'
import { createProjectionBuildSupervisor } from './projectionBuildSupervisor'
import type { ProjectionHistoryChunkReaderPort, ProjectionHistoryReducerPort } from './projectionBuildCoordinator'

describe('projection build supervisor', () => {
  it('sleeps without due work and wakes only when explicitly requested', async () => {
    const db = createMemoryAppDb()
    try {
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'idle-token', now: () => 1,
      })
      let scans = 0
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => { scans += 1; return [] },
        dbPath: db.filePath, readChunk: async () => { throw new Error('no work should be read') },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob should be written') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      await Promise.resolve(); await Promise.resolve()
      expect(scans).toBe(1)
      handle.request?.('retry')
      await Promise.resolve(); await Promise.resolve()
      expect(scans).toBe(2)
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('retries a failed due-work scan and resumes once storage recovers', async () => {
    const db = createMemoryAppDb()
    try {
      const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'due-scan-error-token', now: () => 1 })
      const session = createSession(db, { name: 'projection due scan recovery', model: 'test' })
      let scans = 0
      let reads = 0
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => {
        scans += 1
        if (scans === 1) throw new Error('sqlite busy')
        return [{ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-scan-recovery', specVersion: 1 }]
      }, dbPath: db.filePath,
        readChunk: async (permit, input) => { reads += 1; return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence } },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      for (let i = 0; i < 750 && reads === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(scans).toBeGreaterThan(1)
      expect(reads).toBeGreaterThan(0)
      for (let i = 0; i < 50 && service.get(session.id, 'scope-scan-recovery')?.status !== 'valid'; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(service.get(session.id, 'scope-scan-recovery')).toMatchObject({ status: 'valid' })
      handle.stop()
      await expect(handle.quiesce()).resolves.toBeUndefined()
    } finally { db.close() }
  })

  it('does not retain or later execute a prepare request when the worker is not running', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection prepare before start', model: 'test' })
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'not-running-token', now: () => 1,
      })
      let reads = 0
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async (permit, input) => { reads += 1; return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence } },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async (payload) => ({ locator: 'projection-00000000-0000-4000-8000-000000000003.blob', byteLength: Buffer.byteLength(payload),
          payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }) },
        limits: { maxRows: 1, maxBytes: 1024 }, maxChunksPerSlice: 1, now: () => 1 })
      await expect(supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-not-running', specVersion: 1 }))
        .rejects.toThrow('PROJECTION_BUILD_TASK_NOT_RUNNING')
      const handle = supervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reads).toBe(0)
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('prepares an explicitly requested scope even when background due work is empty', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection foreground prepare', model: 'test' })
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'foreground-token', now: () => 1,
      })
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async (permit, input) => ({ kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }),
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async (payload) => ({ locator: 'projection-00000000-0000-4000-8000-000000000001.blob', byteLength: Buffer.byteLength(payload),
          payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }) },
        limits: { maxRows: 2, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 1 })
      const item = { sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-foreground', specVersion: 1 }
      const handle = supervisor.start()
      const [first, second] = await Promise.all([supervisor.prepare(item), supervisor.prepare(item)])
      expect(first.kind).toBe('published')
      expect(second).toBe(first)
      expect(service.get(session.id, item.scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('returns the persisted rejection reason instead of masking a not-due scope as a claim failure', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection live external owner', model: 'test' })
      const store = createSqliteProjectionStateStore(db)
      const owner = createProjectionService(store, { processGeneration: () => 2, connectionEpoch: () => 1,
        createToken: () => 'owner-token', now: () => 1 })
      owner.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-owned', sessionGeneration: session.generation })
      const lease = owner.beginRebuild({ sessionId: session.id, scopeKey: 'scope-owned', sessionGeneration: session.generation })!
      owner.reject(lease, { failureCaseJson: JSON.stringify({ case: 'CONTENT_UNAVAILABLE', caseId: 'DEFERRED_LARGE', eventSequence: 1 }),
        attempts: 1, retryAfter: 1_000 })
      const requester = createProjectionService(store, { processGeneration: () => 2, connectionEpoch: () => 1,
        createToken: () => 'requester-token', now: () => 2 })
      const supervisor = createProjectionBuildSupervisor({ service: requester, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async () => { throw new Error('must not read without lease') },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('must not write without lease') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 2 })
      const handle = supervisor.start()
      await expect(supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-owned', specVersion: 1 }))
        .rejects.toThrow('PROJECTION_BUILD_DEFERRED:DEFERRED_LARGE')
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('settles a foreground request when claim reconciliation cannot read durable state', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection claim reconciliation failure', model: 'test' })
      const base = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'claim-reconcile-error', now: () => 1 })
      const service = { ...base, beginRebuild: () => null, get: () => { throw new Error('sqlite unavailable') } }
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async () => { throw new Error('must not read without a lease') },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('must not write without a lease') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      await expect(supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-reconcile', specVersion: 1 }))
        .rejects.toThrow('PROJECTION_BUILD_STATE_UNAVAILABLE')
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('isolates observer errors after a source failure and settles the foreground request', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection unexpected worker error', model: 'test' })
      const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'unexpected-worker-token', now: () => 1 })
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async () => { throw new Error('must be caught by coordinator') },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('blob disk unavailable') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1,
        onResult: () => { throw new Error('observer exploded') } })
      const handle = supervisor.start()
      await expect(supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-unexpected', specVersion: 1 }))
        .resolves.toMatchObject({ kind: 'source-unavailable', reason: 'must be caught by coordinator' })
      expect(service.get(session.id, 'scope-unexpected')).toMatchObject({ status: 'rejected' })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('preserves the stopped lease and checkpoint after worker quiescence', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection supervisor quiesce', model: 'test' })
      let token = 0
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => `supervisor-${++token}`, now: () => 1,
      })
      let started!: () => void
      const workerStarted = new Promise<void>((resolve) => { started = resolve })
      let exited!: () => void
      const workerExited = new Promise<void>((resolve) => { exited = resolve })
      const blobPayloads = new Map<string, string>()
      let work: readonly [{ sessionId: string; sessionGeneration: string; scopeKey: string; specVersion: number }] | readonly [] = [
        { sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-a', specVersion: 1 },
      ]
      const historyReducer: ProjectionHistoryReducerPort = { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) }
      const readChunk: ProjectionHistoryChunkReaderPort = async (_permit, input) => {
        started()
        await new Promise<void>((resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('worker terminated')), { once: true })
          workerExited.then(resolve)
        })
        return { kind: 'complete', permit: _permit, afterSessionSequence: input.afterSessionSequence }
      }
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => work, dbPath: db.filePath,
        readChunk, historyReducer, blobs: { write: async (payload) => {
          const locator = `projection-00000000-0000-4000-8000-${String(blobPayloads.size + 1).padStart(12, '0')}.blob`
          blobPayloads.set(locator, payload)
          return { locator, byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }
        }, readVerified: async ({ locator, byteLength, payloadDigest }) => {
          const payload = blobPayloads.get(locator)
          if (payload === undefined || Buffer.byteLength(payload) !== byteLength || createHash('sha256').update(payload).digest('hex') !== payloadDigest) throw new Error('blob mismatch')
          return payload
        } },
        limits: { maxRows: 2, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      await workerStarted
      expect(service.readCheckpoint(session.id, 'scope-a')).not.toBeNull()
      handle.stop()
      let quiesced = false
      const quiescence = handle.quiesce().then(() => { quiesced = true })
      await Promise.resolve()
      expect(quiesced).toBe(false)
      exited()
      await quiescence
      expect(quiesced).toBe(true)
      expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rebuilding', rebuildToken: 'supervisor-1' })
      expect(getDbConnection(db).prepare('SELECT build_checkpoint_json FROM session_projection_state WHERE session_id=? AND scope_key=?')
        .get(session.id, 'scope-a')).toMatchObject({ build_checkpoint_json: expect.any(String) })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const resumedHandle = supervisor.start()
      const resumed = await supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-a', specVersion: 1 })
      expect(resumed.kind).toBe('published')
      expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'valid' })
      resumedHandle.stop()
      await resumedHandle.quiesce()
      work = []
    } finally { db.close() }
  })
})
