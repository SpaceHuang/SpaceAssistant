import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { compactSessionDatabase } from './sessionStorageMaintenance'

// 仅本文件 mock worker 入口：入口不可用是编排器降级进程内路径的唯一触发（其余失败原样上抛），
// sessionStorageMaintenance.test.ts 中的真实 worker 用例不受影响。
vi.mock('./sessionStorageMaintenanceWorkerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionStorageMaintenanceWorkerClient')>()
  const { StorageMaintenanceError } = await import('./storageMaintenanceError')
  return {
    ...actual,
    runSessionMaintenanceWorker: async () => {
      throw new StorageMaintenanceError('STORAGE_MAINTENANCE_FAILED', actual.COMPACTION_WORKER_ENTRY_UNAVAILABLE)
    }
  }
})

describe('degraded compaction archive retention', () => {
  it('degraded in-process success still prunes older archives through the single wrapper', async () => {
    const temp = createTempDatabase('storage-maintenance-prune-degraded-')
    const userDataDir = path.dirname(temp.dbPath)
    getDbConnection(temp.db).exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('payload');")
    temp.db.flushSave()
    const archiveRoot = path.join(userDataDir, 'session-archives')
    const staleName = `${new Date(Date.now() - 10 * 60_000).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    await fs.mkdir(path.join(archiveRoot, staleName), { recursive: true })
    await fs.writeFile(path.join(archiveRoot, staleName, 'spaceassistant-data.db'), 'stale archive bytes')

    const result = await compactSessionDatabase(temp.db, userDataDir, undefined, { awaitArchivePrune: true })

    // worker 入口不可用 → 降级进程内路径成功；wrapper 单点仍拿到降级结果的 archivePath 并完成 prune。
    expect(result.executionTarget).toBe('in-process')
    await expect(fs.readdir(archiveRoot)).resolves.toEqual([path.basename(result.archivePath)])
    temp.cleanup()
  }, 30_000)
})
