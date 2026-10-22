import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSession } from '../../database/operations'
import { createMemoryAppDb } from '../../database/testHelpers'
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

  it('does not report quiescent until the active read worker has exited and preserves the prior checkpoint', async () => {
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
        readChunk, historyReducer, blobs: { write: async (payload) => ({ locator: 'projection-00000000-0000-4000-8000-000000000001.blob',
          byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex'), release: async () => undefined }) },
        limits: { maxRows: 2, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 1 })
      const handle = supervisor.start()
      await workerStarted
      handle.stop()
      let quiesced = false
      const quiescence = handle.quiesce().then(() => { quiesced = true })
      await Promise.resolve()
      expect(quiesced).toBe(false)
      exited()
      await quiescence
      expect(quiesced).toBe(true)
      expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'rebuilding' })
      expect(service.readCheckpoint(session.id, 'scope-a')).not.toBeNull()
      work = []
    } finally { db.close() }
  })
})
