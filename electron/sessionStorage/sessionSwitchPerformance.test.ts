import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createSessionSwitchTrace, readChatPageWithSessionSwitchTrace } from './public/readMessages'
import { projectAgentLogFields } from '../agentLogger/agentLogProjection'
import { readChatPageAfterPreparation } from './public/readMessages'
import { createTempDatabase } from '../database/testHelpers'
import { appendMessage, createSession } from '../database/operations'
import { advanceProcessGeneration } from '../database/processGeneration'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { readProjectionSourceIdentity } from './infrastructure/sqlite/projectionSourceIdentity'
import { encodeProjectionScopeKey } from './domain/scopeKey'
import { readPreparedChatBodiesInWorker } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'
import { createSessionBodySourceBackfillTask, createSqliteProjectionBuildTask, createSqliteSessionStorageHost } from './sqliteSessionStorage'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { runSpillReferenceReconciliationBatch } from '../storage/spillReferenceReconciliation'
import type { PreparedChatBodyView } from './public/model'
import type { SpillDescriptor } from '../storage/spillProtocol'

describe('session switch trace', () => {
  it('records local stage durations and a bounded summary without request payload data', async () => {
    let now = 10
    const emit = vi.fn()
    const trace = createSessionSwitchTrace({ instance: 'main', traceId: 'trace-1', now: () => now, emit })

    const result = await trace.measure('page-read', async () => {
      now = 24
      return 'loaded'
    })
    trace.finish({ outcome: 'ok', cachePath: 'ready', pageSize: 20 })

    expect(result).toBe('loaded')
    expect(emit).toHaveBeenCalledWith({
      event: 'session.switch.trace',
      instance: 'main',
      traceId: 'trace-1',
      outcome: 'ok',
      cachePath: 'ready',
      pageSize: 20,
      durationMs: 14,
      stages: [{ name: 'page-read', durationMs: 14, outcome: 'ok' }]
    })
    expect(Object.keys(emit.mock.calls[0]![0]!)).toEqual([
      'event', 'instance', 'traceId', 'outcome', 'cachePath', 'pageSize', 'durationMs', 'stages'
    ])
  })

  it('records an error stage without capturing the thrown message', async () => {
    let now = 5
    const emit = vi.fn()
    const trace = createSessionSwitchTrace({ instance: 'renderer', traceId: 'trace-2', now: () => now, emit })
    const failure = new Error('private message body and /Users/private/path')

    await expect(trace.measure('page-read', async () => {
      now = 9
      throw failure
    })).rejects.toBe(failure)
    trace.finish({ outcome: 'error', cachePath: 'unknown', pageSize: 20 })

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      stages: [{ name: 'page-read', durationMs: 4, outcome: 'error' }]
    }))
    expect(JSON.stringify(emit.mock.calls)).not.toContain(failure.message)
  })

  it('records worker-reported durations as bounded stages', () => {
    let now = 10
    const emit = vi.fn()
    const trace = createSessionSwitchTrace({ instance: 'main', traceId: 'worker-metrics', now: () => now, emit })
    trace.record('worker-queue', 7.126)
    trace.record('worker-read', 12.345)
    trace.finish({ outcome: 'ok', cachePath: 'ready', pageSize: 20 })
    expect(emit.mock.calls[0]![0]!.stages).toEqual([
      { name: 'worker-queue', durationMs: 7.13, outcome: 'ok' },
      { name: 'worker-read', durationMs: 12.35, outcome: 'ok' }
    ])
  })

  it('rejects invalid metric labels instead of serializing arbitrary data', async () => {
    const emit = vi.fn()
    const trace = createSessionSwitchTrace({ instance: 'main', traceId: 'trace-3', now: () => 1, emit })

    await expect(trace.measure('message body', () => undefined)).rejects.toThrow('SESSION_SWITCH_TRACE_LABEL_INVALID')
    expect(() => trace.finish({ outcome: 'ok', cachePath: 'ready', pageSize: 20, message: 'private' } as never))
      .toThrow('SESSION_SWITCH_TRACE_SUMMARY_INVALID')
    expect(emit).not.toHaveBeenCalled()
  })

  it('allows only bounded switch trace fields through the production log projection', () => {
    const projected = projectAgentLogFields('session.switch.trace', {
      instance: 'main', traceId: 'trace-1', rendererProcessId: 77, requestOrdinal: 3, outcome: 'ok', cachePath: 'ready', pageSize: 20,
      durationMs: 12.34, stages: [{ name: 'page-read', durationMs: 12.34, outcome: 'ok' }],
      sessionId: 'private-session', content: 'private body', error: 'private error', path: '/private/path'
    })

    expect(projected).toEqual({
      instance: 'main', traceId: 'trace-1', rendererProcessId: 77, requestOrdinal: 3, outcome: 'ok', cachePath: 'ready', pageSize: 20,
      durationMs: 12.34, stages: [{ name: 'page-read', durationMs: 12.34, outcome: 'ok' }]
    })
  })

  it('attributes a prepared page read to preparation and query stages without changing its result', async () => {
    let now = 0
    const emit = vi.fn()
    const trace = createSessionSwitchTrace({ instance: 'main', traceId: 'trace-4', now: () => now, emit })
    const page = { entries: [], oldestSequence: null, hasMoreBefore: false }
    const storage = {
      readPreparedChatBodyV1: () => ({ ready: true }),
      ensureChatBodyV1: vi.fn(),
      queries: {
        readChatPage: vi.fn(() => page),
        readPreparedChatPage: vi.fn(async (input: { measure?: (name: string, operation: () => unknown) => Promise<unknown>; recordStage?: (name: string, durationMs: number) => void }) => {
          await input.measure?.('page-select', () => { now += 3 })
          await input.measure?.('body-read', () => {
            now += 4
            input.recordStage?.('source-spill-discovery', 11)
            input.recordStage?.('worker-queue', 2)
            input.recordStage?.('source-spill-verify', 1)
            input.recordStage?.('worker-read', 5)
          })
          await input.measure?.('final-source-check', () => { now += 2 })
          return page
        })
      }
    }

    const result = await readChatPageAfterPreparation(storage as never, { sessionId: 'private-session', limit: 20 }, {
      trace,
      onCachePath: vi.fn()
    })
    trace.finish({ outcome: 'ok', cachePath: 'ready', pageSize: 0 })

    expect(result).toBe(page)
    expect(storage.queries.readChatPage).not.toHaveBeenCalled()
    expect(emit.mock.calls[0]![0]!.stages.map(({ name }) => name)).toEqual([
      'projection-prepare', 'page-select', 'source-spill-discovery', 'worker-queue', 'source-spill-verify', 'worker-read', 'body-read', 'final-source-check'
    ])
    expect(emit.mock.calls[0]![0]!.stages.map(({ name }) => name)).toContain('worker-queue')
    expect(emit.mock.calls[0]![0]!.stages.map(({ name }) => name)).toContain('worker-read')
  })

  it('emits one main IPC trace around the actual read and preserves the page or original error', async () => {
    const emit = vi.fn()
    const page = { entries: [{ message: { content: 'must not be logged' } }] }
    const result = await readChatPageWithSessionSwitchTrace(async ({ trace, onCachePath }) => {
      onCachePath('cold')
      return trace.measure('projection-prepare', async () => page)
    }, { traceId: 'ipc-trace', rendererProcessId: 77, requestOrdinal: 9, emit })
    expect(result).toBe(page)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      instance: 'main', traceId: 'ipc-trace', rendererProcessId: 77, requestOrdinal: 9, outcome: 'ok', cachePath: 'cold', pageSize: 1,
      stages: expect.arrayContaining([expect.objectContaining({ name: 'main-ipc' }), expect.objectContaining({ name: 'projection-prepare' })])
    }))
    expect(JSON.stringify(emit.mock.calls)).not.toContain('must not be logged')

    const error = new Error('private body')
    await expect(readChatPageWithSessionSwitchTrace(async () => { throw error }, { traceId: 'ipc-error', emit }))
      .rejects.toBe(error)
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'error', pageSize: 0 }))
  })
})

const runScaleBenchmarks = process.env.RUN_SESSION_SWITCH_PERF === '1'
describe.skipIf(!runScaleBenchmarks)('session switch source identity scale benchmark', () => {
  it.each([1_000, 10_000, 100_000])('measures the source identity scan with %i session streams (30 samples)', (streamCount) => {
    const temp = createTempDatabase(`session-switch-streams-${streamCount}-`)
    try {
      const session = createSession(temp.db, { name: 'synthetic session switch benchmark' })
      const conn = getDbConnection(temp.db)
      const insert = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,0,1,?)')
      runInTransaction(conn, () => {
        for (let index = 0; index < streamCount; index += 1) insert.run(`invocation-${String(index).padStart(6, '0')}`, session.id)
      })

      const queryPlan = conn.prepare(`EXPLAIN QUERY PLAN SELECT invocation_id FROM agent_history_streams
        WHERE session_id=? ORDER BY invocation_id`).all(session.id)
      const durations: number[] = []
      let identity = ''
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        identity = readProjectionSourceIdentity(conn, session.id, session.generation) ?? ''
        durations.push(performance.now() - startedAt)
      }
      const sorted = [...durations].sort((a, b) => a - b)
      const p50Ms = Number(sorted[14]!.toFixed(3))
      const p95Ms = Number(sorted[28]!.toFixed(3))
      const maxMs = Number(sorted[29]!.toFixed(3))
      const indexed = JSON.stringify(queryPlan).includes('idx_agent_history_streams_session')
      console.info(`[session-switch-perf] ${JSON.stringify({ streamCount, samples: 30, identityBytes: Buffer.byteLength(identity), p50Ms, p95Ms, maxMs, indexed, queryPlan })}`)
      expect(JSON.parse(identity).historyStreams).toHaveLength(streamCount)
      expect(indexed).toBe(true)
    } finally {
      temp.cleanup()
    }
  }, 120_000)

  it.each([1_000, 10_000, 100_000])('measures the latest watermark lookup with %i events in one stream (30 samples)', (eventCount) => {
    const temp = createTempDatabase(`session-switch-events-${eventCount}-`)
    try {
      const session = createSession(temp.db, { name: 'synthetic event scale benchmark' })
      const conn = getDbConnection(temp.db)
      const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,?,1,?)')
      const insertEvent = conn.prepare(`INSERT INTO agent_history_events(
        invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id,commit_order,session_seq
      ) VALUES(?,?,?,?,?,1,'invocation-completed','{}',?,?,?,?)`)
      runInTransaction(conn, () => {
        insertStream.run('event-scale-invocation', eventCount, session.id)
        for (let index = 1; index <= eventCount; index += 1) {
          insertEvent.run('event-scale-invocation', index, `event-${index}`, `key-${index}`, 'event-scale-turn',
            index, session.id, index, index)
        }
      })
      const queryPlan = conn.prepare(`EXPLAIN QUERY PLAN SELECT session_seq,commit_order,event_id,invocation_id FROM agent_history_events
        WHERE session_id=? ORDER BY session_seq DESC LIMIT 1`).all(session.id)
      const durations: number[] = []
      let identity = ''
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        identity = readProjectionSourceIdentity(conn, session.id, session.generation) ?? ''
        durations.push(performance.now() - startedAt)
      }
      const sorted = [...durations].sort((a, b) => a - b)
      const p50Ms = Number(sorted[14]!.toFixed(3))
      const p95Ms = Number(sorted[28]!.toFixed(3))
      const maxMs = Number(sorted[29]!.toFixed(3))
      const usesSequenceIndex = JSON.stringify(queryPlan).includes('idx_agent_history_events_session_seq')
      const usesTemporarySort = JSON.stringify(queryPlan).includes('TEMP B-TREE FOR ORDER BY')
      console.info(`[session-switch-event-perf] ${JSON.stringify({ eventCount, samples: 30, identityBytes: Buffer.byteLength(identity), p50Ms, p95Ms, maxMs, usesSequenceIndex, usesTemporarySort, queryPlan })}`)
      expect(JSON.parse(identity).historyWatermark[0]).toBe(eventCount)
      expect(queryPlan.length).toBeGreaterThan(0)
    } finally {
      temp.cleanup()
    }
  }, 120_000)

  it.each([1_000, 10_000, 100_000])('measures ready-page selection from a %i-message prepared cache (30 samples)', async (messageCount) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `session-switch-ready-${messageCount}-`))
    try {
      const sessionId = `ready-benchmark-${messageCount}-${randomUUID()}`
      const sessionGeneration = `generation-${randomUUID()}`
      const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: messageCount }, messageRevision: 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const messages = Array.from({ length: messageCount }, (_, index) => ({
        id: `m${index}`, role: index % 2 ? 'user' as const : 'assistant' as const, content: 'x', timestamp: index
      }))
      const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
        sourceIdentityJson, historyWatermarkJson: { sessionSeq: messageCount }, messages }
      const bytes = Buffer.from(JSON.stringify(envelope))
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      const blobLocator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: messageCount, payloadDigest, blobByteLength: bytes.byteLength })
      const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3,
        sourceIdentityJson, payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson,
        cachePresent: true, stateSourceIdentityJson: sourceIdentityJson,
        statePayloadGeneration: `projection-${payloadDigest}`, statePayloadDigest: payloadDigest,
        stateValidatedRangeJson: validatedRangeJson, blobLocator, blobByteLength: bytes.byteLength }
      const messageIds = Array.from({ length: 20 }, (_, index) => `m${messageCount - index - 1}`)
      const requestDurations: number[] = []
      const workerReadDurations: number[] = []
      const workerTransportDurations: number[] = []
      const workerStartupDurations: number[] = []
      const workerThreadIds = new Set<number>()
      await readPreparedChatBodiesInWorker({ root, view, messageIds, onWorkerTiming: (stage, durationMs) => {
        if (stage === 'worker-read') workerReadDurations.push(durationMs)
        if (stage === 'worker-startup') workerStartupDurations.push(durationMs)
        if (stage === 'worker-transport') workerTransportDurations.push(durationMs)
      } })
      workerReadDurations.length = 0
      workerTransportDurations.length = 0
      const rssBeforeBytes = process.memoryUsage().rss
      const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 })
      eventLoopDelay.enable()
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        const selected = await readPreparedChatBodiesInWorker({ root, view, messageIds,
          onWorkerTiming: (stage, durationMs) => {
            if (stage === 'worker-read') workerReadDurations.push(durationMs)
            if (stage === 'worker-startup') workerStartupDurations.push(durationMs)
            if (stage === 'worker-transport') workerTransportDurations.push(durationMs)
          } })
        workerThreadIds.add(selected.workerThreadId)
        requestDurations.push(performance.now() - startedAt)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      eventLoopDelay.disable()
      const rssAfterBytes = process.memoryUsage().rss
      const requestSorted = [...requestDurations].sort((a, b) => a - b)
      const workerSorted = [...workerReadDurations].sort((a, b) => a - b)
      console.info(`[session-switch-ready-perf] ${JSON.stringify({ messageCount, cacheBytes: bytes.byteLength, pageSize: 20,
        samples: 30, workerThreadCount: workerThreadIds.size,
        workerStartupMs: workerStartupDurations.length ? Number(workerStartupDurations[0]!.toFixed(3)) : null,
        requestP50Ms: Number(requestSorted[14]!.toFixed(3)), requestP95Ms: Number(requestSorted[28]!.toFixed(3)),
        requestMaxMs: Number(requestSorted[29]!.toFixed(3)), workerReadP50Ms: Number(workerSorted[14]!.toFixed(3)),
        workerReadP95Ms: Number(workerSorted[28]!.toFixed(3)), workerReadMaxMs: Number(workerSorted[29]!.toFixed(3)),
        workerTransportP95Ms: workerTransportDurations.length ? Number([...workerTransportDurations].sort((a, b) => a - b)[Math.floor(workerTransportDurations.length * 0.95) - 1]!.toFixed(3)) : null,
        rssBeforeBytes, rssAfterBytes, eventLoopDelayP95Ms: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(3)),
        eventLoopDelayMaxMs: Number((eventLoopDelay.max / 1e6).toFixed(3)) })}`)
      expect(workerReadDurations).toHaveLength(30)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it.each([0, 1, 10, 100])('measures ready-page source spill verification with %i source spills (30 samples)', async (spillCount) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `session-switch-spills-${spillCount}-`))
    const spillRoot = path.join(root, 'source-spills')
    await fs.mkdir(spillRoot)
    try {
      const sessionId = `spill-benchmark-${spillCount}-${randomUUID()}`
      const sessionGeneration = `generation-${randomUUID()}`
      const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 20 }, messageRevision: 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const messages = Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`, role: index % 2 ? 'user' as const : 'assistant' as const, content: `body-${index}`, timestamp: index
      }))
      const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
        sourceIdentityJson, historyWatermarkJson: { sessionSeq: 20 }, messages: [...messages,
          { id: 'unselected-filler', role: 'assistant' as const, content: 'x'.repeat(300 * 1024), timestamp: 20 }] }
      const bytes = Buffer.from(JSON.stringify(envelope))
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      const blobLocator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 21, payloadDigest, blobByteLength: bytes.byteLength })
      const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3,
        sourceIdentityJson, payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson,
        cachePresent: true, stateSourceIdentityJson: sourceIdentityJson,
        statePayloadGeneration: `projection-${payloadDigest}`, statePayloadDigest: payloadDigest,
        stateValidatedRangeJson: validatedRangeJson, blobLocator, blobByteLength: bytes.byteLength }
      const sourceTruthSpills: SpillDescriptor[] = []
      for (let index = 0; index < spillCount; index += 1) {
        const content = `spill-${index}-${'s'.repeat(96)}`
        const spillBytes = Buffer.from(content)
        const locator = `${randomUUID()}.spill`
        await fs.writeFile(path.join(spillRoot, locator), spillBytes, { mode: 0o600 })
        sourceTruthSpills.push({ version: 1, kind: 'source-of-truth', locator, byteLength: spillBytes.byteLength,
          sha256: createHash('sha256').update(spillBytes).digest('hex'), createdAt: index, head: content, tail: content })
      }
      const timings: Record<'source-spill-verify' | 'worker-read' | 'worker-queue' | 'worker-transport', number[]> = {
        'source-spill-verify': [], 'worker-read': [], 'worker-queue': [], 'worker-transport': []
      }
      const requestDurations: number[] = []
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        const selected = await readPreparedChatBodiesInWorker({ root, sourceSpillRoot: spillRoot, sourceTruthSpills,
          view, messageIds: messages.map(({ id }) => id), onWorkerTiming: (stage, durationMs) => {
            if (stage in timings) timings[stage as keyof typeof timings].push(durationMs)
          } })
        expect(selected.messages).toHaveLength(20)
        requestDurations.push(performance.now() - startedAt)
      }
      const stats = (samples: readonly number[]) => {
        const ordered = [...samples].sort((a, b) => a - b)
        return { p50: Number(ordered[14]!.toFixed(3)), p95: Number(ordered[28]!.toFixed(3)), max: Number(ordered[29]!.toFixed(3)) }
      }
      console.info(`[session-switch-spill-perf] ${JSON.stringify({ spillCount, spillBytes: sourceTruthSpills.reduce((sum, spill) => sum + spill.byteLength, 0),
        cacheBytes: bytes.byteLength, samples: 30, requestMs: stats(requestDurations),
        workerQueueMs: stats(timings['worker-queue']), spillVerifyMs: stats(timings['source-spill-verify']),
        workerReadMs: stats(timings['worker-read']), workerTransportMs: stats(timings['worker-transport']) })}`)
      expect(timings['source-spill-verify']).toHaveLength(30)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it.each([20 * 1024, 640 * 1024, 5 * 1024 * 1024])('measures a 20-message page with %i total body bytes (30 samples)', async (totalBodyBytes) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `session-switch-page-bytes-${totalBodyBytes}-`))
    try {
      const sessionId = `page-bytes-${totalBodyBytes}-${randomUUID()}`
      const sessionGeneration = `generation-${randomUUID()}`
      const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 20 }, messageRevision: 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const contentLength = Math.floor(totalBodyBytes / 20)
      const messages = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`,
        role: index % 2 ? 'user' as const : 'assistant' as const, content: 'x'.repeat(contentLength), timestamp: index }))
      const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
        sourceIdentityJson, historyWatermarkJson: { sessionSeq: 20 }, messages }
      const bytes = Buffer.from(JSON.stringify(envelope))
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      const blobLocator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 20, payloadDigest, blobByteLength: bytes.byteLength })
      const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
        payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson, cachePresent: true,
        stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: `projection-${payloadDigest}`,
        statePayloadDigest: payloadDigest, stateValidatedRangeJson: validatedRangeJson,
        blobLocator, blobByteLength: bytes.byteLength }
      const messageIds = messages.map(({ id }) => id)
      await readPreparedChatBodiesInWorker({ root, view, messageIds })
      const requestDurations: number[] = []
      const workerReadDurations: number[] = []
      const workerTransportDurations: number[] = []
      const rssBeforeBytes = process.memoryUsage().rss
      const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 })
      eventLoopDelay.enable()
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        const selected = await readPreparedChatBodiesInWorker({ root, view, messageIds,
          onWorkerTiming: (stage, durationMs) => {
            if (stage === 'worker-read') workerReadDurations.push(durationMs)
            if (stage === 'worker-transport') workerTransportDurations.push(durationMs)
          } })
        expect(selected.messages).toHaveLength(20)
        requestDurations.push(performance.now() - startedAt)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      eventLoopDelay.disable()
      const rssAfterBytes = process.memoryUsage().rss
      const summarize = (samples: readonly number[]) => {
        const ordered = [...samples].sort((a, b) => a - b)
        return { p50: Number(ordered[14]!.toFixed(3)), p95: Number(ordered[28]!.toFixed(3)), max: Number(ordered[29]!.toFixed(3)) }
      }
      console.info(`[session-switch-body-bytes-perf] ${JSON.stringify({ targetBodyBytes: totalBodyBytes,
        pageBodyBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0),
        cacheBytes: bytes.byteLength, pageSize: 20, samples: 30, requestMs: summarize(requestDurations),
        workerReadMs: summarize(workerReadDurations), workerTransportMs: summarize(workerTransportDurations), rssBeforeBytes, rssAfterBytes,
        eventLoopDelayP95Ms: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(3)),
        eventLoopDelayMaxMs: Number((eventLoopDelay.max / 1e6).toFixed(3)) })}`)
      expect(workerReadDurations).toHaveLength(30)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it.each([1024 * 1024, 8 * 1024 * 1024])('measures a single %i-byte giant message (30 samples)', async (bodyBytes) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `session-switch-giant-${bodyBytes}-`))
    try {
      const sessionId = `giant-${bodyBytes}-${randomUUID()}`
      const sessionGeneration = `generation-${randomUUID()}`
      const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 1 }, messageRevision: 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const message = { id: 'giant-message', role: 'assistant' as const, content: 'g'.repeat(bodyBytes), timestamp: 1 }
      const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
        sourceIdentityJson, historyWatermarkJson: { sessionSeq: 1 }, messages: [message] }
      const bytes = Buffer.from(JSON.stringify(envelope))
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      const blobLocator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 1, payloadDigest, blobByteLength: bytes.byteLength })
      const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
        payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson, cachePresent: true,
        stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: `projection-${payloadDigest}`,
        statePayloadDigest: payloadDigest, stateValidatedRangeJson: validatedRangeJson,
        blobLocator, blobByteLength: bytes.byteLength }
      const requestDurations: number[] = []
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        const selected = await readPreparedChatBodiesInWorker({ root, view, messageIds: [message.id] })
        expect(Buffer.byteLength(selected.messages[0]?.content ?? '')).toBe(bodyBytes)
        requestDurations.push(performance.now() - startedAt)
      }
      const ordered = [...requestDurations].sort((a, b) => a - b)
      console.info(`[session-switch-giant-perf] ${JSON.stringify({ bodyBytes, payloadBytes: bytes.byteLength, samples: 30,
        requestP50Ms: Number(ordered[14]!.toFixed(3)), requestP95Ms: Number(ordered[28]!.toFixed(3)),
        requestMaxMs: Number(ordered[29]!.toFixed(3)) })}`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('compares first worker access with repeated warm access for a 640 KiB page (30 samples each)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-switch-cold-worker-'))
    try {
      const sessionId = `cold-worker-${randomUUID()}`
      const sessionGeneration = `generation-${randomUUID()}`
      const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 20 }, messageRevision: 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const messages = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`,
        role: index % 2 ? 'user' as const : 'assistant' as const, content: 'x'.repeat(32 * 1024), timestamp: index }))
      const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
        sourceIdentityJson, historyWatermarkJson: { sessionSeq: 20 }, messages }
      const bytes = Buffer.from(JSON.stringify(envelope))
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      const blobLocator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, blobLocator), bytes, { mode: 0o600 })
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 20, payloadDigest, blobByteLength: bytes.byteLength })
      const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
        payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson, cachePresent: true,
        stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: `projection-${payloadDigest}`,
        statePayloadDigest: payloadDigest, stateValidatedRangeJson: validatedRangeJson,
        blobLocator, blobByteLength: bytes.byteLength }
      const messageIds = messages.map(({ id }) => id)
      const coldMs: number[] = []
      const coldWorkerReadMs: number[] = []
      const coldWorkerTransportMs: number[] = []
      const warmMs: number[] = []
      const warmWorkerReadMs: number[] = []
      const warmWorkerTransportMs: number[] = []
      for (let sample = 0; sample < 30; sample += 1) {
        const coldSessionId = `${sessionId}-${sample}`
        const coldBytes = Buffer.from(JSON.stringify({ ...envelope, sessionId: coldSessionId }))
        const coldDigest = createHash('sha256').update(coldBytes).digest('hex')
        const coldBlobLocator = `projection-${randomUUID()}.blob`
        await fs.writeFile(path.join(root, coldBlobLocator), coldBytes, { mode: 0o600 })
        const coldRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
          fromSequence: 0, nextSequence: 20, payloadDigest: coldDigest, blobByteLength: coldBytes.byteLength })
        const coldView: PreparedChatBodyView = { ...view, sessionId: coldSessionId,
          payloadGeneration: `projection-${coldDigest}`, payloadDigest: coldDigest, validatedRangeJson: coldRangeJson,
          statePayloadGeneration: `projection-${coldDigest}`, statePayloadDigest: coldDigest,
          stateValidatedRangeJson: coldRangeJson, blobLocator: coldBlobLocator, blobByteLength: coldBytes.byteLength }
        const coldStartedAt = performance.now()
        const coldResult = await readPreparedChatBodiesInWorker({ root, view: coldView, messageIds,
          onWorkerTiming: (stage, durationMs) => {
            if (stage === 'worker-read') coldWorkerReadMs.push(durationMs)
            if (stage === 'worker-transport') coldWorkerTransportMs.push(durationMs)
          } })
        expect(coldResult.messages).toHaveLength(20)
        coldMs.push(performance.now() - coldStartedAt)
      }
      await readPreparedChatBodiesInWorker({ root, view, messageIds })
      for (let sample = 0; sample < 30; sample += 1) {
        const warmStartedAt = performance.now()
        const warmResult = await readPreparedChatBodiesInWorker({ root, view, messageIds,
          onWorkerTiming: (stage, durationMs) => {
            if (stage === 'worker-read') warmWorkerReadMs.push(durationMs)
            if (stage === 'worker-transport') warmWorkerTransportMs.push(durationMs)
          } })
        expect(warmResult.messages).toHaveLength(20)
        warmMs.push(performance.now() - warmStartedAt)
      }
      const summarize = (samples: readonly number[]) => {
        const ordered = [...samples].sort((a, b) => a - b)
        return { p50: Number(ordered[14]!.toFixed(3)), p95: Number(ordered[28]!.toFixed(3)), max: Number(ordered[29]!.toFixed(3)) }
      }
      console.info(`[session-switch-cold-perf] ${JSON.stringify({ pageBodyBytes: messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0),
        cacheBytes: bytes.byteLength, samples: 30, firstWorkerLoadRequestMs: summarize(coldMs),
        firstWorkerLoadInternalMs: summarize(coldWorkerReadMs), firstWorkerLoadTransportMs: summarize(coldWorkerTransportMs),
        warmRequestMs: summarize(warmMs), warmInternalMs: summarize(warmWorkerReadMs), warmTransportMs: summarize(warmWorkerTransportMs) })}`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('measures rejection latency and failure rate for a corrupt prepared blob (30 samples)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-switch-corrupt-worker-'))
    try {
      const sessionId = `corrupt-worker-${randomUUID()}`
      const sessionGeneration = `generation-${randomUUID()}`
      const sourceIdentityJson = JSON.stringify({ historyWatermark: { sessionSeq: 20 }, messageRevision: 1 })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const messages = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`,
        role: index % 2 ? 'user' as const : 'assistant' as const, content: 'x'.repeat(16 * 1024), timestamp: index }))
      const envelope = { formatVersion: 1, scopeKey, specVersion: 3, sessionId, sessionGeneration,
        sourceIdentityJson, historyWatermarkJson: { sessionSeq: 20 }, messages }
      const bytes = Buffer.from(JSON.stringify(envelope))
      const payloadDigest = createHash('sha256').update(bytes).digest('hex')
      const blobLocator = `projection-${randomUUID()}.blob`
      await fs.writeFile(path.join(root, blobLocator), Buffer.from(`${bytes.toString('utf8').slice(0, -1)} `), { mode: 0o600 })
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: 3, sourceIdentityJson,
        fromSequence: 0, nextSequence: 20, payloadDigest, blobByteLength: bytes.byteLength })
      const view: PreparedChatBodyView = { sessionId, sessionGeneration, scopeKey, specVersion: 3, sourceIdentityJson,
        payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson, cachePresent: true,
        stateSourceIdentityJson: sourceIdentityJson, statePayloadGeneration: `projection-${payloadDigest}`,
        statePayloadDigest: payloadDigest, stateValidatedRangeJson: validatedRangeJson,
        blobLocator, blobByteLength: bytes.byteLength }
      const failures: string[] = []
      const durations: number[] = []
      for (let sample = 0; sample < 30; sample += 1) {
        const startedAt = performance.now()
        try { await readPreparedChatBodiesInWorker({ root, view, messageIds: ['m0'] }) }
        catch (error) { failures.push(error instanceof Error ? error.message : 'unknown') }
        durations.push(performance.now() - startedAt)
      }
      const ordered = [...durations].sort((a, b) => a - b)
      console.info(`[session-switch-corrupt-perf] ${JSON.stringify({ samples: 30, failures: failures.length,
        failureClasses: [...new Set(failures)], rejectP50Ms: Number(ordered[14]!.toFixed(3)),
        rejectP95Ms: Number(ordered[28]!.toFixed(3)), rejectMaxMs: Number(ordered[29]!.toFixed(3)) })}`)
      expect(failures).toHaveLength(30)
      expect(failures.every((failure) => failure.includes('projection blob length or digest mismatch'))).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('measures source changes between reads and verifies stale prepared pages fall back (30 samples)', async () => {
    const temp = createTempDatabase('session-switch-source-drift-')
    const blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-switch-source-drift-blobs-'))
    const db = temp.db
    const session = createSession(db, { name: 'synthetic source drift', model: 'test' })
    appendMessage(db, { id: 'source-drift-initial', sessionId: session.id, role: 'user', content: 'initial', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,0,1,?)')
    runInTransaction(conn, () => {
      for (let index = 0; index < 10_000; index += 1) insertStream.run(`drift-stream-${String(index).padStart(5, '0')}`, session.id)
    })
    const generation = advanceProcessGeneration(conn)
    const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot,
      processGeneration: () => generation, connectionEpoch: () => generation, now: () => 10 })
    const host = createSqliteSessionStorageHost(db, {
      storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
      maintenanceTasks: [task]
    })
    try {
      const prepared = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
      expect(prepared).toBeDefined()
      const staleStorage = { ...host.storage, readPreparedChatBodyV1: () => prepared }
      const durations: number[] = []
      let fallbackCount = 0
      for (let sample = 0; sample < 30; sample += 1) {
        const id = `source-drift-${sample}`
        appendMessage(db, { id, sessionId: session.id, role: 'user', content: `body-${sample}`, timestamp: sample + 2, status: 'sent' })
        const cachePaths: string[] = []
        const startedAt = performance.now()
        const page = await readChatPageAfterPreparation(staleStorage, { sessionId: session.id, limit: 20 }, {
          onCachePath: (cachePath) => cachePaths.push(cachePath)
        })
        durations.push(performance.now() - startedAt)
        expect(page.entries.some(({ message }) => message.id === id)).toBe(true)
        if (cachePaths.includes('invalidated')) fallbackCount += 1
      }
      const ordered = [...durations].sort((a, b) => a - b)
      console.info(`[session-switch-source-drift-perf] ${JSON.stringify({ historyStreams: 10_000, samples: 30,
        staleViewRejects: fallbackCount, requestP50Ms: Number(ordered[14]!.toFixed(3)),
        requestP95Ms: Number(ordered[28]!.toFixed(3)), requestMaxMs: Number(ordered[29]!.toFixed(3)) })}`)
      expect(fallbackCount).toBe(30)
    } finally {
      await host.lifecycle.stop({ deadlineMs: 5_000 })
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('measures source mutation during a prepared read and verifies final-check fallback (30 samples)', async () => {
    const temp = createTempDatabase('session-switch-inflight-drift-')
    const blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-switch-inflight-drift-blobs-'))
    const db = temp.db
    const session = createSession(db, { name: 'synthetic in-flight source drift', model: 'test' })
    const conn = getDbConnection(db)
    const initialMessage = { id: 'inflight-initial', role: 'user', content: 'initial', timestamp: 1 }
    appendMessage(db, { ...initialMessage, sessionId: session.id, status: 'sent' })
    const history = new SqliteAgentHistory(conn, 1, () => Date.now(), session.id)
    await history.appendBatch([
      { invocationId: 'inflight-invocation', turnId: 'inflight-turn', sequence: 1, schemaVersion: 1,
        eventId: 'inflight-context', idempotencyKey: 'inflight-context', kind: 'invocation-context-committed',
        payload: { messages: [initialMessage] } },
      { invocationId: 'inflight-invocation', turnId: 'inflight-turn', sequence: 2, schemaVersion: 1,
        eventId: 'inflight-terminal', idempotencyKey: 'inflight-terminal', kind: 'invocation-completed',
        payload: { status: 'completed' } }
    ], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    let reconciliation = await runSpillReferenceReconciliationBatch(conn)
    for (let attempt = 0; reconciliation.status === 'running' && attempt < 10; attempt += 1) {
      reconciliation = await runSpillReferenceReconciliationBatch(conn)
    }
    expect(reconciliation.status).toBe('complete')
    const generation = advanceProcessGeneration(conn)
    const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot,
      processGeneration: () => generation, connectionEpoch: () => generation, now: () => 10 })
    const host = createSqliteSessionStorageHost(db, {
      storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
      maintenanceTasks: [task]
    })
    try {
      const requestMs: number[] = []
      let finalCheckMutations = 0
      let fallbacks = 0
      for (let sample = 0; sample < 30; sample += 1) {
        const prepared = await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        expect(prepared).toBeDefined()
        const id = `inflight-drift-${sample}`
        const baseRead = host.storage.queries.readPreparedChatPage!
        const storage = { ...host.storage, readPreparedChatBodyV1: () => prepared,
          queries: { ...host.storage.queries, readPreparedChatPage: async (input: Parameters<typeof baseRead>[0]) => {
            const measure = input.measure
            return baseRead({ ...input, measure: measure ? async (name, operation) => {
              if (name === 'final-source-check') {
                appendMessage(db, { id, sessionId: session.id, role: 'user', content: `during-${sample}`,
                  timestamp: sample + 2, status: 'sent' })
                finalCheckMutations += 1
              }
              return measure(name, operation)
            } : undefined })
          } } }
        const cachePaths: string[] = []
        const startedAt = performance.now()
        const page = await readChatPageAfterPreparation(storage, { sessionId: session.id, limit: 100 }, {
          onCachePath: (cachePath) => cachePaths.push(cachePath)
        })
        requestMs.push(performance.now() - startedAt)
        expect(page.entries.some(({ message }) => message.id === id), JSON.stringify({ id, ids: page.entries.map(({ message }) => message.id),
          cachePaths, finalCheckMutations })).toBe(true)
        if (cachePaths.includes('invalidated')) fallbacks += 1
      }
      const ordered = [...requestMs].sort((a, b) => a - b)
      console.info(`[session-switch-inflight-drift-perf] ${JSON.stringify({ samples: requestMs.length,
        finalCheckMutations, fallbacks, requestP50Ms: Number(ordered[14]!.toFixed(3)),
        requestP95Ms: Number(ordered[28]!.toFixed(3)), requestMaxMs: Number(ordered[29]!.toFixed(3)) })}`)
      expect(finalCheckMutations).toBe(30)
      expect(fallbacks).toBe(30)
    } finally {
      await host.lifecycle.stop({ deadlineMs: 5_000 })
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it('measures production fallback after a prepared blob is corrupted (30 samples)', async () => {
    const temp = createTempDatabase('session-switch-production-corrupt-')
    const blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-switch-production-corrupt-blobs-'))
    const db = temp.db
    const session = createSession(db, { name: 'production corrupt fallback', model: 'test' })
    const conn = getDbConnection(db)
    const body = 'x'.repeat(300 * 1024)
    const message = { id: 'production-corrupt-message', role: 'user', content: body, timestamp: 1 }
    appendMessage(db, { id: message.id, sessionId: session.id, role: 'user', content: body, timestamp: message.timestamp, status: 'sent' })
    const processGeneration = advanceProcessGeneration(conn)
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'production-corrupt-inv', turnId: 'production-corrupt-turn', sequence: 1, schemaVersion: 1,
        eventId: 'production-corrupt-context', idempotencyKey: 'production-corrupt-context', kind: 'invocation-context-committed',
        payload: { messages: [message] } },
      { invocationId: 'production-corrupt-inv', turnId: 'production-corrupt-turn', sequence: 2, schemaVersion: 1,
        eventId: 'production-corrupt-terminal', idempotencyKey: 'production-corrupt-terminal', kind: 'invocation-completed',
        payload: { status: 'completed' } },
    ], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot,
      processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => Date.now() })
    const host = createSqliteSessionStorageHost(db, {
      storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
      maintenanceTasks: [task]
    })
    try {
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
      const readCache = () => conn.prepare('SELECT blob_locator,inline_payload FROM session_projection_cache WHERE session_id=? AND scope_key=?')
        .get(session.id, encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })) as
        { blob_locator: string | null; inline_payload: string | null } | undefined
      let cache: { blob_locator: string | null; inline_payload: string | null } | undefined
      const durations: number[] = []
      let fallbackCount = 0
      for (let sample = 0; sample < 30; sample += 1) {
        await host.storage.ensureChatBodyV1?.({ sessionId: session.id })
        cache = readCache()
        expect(cache?.blob_locator).toMatch(/^projection-[0-9a-f-]{36}\.blob$/)
        expect(cache?.inline_payload).toBeNull()
        await fs.writeFile(path.join(blobRoot, cache!.blob_locator!), `corrupt-${sample}`)
        const cachePaths: string[] = []
        const startedAt = performance.now()
        const page = await readChatPageAfterPreparation(host.storage, { sessionId: session.id, limit: 20 }, {
          onCachePath: (cachePath) => cachePaths.push(cachePath)
        })
        durations.push(performance.now() - startedAt)
        expect(page.entries).toHaveLength(1)
        expect(page.entries[0]?.message.content).toBe(body)
        if (cachePaths.includes('invalidated')) fallbackCount += 1
      }
      const ordered = [...durations].sort((a, b) => a - b)
      console.info(`[session-switch-production-corrupt-perf] ${JSON.stringify({ samples: durations.length,
        fallbackCount, bodyBytesPerMessage: Buffer.byteLength(body), pageSize: 20,
        requestMs: { p50: Number(ordered[14]!.toFixed(3)), p95: Number(ordered[28]!.toFixed(3)),
          max: Number(ordered[29]!.toFixed(3)) } })}`)
      expect(fallbackCount).toBe(30)
    } finally {
      await host.lifecycle.stop({ deadlineMs: 5_000 })
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  }, 180_000)

  it('measures cold production reads after source locators are ready (30 canonical-only sessions)', async () => {
    const temp = createTempDatabase('session-switch-production-cold-')
    const blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-switch-production-cold-blobs-'))
    const db = temp.db
    const conn = getDbConnection(db)
    const body = 'x'.repeat(300 * 1024)
    const processGeneration = advanceProcessGeneration(conn)
    const sampleCount = Number(process.env.SESSION_SWITCH_PERF_SAMPLE_COUNT ?? 30)
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 30) throw new Error('SESSION_SWITCH_PERF_SAMPLE_COUNT_INVALID')
    const projectionSlices: Array<{ durationMs: number; sourceRows: number; sourceBytes: number; sourceSnapshotDurationMs: number;
      sourceWorkerDurationMs: number; reducerWorkerDurationMs: number; finalViewMaterializationDurationMs: number;
      outcome: string; yielded: boolean }> = []
    const task = createSqliteProjectionBuildTask({ db, dbPath: temp.dbPath, blobRoot,
      processGeneration: () => processGeneration, connectionEpoch: () => processGeneration, now: () => Date.now(),
      onSlice: (slice) => projectionSlices.push(slice) })
    const host = createSqliteSessionStorageHost(db, {
      storage: { projectionBlobRoot: blobRoot },
      startup: { recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        recoverSessionLedgers: async () => ({ repairFailureCount: 0 }) },
      maintenanceTasks: [task]
    })
    const durations: number[] = []
    const stages = new Map<string, number[]>()
    const stageOutcomes = new Map<string, { ok: number; error: number }>()
    const pathSequences: string[] = []
    const projectionSummaries: Array<{ durationMs: number; sourceSnapshotMs: number; sourceWorkerMs: number;
      reducerWorkerMs: number; finalViewMaterializationMs: number; sourceRows: number; sourceBytes: number; slices: number; yieldedSlices: number }> = []
    let lastPrepared: unknown
    const tracedStorage = { ...host.storage, ensureChatBodyV1: async (input: { sessionId: string; signal?: AbortSignal }) => {
      const result = await host.storage.ensureChatBodyV1?.(input)
      lastPrepared = result
      return result
    } }
    try {
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const session = createSession(db, { name: `cold canonical session ${sample}`, model: 'test' })
        const message = { id: `cold-message-${sample}`, role: 'user', content: body, timestamp: sample + 1 }
        appendMessage(db, { id: message.id, sessionId: session.id, role: 'user', content: body,
          timestamp: message.timestamp, status: 'sent' })
        const history = new SqliteAgentHistory(conn, 1, () => Date.now(), session.id)
        await history.appendBatch([
          { invocationId: `cold-inv-${sample}`, turnId: `cold-turn-${sample}`, sequence: 1, schemaVersion: 1,
            eventId: `cold-context-${sample}`, idempotencyKey: `cold-context-${sample}`, kind: 'invocation-context-committed',
            payload: { messages: [message] } },
          { invocationId: `cold-inv-${sample}`, turnId: `cold-turn-${sample}`, sequence: 2, schemaVersion: 1,
            eventId: `cold-terminal-${sample}`, idempotencyKey: `cold-terminal-${sample}`, kind: 'invocation-completed',
            payload: { status: 'completed' } },
        ], 0)
        conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
        conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
        let reconciliation = await runSpillReferenceReconciliationBatch(conn)
        for (let attempt = 0; reconciliation.status === 'running' && attempt < 10; attempt += 1) {
          reconciliation = await runSpillReferenceReconciliationBatch(conn)
        }
        expect(reconciliation.status).toBe('complete')
        let backfillResult: { sessionId: string; status: string; error?: string } | undefined
        const backfillTask = createSessionBodySourceBackfillTask({ db, blobRoot, idleDelayMs: 60_000,
          retryDelayMs: 60_000, onResult: (result) => { if (result.sessionId === session.id) backfillResult = result } })
        const backfillHandle = backfillTask.start()!
        try {
          await vi.waitFor(() => expect(backfillResult).toMatchObject({ sessionId: session.id, status: 'complete' }), { timeout: 30_000 })
        } finally { backfillHandle.stop() }
        const trace = createSessionSwitchTrace({ instance: 'main', traceId: `cold-${sample}`, emit: (event) => {
          for (const stage of event.stages) {
            stages.set(stage.name, [...(stages.get(stage.name) ?? []), stage.durationMs])
            const outcomes = stageOutcomes.get(stage.name) ?? { ok: 0, error: 0 }
            outcomes[stage.outcome] += 1
            stageOutcomes.set(stage.name, outcomes)
          }
        } })
        const cachePaths: Array<'ready' | 'prior-authority' | 'cold' | 'invalidated'> = []
        const sliceStart = projectionSlices.length
        const startedAt = performance.now()
        const page = await readChatPageAfterPreparation(tracedStorage, { sessionId: session.id, limit: 20 }, {
          trace, onCachePath: (cachePath) => cachePaths.push(cachePath)
        })
        if (sample === 0 && lastPrepared) {
          try {
            const direct = await readPreparedChatBodiesInWorker({ root: blobRoot, view: lastPrepared as PreparedChatBodyView,
              messageIds: [message.id] })
            console.info(`[session-switch-production-cold-worker-probe] ${JSON.stringify({ selected: direct.messages.length,
              bodyBytes: Buffer.byteLength(direct.messages[0]?.content ?? '') })}`)
          } catch (error) {
            console.info(`[session-switch-production-cold-worker-probe] ${JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' })}`)
          }
        }
        pathSequences.push(cachePaths.join('→'))
        trace.finish({ outcome: 'ok', cachePath: cachePaths[cachePaths.length - 1] ?? 'unknown', pageSize: page.entries.length })
        durations.push(performance.now() - startedAt)
        const slices = projectionSlices.slice(sliceStart)
        projectionSummaries.push({ durationMs: slices.reduce((sum, slice) => sum + slice.durationMs, 0),
          sourceSnapshotMs: slices.reduce((sum, slice) => sum + slice.sourceSnapshotDurationMs, 0),
          sourceWorkerMs: slices.reduce((sum, slice) => sum + slice.sourceWorkerDurationMs, 0),
          reducerWorkerMs: slices.reduce((sum, slice) => sum + slice.reducerWorkerDurationMs, 0),
          finalViewMaterializationMs: slices.reduce((sum, slice) => sum + slice.finalViewMaterializationDurationMs, 0),
          sourceRows: slices.reduce((sum, slice) => sum + slice.sourceRows, 0),
          sourceBytes: slices.reduce((sum, slice) => sum + slice.sourceBytes, 0), slices: slices.length,
          yieldedSlices: slices.filter((slice) => slice.yielded).length })
        expect(page.entries).toHaveLength(1)
        expect(page.entries[0]?.message.content).toBe(body)
      }
      const summarize = (values: number[]) => {
        const ordered = [...values].sort((a, b) => a - b)
        return { p50: Number(ordered[Math.floor((ordered.length - 1) * 0.5)]!.toFixed(3)),
          p95: Number(ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]!.toFixed(3)), max: Number(ordered[ordered.length - 1]!.toFixed(3)) }
      }
      console.info(`[session-switch-production-cold-perf] ${JSON.stringify({ samples: durations.length,
        bodyBytesPerMessage: Buffer.byteLength(body), requestMs: summarize(durations),
        stageMs: Object.fromEntries([...stages].map(([name, values]) => [name, summarize(values)])),
        projectionBuild: Object.fromEntries(['durationMs', 'sourceSnapshotMs', 'sourceWorkerMs', 'reducerWorkerMs', 'finalViewMaterializationMs',
          'sourceRows', 'sourceBytes', 'slices', 'yieldedSlices'].map((key) => [key,
          summarize(projectionSummaries.map((item) => item[key as keyof typeof item] as number))])),
        stageOutcomes: Object.fromEntries(stageOutcomes), cachePathSequenceCounts: Object.fromEntries(
          [...new Set(pathSequences)].map((sequence) => [sequence, pathSequences.filter((value) => value === sequence).length])) })}`)
      expect(durations).toHaveLength(sampleCount)
      expect(pathSequences.every((sequence) => sequence.startsWith('cold'))).toBe(true)
      expect(stageOutcomes.get('body-read')?.error ?? 0).toBe(0)
      expect(stageOutcomes.get('final-source-check')?.ok ?? 0).toBe(sampleCount)
      expect(stageOutcomes.has('legacy-fallback')).toBe(false)
    } finally {
      await host.lifecycle.stop({ deadlineMs: 5_000 })
      temp.cleanup()
      await fs.rm(blobRoot, { recursive: true, force: true })
    }
  }, 180_000)

})
