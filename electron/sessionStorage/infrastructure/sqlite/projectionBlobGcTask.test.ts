import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDatabase } from '../../../database/testHelpers'
import { openDatabase } from '../../../database'
import { createProjectionBlobGcTask } from './projectionBlobGcTask'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'

describe('projection blob GC lifecycle task', () => {
  afterEach(() => vi.useRealTimers())

  it('retries failed collection and bounds each pass with a resumable cursor', async () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('projection-blob-gc-task-')
    try {
      const collectGarbage = vi.fn()
        .mockRejectedValueOnce(new Error('transient reference scan failure'))
        .mockResolvedValueOnce({ removedCount: 1, removedBytes: 12, nextLocator: 'projection-00000000-0000-0000-0000-000000000001.blob' })
        .mockResolvedValueOnce({ removedCount: 0, removedBytes: 0 })
      const task = createProjectionBlobGcTask(temp.db, temp.dbPath, { collectGarbage, batchSize: 1, retryMs: 25, idleMs: 1000 })
      const handle = task.start()!
      await vi.advanceTimersByTimeAsync(0)
      expect(collectGarbage).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(25)
      expect(collectGarbage).toHaveBeenCalledTimes(2)
      expect(collectGarbage.mock.calls[1]?.[1]).toMatchObject({ maxEntries: 1 })
      await vi.advanceTimersByTimeAsync(1)
      expect(collectGarbage).toHaveBeenCalledTimes(3)
      expect(collectGarbage.mock.calls[2]?.[1]).toMatchObject({
        afterLocator: 'projection-00000000-0000-0000-0000-000000000001.blob', maxEntries: 1
      })
      handle.stop()
      await handle.quiesce()
    } finally { temp.cleanup() }
  })

  it('honors a wake received during collection immediately after the active pass', async () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('projection-blob-gc-wake-')
    let finish!: (value: { removedCount: number; removedBytes: number }) => void
    const collectGarbage = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValueOnce({ removedCount: 1, removedBytes: 4 })
    try {
      const handle = createProjectionBlobGcTask(temp.db, temp.dbPath, { collectGarbage }).start()!
      await vi.advanceTimersByTimeAsync(0)
      handle.request?.('scope-changed')
      finish({ removedCount: 0, removedBytes: 0 })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(collectGarbage).toHaveBeenCalledTimes(2)
      handle.stop()
      await handle.quiesce()
    } finally { temp.cleanup() }
  })

  it('reclaims orphan files after reopening the database and maintenance owner', async () => {
    const temp = createTempDatabase('projection-blob-gc-reopen-')
    const root = path.join(path.dirname(temp.dbPath), 'projection-blobs')
    let reopenedDb: ReturnType<typeof openDatabase> | undefined
    let handle: ReturnType<ReturnType<typeof createProjectionBlobGcTask>['start']> | undefined
    try {
      const staged = await createSessionProjectionBlobStore(root).write('orphan survives process restart')
      await staged.release()
      temp.db.close()
      reopenedDb = openDatabase(temp.dbPath)
      handle = createProjectionBlobGcTask(reopenedDb, root).start()
      await vi.waitFor(async () => expect((await fs.readdir(root)).filter((name) => name.endsWith('.blob'))).toHaveLength(0), { timeout: 5_000 })
    } finally {
      handle?.stop()
      await handle?.quiesce()
      reopenedDb?.close()
      temp.cleanup()
    }
  })
})
