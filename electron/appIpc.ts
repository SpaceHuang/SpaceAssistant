// Phase 2 拆分后:本文件仅保留 IPC 组合器与 IpcContext 类型(driver-authority-refactor Phase 2)。
// 各领域 handler 见 electron/ipc/ 下按域文件;通道名与行为不变(纯移动)。
import type { IpcMain } from 'electron'
import { AppDatabase } from './database'
import { BrowserDetectContext } from './browser/browserDependencyDetect'
import { ClaudeTurnExecution } from './claudeStreamHandlers'
import { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
import { TurnRuntime } from './turnRuntime'
import { WorkDirManager } from './workDirManager'
import { registerAgentIpc } from './ipc/agentProtocolIpc'
import { registerConfigIpc } from './ipc/configIpc'
import { registerDesktopIpc } from './ipc/desktopIpc'
import { registerFileIpc } from './ipc/fileIpc'
import { registerMcpIpcHandlers } from './mcp/mcpIpc'
import { registerSearchIpc } from './ipc/searchIpc'
import { registerSecurityIpc } from './ipc/securityIpc'
import { registerSessionIpc } from './ipc/sessionIpc'

// 兼容 re-export:既有外部消费方(butler/main/llmSystemPrompt)从本文件导入
export { readAppLocale } from './ipc/ipcShared'

export type AppIpcContext = {
  db: AppDatabase
  backup: DebouncedSessionBackupManager
  workDirManager: WorkDirManager
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  setApiKey: (value: string) => Promise<void>
  getBrowserDetectContext: () => BrowserDetectContext
  floatingNotificationManager?: import('./floatingNotificationManager').FloatingNotificationManager
  turnRuntime?: TurnRuntime
  executeTurn?: ClaudeTurnExecution
  /** P0 托盘常驻前提：管家定时任务依赖「关窗进程存活」，设置页据此提示。 */
  isTrayEnabled?: () => boolean
}

/**
 * 组合器:按域注册全部 IPC handler。保留既有导出名以兼容装配方与测试。
 */
export function registerAppIpcHandlers(ipcMain: IpcMain, ctx: AppIpcContext): void {
  registerDesktopIpc(ipcMain, ctx)
  registerAgentIpc(ipcMain, ctx)
  registerSessionIpc(ipcMain, ctx)
  registerFileIpc(ipcMain, ctx)
  registerSearchIpc(ipcMain, ctx)
  registerConfigIpc(ipcMain, ctx)
  registerSecurityIpc(ipcMain, ctx)
  registerMcpIpcHandlers(ipcMain, ctx)
}
