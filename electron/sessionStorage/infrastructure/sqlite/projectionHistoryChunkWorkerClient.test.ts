import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Worker } from 'node:worker_threads'
import { appendMessage, createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { readProjectionHistoryChunkInWorker } from './projectionHistoryChunkWorkerClient'
import type { ProjectionHistoryChunkPermit } from './projectionHistoryChunkReader'

class StubWorker extends EventEmitter {
  requestId?: string
  terminated = false
  postMessage(message: { requestId: string }) { this.requestId = message.requestId }
  terminate() { this.terminated = true; return Promise.resolve(1) }
}

const permit: ProjectionHistoryChunkPermit = { dbPath: '/tmp/session.db', sessionId: 'session-a',
  sessionGeneration: 'generation-a', scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"revision":1}',
  connectionEpoch: 1, processGeneration: 2, rebuildToken: 'token-a' }
const complete = { kind: 'complete' as const, permit, afterSessionSequence: 4 }

describe('projection history chunk worker client', () => {
  it('does not report a result as quiescent until the worker has actually exited', async () => {
    const worker = new StubWorker()
    let settled = false
    const pending = readProjectionHistoryChunkInWorker(permit, { afterSessionSequence: 4, maxRows: 2, maxBytes: 1024 }, {
      workerPath: 'worker.js', timeoutMs: 1000, createWorker: () => worker as unknown as Worker,
    }).then((result) => { settled = true; return result })
    worker.emit('message', { requestId: worker.requestId, result: complete })
    await Promise.resolve()
    expect(settled).toBe(false)
    worker.emit('exit', 0)
    await expect(pending).resolves.toEqual(complete)
    expect(settled).toBe(true)
  })

  it('waits for termination after cancellation before settling the read', async () => {
    const worker = new StubWorker()
    const controller = new AbortController()
    let settled = false
    const pending = readProjectionHistoryChunkInWorker(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 512 }, {
      signal: controller.signal, workerPath: 'worker.js', timeoutMs: 1000, createWorker: () => worker as unknown as Worker,
    }).catch((error: Error) => { settled = true; throw error })
    controller.abort(new Error('stop requested'))
    await Promise.resolve()
    expect(worker.terminated).toBe(true)
    expect(settled).toBe(false)
    worker.emit('exit', 1)
    await expect(pending).rejects.toThrow('stop requested')
    expect(settled).toBe(true)
  })

  it('accepts the coordinator signal on the worker request input and waits for exit', async () => {
    const worker = new StubWorker()
    const controller = new AbortController()
    let settled = false
    const pending = readProjectionHistoryChunkInWorker(permit, { afterSessionSequence: 0, maxRows: 1, maxBytes: 512,
      signal: controller.signal }, { workerPath: 'worker.js', timeoutMs: 1000, createWorker: () => worker as unknown as Worker })
      .catch((error: Error) => { settled = true; throw error })
    controller.abort(new Error('coordinator stopping'))
    await Promise.resolve()
    expect(worker.terminated).toBe(true)
    expect(settled).toBe(false)
    worker.emit('exit', 1)
    await expect(pending).rejects.toThrow('coordinator stopping')
  })

  it('runs the source worker with its own read-only connection and exits after one bounded request', async () => {
    const temp = createTempDatabase('projection-real-worker-')
    try {
      const session = createSession(temp.db, { name: 'projection real worker' })
      appendMessage(temp.db, { id: 'large-worker-message', sessionId: session.id, role: 'user', content: 'x'.repeat(4096),
        timestamp: 1, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
      await history.appendBatch([{ invocationId: 'worker-sample-inv', turnId: 'worker-sample-turn', sequence: 1, schemaVersion: 1,
        eventId: 'worker-sample-event', idempotencyKey: 'worker-sample-event', kind: 'invocation-context-committed',
        payload: { messages: [] } }], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
      const result = await readProjectionHistoryChunkInWorker({ dbPath: temp.dbPath, sessionId: session.id,
        sessionGeneration: session.generation, scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson,
        connectionEpoch: 1, processGeneration: 1, rebuildToken: 'worker-token' }, { afterSessionSequence: 0, maxRows: 2, maxBytes: 2048 }, {
        workerPath: path.join(process.cwd(), 'electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkWorker.ts'), timeoutMs: 5000,
      })
      expect(result).toMatchObject({ kind: 'chunk', afterSessionSequence: 0,
        workerSample: { durationMs: expect.any(Number), heapUsedBytesAtExit: expect.any(Number), processRssBytesAtExit: expect.any(Number),
          heapUsedBytesPeakSampled: expect.any(Number), processRssBytesPeakSampled: expect.any(Number), memorySampleIntervalMs: 10 } })
      await history.appendBatch([{ invocationId: 'worker-sample-inv', turnId: 'worker-sample-turn', sequence: 2, schemaVersion: 1,
        eventId: 'worker-large-event', idempotencyKey: 'worker-large-event', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'large-worker-message', role: 'user', content: 'x'.repeat(4096) }] } }], 1)
      const currentSourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
      const deferred = await readProjectionHistoryChunkInWorker({ dbPath: temp.dbPath, sessionId: session.id,
        sessionGeneration: session.generation, scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: currentSourceIdentityJson,
        connectionEpoch: 1, processGeneration: 1, rebuildToken: 'worker-token' }, { afterSessionSequence: 1, maxRows: 1, maxBytes: 512 }, {
        workerPath: path.join(process.cwd(), 'electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkWorker.ts'), timeoutMs: 5000,
      })
      expect(deferred).toMatchObject({ kind: 'deferred-large', observedEventRows: 1, observedByteLength: expect.any(Number),
        snapshotDurationMs: expect.any(Number), workerSample: { durationMs: expect.any(Number),
          heapUsedBytesAtExit: expect.any(Number), processRssBytesAtExit: expect.any(Number),
          heapUsedBytesPeakSampled: expect.any(Number), processRssBytesPeakSampled: expect.any(Number), memorySampleIntervalMs: 10 } })
      const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-history-stage-'))
      try {
        const tempLocator = `.projection-${randomUUID()}.tmp`
        const staged = await readProjectionHistoryChunkInWorker({ dbPath: temp.dbPath, sessionId: session.id,
          sessionGeneration: session.generation, scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: currentSourceIdentityJson,
          connectionEpoch: 1, processGeneration: 1, rebuildToken: 'worker-token' },
        { afterSessionSequence: 1, maxRows: 1, maxBytes: 512,
          staging: { root: stageRoot, tempLocator, tempLocators: Array.from({ length: 15 }, () => `.projection-${randomUUID()}.tmp`) } }, {
          workerPath: path.join(process.cwd(), 'electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkWorker.ts'), timeoutMs: 5000,
        })
        expect(staged).toMatchObject({ kind: 'staged-chunk', afterSessionSequence: 1, nextSessionSequence: 2,
          rowCount: 1, sourceByteLength: expect.any(Number), stagedBlob: { tempLocator, byteLength: expect.any(Number),
            payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }, workerSample: { durationMs: expect.any(Number) } })
        if (staged.kind !== 'staged-chunk') throw new Error('expected staged chunk result')
        const bytes = await fs.readFile(path.join(stageRoot, tempLocator))
        expect(bytes.byteLength).toBe(staged.stagedBlob.byteLength)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(staged.stagedBlob.payloadDigest)
        const manifest = JSON.parse(bytes.toString('utf8'))
        expect(manifest).toMatchObject({ kind: 'segmented-history-event', event: { eventId: 'worker-large-event' }, messageCount: 1 })
        expect(staged.stagedSegments).toHaveLength(manifest.messageSegments.length + manifest.factSegments.length)
        for (const segment of staged.stagedSegments) {
          const segmentBytes = await fs.readFile(path.join(stageRoot, segment.tempLocator))
          expect(segmentBytes.byteLength).toBe(segment.byteLength)
          expect(createHash('sha256').update(segmentBytes).digest('hex')).toBe(segment.payloadDigest)
          expect(JSON.parse(`[${segmentBytes.toString('utf8').slice(1, -1)}]`)).toHaveLength(1)
        }
      } finally { await fs.rm(stageRoot, { recursive: true, force: true }) }
    } finally { temp.cleanup() }
  }, 15_000)

  it('preserves a legal source-drift message body while staging a large context event', async () => {
    const temp = createTempDatabase('projection-source-drift-body-')
    try {
      const session = createSession(temp.db, { name: 'projection source drift body' })
      const messages = Array.from({ length: 6 }, (_, index) => ({ id: `drift-body-${index}`, role: 'user',
        content: index === 0 ? 'source-drift' : 'x'.repeat(63 * 1024), timestamp: index + 1 }))
      for (const message of messages) appendMessage(temp.db, { id: message.id, sessionId: session.id, role: 'user',
        content: message.content, timestamp: message.timestamp, status: 'sent' })
      const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id)
      await history.appendBatch([{ invocationId: 'drift-body-inv', turnId: 'drift-body-turn', sequence: 1, schemaVersion: 1,
        eventId: 'drift-body-event', idempotencyKey: 'drift-body-event', kind: 'invocation-context-committed',
        payload: { messages } }], 0)
      const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
      const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'projection-source-drift-stage-'))
      try {
        const tempLocator = `.projection-${randomUUID()}.tmp`
        const staged = await readProjectionHistoryChunkInWorker({ dbPath: temp.dbPath, sessionId: session.id,
          sessionGeneration: session.generation, scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson,
          connectionEpoch: 1, processGeneration: 1, rebuildToken: 'drift-body-token' },
        { afterSessionSequence: 0, maxRows: 1, maxBytes: 256 * 1024,
          staging: { root: stageRoot, tempLocator, tempLocators: Array.from({ length: 15 }, () => `.projection-${randomUUID()}.tmp`) } }, {
          workerPath: path.join(process.cwd(), 'electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkWorker.ts'), timeoutMs: 10_000,
        })
        expect(staged).toMatchObject({ kind: 'staged-chunk', nextSessionSequence: 1 })
        if (staged.kind !== 'staged-chunk') throw new Error('expected staged large context event')
        const manifest = JSON.parse((await fs.readFile(path.join(stageRoot, tempLocator))).toString('utf8'))
        const factLocators = new Set((manifest.factSegments as Array<{ locator: string }>).map((segment) => segment.locator))
        const factSegments = staged.stagedSegments.filter((segment) => factLocators.has(segment.locator))
        const facts = (await Promise.all(factSegments.map(async (segment) => JSON.parse(
          `[${(await fs.readFile(path.join(stageRoot, segment.tempLocator))).toString('utf8').slice(1, -1)}]`))))
          .flat() as Array<{ id: string; storedContent: string }>
        expect(facts.find((fact) => fact.id === 'drift-body-0')?.storedContent).toBe('source-drift')
      } finally { await fs.rm(stageRoot, { recursive: true, force: true }) }
    } finally { temp.cleanup() }
  }, 20_000)
})
