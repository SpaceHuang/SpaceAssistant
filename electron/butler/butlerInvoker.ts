import type { AppDatabase } from '../database'
import { getMessages, getConfigValue, getSession, createSession, getPersistedTurn } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { assembleInvocation } from '../runtime/invocationAssembler'
import type { BrowserConfig, ShellConfig, ToolsConfig, ModelEntry } from '../../src/shared/domainTypes'
import { resolveModelContextWindow } from '../../src/shared/llmModelConfig'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import { readAppLocale } from '../appIpc'
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
import { getAutomationTask, getRunById, insertAutomationTaskRun, updateAutomationTaskRun } from './taskStore'
import { requireInvocationAnthropicRoute } from '../runtime/invocationProviderRoute'
import { createHostedTurnHandoff } from '../runtime/hostedTurnHandoff'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { HostedTurnFinalizedError, hostedTerminalSessionEventReason } from '../runtime/hostedTurnFinalization'
import { loadAcceptedTurnMessages } from '../runtime/acceptedTurnContext'
import { getProjectedMessages } from '../runtime/sessionTranscriptProjection'
import { createAcceptedTurnFromPrepared } from '../runtime/acceptedTurnContext'
import { validateTaskWorkDir } from './taskConfigValidation'
import { resolveGlobalThinkingEffort } from '../../src/shared/thinkingEffort'
import { getConfigValue as readConfigValue, getSession as readSession } from '../database'
import type { AutomationTaskRunConfigSnapshot } from '../../src/shared/automationTaskTypes'

/**
 * 管家执行链（P4）：定时 / 手动触发的 automation 任务 → 准入取票 → 会话创建（ownership=automation、
 * visibility=section，同一任务默认每次触发起新会话，控制上下文成本）→ turnRuntime 装配
 * （turnExecutionAdapter 模式）→ runToolChatSession({ lane: 'automation' })。
 * 门控按 P2 的 automation 规则裁决：只读放行，其余 confirm（无回答者 → 拒绝）。
 */

export const BUTLER_SYSTEM_APPENDIX = [
  '你是 SpaceAssistant 的后台管家（automation lane），由定时任务或用户手动触发，无人值守运行。',
  '本回合按任务指令完成检查、总结、提醒、报表等只读 / 汇报型工作。',
  '安全边界：无法获得人工确认——写文件、执行命令、发送消息等需要确认的操作会被自动拒绝；',
  '请优先使用只读工具完成任务，若被拒绝，请在最终回复中说明原因与已完成的部分。',
  '最终回复即任务结果汇报，请直接给出结论与关键数据，不要反问。'
].join('\n')

// 任务声明摘要已提取为两端共用模块（§5.6）：automation 任务 prompt 与桌面当前 turn 用户消息共用。
import { APPROVAL_TASK_DIGEST_MAX_CHARS, buildApprovalTaskDigest } from '../../src/shared/approvalTaskDigest'
export { APPROVAL_TASK_DIGEST_MAX_CHARS, buildApprovalTaskDigest }

export type ButlerInvokerDeps = {
  db: AppDatabase
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
}

export type ButlerRunOutcome =
  | { ok: true; runId: string; sessionId: string; summary: string; deliveryStatus: import('../../src/shared/automationTaskTypes').AutomationTaskRun['deliveryStatus'] }
  | { ok: false; runId?: string; error: string; admissionDenied?: 'hourly-limit' | 'queue-full' }

type ButlerTurnResult =
  | { ok: true; sessionId: string; summary: string; usageJson?: string }
  | { ok: false; error: string; outcome?: 'commit-uncertain' }

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
  let task = getAutomationTask(db, taskId)
  if (!task) return { ok: false, error: `任务不存在：${taskId}` }
  if (!deps.turnRuntime) return { ok: false, error: 'BUTLER_TURN_RUNTIME_REQUIRED' }

  const requestId = request.requestId ?? `butler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scheduledFor = request.scheduledFor ?? 0
  const claim = insertAutomationTaskRun(db, {
    taskId,
    clientId: `${taskId}:${request.trigger}:${requestId}`,
    trigger: request.trigger,
    scheduledFor
  })
  const runId = claim.runId ?? ''
  if (!claim.inserted || !runId) {
    return { ok: false, runId, error: '重复触发（幂等键已存在）' }
  }

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
    const admittedTask = getAutomationTask(db, taskId)
    if (!admittedTask) throw new Error('任务在准入后已删除')
    task = admittedTask
    const activeTask = admittedTask
    const legacyProfilePath = deps.getActiveWorkDirProfilePath?.()
    const workDirResult = admittedTask.workDir
      ? await validateTaskWorkDir(admittedTask.workDir)
      : await validateTaskWorkDir(legacyProfilePath)
    if (!workDirResult.ok) throw new Error(workDirResult.error)
    let modelId = admittedTask.modelId
    let serviceId = admittedTask.modelServiceId
    let providerModelName = admittedTask.modelOverride
    let model: ModelEntry | undefined
    let legacyCredentials: Awaited<ReturnType<typeof resolveLlmCredentialsForModel>> | undefined
    if (modelId && serviceId) {
      model = readStoredModels(db).find((entry) => entry.id === modelId)
      if (!model || !providerModelName || model.name !== providerModelName) throw new Error('任务模型目录项已失效，请编辑任务重新选择')
    } else {
      const models = readStoredModels(db)
      if (admittedTask.modelOverride) {
        const matches = models.filter((entry) => entry.name === admittedTask.modelOverride)
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
    const effort = admittedTask.reasoningEffort ?? resolveGlobalThinkingEffort(readConfigValue(db, 'config.thinkingEffort'), readConfigValue(db, 'config.thinkingEnabled'))
    const effectiveEffort = model.supportsThinking === false ? 'off' : effort
    const configSnapshot: AutomationTaskRunConfigSnapshot = {
      resolutionStatus: 'resolved', workDir: workDirResult.workDir,
      workDirSource: admittedTask.workDir ? 'task' : 'legacy-profile', modelId,
      providerModelName, serviceId, routeIdentity,
      requestedEffort: effort, effectiveEffort, reasoningDegraded: effort !== effectiveEffort
    }
    updateAutomationTaskRun(db, runId, { configSnapshot })
    updateAutomationTaskRun(db, runId, { status: 'running' })

    // 会话创建（归属强制声明）+ 受信执行配置 + turn prepare
    const session = createSession(db, {
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
    const executionConfig = await resolvePinnedAutomationTurnExecutionConfig(db, sessionId, configSnapshot)
    const prepared = deps.turnRuntime.prepare({
      mode: 'create-user',
      requestId,
      sessionId,
      input: { text: task.prompt },
      config: executionConfig
    })
    const acceptedTurn = createAcceptedTurnFromPrepared(db, prepared, 'automation', executionConfig ?? { lane: 'automation' })
    deps.turnRuntime.bindRequest(requestId, prepared.turnId)

    const turn = await executeRemoteTurn({
      runtime: deps.turnRuntime,
      prepared,
      requestId,
      run: () =>
        runButlerModelTurn(deps, {
          sessionId,
          requestId,
          turnId: prepared.turnId,
          acceptedTurn,
          llmServiceId: executionConfig?.llmServiceId,
          taskPrompt: activeTask.prompt,
          currentUserMessageId: prepared.userMessage?.id,
          assistantMessageId: prepared.assistantMessage.id,
          runConfig: { ...configSnapshot, model }
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
  args: { sessionId: string; requestId: string; turnId?: string; acceptedTurn: import('../../src/shared/acceptedTurn').AcceptedTurn; llmServiceId?: string; taskPrompt: string; currentUserMessageId?: string; assistantMessageId?: string; runConfig: AutomationTaskRunConfigSnapshot & { model: ModelEntry } }
): Promise<ButlerTurnResult> {
  const db = deps.db
  const session = getSession(db, args.sessionId)
  if (!session) return { ok: false, error: 'BUTLER_SESSION_MISSING' }

  const toolsConfig = deps.getToolsConfig()
  let rawMessages: ReturnType<typeof getMessages>
  if (args.turnId) {
    const persisted = getPersistedTurn(db, args.turnId)
    if (!persisted || persisted.sessionId !== args.sessionId || persisted.requestId !== args.requestId ||
      !persisted.userMessageId || persisted.userMessageId !== args.currentUserMessageId) {
      throw new Error('TURN_EXECUTION_CREDENTIALS_INVALID')
    }
    if (persisted.state === 'configuring') throw new Error('TURN_EXECUTION_CONFIGURING')
    rawMessages = loadAcceptedTurnMessages(db, persisted)
  } else {
    rawMessages = getProjectedMessages(db, args.sessionId)
  }
  const built = buildClaudeToolChatMessages(rawMessages, {
    workspaceRoot: args.runConfig.workDir!,
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
    system: BUTLER_SYSTEM_APPENDIX,
    memoryContent: null,
    memoryEnabled: false,
    locale: readAppLocale(db)
  })

  const butlerEvents = createButlerSessionEvents({
    workDir: args.runConfig.workDir!,
    sessionId: args.sessionId,
    sessionCreatedAt: session.createdAt,
    failClosedCriticalEvents: true
  })
  const hostedTurnId = args.acceptedTurn.turnId
  await butlerEvents.sink.appendCritical({ type: 'turn_start', payload: { turnId: hostedTurnId } })
  await butlerEvents.sink.appendCritical({ type: 'step_start', payload: { turnId: hostedTurnId, stepId: args.requestId } })
  const workDir = args.runConfig.workDir!

  const { invocation, ports, agentSdk } = assembleInvocation({
    requestId: args.requestId,
    sessionId: args.sessionId,
    turnId: args.turnId,
    acceptedTurn: args.acceptedTurn,
    // DIM3：统计维度以实际解析出的服务为准（评审 P1-2）；配置值仅作兜底
    llmServiceId: creds.serviceId || args.llmServiceId,
    lane: 'automation',
    // D 任务声明（可信证据）：随执行链进入审批线索包，供任务相关性判断
    approvalTaskDigest: buildApprovalTaskDigest(args.taskPrompt),
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
    workDirManager: deps.workDirManager,
    resolveWorkDir: deps.workDirManager
      ? () => args.runConfig.workDir!
      : undefined,
    userDataDir: deps.getUserDataPath(),
    getApiKey: creds.getApiKey,
    appDb: db,
    locale: readAppLocale(db),
    assistantMessageId: args.assistantMessageId,
    sessionEventLocation: { workDir: args.runConfig.workDir!, sessionId: args.sessionId, createdAt: session.createdAt },
    emitFactEvent: butlerEvents.emitFactEvent,
    emitSessionEvent: butlerEvents.emitSessionEvent,
    onFileTreeChanged: butlerEvents.onFileTreeChanged
  })
  let reason = 'failed'
  let failure: unknown
  let res: Awaited<ReturnType<typeof runToolChatSession>> | undefined
  try {
    res = await runToolChatSession(invocation, ports, {
      onHostedTurnHandoff: createHostedTurnHandoff({ agentSdk, history: ports.history!, invocationId: hostedTurnId, turnId: hostedTurnId, acceptedTurn: args.acceptedTurn, sessionDb: db, routeId: providerRouteId, sessionId: args.sessionId, maxToolRounds: invocation.limits.maxToolRounds })
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
