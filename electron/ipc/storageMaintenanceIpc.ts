import path from 'node:path'
import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import { collectSessionStorageProfile } from '../database/sessionStorageProfile'
import { clearSessionProjectionCaches, compactSessionDatabase } from '../storage/sessionStorageMaintenance'

export function registerStorageMaintenanceIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
  ipcMain.handle('storage:get-profile', () => collectSessionStorageProfile(ctx.db.filePath))
  ipcMain.handle('storage:clear-cache', () => clearSessionProjectionCaches(ctx.db))
  ipcMain.handle('storage:compact', (event) => compactSessionDatabase(ctx.db, ctx.getUserDataPath(), (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('storage:maintenance-progress', progress)
  }))
}

export function getStorageSpillDirectory(userDataPath: string): string {
  return path.join(userDataPath, 'spill')
}
