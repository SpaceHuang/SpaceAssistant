import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { registerStorageMaintenanceIpc } from './storageMaintenanceIpc'

describe('storage maintenance IPC', () => {
  it('skips progress sends after the renderer sender is destroyed', async () => {
    const temp = createTempDatabase('storage-maintenance-destroyed-sender-')
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any
    const send = vi.fn(() => { throw new Error('destroyed sender') })
    const ctx = { db: temp.db, getUserDataPath: () => temp.dbPath.replace(/test\.db$/, 'user-data') } as any
    registerStorageMaintenanceIpc(ipcMain, ctx)
    const result = await handlers.get('storage:compact')!({ sender: { send, isDestroyed: () => true } }) as { archivePath: string }
    expect(result.archivePath).toContain('user-data/session-archives')
    expect(send).not.toHaveBeenCalled()
    temp.cleanup()
  })

  it('exposes profile/cache operations and forwards compaction progress', async () => {
    const temp = createTempDatabase('storage-maintenance-ipc-')
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) } as any
    const send = vi.fn()
    const ctx = { db: temp.db, getUserDataPath: () => temp.dbPath.replace(/test\.db$/, 'user-data') } as any
    registerStorageMaintenanceIpc(ipcMain, ctx)
    const profile = await handlers.get('storage:get-profile')!()
    expect(profile).toHaveProperty('dbBytes')
    expect(await handlers.get('storage:clear-cache')!()).toEqual({ cacheRows: 0, eligibilityRows: 0 })
    const result = await handlers.get('storage:compact')!({ sender: { send, isDestroyed: () => false } }) as { archivePath: string }
    expect(result.archivePath).toContain('user-data/session-archives')
    expect(send).toHaveBeenCalledWith('storage:maintenance-progress', expect.objectContaining({ phase: 'complete' }))
    temp.cleanup()
  })
})
