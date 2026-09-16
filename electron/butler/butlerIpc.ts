import { ipcMain } from 'electron'
import { runButlerTask, type ButlerInvokerDeps } from './butlerInvoker'

/**
 * 管家 IPC（P4 先注册 butler:run-task 手动触发；P6 扩展任务 CRUD 面）。
 * 渲染进程只表达意图：准入、会话创建、门控、投递全在主进程。
 */
export function registerButlerIpcHandlers(ipcMain: Electron.IpcMain, deps: ButlerInvokerDeps): void {
  ipcMain.handle('butler:run-task', async (_e, payload: { taskId: string; requestId?: string }): Promise<{ ok: boolean; runId?: string; sessionId?: string; summary?: string; error?: string }> => {
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId.trim() : ''
    if (!taskId) return { ok: false, error: '任务 ID 缺失' }
    const requestId = typeof payload?.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : undefined
    const result = await runButlerTask(deps, taskId, { trigger: 'manual', ...(requestId ? { requestId } : {}) })
    if (result.ok) {
      return { ok: true, runId: result.runId, sessionId: result.sessionId, summary: result.summary }
    }
    return { ok: false, runId: result.runId, error: result.error }
  })
}
