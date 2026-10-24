import path from 'node:path'
import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import { StorageProfileCoordinator } from '../storageProfile/storageProfileCoordinator'
import { runStorageProfileWorker } from '../storageProfile/storageProfileWorkerClient'
import { compactSessionDatabase, StorageMaintenanceError } from '../storage/sessionStorageMaintenance'
import { logAgentEvent } from '../agentLogger/agentLogger'

export function registerStorageMaintenanceIpc(ipcMain: IpcMain, ctx: AppIpcContext): StorageProfileCoordinator {
  const coordinator = ctx.storageProfileCoordinator ?? new StorageProfileCoordinator({
    run: (request, options) => runStorageProfileWorker(request, { signal: options.signal })
  })
  ipcMain.handle('storage:get-overview', async (_event, options?: { force?: boolean }) => {
    try { return (await coordinator.request({ dbPath: ctx.db.filePath, type: 'overview', force: options?.force === true })).result }
    catch (error) { throw new Error(logProfileRequestFailure('overview', error)) }
  })
  ipcMain.handle('storage:run-audit', async () => {
    try { return (await coordinator.request({ dbPath: ctx.db.filePath, type: 'audit', force: true })).result }
    catch (error) { throw new Error(logProfileRequestFailure('audit', error)) }
  })
  ipcMain.handle('storage:clear-cache', async () => {
    try { return await coordinator.withMaintenance(ctx.db.filePath, async () => ctx.sessionStorage?.clearProjectionCaches?.() ?? Promise.reject(new Error('SESSION_STORAGE_CACHE_CLEANUP_REQUIRED'))) }
    catch (error) {
      const stable = stableMaintenanceError(error)
      logAgentEvent('warn', 'storage.profile.request_failed', { request: 'clear-cache', errorCode: stable,
        reason: error instanceof Error ? error.message : String(error) })
      throw new Error(stable)
    }
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

/** 概览/审计/清缓存失败的诊断日志：设置页「部分容量数据暂不可用」警示的根因在此可查。 */
function logProfileRequestFailure(request: 'overview' | 'audit' | 'clear-cache', error: unknown): string {
  const stable = stableStorageProfileError(error)
  logAgentEvent('warn', 'storage.profile.request_failed', {
    request, errorCode: stable,
    reason: error instanceof Error ? error.message : String(error)
  })
  return stable
}

function stableStorageProfileError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('MAINTENANCE_BUSY')) return 'STORAGE_PROFILE_MAINTENANCE_BUSY'
  if (message.includes('QUEUE_FULL')) return 'STORAGE_PROFILE_QUEUE_FULL'
  if (message.includes('TIMEOUT')) return 'STORAGE_PROFILE_TIMEOUT'
  return 'STORAGE_PROFILE_WORKER_ERROR'
}

function stableMaintenanceError(error: unknown): string {
  // StorageMaintenanceError 的 message 是英文句子，稳定码只在 code 上；message.includes 仅作其他层拼接的兜底。
  if (error instanceof StorageMaintenanceError) return error.code
  if (error instanceof Error && error.message.includes('MAINTENANCE_BUSY')) return 'STORAGE_MAINTENANCE_BUSY'
  return 'STORAGE_MAINTENANCE_FAILED'
}

export function getStorageSpillDirectory(userDataPath: string): string {
  return path.join(userDataPath, 'spill')
}
