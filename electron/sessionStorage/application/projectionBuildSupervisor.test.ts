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
      const slices: Array<{ durationMs: number; nextSequence: number | null; outcome: string; yielded: boolean;
        sourceRows: number; sourceBytes: number; sourceSnapshotDurationMs: number; sourceWorkerDurationMs: number; reducerWorkerDurationMs: number;
        finalViewMaterializationDurationMs: number;
        maxWorkerHeapUsedBytesAtExit: number | null; maxProcessRssBytesAtExit: number | null;
        maxWorkerHeapUsedBytesPeakSampled: number | null; maxProcessRssBytesPeakSampled: number | null;
        memorySampleIntervalMs: number | null; workerSamples: number }> = []
      const stored = new Map<string, string>()
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => store.listDueWork(1), dbPath: db.filePath,
        readChunk: async (permit, input) => {
          reads += 1
          if (input.afterSessionSequence > 0) return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
          const event = { invocationId: 'cooperative-inv', sequence: 1, eventId: 'cooperative-event', idempotencyKey: 'cooperative-key',
            turnId: 'cooperative-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1, commitOrder: 1, createdAt: 1 }
          return { kind: 'chunk', permit, afterSessionSequence: 0, nextSessionSequence: 1, events: [event], messageFacts: [],
            byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: true,
            snapshotDurationMs: 1,
            workerSample: { durationMs: 2, heapUsedBytesAtExit: 30, processRssBytesAtExit: 100,
              heapUsedBytesPeakSampled: 40, processRssBytesPeakSampled: 150, memorySampleIntervalMs: 10 } }
        },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', resetOutput: false,
          outputOperations: [{ type: 'append', messages: [{ id: 'cooperative-message', role: 'user', content: 'kept' }] }] }),
          finalize: () => ({ outputOperations: [] }) },
        reduceChunk: async () => ({ stateJson: '{}', resetOutput: false,
          outputOperations: [{ type: 'append', messages: [{ id: 'cooperative-message', role: 'user', content: 'kept' }] }],
          workerSample: { durationMs: 4, heapUsedBytesAtExit: 50, processRssBytesAtExit: 200,
            heapUsedBytesPeakSampled: 60, processRssBytesPeakSampled: 250, memorySampleIntervalMs: 10 } }),
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
      expect(slices[0]).toMatchObject({ sourceRows: 1, sourceBytes: Buffer.byteLength(JSON.stringify({
        invocationId: 'cooperative-inv', sequence: 1, eventId: 'cooperative-event', idempotencyKey: 'cooperative-key',
        turnId: 'cooperative-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}', sessionSequence: 1,
        commitOrder: 1, createdAt: 1 })), sourceSnapshotDurationMs: 1, sourceWorkerDurationMs: 2, reducerWorkerDurationMs: 4,
        finalViewMaterializationDurationMs: 0,
        maxWorkerHeapUsedBytesAtExit: 50, maxProcessRssBytesAtExit: 200, maxWorkerHeapUsedBytesPeakSampled: 60,
        maxProcessRssBytesPeakSampled: 250, memorySampleIntervalMs: 10, workerSamples: 2 })
      expect(slices[1]?.finalViewMaterializationDurationMs).toEqual(expect.any(Number))
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
    let handle: ReturnType<ReturnType<typeof createProjectionBuildSupervisor>['start']> | undefined
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
      handle = supervisor.start()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(reads).toBe(0)
      // Poll against a generous bound: under a loaded full-suite run the worker can be
      // scheduled after retryAfter even though a fixed 120ms sleep has elapsed.
      for (let attempts = 0; attempts < 3_000 && reads === 0; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(reads).toBeGreaterThan(0)
      for (let attempts = 0; attempts < 20 && restartedService.get(session.id, scopeKey)?.status !== 'valid'; attempts += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      expect(restartedService.get(session.id, scopeKey)).toMatchObject({ status: 'valid' })
    } finally {
      handle?.stop()
      await handle?.quiesce()
      temp.cleanup()
    }
  }, 30_000)

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

  it.each([
    { waitedMs: 0, expectedOrder: ['background-head', 'foreground', 'maintenance'] },
    { waitedMs: 300, expectedOrder: ['background-head', 'maintenance', 'foreground'] },
  ])('keeps foreground priority until maintenance has waited long enough ($waitedMs ms)', async ({ waitedMs, expectedOrder }) => {
    const db = createMemoryAppDb()
    try {
      const headSession = createSession(db, { name: 'projection background head', model: 'test' })
      const maintenanceSession = createSession(db, { name: 'projection aged maintenance', model: 'test' })
      const foregroundSession = createSession(db, { name: 'projection queued foreground', model: 'test' })
      const store = createSqliteProjectionStateStore(db)
      const head = { sessionId: headSession.id, sessionGeneration: headSession.generation, scopeKey: 'scope-background-head', specVersion: 1 }
      const maintenance = { sessionId: maintenanceSession.id, sessionGeneration: maintenanceSession.generation,
        scopeKey: 'scope-aged-maintenance', specVersion: 1 }
      const foreground = { sessionId: foregroundSession.id, sessionGeneration: foregroundSession.generation,
        scopeKey: 'scope-queued-foreground', specVersion: 1 }
      for (const item of [head, maintenance, foreground]) store.ensureInvalid({ sessionId: item.sessionId, scopeKey: item.scopeKey,
        sessionGeneration: item.sessionGeneration, now: 1 })
      const service = createProjectionService(store, { processGeneration: () => 1, connectionEpoch: () => 1,
        createToken: (() => { let token = 0; return () => `fair-${++token}` })(), now: () => 1 })
      let releaseHead!: () => void
      let signalHeadStarted!: () => void
      const headStarted = new Promise<void>((resolve) => { signalHeadStarted = resolve })
      const order: string[] = []
      let signalMaintenancePublished!: () => void
      const maintenancePublished = new Promise<void>((resolve) => { signalMaintenancePublished = resolve })
      let now = 0
      const blobs = new Map<string, string>()
      const dueWork = [head, maintenance]
      const supervisor = createProjectionBuildSupervisor({ service,
        listDueWork: () => dueWork.filter((item) => service.get(item.sessionId, item.scopeKey)?.status === 'invalid'),
        dbPath: db.filePath,
        readChunk: async (permit, input) => {
          if (permit.scopeKey === head.scopeKey) {
            order.push('background-head')
            signalHeadStarted()
            await new Promise<void>((resolve) => { releaseHead = resolve })
          } else if (permit.scopeKey === maintenance.scopeKey) order.push('maintenance')
          else order.push('foreground')
          return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
        },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }),
          finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async (payload) => { const locator = `fair-${blobs.size}.blob`; blobs.set(locator, payload); return { locator,
          byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined } },
          readVerified: async ({ locator }) => blobs.get(locator)! },
        limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, sliceBudgetMs: 0,
        maintenancePromotionAgeMs: 250, monotonicNow: (() => { let tick = 0; return () => tick++ })(), now: () => now,
        onResult: (item, result) => { if (item.scopeKey === maintenance.scopeKey && result.kind === 'published') signalMaintenancePublished() } })
      const handle = supervisor.start()
      await headStarted
      const foregroundResult = supervisor.prepare(foreground)
      now = waitedMs
      releaseHead()
      await expect(foregroundResult).resolves.toMatchObject({ kind: 'published' })
      await maintenancePublished
      expect(order).toEqual(expectedOrder)
      expect(service.get(maintenance.sessionId, maintenance.scopeKey)).toMatchObject({ status: 'valid' })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('yields on the accumulated slice budget when each individual history chunk is below budget', async () => {
    const db = createMemoryAppDb()
    try {
      const backgroundSession = createSession(db, { name: 'projection accumulated slice', model: 'test' })
      const foregroundSession = createSession(db, { name: 'projection slice foreground', model: 'test' })
      const store = createSqliteProjectionStateStore(db)
      const background = { sessionId: backgroundSession.id, sessionGeneration: backgroundSession.generation,
        scopeKey: 'scope-accumulated-slice', specVersion: 1 }
      const foreground = { sessionId: foregroundSession.id, sessionGeneration: foregroundSession.generation,
        scopeKey: 'scope-slice-foreground', specVersion: 1 }
      for (const item of [background, foreground]) store.ensureInvalid({ sessionId: item.sessionId, scopeKey: item.scopeKey,
        sessionGeneration: item.sessionGeneration, now: 1 })
      const service = createProjectionService(store, { processGeneration: () => 1, connectionEpoch: () => 1,
        createToken: (() => { let token = 0; return () => `slice-${++token}` })(), now: () => 1 })
      let releaseFirstChunk!: () => void
      let signalFirstChunk!: () => void
      const firstChunkStarted = new Promise<void>((resolve) => { signalFirstChunk = resolve })
      let backgroundReads = 0
      let fakeTime = 0
      const order: string[] = []
      const slices: Array<{ durationMs: number; yielded: boolean }> = []
      const blobs = new Map<string, string>()
      const supervisor = createProjectionBuildSupervisor({ service,
        listDueWork: () => service.get(background.sessionId, background.scopeKey)?.status === 'invalid' ? [background] : [],
        dbPath: db.filePath,
        readChunk: async (permit, input) => {
          if (permit.scopeKey !== background.scopeKey) {
            order.push(`foreground:${input.afterSessionSequence}`)
            return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
          }
          order.push(`background:${input.afterSessionSequence}`)
          if (backgroundReads++ === 0) {
            signalFirstChunk()
            await new Promise<void>((resolve) => { releaseFirstChunk = resolve })
          }
          if (input.afterSessionSequence >= 2) return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
          const next = input.afterSessionSequence + 1
          const event = { invocationId: 'slice-inv', sequence: next, eventId: `slice-event-${next}`,
            idempotencyKey: `slice-key-${next}`, turnId: 'slice-turn', schemaVersion: 1, kind: 'input', payloadJson: '{}',
            sessionSequence: next, commitOrder: next, createdAt: next }
          return { kind: 'chunk', permit, afterSessionSequence: input.afterSessionSequence, nextSessionSequence: next,
            events: [event], messageFacts: [], byteLength: Buffer.byteLength(JSON.stringify(event)), hasMore: true }
        },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }),
          finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async (payload) => { const locator = `slice-${blobs.size}.blob`; blobs.set(locator, payload); return { locator,
          byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined } },
          readVerified: async ({ locator }) => blobs.get(locator)! },
        limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, sliceBudgetMs: 8,
        monotonicNow: () => { const current = fakeTime; fakeTime += 5; return current }, maintenancePromotionAgeMs: 250,
        onSlice: ({ durationMs, yielded }) => slices.push({ durationMs, yielded }), now: () => 0 })
      const handle = supervisor.start()
      await firstChunkStarted
      const foregroundResult = supervisor.prepare(foreground)
      releaseFirstChunk()
      await expect(foregroundResult).resolves.toMatchObject({ kind: 'published' })
      expect(order.slice(0, 3)).toEqual(['background:0', 'background:1', 'foreground:0'])
      expect(slices.slice(0, 2)).toEqual([{ durationMs: 5, yielded: false }, { durationMs: 10, yielded: true }])
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })

  it('preserves one worker owner across deterministic request, stop, and resume sequences', async () => {
    const db = createMemoryAppDb()
    try {
      const store = createSqliteProjectionStateStore(db)
      const service = createProjectionService(store, { processGeneration: () => 1, connectionEpoch: () => 1,
        createToken: (() => { let token = 0; return () => `random-sequence-${++token}` })(), now: () => 1 })
      const items = Array.from({ length: 5 }, (_, index) => {
        const session = createSession(db, { name: `projection randomized ${index}`, model: 'test' })
        const item = { sessionId: session.id, sessionGeneration: session.generation, scopeKey: `scope-random-${index}`, specVersion: 1 }
        store.ensureInvalid({ sessionId: item.sessionId, scopeKey: item.scopeKey, sessionGeneration: item.sessionGeneration, now: 1 })
        return item
      })
      let seed = 0x5eed
      const random = () => { seed = (seed * 48_271) % 2_147_483_647; return seed }
      const requestOrder = [...items]
      for (let index = requestOrder.length - 1; index > 0; index -= 1) {
        const other = random() % (index + 1)
        ;[requestOrder[index], requestOrder[other]] = [requestOrder[other]!, requestOrder[index]!]
      }
      let activeWorkers = 0
      let maxActiveWorkers = 0
      let signalFirstWorker!: () => void
      const firstWorkerStarted = new Promise<void>((resolve) => { signalFirstWorker = resolve })
      const supervisor = createProjectionBuildSupervisor({ service,
        listDueWork: () => store.listDueWork(1), dbPath: db.filePath,
        readChunk: async (permit, input) => {
          activeWorkers += 1
          maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers)
          signalFirstWorker()
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 1)
              input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('WORKER_ABORTED')) }, { once: true })
            })
            return { kind: 'complete', permit, afterSessionSequence: input.afterSessionSequence }
          } finally { activeWorkers -= 1 }
        },
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }),
          finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async (payload) => ({ locator: `random-${payload.length}.blob`, byteLength: Buffer.byteLength(payload),
          payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }),
          readVerified: async () => '[]' },
        limits: { maxRows: 1, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 1 })
      const firstHandle = supervisor.start()
      const interruptedRequests = requestOrder.slice(0, 2).map((item) => supervisor.prepare(item))
      await firstWorkerStarted
      firstHandle.request?.('capacity-pressure')
      firstHandle.stop()
      const interrupted = await Promise.allSettled(interruptedRequests)
      await firstHandle.quiesce()
      expect(interrupted.every((result) => result.status === 'rejected')).toBe(true)

      const resumedHandle = supervisor.start()
      const requests = requestOrder.flatMap((item, index) => index % 2 === 0
        ? [supervisor.prepare(item), supervisor.prepare(item)]
        : [supervisor.prepare(item)])
      const results = await Promise.all(requests)
      expect(results.every((result) => result.kind === 'published')).toBe(true)
      expect(maxActiveWorkers).toBe(1)
      expect(activeWorkers).toBe(0)
      for (const item of items) expect(service.get(item.sessionId, item.scopeKey)).toMatchObject({ status: 'valid' })
      resumedHandle.stop()
      await resumedHandle.quiesce()
    } finally { db.close() }
  })

  it('reports source measurements when a worker defers an oversized History event', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'projection deferred metrics', model: 'test' })
      const service = createProjectionService(createSqliteProjectionStateStore(db), {
        processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'deferred-metrics-token', now: () => 1,
      })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      service.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })
      const slices: Array<Record<string, unknown>> = []
      const supervisor = createProjectionBuildSupervisor({ service, listDueWork: () => [], dbPath: db.filePath,
        readChunk: async (permit, input) => ({ kind: 'deferred-large', permit, afterSessionSequence: input.afterSessionSequence,
          eventSequence: 1, observedByteLength: 900_000, observedEventRows: 1, snapshotDurationMs: 7,
          workerSample: { durationMs: 9, heapUsedBytesAtExit: 12_000, processRssBytesAtExit: 24_000,
            heapUsedBytesPeakSampled: 14_000, processRssBytesPeakSampled: 27_000, memorySampleIntervalMs: 10 } }),
        historyReducer: { createState: () => '{}', fold: () => ({ stateJson: '{}', outputOperations: [], resetOutput: false }),
          finalize: () => ({ outputOperations: [] }) },
        blobs: { write: async () => { throw new Error('deferred event must not write a blob') } },
        limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 1, now: () => 1,
        onSlice: (slice) => slices.push(slice) })
      const handle = supervisor.start()
      const result = await supervisor.prepare({ sessionId: session.id, sessionGeneration: session.generation,
        scopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
      expect(result.kind).toBe('deferred-large')
      expect(slices[0]).toMatchObject({ outcome: 'deferred-large', sourceRows: 1, sourceBytes: 900_000,
        sourceSnapshotDurationMs: 7, sourceWorkerDurationMs: 9, maxWorkerHeapUsedBytesAtExit: 12_000,
        maxProcessRssBytesAtExit: 24_000, maxWorkerHeapUsedBytesPeakSampled: 14_000,
        maxProcessRssBytesPeakSampled: 27_000, memorySampleIntervalMs: 10, workerSamples: 1 })
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
