import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { registerStorageMaintenanceIpc } from './storageMaintenanceIpc'
import { StorageProfileCoordinator } from '../storageProfile/storageProfileCoordinator'
import { runStorageProfileWorker } from '../storageProfile/storageProfileWorkerClient'
import path from 'node:path'

describe('storage maintenance IPC', () => {
  it('exposes profile/cache operations and forwards compaction progress', async () => {
    const temp = createTempDatabase('storage-maintenance-ipc-')
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any
    const send = vi.fn()
    const coordinator = new StorageProfileCoordinator({ run: async (request) => request.type === 'overview'
      ? { type: 'overview', result: { dbBytes: 1 } as any }
      : { type: 'audit', result: { collectedAt: new Date().toISOString() } as any } })
    const ctx = { db: temp.db, getUserDataPath: () => temp.dbPath.replace(/test\.db$/, 'user-data'), storageProfileCoordinator: coordinator } as any
    registerStorageMaintenanceIpc(ipcMain, ctx)
    expect(handlers.has('storage:get-profile')).toBe(false)
    expect(await handlers.get('storage:get-overview')!()).toEqual({ dbBytes: 1 })
    expect(await handlers.get('storage:run-audit')!()).toEqual({ collectedAt: expect.any(String) })
    expect(await handlers.get('storage:clear-cache')!()).toEqual({ cacheRows: 0, eligibilityRows: 0 })
    const result = await handlers.get('storage:compact')!({ sender: { send } }) as { archivePath: string }
    expect(result.archivePath).toContain('user-data/session-archives')
    expect(send).toHaveBeenCalledWith('storage:maintenance-progress', expect.objectContaining({ phase: 'complete' }))
    temp.cleanup()
  })

  it('drains a real worker before checkpoint and invalidates its result after compaction', async () => {
    const temp = createTempDatabase('storage-maintenance-worker-drain-')
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any
    const coordinator = new StorageProfileCoordinator({ run: (request, options) => runStorageProfileWorker(request, {
      ...options, timeoutMs: 10_000, workerPath: path.join(process.cwd(), 'electron/storageProfile/storageProfileWorker.ts')
    }) })
    registerStorageMaintenanceIpc(ipcMain, { db: temp.db, getUserDataPath: () => temp.dbPath.replace(/test\.db$/, 'user-data'), storageProfileCoordinator: coordinator } as any)
    const before = await handlers.get('storage:get-overview')!() as any
    const send = vi.fn()
    const compacted = await handlers.get('storage:compact')!({ sender: { send } }) as { pageCountAfter: number }
    const after = await handlers.get('storage:get-overview')!() as any
    expect(before.tables.messages).toEqual(after.tables.messages)
    expect(compacted.pageCountAfter).toEqual(expect.any(Number))
    expect(coordinator.activeWorkerCount).toBe(0)
    expect(send).toHaveBeenCalledWith('storage:maintenance-progress', expect.objectContaining({ phase: 'complete' }))
    temp.cleanup()
  })

  it('maps worker errors to stable IPC codes without paths or stacks', async () => {
    const temp = createTempDatabase('storage-maintenance-ipc-error-')
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any
    const coordinator = new StorageProfileCoordinator({ run: async () => { throw new Error(`/private/user/data/db failed at stack line`) } })
    registerStorageMaintenanceIpc(ipcMain, { db: temp.db, getUserDataPath: () => '/private/user/data', storageProfileCoordinator: coordinator } as any)
    await expect(handlers.get('storage:get-overview')!()).rejects.toThrow('STORAGE_PROFILE_WORKER_ERROR')
    temp.cleanup()
  })
})
