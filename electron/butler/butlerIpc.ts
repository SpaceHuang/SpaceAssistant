import { dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { runButlerTask, type ButlerInvokerDeps } from './butlerInvoker'
import {
  createAutomationTask,
  deleteAutomationTask,
  getAutomationTask,
  listAutomationTasks,
  listAutomationTaskRuns,
  updateAutomationTaskConditional,
  type AutomationTaskInput,
  type AutomationTaskSchedule
} from './taskStore'
import { validateTaskAuthorizedDirs, validateTaskModelConfig, validateTaskOutputDir, validateTaskWorkDir, validateTaskWorkDirs } from './taskConfigValidation'
import { readActiveLlmServiceIds, readLlmServices, readStoredModels } from '../llmServiceResolver'
import { getConfigValue } from '../database'
import { runTaskPreflight, type TaskPreflightAnalysisOutput, type TaskPreflightAnalyzer } from './taskPreflight'
import { createTaskPreflightModelAnalyzer } from './taskPreflightModelAnalyzer'
import { buildSnapshotFromDb } from '../mcp/mcpToolRegistry'
import { filterBuiltinToolsForApi } from '../toolsConfigRuntime'
import { getPreflightIssueMessageKey, type PreflightReport, type ButlerTaskWriteResult } from '../../src/shared/automationTaskTypes'
import type { AutomationOutputOrganization, AutomationTaskMcpToolCandidate, AutomationTaskPermission, AutomationTaskAuthorizationRecord, AutomationTaskPreflightTraceItem, AutomationTaskToolRequirement } from '../../src/shared/automationTaskTypes'

/**
 * 管家 IPC（P6 任务 CRUD 面 + P4 手动触发）。渲染进程只表达意图：
 * 准入、调度、会话创建、门控、投递全在主进程。
 */

export type ButlerIpcDeps = ButlerInvokerDeps

export type ButlerTaskPreflightDeps = {
  now?: () => number
  createAnalyzer?: (task: { modelId?: string; modelServiceId?: string; reasoningEffort?: import('../../src/shared/agent/invocation').AgentReasoningEffort }) => TaskPreflightAnalyzer
  preflight?: typeof runTaskPreflight
  validateModel?: typeof validateTaskModelConfig
  validateWorkDir?: typeof validateTaskWorkDir
  validateWorkDirs?: typeof validateTaskWorkDirs
  validateAuthorizedDirs?: typeof validateTaskAuthorizedDirs
  validateOutputDir?: typeof validateTaskOutputDir
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
  const validateAuthorizedDirs = preflightDeps.validateAuthorizedDirs ?? (preflightDeps.validateWorkDirs
    ? async (value: unknown) => {
      if (Array.isArray(value) && value.length === 0) return { ok: true as const, authorizedDirs: [] }
      const result = await validateWorkDirs(value)
      return result.ok ? { ok: true as const, authorizedDirs: result.workDirs } : result
    }
    : validateTaskAuthorizedDirs)
  const validateOutputDir = preflightDeps.validateOutputDir ?? validateTaskOutputDir

  type PendingAuthorizationReview = {
    expiresAt: number
    taskId?: string
    permissions: AutomationTaskPermission[]
    report: PreflightReport
    factsDigest?: string
    mockTrace?: AutomationTaskPreflightTraceItem[]
    taskRevision: number
    expectedCurrentTaskRevision?: number
    commit: (authorizationRecord: AutomationTaskAuthorizationRecord) => ButlerTaskWriteResult | Promise<ButlerTaskWriteResult>
  }
  const pendingAuthorizationReviews = new Map<string, PendingAuthorizationReview>()

  async function inspectTask(input: { prompt: string; schedule: AutomationTaskSchedule; deliveryPref: string; roots: string[]; outputDir: string; modelId?: string; modelServiceId?: string; reasoningEffort?: import('../../src/shared/agent/invocation').AgentReasoningEffort; taskRevision: number; requestReceivedAt: number; analysisOverride?: TaskPreflightAnalysisOutput }) {
    const preflightStartedAt = Date.now()
    if (input.schedule.kind === 'once' && input.schedule.at <= input.requestReceivedAt) {
      return { report: { status: 'blocked' as const, blockers: [{ code: 'ONCE_AT_NOT_FUTURE', field: 'schedule', messageKey: getPreflightIssueMessageKey('ONCE_AT_NOT_FUTURE') }], suggestedDirectories: [] }, bindings: [], factsDigest: undefined, requiredPermissions: [], mcpTools: [] }
    }
    const mcpEntries = [...buildSnapshotFromDb(db, { admission: 'deferred' }).entries.values()]
    const mcpTools = mcpEntries.flatMap((entry): Array<AutomationTaskMcpToolCandidate & { mappedName: string }> => {
      if (!entry.descriptorHash || !entry.profileHash) return []
      const properties = entry.inputSchema.properties && typeof entry.inputSchema.properties === 'object' && !Array.isArray(entry.inputSchema.properties)
        ? entry.inputSchema.properties as Record<string, unknown>
        : {}
      const required = new Set(Array.isArray(entry.inputSchema.required)
        ? entry.inputSchema.required.filter((name): name is string => typeof name === 'string')
        : [])
      const parameters = Object.entries(properties).slice(0, 50).map(([name, raw]) => {
        const parameter = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
        return {
          name,
          required: required.has(name),
          ...(typeof parameter.type === 'string' ? { type: parameter.type.slice(0, 80) } : {}),
          ...(typeof parameter.description === 'string' ? { description: parameter.description.slice(0, 160) } : {})
        }
      })
      return [{
        serverId: entry.serverId, serverName: entry.serverName, toolName: entry.originalName,
        description: entry.description, parameters, mappedName: entry.mappedName,
        descriptorHash: entry.descriptorHash, profileHash: entry.profileHash
      }]
    })
    const builtinTools = filterBuiltinToolsForApi(
      deps.getToolsConfig(),
      undefined,
      deps.getBrowserConfig?.(),
      null,
      deps.getShellConfig?.() ?? null
    ).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema }))
    const mcpModelTools = mcpEntries.map((entry) => ({ name: entry.mappedName, description: entry.description, inputSchema: entry.inputSchema }))
    const result = await preflight({
      prompt: input.prompt,
      scheduleSummary: JSON.stringify(input.schedule),
      deliverySummary: input.deliveryPref,
      roots: input.roots,
      outputDir: input.outputDir,
      taskRevision: input.taskRevision,
      preflightStartedAt,
      mcpTools,
      tools: [...builtinTools, ...mcpModelTools],
      ...(input.analysisOverride ? { analysisOverride: input.analysisOverride } : {})
    }, { analyzer: createAnalyzer({ modelId: input.modelId, modelServiceId: input.modelServiceId, reasoningEffort: input.reasoningEffort }) })
    return { ...result, mcpTools }
  }

  function preflightFailure(result: Awaited<ReturnType<typeof inspectTask>>): ButlerTaskWriteResult | undefined {
    if (result.report.status === 'passed') return undefined
    if (result.report.status === 'unavailable') return { ok: false, kind: 'preflight-unavailable', error: result.report.blockers[0]?.code ?? 'PREFLIGHT_UNAVAILABLE' }
    return { ok: false, kind: 'preflight-blocked', report: result.report }
  }

  function parseOutputOrganization(raw: unknown): AutomationOutputOrganization | undefined {
    return raw === 'direct' || raw === 'daily' || raw === 'hourly' ? raw : undefined
  }

  function buildPermissionList(task: { authorizedDirs: string[]; outputDir: string; outputOrganization: AutomationOutputOrganization; deliveryPref: 'desktop' | 'feishu' | 'wechat' | 'none'; deliveryTarget?: string }, requiredPermissions: readonly AutomationTaskToolRequirement[], mcpTools: readonly AutomationTaskMcpToolCandidate[] = []): AutomationTaskPermission[] {
    const permissions: AutomationTaskPermission[] = task.authorizedDirs.map((path) => ({ kind: 'directory-read-write', path }))
    permissions.push({ kind: 'result-write', outputDirectory: task.outputDir, organization: task.outputOrganization })
    const shellRequirements = requiredPermissions.filter((permission): permission is Extract<AutomationTaskToolRequirement, { tool: 'run_shell' }> => permission.tool === 'run_shell')
    if (shellRequirements.length) permissions.push({ kind: 'local-shell', scopeRoots: [...task.authorizedDirs], commands: shellRequirements.map(({ command, workingDirectory }) => ({ command, workingDirectory })) })
    const grepRoots = [...new Set(requiredPermissions.filter((permission) => permission.tool === 'grep').flatMap((permission) => permission.tool === 'grep' ? permission.scopeRoots : []))]
    if (grepRoots.length) permissions.push({ kind: 'grep', scopeRoots: grepRoots })
    const scriptRoots = [...new Set(requiredPermissions.filter((permission) => permission.tool === 'run_script').flatMap((permission) => permission.tool === 'run_script' ? permission.scopeRoots : []))]
    if (scriptRoots.length) permissions.push({ kind: 'run-script', scopeRoots: scriptRoots, scriptHashBinding: 'per-invocation' })
    const mcpRequirements = requiredPermissions.filter((permission): permission is Extract<AutomationTaskToolRequirement, { tool: 'mcp' }> => permission.tool === 'mcp')
    const seenMcp = new Set<string>()
    for (const requirement of mcpRequirements) {
      const candidate = mcpTools.find((tool) => tool.serverId === requirement.serverId && tool.toolName === requirement.toolName)
      if (!candidate || !candidate.descriptorHash || !candidate.profileHash) continue
      const key = `${candidate.serverId}\0${candidate.toolName}`
      if (seenMcp.has(key)) continue
      seenMcp.add(key)
      permissions.push({ kind: 'mcp-tool', serverId: candidate.serverId, serverName: candidate.serverName, toolName: candidate.toolName,
        description: candidate.description, purpose: requirement.purpose, parameters: candidate.parameters,
        descriptorHash: candidate.descriptorHash, profileHash: candidate.profileHash })
    }
    if (task.deliveryPref !== 'none') permissions.push({ kind: 'deliver-result', delivery: task.deliveryPref, ...(task.deliveryTarget ? { target: task.deliveryTarget } : {}) })
    return permissions
  }

  type TaskInspection = Awaited<ReturnType<typeof inspectTask>>
  function stageAuthorizationScopeReview(args: {
    inspection: TaskInspection
    authorizedDirs: string[]
    task: Parameters<typeof buildPermissionList>[0]
    taskId?: string
    expectedCurrentTaskRevision?: number
    taskRevision: number
    inspectWithAuthorizedDirs: (authorizedDirs: string[], analysisOverride: TaskPreflightAnalysisOutput) => Promise<TaskInspection>
    commit: (authorizedDirs: string[], inspection: TaskInspection, authorizationRecord: AutomationTaskAuthorizationRecord) => ButlerTaskWriteResult
  }): ButlerTaskWriteResult | undefined {
    const continuation = args.inspection.authorizationContinuation
    if (!continuation) return undefined
    const proposedAuthorizedDirs = [...new Set([...args.authorizedDirs, ...continuation.authorizedRoots])].sort()
    const permissions = buildPermissionList({ ...args.task, authorizedDirs: proposedAuthorizedDirs }, args.inspection.requiredPermissions ?? [], args.inspection.mcpTools)
    return stageAuthorizationReview({
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.expectedCurrentTaskRevision !== undefined ? { expectedCurrentTaskRevision: args.expectedCurrentTaskRevision } : {}),
      permissions,
      report: args.inspection.report,
      ...(args.inspection.factsDigest ? { factsDigest: args.inspection.factsDigest } : {}),
      ...(args.inspection.mockTrace ? { mockTrace: args.inspection.mockTrace } : {}),
      taskRevision: args.taskRevision,
      commit: async (initialRecord) => {
        // final-check: only after the user approves the complete list do we enumerate the proposed root.
        const rootsResult = await validateAuthorizedDirs(proposedAuthorizedDirs)
        if (!rootsResult.ok) return { ok: false, kind: 'validation-error', error: rootsResult.error }
        const approvedAuthorizedDirs = rootsResult.authorizedDirs
        if (proposedAuthorizedDirs.some((root) => !approvedAuthorizedDirs.includes(root))) {
          return { ok: false, kind: 'validation-error', error: '授权目录位置在确认后发生变化，请重新预检任务' }
        }
        const approvedInspection = await args.inspectWithAuthorizedDirs(approvedAuthorizedDirs, continuation.analysis)
        const failure = preflightFailure(approvedInspection)
        if (failure) return failure
        const approvedPermissions = buildPermissionList({ ...args.task, authorizedDirs: approvedAuthorizedDirs }, approvedInspection.requiredPermissions ?? [], approvedInspection.mcpTools)
        if (JSON.stringify(approvedPermissions) !== JSON.stringify(permissions)) {
          return { ok: false, kind: 'validation-error', error: '预检期间权限清单发生变化，请重新预检任务' }
        }
        return args.commit(approvedAuthorizedDirs, approvedInspection, {
          ...initialRecord,
          ...(approvedInspection.factsDigest ? { preflightFactsDigest: approvedInspection.factsDigest } : {})
        })
      }
    })
  }

  function stageAuthorizationReview(args: Omit<PendingAuthorizationReview, 'expiresAt'>): ButlerTaskWriteResult {
    // policy: 只把主机从预检事实派生的权限范围放入一次性凭据；渲染端提交的 accessPermissions 不参与决策。
    const issuedAt = now()
    for (const [reviewId, pending] of pendingAuthorizationReviews) {
      if (pending.expiresAt <= issuedAt) pendingAuthorizationReviews.delete(reviewId)
    }
    const reviewId = randomUUID()
    pendingAuthorizationReviews.set(reviewId, { ...args, expiresAt: issuedAt + 5 * 60_000 })
    return { ok: false, kind: 'authorization-review-required', reviewId, permissions: args.permissions, report: args.report }
  }

  function createAuthorizationRecord(review: PendingAuthorizationReview): AutomationTaskAuthorizationRecord {
    return {
      id: randomUUID(),
      actor: 'user-confirmation',
      source: 'task-preflight-confirmation',
      approvedAt: now(),
      taskRevision: review.taskRevision,
      ...(review.report.preflightCoverage ? { preflightCoverage: review.report.preflightCoverage } : {}),
      ...(review.factsDigest ? { preflightFactsDigest: review.factsDigest } : {}),
      permissions: structuredClone(review.permissions),
      ...(review.mockTrace ? { preflightTrace: structuredClone(review.mockTrace) } : {})
    }
  }

  ipcMain.handle('butler:confirm-write', async (_e, payload: { reviewId?: string }): Promise<ButlerTaskWriteResult> => {
    const reviewId = typeof payload?.reviewId === 'string' ? payload.reviewId : ''
    const review = reviewId ? pendingAuthorizationReviews.get(reviewId) : undefined
    if (!review) return { ok: false, kind: 'validation-error', error: '权限确认已失效，请重新预检任务' }
    pendingAuthorizationReviews.delete(reviewId)
    if (review.expiresAt <= now()) return { ok: false, kind: 'validation-error', error: '权限确认已过期，请重新预检任务' }
    if (review.expectedCurrentTaskRevision !== undefined) {
      const existing = review.taskId ? getAutomationTask(db, review.taskId) : undefined
      if (!existing || (existing.taskRevision ?? 0) !== review.expectedCurrentTaskRevision) {
        return { ok: false, kind: 'validation-error', error: 'task-revision-conflict' }
      }
    }
    // final-check: reviewId 只确认主机生成的权限记录，不携带任务启停状态；启停由独立的 butler:update 状态写入处理。
    return await review.commit(createAuthorizationRecord(review))
  })

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

  ipcMain.handle('butler:choose-outputdir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await (win
      ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }))
    if (result.canceled) return { cancelled: true as const }
    const validated = await validateOutputDir(result.filePaths[0])
    return validated.ok ? { cancelled: false as const, path: validated.outputDir } : { cancelled: false as const, error: validated.error }
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
    const outputResult = await validateOutputDir(payload?.outputDir)
    if (!outputResult.ok) return { ok: false, kind: 'validation-error', error: outputResult.error }
    const outputOrganization = parseOutputOrganization(payload?.outputOrganization)
    if (!outputOrganization) return { ok: false, kind: 'validation-error', error: '结果归档方式无效' }
    // Runtime compatibility at the IPC boundary only: older renderer builds may still send workDir.
    const legacyPayload = payload as Partial<AutomationTaskInput> & { workDir?: unknown }
    const requestedAuthorizedDirs = Object.prototype.hasOwnProperty.call(payload ?? {}, 'authorizedDirs')
      ? payload?.authorizedDirs
      : Object.prototype.hasOwnProperty.call(payload ?? {}, 'workDirs')
        ? payload?.workDirs
        : legacyPayload.workDir !== undefined ? [legacyPayload.workDir] : []
    const rootsResult = await validateAuthorizedDirs(requestedAuthorizedDirs)
    if (!rootsResult.ok) return { ok: false, kind: 'validation-error', error: rootsResult.error }
    const authorizedDirs = rootsResult.authorizedDirs
    const config = await validateModel(db, {
      modelId: payload?.modelId,
      modelServiceId: payload?.modelServiceId,
      modelOverride: payload?.modelOverride,
      reasoningEffort: payload?.reasoningEffort
    })
    if (!config.ok) return { ok: false, kind: 'validation-error', error: config.error }
    const inspection = await inspectTask({ prompt, schedule, deliveryPref, roots: authorizedDirs, outputDir: outputResult.outputDir, modelId: config.modelId, modelServiceId: config.modelServiceId, reasoningEffort: config.reasoningEffort, taskRevision: 1, requestReceivedAt })
    const taskInput: AutomationTaskInput = {
      name,
      prompt,
      schedule,
      deliveryPref,
      ...(payload?.deliveryTarget ? { deliveryTarget: payload.deliveryTarget } : {}),
      ...(payload?.modelOverride ? { modelOverride: payload.modelOverride } : {}),
      authorizedDirs,
      workDirs: authorizedDirs,
      outputDir: outputResult.outputDir,
      outputOrganization,
      modelId: config.modelId,
      modelServiceId: config.modelServiceId,
      reasoningEffort: config.reasoningEffort,
      // Permission review only stores the task and its authorization receipt. New tasks stay paused
      // until the renderer applies the user's separate final-page activation choice.
      enabled: false
    }
    if (inspection.authorizationContinuation) {
      return stageAuthorizationScopeReview({
        inspection,
        authorizedDirs,
        task: { authorizedDirs, outputDir: outputResult.outputDir, outputOrganization, deliveryPref, ...(payload?.deliveryTarget ? { deliveryTarget: payload.deliveryTarget } : {}) },
        taskRevision: 1,
        inspectWithAuthorizedDirs: (approvedRoots, analysisOverride) => inspectTask({
          prompt, schedule, deliveryPref, roots: approvedRoots, outputDir: outputResult.outputDir,
          modelId: config.modelId, modelServiceId: config.modelServiceId, reasoningEffort: config.reasoningEffort,
          taskRevision: 1, requestReceivedAt: now(), analysisOverride
        }),
        commit: (approvedRoots, approvedInspection, authorizationRecord) => {
          const approvedTaskInput = { ...taskInput, authorizedDirs: approvedRoots, workDirs: approvedRoots }
          const task = createAutomationTask(db, approvedTaskInput, { targetBindings: approvedInspection.bindings, authorizationRecord })
          return { ok: true, id: task.id, task }
        }
      })!
    }
    const failure = preflightFailure(inspection)
    if (failure) return failure
    const permissions = buildPermissionList({ authorizedDirs, outputDir: outputResult.outputDir, outputOrganization, deliveryPref, ...(payload?.deliveryTarget ? { deliveryTarget: payload.deliveryTarget } : {}) }, inspection.requiredPermissions ?? [], inspection.mcpTools)
    return stageAuthorizationReview({
      permissions,
      report: inspection.report,
      ...(inspection.factsDigest ? { factsDigest: inspection.factsDigest } : {}),
      ...(inspection.mockTrace ? { mockTrace: inspection.mockTrace } : {}),
      taskRevision: 1,
      commit: (authorizationRecord) => {
        const task = createAutomationTask(db, taskInput, { targetBindings: inspection.bindings, authorizationRecord })
        return { ok: true, id: task.id, task }
      }
    })
  })

  ipcMain.handle('butler:update', async (_e, payload: { id: string; patch: Record<string, unknown> }): Promise<ButlerTaskWriteResult> => {
    const requestReceivedAt = now()
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const existing = id ? getAutomationTask(db, id) : undefined
    if (!id || !existing) return { ok: false, kind: 'validation-error', error: '任务不存在' }
    const patch = payload?.patch ?? {}
    const expectedTaskRevision = typeof patch.expectedTaskRevision === 'number' ? patch.expectedTaskRevision : (existing.taskRevision ?? 0)
    if (expectedTaskRevision !== (existing.taskRevision ?? 0)) return { ok: false, kind: 'validation-error', error: 'task-revision-conflict' }
    const changedKeys = Object.keys(patch).filter((key) => key !== 'expectedTaskRevision')
    const hasCurrentAuthorizationRecord = existing.accessPermissions?.authorizationRecord?.taskRevision === (existing.taskRevision ?? 0)
    // policy (SYS-AUTOSHELL-001): disabling is always safe; enabling skips review only when this task revision already has a host-issued receipt.
    if (changedKeys.length === 1 && changedKeys[0] === 'enabled' && typeof patch.enabled === 'boolean'
      && (patch.enabled === false || (existing.preflightVersion === 1 && hasCurrentAuthorizationRecord))) {
      const commit = updateAutomationTaskConditional(db, id, { enabled: patch.enabled, expectedTaskRevision })
      return commit.ok ? { ok: true, id, task: commit.task } : { ok: false, kind: 'validation-error', error: commit.reason }
    }
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
    const rootsProvided = Object.prototype.hasOwnProperty.call(patch, 'authorizedDirs')
      || Object.prototype.hasOwnProperty.call(patch, 'workDirs')
      || Object.prototype.hasOwnProperty.call(patch, 'workDir')
    const requestedAuthorizedDirs = Object.prototype.hasOwnProperty.call(patch, 'authorizedDirs')
      ? patch.authorizedDirs
      : Object.prototype.hasOwnProperty.call(patch, 'workDirs')
        ? patch.workDirs
        : Object.prototype.hasOwnProperty.call(patch, 'workDir') ? [patch.workDir] : existing.authorizedDirs
    const rootsResult = await validateAuthorizedDirs(requestedAuthorizedDirs)
    if (!rootsResult.ok) return { ok: false, kind: 'validation-error', error: rootsResult.error }
    if (rootsProvided) {
      next.authorizedDirs = rootsResult.authorizedDirs
      next.workDirs = rootsResult.authorizedDirs
    }
    const requestedOutputDir = Object.prototype.hasOwnProperty.call(patch, 'outputDir') ? patch.outputDir : existing.outputDir
    const outputResult = await validateOutputDir(requestedOutputDir)
    if (!outputResult.ok) return { ok: false, kind: 'validation-error', error: outputResult.error }
    const outputOrganization = Object.prototype.hasOwnProperty.call(patch, 'outputOrganization')
      ? parseOutputOrganization(patch.outputOrganization)
      : existing.outputOrganization ?? undefined
    if (!outputOrganization) return { ok: false, kind: 'validation-error', error: '结果归档方式无效' }
    next.outputDir = outputResult.outputDir
    next.outputOrganization = outputOrganization
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
    const candidate = { ...existing, ...next }
    const candidateRoots: string[] = rootsProvided ? rootsResult.authorizedDirs : existing.authorizedDirs
    const inspection = await inspectTask({ prompt: candidate.prompt, schedule: candidate.schedule, deliveryPref: candidate.deliveryPref, roots: candidateRoots, outputDir: outputResult.outputDir, modelId: candidate.modelId, modelServiceId: candidate.modelServiceId, reasoningEffort: candidate.reasoningEffort, taskRevision: (existing.taskRevision ?? 0) + 1, requestReceivedAt })
    if (inspection.authorizationContinuation) {
      const taskRevision = (existing.taskRevision ?? 0) + 1
      return stageAuthorizationScopeReview({
        inspection,
        authorizedDirs: candidateRoots,
        task: {
          authorizedDirs: candidateRoots,
          outputDir: outputResult.outputDir,
          outputOrganization,
          deliveryPref: candidate.deliveryPref,
          ...(candidate.deliveryTarget ? { deliveryTarget: candidate.deliveryTarget } : {})
        },
        taskId: id,
        expectedCurrentTaskRevision: existing.taskRevision ?? 0,
        taskRevision,
        inspectWithAuthorizedDirs: (approvedRoots, analysisOverride) => inspectTask({
          prompt: candidate.prompt, schedule: candidate.schedule, deliveryPref: candidate.deliveryPref, roots: approvedRoots,
          outputDir: outputResult.outputDir, modelId: candidate.modelId, modelServiceId: candidate.modelServiceId,
          reasoningEffort: candidate.reasoningEffort, taskRevision, requestReceivedAt: now(), analysisOverride
        }),
        commit: (approvedRoots, approvedInspection, authorizationRecord) => {
          const commit = updateAutomationTaskConditional(db, id, {
            ...next,
            authorizedDirs: approvedRoots,
            workDirs: approvedRoots,
            expectedTaskRevision
          }, { targetBindings: approvedInspection.bindings, authorizationRecord })
          if (!commit.ok) return { ok: false, kind: 'validation-error', error: commit.reason }
          return { ok: true, id, task: commit.task }
        }
      })!
    }
    const failure = preflightFailure(inspection)
    if (failure) return failure
    const permissions = buildPermissionList({
      authorizedDirs: candidateRoots,
      outputDir: outputResult.outputDir,
      outputOrganization,
      deliveryPref: candidate.deliveryPref,
      ...(candidate.deliveryTarget ? { deliveryTarget: candidate.deliveryTarget } : {})
    }, inspection.requiredPermissions ?? [], inspection.mcpTools)
    return stageAuthorizationReview({
      taskId: id,
      expectedCurrentTaskRevision: existing.taskRevision ?? 0,
      permissions,
      report: inspection.report,
      ...(inspection.factsDigest ? { factsDigest: inspection.factsDigest } : {}),
      ...(inspection.mockTrace ? { mockTrace: inspection.mockTrace } : {}),
      taskRevision: (existing.taskRevision ?? 0) + 1,
      commit: (authorizationRecord) => {
        const commit = updateAutomationTaskConditional(db, id, { ...next, expectedTaskRevision }, { targetBindings: inspection.bindings, authorizationRecord })
        if (!commit.ok) return { ok: false, kind: 'validation-error', error: commit.reason }
        return { ok: true, id, task: commit.task }
      }
    })
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
