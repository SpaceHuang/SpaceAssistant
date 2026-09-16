import { ipcMain } from 'electron'
import { runButlerTask, type ButlerInvokerDeps } from './butlerInvoker'
import {
  createAutomationTask,
  deleteAutomationTask,
  getAutomationTask,
  listAutomationTasks,
  updateAutomationTask,
  type AutomationTaskInput,
  type AutomationTaskSchedule
} from './taskStore'

/**
 * 管家 IPC（P6 任务 CRUD 面 + P4 手动触发）。渲染进程只表达意图：
 * 准入、调度、会话创建、门控、投递全在主进程。
 */

export type ButlerIpcDeps = ButlerInvokerDeps

function parseSchedule(raw: unknown): AutomationTaskSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { kind?: string; intervalMinutes?: number; time?: string; at?: number }
  if (r.kind === 'interval' && typeof r.intervalMinutes === 'number' && r.intervalMinutes > 0) {
    return { kind: 'interval', intervalMinutes: r.intervalMinutes }
  }
  if (r.kind === 'daily' && typeof r.time === 'string' && /^\d{2}:\d{2}$/.test(r.time)) {
    return { kind: 'daily', time: r.time }
  }
  if (r.kind === 'once' && typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0) {
    return { kind: 'once', at: r.at }
  }
  return undefined
}

function parseDeliveryPref(raw: unknown): 'desktop' | 'feishu' | 'wechat' | 'none' | undefined {
  return raw === 'desktop' || raw === 'feishu' || raw === 'wechat' || raw === 'none' ? raw : undefined
}

export function registerButlerIpcHandlers(ipcMain: Electron.IpcMain, deps: ButlerIpcDeps): void {
  const { db } = deps

  ipcMain.handle('butler:list', () => listAutomationTasks(db))

  ipcMain.handle('butler:create', (_e, payload: Partial<AutomationTaskInput>): { ok: boolean; id?: string; error?: string } => {
    const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
    const schedule = parseSchedule(payload?.schedule)
    const deliveryPref = parseDeliveryPref(payload?.deliveryPref)
    if (!name || !prompt || !schedule || !deliveryPref) {
      return { ok: false, error: '任务参数不完整（名称 / 提示词 / 触发方式 / 投递偏好）' }
    }
    const task = createAutomationTask(db, {
      name,
      prompt,
      schedule,
      deliveryPref,
      ...(payload?.deliveryTarget ? { deliveryTarget: payload.deliveryTarget } : {}),
      ...(payload?.modelOverride ? { modelOverride: payload.modelOverride } : {}),
      ...(payload?.enabled !== undefined ? { enabled: payload.enabled } : {})
    })
    return { ok: true, id: task.id }
  })

  ipcMain.handle('butler:update', (_e, payload: { id: string; patch: Record<string, unknown> }): { ok: boolean; error?: string } => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id || !getAutomationTask(db, id)) return { ok: false, error: '任务不存在' }
    const patch = payload?.patch ?? {}
    const next: Record<string, unknown> = {}
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
    if (typeof patch.prompt === 'string' && patch.prompt.trim()) next.prompt = patch.prompt.trim()
    const schedule = parseSchedule(patch.schedule)
    if (schedule) next.schedule = schedule
    const deliveryPref = parseDeliveryPref(patch.deliveryPref)
    if (deliveryPref) next.deliveryPref = deliveryPref
    if (typeof patch.deliveryTarget === 'string') next.deliveryTarget = patch.deliveryTarget
    if (typeof patch.modelOverride === 'string') next.modelOverride = patch.modelOverride
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    updateAutomationTask(db, id, next)
    return { ok: true }
  })

  ipcMain.handle('butler:delete', (_e, payload: { id: string }): { ok: boolean; error?: string } => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return { ok: false, error: '任务 ID 缺失' }
    return { ok: deleteAutomationTask(db, id) }
  })

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
