import { dialog, BrowserWindow } from 'electron'
import { runButlerTask, type ButlerInvokerDeps } from './butlerInvoker'
import {
  createAutomationTask,
  deleteAutomationTask,
  getAutomationTask,
  listAutomationTasks,
  listAutomationTaskRuns,
  updateAutomationTask,
  updateAutomationTaskConditional,
  type AutomationTaskInput,
  type AutomationTaskSchedule
} from './taskStore'
import { validateTaskModelConfig, validateTaskWorkDir, validateTaskWorkDirs } from './taskConfigValidation'
import { readActiveLlmServiceIds, readLlmServices, readStoredModels } from '../llmServiceResolver'
import { getConfigValue } from '../database'
import { runTaskPreflight, type TaskPreflightAnalyzer } from './taskPreflight'
import { createTaskPreflightModelAnalyzer } from './taskPreflightModelAnalyzer'
import type { PreflightReport, ButlerTaskWriteResult } from '../../src/shared/automationTaskTypes'

/**
 * 管家 IPC（P6 任务 CRUD 面 + P4 手动触发）。渲染进程只表达意图：
 * 准入、调度、会话创建、门控、投递全在主进程。
 */

export type ButlerIpcDeps = ButlerInvokerDeps

export type ButlerTaskPreflightDeps = {
  now?: () => number
  createAnalyzer?: (task: { modelId?: string; modelServiceId?: string }) => TaskPreflightAnalyzer
  preflight?: typeof runTaskPreflight
  validateModel?: typeof validateTaskModelConfig
  validateWorkDir?: typeof validateTaskWorkDir
  validateWorkDirs?: typeof validateTaskWorkDirs
}

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

function hasRequiredDeliveryTarget(pref: 'desktop' | 'feishu' | 'wechat' | 'none', target: unknown): boolean {
  return (pref !== 'feishu' && pref !== 'wechat') || (typeof target === 'string' && target.trim().length > 0 && target.trim().length <= 512)
}

export function registerButlerIpcHandlers(ipcMain: Electron.IpcMain, deps: ButlerIpcDeps, preflightDeps: ButlerTaskPreflightDeps = {}): void {
  const { db } = deps
  const now = preflightDeps.now ?? Date.now
  const preflight = preflightDeps.preflight ?? runTaskPreflight
  const createAnalyzer = preflightDeps.createAnalyzer ?? ((task) => createTaskPreflightModelAnalyzer(db, task))
  const validateModel = preflightDeps.validateModel ?? validateTaskModelConfig
  const validateWorkDir = preflightDeps.validateWorkDir ?? validateTaskWorkDir
  const validateWorkDirs = preflightDeps.validateWorkDirs ?? validateTaskWorkDirs

  async function inspectTask(input: { prompt: string; schedule: AutomationTaskSchedule; deliveryPref: string; roots: string[]; modelId?: string; modelServiceId?: string; taskRevision: number; requestReceivedAt: number }) {
    if (input.schedule.kind === 'once' && input.schedule.at <= input.requestReceivedAt) {
      return { report: { status: 'blocked' as const, blockers: [{ code: 'ONCE_AT_NOT_FUTURE', field: 'schedule', messageKey: 'butler.preflight.once_at_not_future' }], suggestedDirectories: [] }, bindings: [] }
    }
    return preflight({
      prompt: input.prompt,
      scheduleSummary: JSON.stringify(input.schedule),
      deliverySummary: input.deliveryPref,
      roots: input.roots,
      taskRevision: input.taskRevision
    }, { analyzer: createAnalyzer({ modelId: input.modelId, modelServiceId: input.modelServiceId }) })
  }

  function preflightFailure(result: Awaited<ReturnType<typeof inspectTask>>): ButlerTaskWriteResult | undefined {
    if (result.report.status === 'passed') return undefined
    if (result.report.status === 'unavailable') return { ok: false, kind: 'preflight-unavailable', error: result.report.blockers[0]?.code ?? 'PREFLIGHT_UNAVAILABLE' }
    return { ok: false, kind: 'preflight-blocked', report: result.report }
  }

  ipcMain.handle('butler:list', () => listAutomationTasks(db))
  ipcMain.handle('butler:list-runs', (_e, payload: { taskId: string }) => listAutomationTaskRuns(db, payload.taskId))

  ipcMain.handle('butler:choose-workdir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await (win
      ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }))
    if (result.canceled) return { cancelled: true as const }
    const validated = await validateTaskWorkDir(result.filePaths[0])
    return validated.ok ? { cancelled: false as const, path: validated.workDir } : { cancelled: false as const, error: validated.error }
  })

  ipcMain.handle('butler:get-defaults', () => {
    const models = readStoredModels(db)
    const services = readLlmServices(db)
    const activeIds = readActiveLlmServiceIds(db)
    const currentModel = getConfigValue(db, 'config.defaultModel') ?? getConfigValue(db, 'config.model')
    const model = models.find((entry) => entry.id === currentModel || entry.name === currentModel)
    const service = model && services.find((entry) => activeIds.includes(entry.id) && (entry.supportedModelIds ?? []).includes(model.id) && entry.apiKeyPresent)
    const configuredEffort = getConfigValue(db, 'config.thinkingEffort') ?? 'off'
    const reasoningEffort = model?.supportsThinking === false ? 'off' : configuredEffort
    return { ...(model && service ? { modelId: model.id, modelOverride: model.name, modelServiceId: service.id } : {}), reasoningEffort }
  })

  ipcMain.handle('butler:model-candidates', () => {
    const active = new Set(readActiveLlmServiceIds(db))
    const services = readLlmServices(db).filter((service) => active.has(service.id) && service.apiKeyPresent)
    return services.flatMap((service) => (service.supportedModelIds ?? []).map((modelId) => {
      const model = readStoredModels(db).find((entry) => entry.id === modelId && entry.enabled)
      return model ? { modelId, providerModelName: model.name, serviceId: service.id, serviceName: service.name, supportsThinking: model.supportsThinking !== false } : undefined
    }).filter(Boolean))
  })

  ipcMain.handle('butler:create', async (_e, payload: Partial<AutomationTaskInput>): Promise<ButlerTaskWriteResult> => {
    const requestReceivedAt = now()
    const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : ''
    const schedule = parseSchedule(payload?.schedule)
    const deliveryPref = parseDeliveryPref(payload?.deliveryPref)
    if (!name || !prompt || !schedule || !deliveryPref) {
      return { ok: false, kind: 'validation-error', error: '任务参数不完整（名称 / 提示词 / 触发方式 / 投递偏好）' }
    }
    if (!hasRequiredDeliveryTarget(deliveryPref, payload?.deliveryTarget)) return { ok: false, kind: 'validation-error', error: '飞书或微信投递必须填写有效接收对象' }
    const rootsResult = Object.prototype.hasOwnProperty.call(payload ?? {}, 'workDirs')
      ? await validateWorkDirs(payload?.workDirs)
      : await validateWorkDir(payload?.workDir)
    if (!rootsResult.ok) return { ok: false, kind: 'validation-error', error: rootsResult.error }
    const workDirs = 'workDirs' in rootsResult ? rootsResult.workDirs : [rootsResult.workDir]
    const config = await validateModel(db, {
      modelId: payload?.modelId,
      modelServiceId: payload?.modelServiceId,
      modelOverride: payload?.modelOverride,
      reasoningEffort: payload?.reasoningEffort
    })
    if (!config.ok) return { ok: false, kind: 'validation-error', error: config.error }
    const inspection = await inspectTask({ prompt, schedule, deliveryPref, roots: workDirs, modelId: config.modelId, modelServiceId: config.modelServiceId, taskRevision: 1, requestReceivedAt })
    const failure = preflightFailure(inspection)
    if (failure) return failure
    const task = createAutomationTask(db, {
      name,
      prompt,
      schedule,
      deliveryPref,
      ...(payload?.deliveryTarget ? { deliveryTarget: payload.deliveryTarget } : {}),
      ...(payload?.modelOverride ? { modelOverride: payload.modelOverride } : {}),
      workDirs,
      modelId: config.modelId,
      modelServiceId: config.modelServiceId,
      reasoningEffort: config.reasoningEffort,
      ...(payload?.enabled !== undefined ? { enabled: payload.enabled } : {})
    }, { targetBindings: inspection.bindings })
    return { ok: true, id: task.id, task }
  })

  ipcMain.handle('butler:update', async (_e, payload: { id: string; patch: Record<string, unknown> }): Promise<ButlerTaskWriteResult> => {
    const requestReceivedAt = now()
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const existing = id ? getAutomationTask(db, id) : undefined
    if (!id || !existing) return { ok: false, kind: 'validation-error', error: '任务不存在' }
    const patch = payload?.patch ?? {}
    const expectedTaskRevision = typeof patch.expectedTaskRevision === 'number' ? patch.expectedTaskRevision : (existing.taskRevision ?? 0)
    if (expectedTaskRevision !== (existing.taskRevision ?? 0)) return { ok: false, kind: 'validation-error', error: 'task-revision-conflict' }
    const next: Record<string, unknown> = {}
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
    if (typeof patch.prompt === 'string' && patch.prompt.trim()) next.prompt = patch.prompt.trim()
    const schedule = parseSchedule(patch.schedule)
    if (schedule) next.schedule = schedule
    const deliveryPref = parseDeliveryPref(patch.deliveryPref)
    if (deliveryPref) next.deliveryPref = deliveryPref
    if (typeof patch.deliveryTarget === 'string') next.deliveryTarget = patch.deliveryTarget
    if (!hasRequiredDeliveryTarget(deliveryPref ?? existing.deliveryPref, typeof patch.deliveryTarget === 'string' ? patch.deliveryTarget : existing.deliveryTarget)) {
      return { ok: false, kind: 'validation-error', error: '飞书或微信投递必须填写有效接收对象' }
    }
    if (typeof patch.modelOverride === 'string') next.modelOverride = patch.modelOverride
    const rootsProvided = Object.prototype.hasOwnProperty.call(patch, 'workDirs') || Object.prototype.hasOwnProperty.call(patch, 'workDir')
    if (rootsProvided) {
      const workDirs = Object.prototype.hasOwnProperty.call(patch, 'workDirs')
        ? await validateWorkDirs(patch.workDirs)
        : await validateWorkDir(patch.workDir)
      if (!workDirs.ok) return { ok: false, kind: 'validation-error', error: workDirs.error }
      next.workDirs = 'workDirs' in workDirs ? workDirs.workDirs : [workDirs.workDir]
    }
    const modelKeys = ['modelId', 'modelServiceId', 'reasoningEffort', 'modelOverride']
    if (modelKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
      const candidate = { ...existing, ...next, ...patch }
      const config = await validateModel(db, {
        modelId: candidate.modelId,
        modelServiceId: candidate.modelServiceId,
        modelOverride: candidate.modelOverride,
        reasoningEffort: candidate.reasoningEffort
      })
      if (!config.ok) return { ok: false, kind: 'validation-error', error: config.error }
      next.modelId = config.modelId
      next.modelServiceId = config.modelServiceId
      next.modelOverride = config.modelOverride
      next.reasoningEffort = config.reasoningEffort
    }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    const candidate = { ...existing, ...next }
    const candidateRoots: string[] = Array.isArray(next.workDirs)
      ? next.workDirs as string[]
      : existing.workDirs ?? (existing.workDir ? [existing.workDir] : [])
    const inspection = await inspectTask({ prompt: candidate.prompt, schedule: candidate.schedule, deliveryPref: candidate.deliveryPref, roots: candidateRoots, modelId: candidate.modelId, modelServiceId: candidate.modelServiceId, taskRevision: (existing.taskRevision ?? 0) + 1, requestReceivedAt })
    const failure = preflightFailure(inspection)
    if (failure) return failure
    const commit = updateAutomationTaskConditional(db, id, { ...next, expectedTaskRevision }, { targetBindings: inspection.bindings })
    if (!commit.ok) return commit.reason === 'schedule-pending'
      ? { ok: false, kind: 'validation-error', error: 'schedule-pending' }
      : { ok: false, kind: 'validation-error', error: commit.reason }
    return { ok: true, id, task: commit.task }
  })

  ipcMain.handle('butler:delete', (_e, payload: { id: string }): { ok: boolean; error?: string } => {
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id) return { ok: false, error: '任务 ID 缺失' }
    const deleted = deleteAutomationTask(db, id)
    if (deleted) return { ok: true }
    return { ok: false, error: getAutomationTask(db, id) ? 'task-has-active-run' : 'task-not-found' }
  })

  ipcMain.handle('butler:run-task', async (_e, payload: { taskId: string; requestId?: string }): Promise<{ ok: boolean; runId?: string; sessionId?: string; summary?: string; deliveryStatus?: import('../../src/shared/automationTaskTypes').AutomationTaskRun['deliveryStatus']; error?: string }> => {
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId.trim() : ''
    if (!taskId) return { ok: false, error: '任务 ID 缺失' }
    const requestId = typeof payload?.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : undefined
    const result = await runButlerTask(deps, taskId, { trigger: 'manual', ...(requestId ? { requestId } : {}) })
    if (result.ok) {
      return { ok: true, runId: result.runId, sessionId: result.sessionId, summary: result.summary, deliveryStatus: result.deliveryStatus }
    }
    return { ok: false, runId: result.runId, error: result.error }
  })
}
