import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../../database/testHelpers'
import { openDatabase } from '../../database'
import { getDbConnection } from '../../database/sqliteStore'
import { createSqliteProjectionStateStore } from '../infrastructure/sqlite/sessionProjectionStateStore'
import { createProjectionService } from './projectionService'
import { createProjectionBuildSupervisor } from './projectionBuildSupervisor'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, encodeProjectionScopeKey } from '../domain/scopeKey'
import type { ProjectionHistoryChunkReaderPort, ProjectionHistoryReducerPort } from './projectionBuildCoordinator'

describe('projection build supervisor', () => {
  afterEach(() => { vi.useRealTimers() })
  it('releases and reacquires its lease after an over-budget slice while preserving the checkpoint', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection cooperative slice', model: 'test' })
      const store = createSqliteProjectionStateStore(db)
      const service = createProjectionService(store, { processGeneration: () => 1, connectionEpoch: () => 1,
        createToken: (() => { let token = 0; return () => `cooperative-${++token}` })(), now: () => 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      service.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })
      const work = { sessionId: session.id, sessionGeneration: session.generation, scopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION }
      let reads = 0
      let clock = 0
      const slices: Array<{ durationMs: number; nextSequence: number | null; outcome: string; yielded: boolean }> = []
      const stored = new Map<string, string>()
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => store.listDueWork(1), dbPath: db.filePath,
        readChunk: async (permit, input) => {
          reads += 1
          if (input.afterSessionSequence > 0) return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
          const event = { invocationId: 'cooperative-inv', sequence: 1, eventId: 'cooperative-event', idempotencyKey: 'cooperative-key',
            turnId: 'cooperative-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
          return { kind: 'chunk', permit, afterSessionSequence: 0, nextSessionSequence: 1, events: [event], messageFacts: [],
            byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: true }
        },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', resetOutput: false,
          outputOperations: [{ type: 'append', messages: [{ id: 'cooperative-message', role: 'user', content: 'kept' }] }] }),
          finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async (payload) => { const locator = `cooperative-${stored.size}.blob`; stored.set(locator, payload)
          return { locator, byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined } },
          readVerified: async ({ locator }) => stored.get(locator)! },
        limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, sliceBudgetMs: 0,
        monotonicNow: () => { const value = clock; clock += 10; return value }, onSlice: (slice) => slices.push(slice), now: () => 1 })
      const handle = supervisor.start()
      const result = await supervisor.prepare(work)
      expect(result.kind).toBe('published')
      expect(reads).toBe(2)
      expect(slices[0]).toMatchObject({ nextSequence: 1, yielded: true })
      expect(service.get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

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
      const failures: string[] = []
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => {
        scans += 1
        if (scans === 1) throw new Error('sqlite busy')
        return [{ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-scan-recovery', specVersion: 1 }]
      }, dbPath: db.filePath,
        onFailure: (code) => { failures.push(code); throw new Error('diagnostic sink unavailable') },
        readChunk: async (permit, input) => { reads += 1; return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence } },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      for (let i = 0; i < 750 && reads === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(scans).toBeGreaterThan(1)
      expect(failures).toEqual(['PROJECTION_BUILD_DUE_WORK_SCAN_FAILED'])
      expect(reads).toBeGreaterThan(0)
      for (let i = 0; i < 50 && service.get(session.id, 'scope-scan-recovery')?.status !== 'valid'; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(service.get(session.id, 'scope-scan-recovery')).toMatchObject({ status: 'valid' })
      handle.stop()
      await expect(handle.quiesce()).resolves.toBeUndefined()
    } finally { db.close() }
  })

  it('retries a transient claim failure without waiting for another external wake', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection transient claim failure', model: 'test' })
      const base = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'transient-claim-token', now: () => 1 })
      let claims = 0
      const service = { ...base, beginRebuild: (...args: Parameters<typeof base.beginRebuild>) => {
        claims += 1
        if (claims === 1) throw new Error('temporary sqlite busy')
        return base.beginRebuild(...args)
      } }
      const work = { sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-transient-claim', specVersion: 1 }
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [work], dbPath: db.filePath,
        readChunk: async (permit, input) => ({ kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }),
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('inline result should not write blob') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      for (let i = 0; i < 750 && service.get(session.id, work.scopeKey)?.status !== 'valid'; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(claims).toBeGreaterThan(1)
      expect(service.get(session.id, work.scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('consumes a rejected scope at retryAfter without another external request', async () => {
    const temp = createTempDatabase('projection-due-retry-reopen-')
    let db = temp.db
    try {
      const retryAfter = Date.now() + 100
      const session = createSession(db, { name: 'projection due retry', model: 'test' })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      const service = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'due-retry-token', now: Date.now })
      service.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })
      const lease = service.beginRebuild({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })!
      service.reject(lease, { failureCaseJson: '{"case":"CONTENT_UNAVAILABLE","caseId":"TEMPORARY"}', attempts: 1, retryAfter })
      db.close()
      db = openDatabase(temp.dbPath)
      const reopenedStore = createSqliteProjectionStateStore(db)
      const restartedService = createProjectionService(reopenedStore, { processGeneration: () => 2,
        connectionEpoch: () => 2, createToken: () => 'restarted-due-retry-token', now: Date.now })
      let reads = 0
      const supervisor = createProjectionBuildSupervisor({ service: restartedService,
        listDueWork: () => reopenedStore.listDueWork(Date.now(), 64, 2),
        nextRetryAt: () => reopenedStore.nextRetryAt(Date.now()), dbPath: temp.dbPath,
        readChunk: async (permit, input) => { reads += 1; return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence } },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: Date.now })
      const handle = supervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(reads).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(reads).toBeGreaterThan(0)
      for (let attempts = 0; attempts < 20 && restartedService.get(session.id, scopeKey)?.status !== 'valid'; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      expect(restartedService.get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { temp.cleanup() }
  })

  it('backs off repeated claim failures and caps the delay', async () => {
    vi.useFakeTimers()
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection bounded retry', model: 'test' })
      const base = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'bounded-retry-token', now: () => 1 })
      let claims = 0
      const service = { ...base, beginRebuild: (...args: Parameters<typeof base.beginRebuild>) => {
        claims += 1
        throw new Error('sqlite unavailable')
      } }
      const work = { sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-bounded-retry', specVersion: 1 }
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [work], dbPath: db.filePath,
        readChunk: async () => { throw new Error('no source reads expected') },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(claims).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(claims).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(claims).toBe(2)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(claims).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(claims).toBe(3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(claims).toBeLessThanOrEqual(20)
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('survives a retry-deadline scan failure and later consumes due work', async () => {
    const temp = createTempDatabase('projection-retry-deadline-scan-failure-')
    const db = temp.db
    try {
      let now = Date.now()
      const session = createSession(db, { name: 'projection retry deadline scan failure', model: 'test' })
      const store = createSqliteProjectionStateStore(db)
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      const service = createProjectionService(store, { processGeneration: () => 1, connectionEpoch: () => 1,
        createToken: () => 'retry-deadline-recovery', now: () => now })
      service.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })
      const lease = service.beginRebuild({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })!
      service.reject(lease, { failureCaseJson: '{"case":"CONTENT_UNAVAILABLE","caseId":"TEMPORARY"}', attempts: 1, retryAfter: now + 100 })
      let deadlineScans = 0
      let reads = 0
      const failures: string[] = []
      const supervisor = createProjectionBuildSupervisor({ service,
        listDueWork: () => store.listDueWork(now, 64, 1), nextRetryAt: () => {
          deadlineScans += 1
          if (deadlineScans === 1) throw new Error('sqlite busy')
          return store.nextRetryAt(now)
        }, onFailure: (code) => { failures.push(code) }, dbPath: db.filePath,
        readChunk: async (permit, input) => { reads += 1; return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence } },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => now })
      const handle = supervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(failures).toEqual(['PROJECTION_BUILD_DUE_WORK_SCAN_FAILED'])
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000
        const poll = () => {
          now = Date.now()
          if (service.get(session.id, scopeKey)?.status === 'valid') { resolve(); return }
          if (Date.now() >= deadline) { reject(new Error('projection retry did not publish before timeout')); return }
          setTimeout(poll, 5)
        }
        poll()
      })
      expect(reads).toBeGreaterThan(0)
      expect(service.get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { temp.cleanup() }
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
        .rejects.toMatchObject({ message: 'PROJECTION_PREPARATION_UNAVAILABLE', code: 'PROJECTION_PREPARATION_UNAVAILABLE', retryAfter: 1_001 })
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
      try {
        await supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-owned', specVersion: 1 })
        throw new Error('expected persisted rejection')
      } catch (error) {
        expect(error).toMatchObject({ message: 'PROJECTION_BUILD_DEFERRED:DEFERRED_LARGE', code: 'PROJECTION_BUILD_DEFERRED', retryAfter: 1_000 })
      }
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

  it('resumes an in-memory lease after both coordinator and rejection persistence fail transiently', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection transient storage recovery', model: 'test' })
      const base = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'transient-recovery-token', now: () => 1 })
      let checkpointReads = 0
      let rejectWrites = 0
      const service = { ...base,
        readCheckpoint: (sessionId: string, scopeKey: string) => {
          checkpointReads += 1
          if (checkpointReads === 1) throw new Error('temporary sqlite read failure')
          return base.readCheckpoint(sessionId, scopeKey)
        },
        reject: (...args: Parameters<typeof base.reject>) => {
          rejectWrites += 1
          if (rejectWrites === 1) throw new Error('temporary sqlite write failure')
          return base.reject(...args)
        } }
      let reads = 0
      const work = { sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-transient-recovery', specVersion: 1 }
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [work], dbPath: db.filePath,
        readChunk: async (permit, input) => { reads += 1; return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence } },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('no blob expected') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      for (let i = 0; i < 750 && service.get(session.id, work.scopeKey)?.status !== 'valid'; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(checkpointReads).toBeGreaterThan(1)
      expect(rejectWrites).toBeGreaterThan(0)
      expect(reads).toBeGreaterThan(0)
      expect(service.get(session.id, work.scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('retries an unproven publish commit under the same lease until durable state resolves it', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection publish unknown recovery', model: 'test' })
      const base = createProjectionService(createSqliteProjectionStateStore(db), { processGeneration: () => 1,
        connectionEpoch: () => 1, createToken: () => 'publish-unknown-recovery-token', now: () => 1 })
      let publishes = 0
      const service = { ...base, publish: (...args: Parameters<typeof base.publish>) => {
        publishes += 1
        if (publishes === 1) {
          const error = new Error('commit result unknown')
          error.name = 'TransactionCommitUnknownError'
          throw error
        }
        return base.publish(...args)
      } }
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async (permit, input) => ({ kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }),
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }), finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('inline result should not write blob') } }, limits: { maxRows: 1, maxBytes: 1024 },
        maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      const result = await supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation, scopeKey: 'scope-publish-unknown', specVersion: 1 })
      expect(result.kind).toBe('publish-unknown')
      for (let i = 0; i < 750 && service.get(session.id, 'scope-publish-unknown')?.status !== 'valid'; i += 1) await new Promise((resolve) => setTimeout(resolve, 2))
      expect(publishes).toBe(2)
      expect(service.get(session.id, 'scope-publish-unknown')).toMatchObject({ status: 'valid' })
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

  it('releases the stopped lease after worker quiescence so a later start can claim safely', async () => {
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
      expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rebuilding', processGeneration: 0, rebuildToken: expect.any(String) })
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
