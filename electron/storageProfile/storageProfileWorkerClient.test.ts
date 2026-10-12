import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import { runStorageProfileWorker } from './storageProfileWorkerClient'

describe('storage profile worker client', () => {
  it('waits for worker exit after timeout before rejecting drained', async () => {
    const worker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      terminate: vi.fn(async () => 0)
    }) as unknown as Worker
    let settled = false
    const pending = runStorageProfileWorker({ type: 'overview', dbPath: '/synthetic/db' }, { timeoutMs: 5,
      workerPath: path.join(process.cwd(), 'electron/storageProfile/storageProfileWorker.js'), createWorker: () => worker })
      .finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(settled).toBe(false)
    worker.emit('exit', 1)
    await expect(pending).rejects.toMatchObject({ code: 'STORAGE_PROFILE_TIMEOUT' })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('opens a real worker, returns a DTO, and releases the SQLite snapshot for checkpoint', async () => {
    const { createStorageProfileFixture } = await import('../../scripts/storage-profile-perf-baseline-fixture')
    const { DatabaseSync } = await import('node:sqlite')
    const fixture = createStorageProfileFixture('small')
    try {
      const workerPath = path.join(process.cwd(), 'electron/storageProfile/storageProfileWorker.ts')
      const response = await runStorageProfileWorker({ type: 'overview', dbPath: fixture.dbPath }, { timeoutMs: 10_000, workerPath })
      expect(response.type).toBe('overview')
      expect(response.result).toMatchObject({ tables: { messages: { rows: 100 } } })
      const db = new DatabaseSync(fixture.dbPath)
      expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toBeDefined()
      db.close()
      await expect(runStorageProfileWorker({ type: 'overview', dbPath: fixture.dbPath }, { timeoutMs: 10_000, workerPath })).resolves.toMatchObject({ type: 'overview' })
    } finally { fixture.cleanup() }
  })

  it('terminates a real worker during a large synchronous scan, releases the reader, and accepts a later request', async () => {
    const { createStorageProfileFixture } = await import('../../scripts/storage-profile-perf-baseline-fixture')
    const { DatabaseSync } = await import('node:sqlite')
    const fixture = createStorageProfileFixture('large')
    const workerPath = path.join(process.cwd(), 'electron/storageProfile/storageProfileWorker.ts')
    try {
      await expect(runStorageProfileWorker({ type: 'audit', dbPath: fixture.dbPath }, { timeoutMs: 150, workerPath }))
        .rejects.toMatchObject({ code: 'STORAGE_PROFILE_TIMEOUT' })
      const db = new DatabaseSync(fixture.dbPath)
      expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()).toBeDefined()
      db.close()
      await expect(runStorageProfileWorker({ type: 'overview', dbPath: fixture.dbPath }, { timeoutMs: 10_000, workerPath }))
        .resolves.toMatchObject({ type: 'overview', result: { tables: { messages: { rows: 20_000 } } } })
    } finally { fixture.cleanup() }
  }, 30_000)

  it('settles SQLite open errors and malformed requests without fallback', async () => {
    await expect(runStorageProfileWorker({ type: 'overview', dbPath: '/missing/storage-profile.db' }, {
      timeoutMs: 1_000, workerPath: path.join(process.cwd(), 'electron/storageProfile/storageProfileWorker.ts')
    }))
      .rejects.toMatchObject({ code: 'STORAGE_PROFILE_WORKER_ERROR' })
  })

  it('settles unexpected worker exit and missing loader paths with stable errors', async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 1) }) as unknown as Worker
    const pending = runStorageProfileWorker({ type: 'audit', dbPath: '/synthetic/db' }, {
      timeoutMs: 1_000, workerPath: path.join(process.cwd(), 'dist-electron/electron/storageProfile/storageProfileWorker.js'), createWorker: () => worker
    })
    worker.emit('exit', 2)
    await expect(pending).rejects.toMatchObject({ code: 'STORAGE_PROFILE_WORKER_EXIT' })
    await expect(runStorageProfileWorker({ type: 'overview', dbPath: '/synthetic/db' }, { workerPath: '/missing/storageProfileWorker.js' }))
      .rejects.toMatchObject({ code: 'STORAGE_PROFILE_WORKER_ERROR' })
  })

  it('waits for actual worker exit after aborting a synchronous worker', async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 0) }) as unknown as Worker
    const controller = new AbortController()
    let settled = false
    const pending = runStorageProfileWorker({ type: 'overview', dbPath: '/synthetic/db' }, {
      timeoutMs: 1_000, signal: controller.signal,
      workerPath: path.join(process.cwd(), 'dist-electron/electron/storageProfile/storageProfileWorker.js'), createWorker: () => worker
    }).finally(() => { settled = true })
    controller.abort()
    await Promise.resolve()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    worker.emit('exit', 1)
    await expect(pending).rejects.toMatchObject({ code: 'STORAGE_PROFILE_WORKER_EXIT' })
  })
})
