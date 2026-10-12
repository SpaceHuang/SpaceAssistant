import path from 'node:path'
import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import { StorageProfileCoordinator } from '../storageProfile/storageProfileCoordinator'
import { runStorageProfileWorker } from '../storageProfile/storageProfileWorkerClient'
import { clearSessionProjectionCaches, compactSessionDatabase } from '../storage/sessionStorageMaintenance'

export function registerStorageMaintenanceIpc(ipcMain: IpcMain, ctx: AppIpcContext): StorageProfileCoordinator {
  const coordinator = ctx.storageProfileCoordinator ?? new StorageProfileCoordinator({
    run: (request, options) => runStorageProfileWorker(request, { signal: options.signal })
  })
  ipcMain.handle('storage:get-overview', async (_event, options?: { force?: boolean }) => {
    try { return (await coordinator.request({ dbPath: ctx.db.filePath, type: 'overview', force: options?.force === true })).result }
    catch (error) { throw new Error(stableStorageProfileError(error)) }
  })
  ipcMain.handle('storage:run-audit', async () => {
    try { return (await coordinator.request({ dbPath: ctx.db.filePath, type: 'audit', force: true })).result }
    catch (error) { throw new Error(stableStorageProfileError(error)) }
  })
  ipcMain.handle('storage:clear-cache', async () => {
    try { return await coordinator.withMaintenance(ctx.db.filePath, async () => clearSessionProjectionCaches(ctx.db)) }
    catch (error) { throw new Error(stableMaintenanceError(error)) }
  })
  ipcMain.handle('storage:compact', async (event) => {
    try {
      return await coordinator.withMaintenance(ctx.db.filePath, async () => compactSessionDatabase(ctx.db, ctx.getUserDataPath(), (progress) => {
        event.sender.send('storage:maintenance-progress', progress)
      }))
    } catch (error) { throw new Error(stableMaintenanceError(error)) }
  })
  return coordinator
}

function stableStorageProfileError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('MAINTENANCE_BUSY')) return 'STORAGE_PROFILE_MAINTENANCE_BUSY'
  if (message.includes('QUEUE_FULL')) return 'STORAGE_PROFILE_QUEUE_FULL'
  if (message.includes('TIMEOUT')) return 'STORAGE_PROFILE_TIMEOUT'
  return 'STORAGE_PROFILE_WORKER_ERROR'
}

function stableMaintenanceError(error: unknown): string {
  if (error instanceof Error && error.message.includes('MAINTENANCE_BUSY')) return 'STORAGE_MAINTENANCE_BUSY'
  return 'STORAGE_MAINTENANCE_FAILED'
}

export function getStorageSpillDirectory(userDataPath: string): string {
  return path.join(userDataPath, 'spill')
}
