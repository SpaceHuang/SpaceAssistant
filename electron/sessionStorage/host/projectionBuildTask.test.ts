import { describe, expect, it, vi } from 'vitest'
import { createProjectionBuildLifecycleTask } from './projectionBuildTask'
import { createMemoryAppDb } from '../../database/testHelpers'
import { createSession } from '../../database/operations'
import { createSqliteProjectionStateStore } from '../infrastructure/sqlite/sessionProjectionStateStore'
import { encodeProjectionScopeKey } from '../domain/scopeKey'

describe('projection build lifecycle adapter', () => {
  it('registers the one-worker supervisor as derived-index and exposes its stop/quiesce handle', async () => {
    const task = createProjectionBuildLifecycleTask({
      service: { beginRebuild: vi.fn(), readCheckpoint: vi.fn() } as never,
      listDueWork: () => [], dbPath: '/tmp/session.db',
      readChunk: vi.fn(), historyReducer: { createState: () => '{}', fold: vi.fn(), finalize: vi.fn() },
      blobs: { write: vi.fn() }, limits: { maxRows: 1, maxBytes: 512 }, maxChunksPerSlice: 1, now: () => 1,
    })
    expect(task.taskId).toBe('session-projection-build')
    expect(task.category).toBe('derived-index')
    const handle = task.start()
    expect(handle).toMatchObject({ stop: expect.any(Function), quiesce: expect.any(Function) })
    handle?.stop()
    await handle?.quiesce()
  })

  it('wires persisted due scopes into the registered supervisor and claims them', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'host projection due work', model: 'test' })
      const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 7 })
      const store = createSqliteProjectionStateStore(db)
      store.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation, now: 1 })
      const service = { beginRebuild: vi.fn(() => null), readCheckpoint: vi.fn() } as never
      const task = createProjectionBuildLifecycleTask({ dbPath: '/tmp/session.db', service,
        listDueWork: () => store.listDueWork(2, 64, 2), readChunk: vi.fn(), historyReducer: {} as never, blobs: {} as never,
        limits: { maxRows: 20, maxBytes: 4096 }, maxChunksPerSlice: 1, now: () => 2 })

      expect(task.category).toBe('derived-index')
      const handle = task.start()!
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(service.beginRebuild).toHaveBeenCalledWith({ sessionId: session.id,
        sessionGeneration: session.generation, scopeKey })
      handle.stop()
      await handle.quiesce()
    } finally { db.close() }
  })
})
