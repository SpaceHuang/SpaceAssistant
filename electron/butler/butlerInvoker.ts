import type { AppDatabase } from '../database'
import { readChatMessagesAfterPreparation } from '../sessionStorage/application/readChatMessages'
import path from 'node:path'
import { getConfigValue } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { assembleInvocation } from '../runtime/invocationAssembler'
import type { BrowserConfig, ShellConfig, ToolsConfig, ModelEntry } from '../../src/shared/domainTypes'
import { resolveModelContextWindow } from '../../src/shared/llmModelConfig'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import { readAppLocale } from '../appIpc'
import { readWikiConfig } from '../wiki/wikiConfigReader'
import { resolveLlmCredentialsForPair, resolveLlmCredentialsForModel, readActiveLlmServiceIds, readLlmServices, readStoredModels } from '../llmServiceResolver'
import { logHistoryOversizedToolResult } from '../oversizedToolResultLog'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { buildFinalSystemPrompt } from '../llmSystemPrompt'
import { resolvePinnedAutomationTurnExecutionConfig } from '../turnExecutionConfig'
import type { WorkDirManager } from '../workDirManager'
import type { TurnRuntime } from '../turnRuntime'
import { executeRemoteTurn } from '../remote/turnExecutionAdapter'
import { createButlerSessionEvents } from './butlerSessionEvents'
import { getCallAdmissionGate } from '../runtime/callAdmissionGate'
import { deliverTaskResult, type ButlerDeliveryPorts } from './butlerDelivery'
import { getAutomationTask, getQueuedClaimIdentity, getRunById, insertManualTaskClaim, transitionClaimToRunning, updateAutomationTaskRun } from './taskStore'
import { requireInvocationAnthropicRoute } from '../runtime/invocationProviderRoute'
import { createHostedTurnHandoff } from '../runtime/hostedTurnHandoff'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { HostedTurnFinalizedError, hostedTerminalSessionEventReason } from '../runtime/hostedTurnFinalization'
import { createAcceptedTurnFromPrepared } from '../runtime/acceptedTurnContext'
import { taskAuthorizedRootSetMatchesSnapshot, validateTaskAuthorizedDirsForRun, validateTaskWorkDirs } from './taskConfigValidation'
import { getAutomationTaskWorkDirs } from '../../src/shared/automationTaskTypes'
import { resolveGlobalThinkingEffort } from '../../src/shared/thinkingEffort'
import { getConfigValue as readConfigValue } from '../database'
import type { AutomationRunOutputScope, AutomationTaskRunConfigSnapshot } from '../../src/shared/automationTaskTypes'
import { TaskPathFactsProvider } from './taskPathFacts'
import { validatePersistedTargetBindings } from './taskTargetResolver'
import { ensureAutomationRunOutputDirectory, isValidAutomationRunOutputScope, resolveBoundOutputTarget } from './taskOutputDirectory'
import { matchAutomationResultWritePermission } from './automationTaskPermissionMatch'

/**
 * 管家执行链（P4）：定时 / 手动触发的 automation 任务 → 准入取票 → 会话创建（ownership=automation、
 * visibility=section，同一任务默认每次触发起新会话，控制上下文成本）→ turnRuntime 装配
 * （turnExecutionAdapter 模式）→ runToolChatSession({ lane: 'automation' })。
 * 门控按 P2 的 automation 规则裁决：只读放行，其余 confirm（无回答者 → 拒绝）。
 */

export const BUTLER_SYSTEM_APPENDIX = [
  '你是 SpaceAssistant 的后台管家（automation lane），由定时任务或用户手动触发，无人值守运行。',
  '本回合按任务指令完成查询、处理、总结、提醒、报表等工作。',
  '安全边界：无法获得人工确认。结果目录授权只覆盖本次运行归档目录及其子目录的写入，不授权读取，也不允许写出该目录；run_shell、grep、run_script、MCP 工具仅在主进程任务授权记录列出时可用，且只能在记录的命令参数或范围内使用。run_shell 的执行超时由你按任务实际需要选择，不属于授权范围。Shell 仍经过安全预检；危险、敏感或无法完整分析的命令会被拒绝。',
  '请优先使用只读工具完成任务，若被拒绝，请在最终回复中说明原因与已完成的部分。',
  '最终回复即任务结果汇报，请直接给出结论与关键数据，不要反问。'
].join('\n')

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function receiptShellWorkingDirectories(snapshot: AutomationTaskRunConfigSnapshot): string[] {
  return [...new Set((snapshot.accessPermissions?.authorizationRecord?.permissions ?? [])
    .filter((permission) => permission.kind === 'local-shell')
    .flatMap((permission) => permission.commands.map((command) => command.workingDirectory)))].sort()
}

function runOutputScopeFromSnapshot(snapshot: AutomationTaskRunConfigSnapshot): AutomationRunOutputScope | undefined {
  if (snapshot.preflightVersion !== 1 || !snapshot.outputDir || !snapshot.outputOrganization || !snapshot.runOutputDir || snapshot.scheduledFor === undefined) return undefined
  const scope: AutomationRunOutputScope = {
    outputDirectory: snapshot.outputDir,
    organization: snapshot.outputOrganization,
    scheduledFor: snapshot.scheduledFor,
    runOutputDir: snapshot.runOutputDir,
    taskRevision: snapshot.taskRevision ?? -1
  }
  return isValidAutomationRunOutputScope(scope) ? scope : undefined
}

export function buildButlerSystemAppendix(
  accessPermissions?: import('../../src/shared/automationTaskTypes').AutomationTaskAccessPermissions,
  outputScope?: AutomationRunOutputScope
): string {
  const permissions = accessPermissions?.authorizationRecord?.permissions ?? []
  const resultWriteAuthorized = outputScope && matchAutomationResultWritePermission(accessPermissions, outputScope)
  const shellGrant = permissions.find((permission) => permission.kind === 'local-shell')
  const grepGrant = permissions.find((permission) => permission.kind === 'grep')
  const scriptGrant = permissions.find((permission) => permission.kind === 'run-script')
  const mcpGrants = permissions.filter((permission) => permission.kind === 'mcp-tool')
  return [
    BUTLER_SYSTEM_APPENDIX,
    resultWriteAuthorized
      ? `本次运行结果目录已获用户授权写入：${outputScope.runOutputDir}。报告、总结等文档结果应保存到此目录；目录只允许写入，不允许读取。`
      : '本任务没有有效的结果目录写入授权；不得创建或修改本地文件。',
    shellGrant?.kind === 'local-shell'
      ? `本任务获批的 run_shell 命令及工作目录仅限：${shellGrant.commands.map(({ command, workingDirectory }) => `${command}（${workingDirectory}）`).join('；')}。每次调用都必须在 workingDirectory 参数中填写该条获批命令对应的目录，并保持命令文本、参数和目录不变；执行时自行选择合适的超时，超时不属于授权范围。Shell 预检仍可拒绝。`
      : '本任务未获批 run_shell。遇到本地命令需求时说明缺少授权，不要用其他工具绕过权限。',
    grepGrant?.kind === 'grep'
      ? `本任务获批使用 grep 搜索的目录：${grepGrant.scopeRoots.join('、')}。搜索路径必须落在这些目录内。`
      : '本任务未获批 grep；不要用其他工具模拟搜索以绕过权限。',
    scriptGrant?.kind === 'run-script'
      ? `本任务获批 run_script 的目录范围：${scriptGrant.scopeRoots.join('、')}。每次具体脚本都必须由安全审核 Agent 审核，并以主机计算的代码 SHA-256、参数和环境摘要绑定；任何变化都不能沿用旧审批。`
      : '本任务未获批 run_script；不要改用 Shell 执行脚本来绕过权限。',
    mcpGrants.length
      ? `本任务获批调用以下 MCP 服务工具：${mcpGrants.map((grant) => grant.kind === 'mcp-tool' ? `${grant.serverName}/${grant.toolName}（用途：${grant.purpose}）` : '').join('；')}。仅可调用列出的服务和工具；具体参数仍交由安全审核 Agent 按任务目标与本次事实审核。`
      : '本任务未获批任何 MCP 工具；不要调用 MCP 工具，也不要通过其他工具绕过此限制。'
  ].join('\n')
}

// 任务声明摘要已提取为两端共用模块（§5.6）：automation 任务 prompt 与桌面当前 turn 用户消息共用。
import { APPROVAL_TASK_DIGEST_MAX_CHARS, buildApprovalTaskDigest, buildApprovalTaskEvidence } from '../../src/shared/approvalTaskDigest'
export { APPROVAL_TASK_DIGEST_MAX_CHARS, buildApprovalTaskDigest, buildApprovalTaskEvidence }

export type ButlerInvokerDeps = {
  db: AppDatabase
  sessionStorage?: import('../sessionStorage/host/ports').SessionStorage
  turnRuntime?: TurnRuntime
  getWorkDir: () => string
  getUserDataPath: () => string
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getShellConfig?: () => ShellConfig | null
  workDirManager?: WorkDirManager
  /** 会话工作目录解析（主进程装配注入，与桌面链路同一来源）。 */
  resolveWorkDirForSession?: (sessionId: string) => string
  /** 活动工作目录 profile id（会话创建时绑定）。 */
  getActiveWorkDirProfileId?: () => string | undefined
  getActiveWorkDirProfilePath?: () => string | undefined
  /** B1(偏差 23):统一调用级准入门(automation lane 配置数据化,ButlerAdmission 退役)。 */
  admissionGate?: import('../runtime/callAdmissionGate').CallAdmissionGate
  /** 投递端口（主进程装配注入；缺省 = IM 未接线走显式降级路径）。 */
  deliveryPorts?: ButlerDeliveryPorts
  /** P6：共享投递入口（装配器持有）；缺省为调用级实例。 */
  deliveryHub?: import('../driver/deliveryHub').DeliveryHub
  /** 会话创建出口（主进程装配注入）：调度 / 手动触发的管家会话创建即回调，
   *  装配方经此把新会话推给渲染端会话列表（否则列表要重启才能看到，拉模式失效）。 */
  onSessionCreated?: (session: { id: string; name: string; ownership: string; visibility: string; workDirProfileId?: string }) => void
}

export type ButlerRunRequest = {
  trigger: 'manual' | 'schedule'
  /** 幂等键尾巴；缺省自动生成（手动触发传 requestId，调度器传 scheduledFor）。 */
  requestId?: string
  /** 定时触发对应的调度时刻（epoch ms）；手动触发为 0。 */
  scheduledFor?: number
  /** Internal scheduler claim identity; renderer IPC never forwards this field. */
  runId?: string
}

export type ButlerRunOutcome =
  | { ok: true; runId: string; sessionId: string; summary: string; deliveryStatus: import('../../src/shared/automationTaskTypes').AutomationTaskRun['deliveryStatus'] }
  | { ok: false; runId?: string; error: string; admissionDenied?: 'hourly-limit' | 'queue-full' }

type ButlerTurnResult =
  | { ok: true; sessionId: string; summary: string; usageJson?: string }
  | { ok: false; error: string; outcome?: 'commit-uncertain' }

export function buildTaskPromptWithOutputScope(prompt: string, snapshot: AutomationTaskRunConfigSnapshot): string {
  const outputScope = runOutputScopeFromSnapshot(snapshot)
  if (!outputScope) return prompt
  const resultWriteAuthorized = matchAutomationResultWritePermission(snapshot.accessPermissions, outputScope)
  const outputBindings = (snapshot.targetSelections ?? []).filter((binding) => binding.kind === 'output')
  const targets = outputBindings.map((binding) => resolveBoundOutputTarget(binding, outputScope.runOutputDir))
  const executionTime = new Date(outputScope.scheduledFor)
  const timestamp = `${String(executionTime.getFullYear()).padStart(4, '0')}${String(executionTime.getMonth() + 1).padStart(2, '0')}${String(executionTime.getDate()).padStart(2, '0')}-${String(executionTime.getHours()).padStart(2, '0')}${String(executionTime.getMinutes()).padStart(2, '0')}${String(executionTime.getSeconds()).padStart(2, '0')}-${String(executionTime.getMilliseconds()).padStart(3, '0')}`
  const defaultResultPath = path.join(outputScope.runOutputDir, `result-${timestamp}.md`)
  const lines = [
    `本次运行结果目录：${outputScope.runOutputDir}`,
    resultWriteAuthorized
      ? '用户已授权在此目录及其子目录中写入本次生成的结果。报告、总结等文档结果请保存到这里；只能写入，不能读取此目录中的既有内容，也不能写到目录之外。'
      : '本次运行没有有效的结果目录写入授权，请勿创建或修改本地文件。',
    targets.length
      ? `任务指定的结果文件目标：\n${targets.map((target) => `- ${target}`).join('\n')}`
      : resultWriteAuthorized ? `未指定固定文件名时，建议保存到：${defaultResultPath}` : '本次没有可写的结果文件目标。',
    '读取或修改资料必须使用用户另行授权的目录。'
  ]
  return `${prompt}\n\n${lines.join('\n')}`
}

function extractTextFromContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s.trim()
}

/** 执行一次管家任务（手动触发入口；调度器复用同一函数）。run 行先抢占（幂等），再准入，再执行。 */
export async function runButlerTask(deps: ButlerInvokerDeps, taskId: string, request: ButlerRunRequest): Promise<ButlerRunOutcome> {
  const db = deps.db
  const requestId = request.requestId ?? `butler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (request.trigger === 'schedule') {
    if (!request.runId) return { ok: false, error: 'SCHEDULE_CLAIM_REQUIRED' }
    const identity = getQueuedClaimIdentity(db, request.runId)
    if (!identity || identity.taskId !== taskId || identity.slot !== request.scheduledFor) return { ok: false, runId: request.runId, error: 'SCHEDULE_CLAIM_INVALID' }
    return executeClaimedRun(deps, { ...identity, runId: request.runId, requestId, trigger: 'schedule' })
  }
  const claim = insertManualTaskClaim(db, taskId, `${taskId}:manual:${requestId}`)
  const runId = claim.runId ?? ''
  if (!claim.inserted || !runId) return { ok: false, runId, error: '重复触发（幂等键已存在）' }
  return executeClaimedRun(deps, { taskId, runId, requestId, trigger: 'manual', slot: 0, generation: claim.scheduleGeneration ?? 0 })
}

export async function executeClaimedRun(deps: ButlerInvokerDeps, claim: { taskId: string; runId: string; requestId: string; trigger: 'manual' | 'schedule'; slot: number; generation: number }): Promise<ButlerRunOutcome> {
  const db = deps.db
  const sessionStorage = deps.sessionStorage
  if (!sessionStorage) return { ok: false, runId: claim.runId, error: 'SESSION_STORAGE_REQUIRED' }
  let task = getAutomationTask(db, claim.taskId)
  if (!task) return { ok: false, runId: claim.runId, error: `任务不存在：${claim.taskId}` }
  if (!deps.turnRuntime) return { ok: false, runId: claim.runId, error: 'BUTLER_TURN_RUNTIME_REQUIRED' }
  const { runId, requestId } = claim

  const admissionGate = deps.admissionGate ?? getCallAdmissionGate()
  const admission = await admissionGate.acquire({
    lane: 'automation',
    priority: 'background',
    role: 'top-level',
    disposition: 'queue',
    requestId
  })
  if (!admission.ok) {
    const reason = admission.verdict === 'rejected' ? admission.cause : admission.verdict
    updateAutomationTaskRun(db, runId, { status: 'failed', error: `准入拒绝：${reason}` })
    return { ok: false, runId, error: `准入拒绝：${reason}`, admissionDenied: reason as 'hourly-limit' | 'queue-full' }
  }
  const ticket = admission.ticket

  try {
    const admittedTask = getAutomationTask(db, claim.taskId)
    if (!admittedTask) throw new Error('任务在准入后已删除')
    const started = transitionClaimToRunning(db, runId, claim.taskId, claim.slot, claim.generation)
    if (!started.ok) {
      if (started.reason === 'invalid-task-config') throw new Error('任务工作目录不能为空')
      throw new Error(`TASK_CLAIM_START_REJECTED:${started.reason}`)
    }
    const claimSnapshot = started.snapshot!
    const activeTask = { ...admittedTask, name: claimSnapshot.taskName ?? admittedTask.name, prompt: claimSnapshot.prompt ?? admittedTask.prompt,
      deliveryPref: claimSnapshot.deliveryPref ?? admittedTask.deliveryPref, deliveryTarget: claimSnapshot.deliveryTarget ?? admittedTask.deliveryTarget,
      workDirs: claimSnapshot.workDirs ?? [], modelId: claimSnapshot.modelId, modelServiceId: claimSnapshot.serviceId,
      modelOverride: claimSnapshot.providerModelName, reasoningEffort: claimSnapshot.requestedEffort }
    task = activeTask
    const rootsInput = claimSnapshot.authorizedDirs ?? claimSnapshot.workDirs ?? getAutomationTaskWorkDirs({ workDirs: claimSnapshot.workDirs ?? [] })
    let workDirs: string[]
    if (claimSnapshot.preflightVersion === 1) {
      // final-check SYS-AUTOROOT-001: resolved roots must retain the identity in the approved snapshot;
      // re-resolve after fact collection and immediately before accepting the run, before session/model/tool dispatch.
      const validated = await validateTaskAuthorizedDirsForRun(rootsInput, rootsInput)
      if (!validated.ok) throw new Error(validated.error)
      workDirs = validated.authorizedDirs
    } else {
      const validated = await validateTaskWorkDirs(rootsInput)
      if (!validated.ok) throw new Error(validated.error)
      workDirs = validated.workDirs
    }
    let runOutputDir = claimSnapshot.runOutputDir
    let approvedShellWorkingDirectory: string | undefined
    if (claimSnapshot.preflightVersion === 1) {
      if (!claimSnapshot.outputDir || !claimSnapshot.outputOrganization || !claimSnapshot.runOutputDir || !claimSnapshot.scheduledFor) {
        throw new Error('TASK_OUTPUT_SNAPSHOT_INVALID')
      }
      const pathFactsProvider = new TaskPathFactsProvider()
      const facts = await pathFactsProvider.collect(workDirs, claimSnapshot.outputDir)
      if (!taskAuthorizedRootSetMatchesSnapshot(facts.roots, rootsInput)) throw new Error('TASK_AUTHORIZED_ROOT_DRIFT')
      const rootsAfterFacts = await validateTaskAuthorizedDirsForRun(rootsInput, rootsInput)
      if (!rootsAfterFacts.ok) throw new Error(rootsAfterFacts.error)
      const persistedBindings = claimSnapshot.targetSelections ?? []
      // final-check: re-probe explicit bound paths directly before accepting the frozen target;
      // basename bindings still require complete recursive facts inside validatePersistedTargetBindings.
      const exactPathFacts = await pathFactsProvider.inspectPaths(persistedBindings.flatMap((binding) =>
        binding.kind === 'exact' && binding.targetReference?.kind === 'path' ? [binding.path]
          : binding.kind === 'collection' ? [binding.directory]
            : []
      ))
      const bindingFacts = exactPathFacts.length ? { ...facts, proposedPathCandidates: exactPathFacts } : facts
      const validation = validatePersistedTargetBindings({ bindings: persistedBindings, roots: facts.roots, outputRoot: facts.outputRoot, facts: bindingFacts, taskRevision: claimSnapshot.taskRevision ?? -1 })
      if (!validation.ok) throw new Error(`TASK_BINDING_REVALIDATION_FAILED:${validation.code}`)
      // final-check: recheck each receipt-bound Shell cwd before creating a session. A task may
      // have several commands with different approved working directories; call-level dispatch
      // resolves the exact command/cwd pair later, while the session keeps a stable base root.
      const approvedShellWorkingDirectories = receiptShellWorkingDirectories(claimSnapshot)
      if (approvedShellWorkingDirectories.some((cwd) => !workDirs.some((root) => isPathWithin(root, cwd)))) {
        throw new Error('TASK_SHELL_WORKING_DIRECTORY_NOT_AUTHORIZED')
      }
      if (approvedShellWorkingDirectories.length) {
        const checked = await pathFactsProvider.inspectPaths(approvedShellWorkingDirectories)
        const checkedByPath = new Map(checked.map((candidate) => [candidate.path, candidate]))
        if (approvedShellWorkingDirectories.some((cwd) => checkedByPath.get(cwd)?.kind !== 'directory')) {
          throw new Error('TASK_SHELL_WORKING_DIRECTORY_CHANGED')
        }
      }
      if (approvedShellWorkingDirectories.length === 1) approvedShellWorkingDirectory = approvedShellWorkingDirectories[0]
      const safeRunOutputDir = await ensureAutomationRunOutputDirectory(claimSnapshot.outputDir, claimSnapshot.outputOrganization, claimSnapshot.scheduledFor)
      if (path.normalize(safeRunOutputDir) !== path.normalize(claimSnapshot.runOutputDir)) throw new Error('TASK_OUTPUT_SNAPSHOT_MISMATCH')
      runOutputDir = safeRunOutputDir
    }
    const workDirResult = { ok: true as const, workDir: approvedShellWorkingDirectory ?? workDirs[0] ?? runOutputDir ?? deps.getWorkDir() }
    let modelId = claimSnapshot.modelId
    let serviceId = claimSnapshot.serviceId
    let providerModelName = claimSnapshot.providerModelName
    let model: ModelEntry | undefined
    let legacyCredentials: Awaited<ReturnType<typeof resolveLlmCredentialsForModel>> | undefined
    if (modelId && serviceId) {
      model = readStoredModels(db).find((entry) => entry.id === modelId)
      if (!model || !providerModelName || model.name !== providerModelName) throw new Error('任务模型目录项已失效，请编辑任务重新选择')
    } else {
      const models = readStoredModels(db)
      if (activeTask.modelOverride) {
        const matches = models.filter((entry) => entry.name === activeTask.modelOverride)
        if (matches.length !== 1) throw new Error(matches.length ? '旧任务模型名称存在歧义，请编辑任务选择具体模型' : '旧任务模型已不存在，请编辑任务选择模型')
        model = matches[0]
        const candidates = readLlmServices(db).filter((service) => readActiveLlmServiceIds(db).includes(service.id) && (service.supportedModelIds ?? []).includes(model!.id) && service.apiKeyPresent)
        const service = candidates[0]
        legacyCredentials = service ? await resolveLlmCredentialsForModel(db, model.name, { serviceId: service.id, models }) : await resolveLlmCredentialsForModel(db, model.name, { models })
        if (legacyCredentials.error) throw new Error(`旧任务模型当前没有可用服务：${legacyCredentials.error}`)
        modelId = model.id; serviceId = legacyCredentials.serviceId; providerModelName = model.name
      } else {
        const name = readConfigValue(db, 'config.defaultModel') ?? readConfigValue(db, 'config.model') ?? ''
        model = models.find((entry) => entry.name === name)
        if (!model) throw new Error('当前桌面模型配置无效，无法解析旧任务')
        const service = readLlmServices(db).find((entry) => readActiveLlmServiceIds(db).includes(entry.id) && (entry.supportedModelIds ?? []).includes(model!.id) && entry.apiKeyPresent)
        legacyCredentials = service
          ? await resolveLlmCredentialsForModel(db, model.name, { serviceId: service.id, models })
          : await resolveLlmCredentialsForModel(db, model.name, { models })
        if (legacyCredentials.error) throw new Error(`当前桌面模型配置无效：${legacyCredentials.error}`)
        modelId = model.id; serviceId = legacyCredentials.serviceId; providerModelName = model.name
      }
    }
    if (!modelId || !serviceId || !model || !providerModelName) throw new Error('任务模型配置不完整')
    const validatedPair = await resolveLlmCredentialsForPair(db, modelId, serviceId)
    if ('error' in validatedPair) throw new Error(validatedPair.error)
    if (validatedPair.providerModelName !== providerModelName) throw new Error('任务模型目录已变化，请编辑任务重新选择')
    // Register the exact catalog pair before session creation so the run snapshot captures
    // the actual provider route ID, and unsupported routes fail before a turn is accepted.
    const routeIdentity = requireInvocationAnthropicRoute({
      modelId: providerModelName,
      endpoint: validatedPair.baseUrl,
      credentialRef: `llm-service:${serviceId}`
    }, getDefaultAgentRuntime().modelProviders)
    if (claimSnapshot.preflightVersion === 1) {
      const finalRoots = await validateTaskAuthorizedDirsForRun(rootsInput, rootsInput)
      if (!finalRoots.ok) throw new Error(finalRoots.error)
    }
    const effort = activeTask.reasoningEffort ?? resolveGlobalThinkingEffort(readConfigValue(db, 'config.thinkingEffort'), readConfigValue(db, 'config.thinkingEnabled'))
    const effectiveEffort = model.supportsThinking === false ? 'off' : effort
    const configSnapshot: AutomationTaskRunConfigSnapshot = {
      ...claimSnapshot,
      resolutionStatus: 'resolved', workDir: workDirResult.workDir, authorizedDirs: workDirs, workDirs,
      ...(runOutputDir ? { runOutputDir } : {}),
      preflightVersion: claimSnapshot.preflightVersion ?? 0, taskRevision: claimSnapshot.taskRevision,
      targetSelections: claimSnapshot.targetSelections ?? [],
      workDirSource: 'task', modelId,
      providerModelName, serviceId, routeIdentity,
      requestedEffort: effort, effectiveEffort, reasoningDegraded: effort !== effectiveEffort
    }
    updateAutomationTaskRun(db, runId, { configSnapshot })
    updateAutomationTaskRun(db, runId, { status: 'running' })

    // 会话创建（归属强制声明）+ 受信执行配置 + turn prepare
    const session = sessionStorage.commands.createSession({
      name: `管家 · ${task.prompt.slice(0, 24)}`,
      model: providerModelName,
      llmServiceId: serviceId,
      fixedWorkDir: workDirResult.workDir,
      thinkingEffort: effectiveEffort,
    ownership: 'automation',
    visibility: 'section'
    })
    const sessionId = session.id
    if (effectiveEffort !== effort) logAgentEvent('info', 'agent.profile.reasoning_degraded', {
      requestId, sessionId, modelId, model: providerModelName, from: effort, to: 'off', reason: 'model-not-support-thinking'
    })
  // 会话创建即通知装配方（渲染端列表即时可见；依赖 P1 出口契约，Core 不接触窗口）
  deps.onSessionCreated?.({
    id: session.id,
    name: session.name,
    ownership: 'automation',
    visibility: 'section',
    ...(session.workDirProfileId ? { workDirProfileId: session.workDirProfileId } : {})
    })
    const executionConfig = await resolvePinnedAutomationTurnExecutionConfig(db, sessionStorage.queries, sessionId, configSnapshot)
    const prepared = deps.turnRuntime.prepare({
      mode: 'create-user',
      requestId,
      sessionId,
      input: { text: task.prompt },
      config: executionConfig
    })
    const acceptedTurn = createAcceptedTurnFromPrepared(prepared, 'automation', executionConfig ?? { lane: 'automation' }, sessionStorage.execution)
    deps.turnRuntime.bindRequest(requestId, prepared.turnId)

    const turn = await executeRemoteTurn({
      runtime: deps.turnRuntime,
      prepared,
      requestId,
      run: () =>
        runButlerModelTurn(deps, {
          sessionStorage,
          sessionId,
          requestId,
          turnId: prepared.turnId,
          acceptedTurn,
          llmServiceId: executionConfig?.llmServiceId,
          taskPrompt: buildTaskPromptWithOutputScope(activeTask.prompt, configSnapshot),
          currentUserMessageId: prepared.userMessage?.id,
          assistantMessageId: prepared.assistantMessage.id,
          runConfig: { ...configSnapshot, model, taskId: activeTask.id }
        })
    })

    if (!turn.ok) {
      updateAutomationTaskRun(db, runId, { status: turn.outcome === 'commit-uncertain' ? 'interrupted' : 'failed', error: turn.error })
      return { ok: false, runId, error: turn.error }
    }
    // P5 投递薄分发：run 终态按任务配置送达；只有 completed 才投递（skipped 由调度侧守卫）。
    const delivery =
      activeTask.deliveryPref === 'none'
        ? ({ status: 'none' as const } as const)
        : await deliverTaskResult({
            task: {
              id: activeTask.id,
              name: activeTask.name,
              deliveryPref: activeTask.deliveryPref,
              ...(activeTask.deliveryTarget ? { deliveryTarget: activeTask.deliveryTarget } : {})
            },
            run: { runId, status: 'completed', sessionId: turn.sessionId, resultSummary: turn.summary },
            ports: deps.deliveryPorts ?? {},
            ...(deps.deliveryHub ? { hub: deps.deliveryHub } : {})
          })
    updateAutomationTaskRun(db, runId, {
      status: 'completed',
      sessionId: turn.sessionId,
      resultSummary: turn.summary,
      usageJson: turn.usageJson,
      deliveryStatus: delivery.status,
      ...(delivery.status === 'delivered' ? { deliveredAt: Date.now() } : {})
    })
    return { ok: true, runId, sessionId: turn.sessionId, summary: turn.summary, deliveryStatus: delivery.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 评审 P1-1：catch 块内的失败落库本身可能再抛（退出竞态下 db 已关闭），
    // 再抛会逃逸成 unhandled rejection——吞噬并记日志，保证向上返回结构化失败。
    try {
      if (!getRunById(db, runId)?.configSnapshot) {
        updateAutomationTaskRun(db, runId, { configSnapshot: { resolutionStatus: 'failed', error: message } })
      }
      updateAutomationTaskRun(db, runId, { status: 'failed', error: message })
    } catch {
      // 落库失败时 run 行保持 running；下一次启动恢复会标 interrupted
    }
    return { ok: false, runId, error: message }
  } finally {
    ticket.release()
  }
}

async function runButlerModelTurn(
  deps: ButlerInvokerDeps,
  args: { sessionStorage: import('../sessionStorage/host/ports').SessionStorage; sessionId: string; requestId: string; turnId?: string; acceptedTurn: import('../../src/shared/acceptedTurn').AcceptedTurn; llmServiceId?: string; taskPrompt: string; currentUserMessageId?: string; assistantMessageId?: string; runConfig: AutomationTaskRunConfigSnapshot & { model: ModelEntry; taskId: string } }
): Promise<ButlerTurnResult> {
  const db = deps.db
  const sessionStorage = args.sessionStorage
  const session = sessionStorage.queries.readSession(args.sessionId)
  if (!session) return { ok: false, error: 'BUTLER_SESSION_MISSING' }
  if (sessionStorage.ensureLedgerReady && !(await sessionStorage.ensureLedgerReady(args.sessionId))) {
    return { ok: false, error: 'SESSION_LEDGER_BLOCKED' }
  }

  const toolsConfig = deps.getToolsConfig()
  let rawMessages: import('../../src/shared/domainTypes').Message[]
  if (args.turnId) {
    const persisted = sessionStorage.execution.readTurn({ sessionId: args.sessionId, turnId: args.turnId })
    if (!persisted || persisted.sessionId !== args.sessionId || persisted.requestId !== args.requestId ||
      !persisted.userMessageId || persisted.userMessageId !== args.currentUserMessageId) {
      throw new Error('TURN_EXECUTION_CREDENTIALS_INVALID')
    }
    if (persisted.state === 'configuring') throw new Error('TURN_EXECUTION_CONFIGURING')
    rawMessages = sessionStorage.execution.loadAcceptedMessages({ sessionId: args.sessionId, turnId: args.turnId })
  } else {
    rawMessages = await readChatMessagesAfterPreparation(sessionStorage, { sessionId: args.sessionId })
  }
  const built = buildClaudeToolChatMessages(rawMessages, {
    workspaceRoot: args.runConfig.workDir!,
    workspaceRoots: args.runConfig.workDirs,
    onOversizedToolResult: (info) => {
      logHistoryOversizedToolResult({
        sessionId: args.sessionId,
        toolUseId: info.toolUseId,
        originalLength: info.originalLength,
        compactedLength: info.compactedLength,
        source: 'butler-invoker'
      })
    }
  })
  const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)
  const { messages } = ensureToolResultPairing(trimmed, { requiredUserMessageId: args.currentUserMessageId })

  let contextWindow: number | undefined
  let contextWindowTrusted = false
  try {
    const models = JSON.parse(getConfigValue(db, 'config.models') ?? '[]') as ModelEntry[]
    const modelWindow = resolveModelContextWindow(session.model, models)
    contextWindow = modelWindow.contextWindow
    contextWindowTrusted = modelWindow.trusted
  } catch { /* 无模型表时回退 undefined */ }

  const pair = await resolveLlmCredentialsForPair(db, args.runConfig.modelId!, args.runConfig.serviceId!)
  if (pair && 'error' in pair) return { ok: false, error: pair.error }
  const creds = { ...pair!, serviceId: pair!.serviceId, baseUrl: pair!.baseUrl, providerModelName: pair!.providerModelName }
  const providerRouteId = requireInvocationAnthropicRoute({
    modelId: args.runConfig.providerModelName!,
    endpoint: creds.baseUrl,
    credentialRef: `llm-service:${creds.serviceId || args.llmServiceId || 'default'}`
  }, getDefaultAgentRuntime().modelProviders)

  const system = buildFinalSystemPrompt({
    system: buildButlerSystemAppendix(args.runConfig.accessPermissions, runOutputScopeFromSnapshot(args.runConfig)),
    memoryContent: null,
    memoryEnabled: false,
    locale: readAppLocale(db)
  })

  const butlerEvents = await createButlerSessionEvents({
    userDataDir: deps.getUserDataPath(),
    taskId: args.runConfig.taskId,
    sessionId: args.sessionId,
    sessionCreatedAt: session.createdAt,
    failClosedCriticalEvents: true
  })
  const hostedTurnId = args.acceptedTurn.turnId
  await butlerEvents.sink.appendCritical({ type: 'turn_start', payload: { turnId: hostedTurnId } })
  await butlerEvents.sink.appendCritical({ type: 'step_start', payload: { turnId: hostedTurnId, stepId: args.requestId } })
  const workDir = args.runConfig.workDir!
  const approvalTaskEvidence = buildApprovalTaskEvidence(args.taskPrompt)

  const { invocation, ports, agentSdk } = assembleInvocation({
    // W3 lane 对齐：未透传会被执行层按「未启用」误拒（桌面/IM 链路均注入）
    wikiConfig: readWikiConfig(db),
    requestId: args.requestId,
    sessionId: args.sessionId,
    turnId: args.turnId,
    acceptedTurn: args.acceptedTurn,
    // DIM3：统计维度以实际解析出的服务为准（评审 P1-2）；配置值仅作兜底
    llmServiceId: creds.serviceId || args.llmServiceId,
    lane: 'automation',
    // D 任务声明（可信证据）：随执行链进入审批线索包，供任务相关性判断
    approvalTaskDigest: approvalTaskEvidence.digest,
    approvalTaskDigestTruncated: approvalTaskEvidence.truncated,
    model: args.runConfig.providerModelName!,
    modelId: args.runConfig.modelId,
    supportsThinking: args.runConfig.model.supportsThinking !== false,
    providerRouteId: args.runConfig.routeIdentity ?? providerRouteId,
    contextWindow,
    contextWindowTrusted,
    baseUrl: creds.baseUrl,
    messages,
    system,
    options: { maxTokens: 8192 },
    effort: args.runConfig.effectiveEffort ?? 'off',
    currentUserMessageId: args.currentUserMessageId,
    toolsConfig,
    resolveToolsConfig: deps.getToolsConfig,
    resolveBrowserConfig: deps.getBrowserConfig,
    resolveShellConfig: deps.getShellConfig,
    browserConfig: deps.getBrowserConfig?.(),
    shellConfig: deps.getShellConfig?.() ?? null,
    workDir,
    taskWorkDirs: args.runConfig.workDirs,
    taskAccessPermissions: args.runConfig.accessPermissions,
    ...(args.runConfig.preflightVersion === 1 ? {
      taskOutputBindings: args.runConfig.targetSelections ?? [],
      ...(args.runConfig.runOutputDir ? { taskRunOutputDir: args.runConfig.runOutputDir } : {}),
      ...(args.runConfig.outputDir && args.runConfig.outputOrganization && args.runConfig.scheduledFor && args.runConfig.runOutputDir ? {
        taskRunOutputScope: {
          outputDirectory: args.runConfig.outputDir,
          organization: args.runConfig.outputOrganization,
          scheduledFor: args.runConfig.scheduledFor,
          runOutputDir: args.runConfig.runOutputDir,
          taskRevision: args.runConfig.taskRevision ?? -1
        }
      } : {})
    } : {}),
    workDirManager: deps.workDirManager,
    resolveWorkDir: deps.workDirManager
      ? () => args.runConfig.workDir!
      : undefined,
    userDataDir: deps.getUserDataPath(),
    getApiKey: creds.getApiKey,
    appDb: db,
    sessionStorage,
    historyForSession: (sessionId: string) => sessionStorage.execution.historyFor({ sessionId }),
    locale: readAppLocale(db),
    assistantMessageId: args.assistantMessageId,
    sessionEventLocation: { workDir: path.join(deps.getUserDataPath(), 'automation-sessions', args.runConfig.taskId), sessionId: args.sessionId, createdAt: session.createdAt },
    emitFactEvent: butlerEvents.emitFactEvent,
    emitSessionEvent: butlerEvents.emitSessionEvent,
    onFileTreeChanged: butlerEvents.onFileTreeChanged
  })
  let reason = 'failed'
  let failure: unknown
  let res: Awaited<ReturnType<typeof runToolChatSession>> | undefined
  try {
    res = await runToolChatSession(invocation, ports, {
      onHostedTurnHandoff: createHostedTurnHandoff({ agentSdk, history: ports.history!, invocationId: hostedTurnId, turnId: hostedTurnId, acceptedTurn: args.acceptedTurn, sessionQueries: sessionStorage.queries, ensureChatBodyV1: sessionStorage.ensureChatBodyV1, sessionExecution: sessionStorage.execution, routeId: providerRouteId, sessionId: args.sessionId, maxToolRounds: invocation.limits.maxToolRounds })
    })
    reason = res.ok ? 'completed' : res.cancelled ? 'cancelled' : 'failed'
  } catch (error) {
    failure = error
    if (error instanceof HostedTurnFinalizedError) reason = hostedTerminalSessionEventReason(error.outcome)
  } finally {
    try {
      await butlerEvents.sink.appendCritical({ type: 'step_end', payload: { turnId: hostedTurnId, stepId: args.requestId, reason } })
      await butlerEvents.sink.appendCritical({ type: 'turn_end', payload: { turnId: hostedTurnId, reason, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : !res?.ok ? { error: res?.error } : {}) } })
    } catch (error) {
      try { logAgentEvent('warn', 'tool.error', { requestId: args.requestId, toolName: 'butler-session-event-finalize', message: error instanceof Error ? error.message : String(error) }) }
      catch { /* Diagnostics must not replace the canonical Hosted turn outcome. */ }
    } finally {
      try { await butlerEvents.sink.close() }
      catch (error) {
        try { logAgentEvent('warn', 'tool.error', { requestId: args.requestId, toolName: 'butler-session-event-close', message: error instanceof Error ? error.message : String(error) }) }
        catch { /* Diagnostics must not replace the canonical Hosted turn outcome. */ }
      }
    }
  }
  if (failure) throw failure
  if (!res) return { ok: false, error: 'BUTLER_TURN_RESULT_MISSING' }
  if (!res.ok) return { ok: false, error: res.error }
  const summary = extractTextFromContent(res.content) || '任务已完成。'
  return {
    ok: true,
    sessionId: args.sessionId,
    summary,
    ...(res.usage ? { usageJson: JSON.stringify(res.usage) } : {})
  }
}
