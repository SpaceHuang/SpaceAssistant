import { createHash } from 'node:crypto'
import type {
  AgentEventSink,
  AgentHostPorts,
  AgentInvocation,
  AgentNotifyEvent
} from '../../src/shared/agent/invocation'
import { AGENT_ADDITIONAL_CONTEXT_KEYS } from '../../src/shared/agent/invocation'
import type { FloatingNotificationManager } from '../floatingNotificationManager'
import { readPolicyPackages, resolveEffectivePolicyRulesWithOrigin } from '../confirmation/policyRulesRuntime'
import { intersectPolicyRulesWithFloor } from '../../src/shared/policy/policyFloor'
import { SqliteDecisionCache } from '../confirmation/sqliteDecisionCache'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { getDbConnection, getSession, updateSession } from '../database'
import { readStoredModels } from '../llmServiceResolver'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { AppDatabase } from '../database'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { recordStepUsage, recordTurnSummary } from '../usageStats/usageStatsRecorder'
import { safeAppendDiagnostic } from '../mcp/mcpDiagnostics'
import { scheduleSessionTitleSuggestion } from '../sessionTitleSuggest'
import { recordUserAnswerFromDecision } from '../confirmation/decisionCacheWriter'
import { evaluateToolCallGate } from '../confirmation/toolCallGate'
import { buildSnapshotFromDb, type McpToolSnapshot } from '../mcp/mcpToolRegistry'
import { resolveRequestLocale } from '../llmSystemPrompt'
import { listProfiles } from '../mcp/mcpConfigStore'
import { getSecret } from '../mcp/mcpSecretStore'
import { getDiagnostics } from '../mcp/mcpDiagnostics'
import { createMcpOAuthClientProvider } from '../mcp/mcpOauthService'
import { createMcpToolExecutor } from '../mcp/mcpToolExecutor'
import { getSecurityAuditLog } from '../confirmation/audit'
import { McpConnectionManager } from '../mcp/mcpConnectionManager'
import { createHostedMcpToolRegistry } from '../mcp/hostedMcpRegistry'
import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import { createWorkspaceSnapshotTracker } from '../workDirSnapshot'
import { getDefaultAgentRuntime } from './agentRuntimeDefaults'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { createAgentSdkProviderRecovery } from './agentSdkProviderRecovery'
import { createAgentSdkOutputRecovery } from './agentSdkOutputRecovery'
import { createAgentSdkUsageRecorder, createAgentSdkUsageSessionEvent } from './agentSdkUsageRecorder'
import type { StepAttribution } from '../../src/shared/usageAttribution'
import { createAgentSdkDesktopObserver } from './agentSdkDesktopObserver'
import { createAgentSdkPreflightAdapter, createAgentSdkTurnBoundaryAdapter } from './agentSdkTurnBoundary'
import { projectAgentToolResult } from '../../src/shared/agentToolResult'
import { isProcessToolName } from '../../src/shared/processResultProjection'
import { resolveRegisteredToolName } from '../tools/registeredToolName'
import { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff, markAgentSdkSafetyDecisionConfirmed } from '../confirmation/agentSdkSafetyPolicy'
import { createAgentSdkConfirmationPort, mapAgentSdkConfirmationOutcome } from '../confirmation/agentSdkConfirmationPort'
import { registerActiveAgentToolCancellation } from '../activeAgentToolCancellation'
import type { GateConfirmationContext } from '../confirmation/agentSdkConfirmationPort'
import type { PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'
import type { ToolCallGateArgs } from '../confirmation/toolCallGate'
import { createRegisteredAgentTurnTools } from '../tools/registeredAgentTurnTools'
import { classifyWorkDirProfileTarget } from '../workDirBinding'
import { sessionDisplayNameRaw } from '../../src/shared/sessionDisplay'
import { channelFor, type ResolveConfirmChannelArgs } from '../confirmation/channels'
import { AgentChannel } from '../confirmation/agentChannel'
import { getCallAdmissionGate } from './callAdmissionGate'
import { toolIdToOpenAiCompatibleApiToolName } from '../../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../../src/shared/toolNameCompatibility'
import { sanitizeCapabilityParamsForDisplay } from '../../src/shared/capabilityParamSanitize'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { createHostedAgentTurnHost } from './hostedAgentTurnHost'
import type { ConfirmationPort } from '../../packages/agent-sdk/src/turn'
import { FileStateCache } from '../fileStateCache'
import { resolveEffectiveShellOutputMode } from '../../src/shared/shellOutputMode'
import { assessActDanger } from '../browser/actDangerAssessor'
import { stagehandService } from '../browser/stagehandService'
import { resolveHostedBrowserGateFacts } from './hostedBrowserGateFacts'
import { shouldFallbackToUser } from '../confirmation/fallbackToUser'
import { approvalFallbackReasonFor } from '../confirmation/fallbackReason'
import type { ConfirmOutcome } from '../../src/shared/confirmation/types'
import { cancelToolConfirm } from '../toolConfirmRegistry'
import { buildConfirmationDiff } from '../confirmation/confirmDiff'
import { extractHostname } from '../browser/urlSecurity'
import { rememberBrowserSessionActTrust, rememberBrowserSessionTrustedUrl } from '../browser/browserSessionTrust'
import { computeDiffLineStats } from '../../src/shared/writeDiffStats'

/**
 * Runtime 唯一装配点（roadmap「Runtime 是唯一装配点」在主进程的落位）。
 *
 * P1 立骨架：把调用方材料（字段名平移自原 RunToolChatSessionArgs）映射为
 * AgentInvocation + AgentHostPorts；P2 起在此承接端口实现（storage / usage / tools、
 * 规则与预检材料解析），P4 承接 Profile 解析，P6 承接 sink 注册。
 */

/** 调用方装配材料：字段与原 RunToolChatSessionArgs 同构（floatingNotificationManager 由装配器消化为 events.notify）。 */
export interface AgentInvocationMaterials {
  requestId: string
  acceptedTurn?: import('../../src/shared/acceptedTurn').AcceptedTurn
  hostedHistory?: import('../../packages/agent-sdk/src/history').HistoryPort
  appendHistoryEvents?: (events: readonly Readonly<{ kind: import('../../packages/agent-sdk/src/history').HistoryEvent['kind']; payload: unknown }>[]) => Promise<void>
  expectedHistoryVersion?: () => Promise<number>
  deadlineAt?: number
  sessionId: string
  turnId?: string
  llmServiceId?: string
  windowId?: string
  model: string
  providerRouteId?: string
  contextWindow?: number
  contextWindowTrusted?: boolean
  baseUrl?: string
  messages: readonly unknown[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  /** P4（偏差 6）：显式思维强度档位；优先于 enableThinking 兼容映射；缺省 'off'（零成本档）。 */
  effort?: import('../../src/shared/agent/invocation').AgentReasoningEffort
  toolsConfig: import('../../src/shared/domainTypes').ToolsConfig
  /** Re-read mutable execution configuration during approved safety recheck and executor refresh. */
  resolveToolsConfig?: () => import('../../src/shared/domainTypes').ToolsConfig
  resolveShellConfig?: () => import('../../src/shared/domainTypes').ShellConfig | null
  resolveWikiConfig?: () => import('../../src/shared/domainTypes').WikiConfig
  browserConfig?: import('../../src/shared/domainTypes').BrowserConfig
  resolveBrowserConfig?: () => import('../../src/shared/domainTypes').BrowserConfig
  shellConfig?: import('../../src/shared/domainTypes').ShellConfig | null
  wikiConfig?: import('../../src/shared/domainTypes').WikiConfig
  feishuConfig?: import('../../src/shared/domainTypes').FeishuConfig
  wechatConfig?: import('../../src/shared/domainTypes').WeChatConfig
  larkCliRunner?: import('../feishu/larkCliRunner').LarkCliRunner
  lane?: import('../../src/shared/confirmation/types').ExecutionLane
  internalConfirmExemption?: 'approval-agent'
  maxToolLoopRounds?: number
  approvalTaskDigest?: string
  remoteContext?: import('../tools/types').RemoteContext
  /** Generic remote activity signal; generated answer text remains staged until terminal acceptance. */
  onRemoteTextActivity?: (text: string) => void
  workDir: string
  workDirManager?: import('../workDirManager').WorkDirManager
  resolveWorkDir?: () => string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  appDb?: unknown
  /** Optional canonical History adapter override for isolated host composition and non-SQLite lanes. */
  agentSdkHistory?: import('../../packages/agent-sdk/src/history').HistoryPort
  locale?: import('../../src/shared/domainTypes').AppLocale
  projectMemoryEnabled?: boolean
  skillFragments?: string[]
  currentUserMessageId?: string
  historyFacts?: readonly unknown[]
  assistantMessageId?: string
  hasImageAttachments?: boolean
  getBrowserDetectContext?: () => import('../../src/shared/browserTypes').BrowserDetectContext
  /** P3：父调用的规则集上界（嵌套调用取交集；放行集合只收窄，授权不继承）。 */
  policyRuleFloor?: import('../../src/shared/confirmation/types').PolicyRule[]
  /** P7（偏差 16）：本次调用的工具裁剪声明（allow 封闭集 / deny）。 */
  toolsTrim?: { allow?: readonly string[]; deny?: readonly string[] }
  /** P7：父调用的工具裁剪上界（嵌套取交集；违规 = 装配期拒绝）。 */
  parentToolsTrim?: { allow?: readonly string[]; deny?: readonly string[] }
  /** §5.5 收口：宿主实例在此包装为 events.notify，不再进入调用契约。 */
  floatingNotificationManager?: FloatingNotificationManager
  emitFactEvent: (event: import('../../src/shared/assistantFactAggregator').AssistantFactEvent) => void
  emitSessionEvent: (event: import('../sessionEvents').SessionEventInput) => void | Promise<void>
  onFileTreeChanged?: (event: import('../../src/shared/fileTreeSync').FileTreeChangeEvent) => void
  onTitleGenerated?: (session: import('../../src/shared/domainTypes').Session) => void
  sessionEventLocation?: { workDir: string; sessionId: string; createdAt: number }
  contextMeter?: import('../toolChatLoop').RunToolChatSessionArgs['contextMeter']
  onTurnBoundary?: import('../toolChatLoop').HostedTurnBoundaryCallback
  /** Runtime facts needed by Hosted SDK gate evaluation that are resolved at tool-call time. */
  resolveAgentSdkGateSupplement?: (input: { binding: PermitBinding; toolName: string; toolInput: Record<string, unknown>; signal?: AbortSignal }) => Promise<Pick<ToolCallGateArgs, 'dangerAssessment' | 'currentPageUrl' | 'remoteBudgetState' | 'audit'> | undefined> | Pick<ToolCallGateArgs, 'dangerAssessment' | 'currentPageUrl' | 'remoteBudgetState' | 'audit'> | undefined
  approvalAdmission?: import('./agentRuntime').ApprovalAdmissionLike
  invocationRuntime?: import('./agentRuntime').InvocationRuntimeLike
  applicationAdmission?: AgentHostPorts['applicationAdmission']
  resourceLocks?: import('./agentRuntime').ResourceLockRegistryLike
  toolExecutionConcurrency?: number
}

/** R1：会话工作目录单一事实源——装配期解析快照，调用边界经 refresh() 跟随绑定变更。 */
function buildWorkspacePorts(materials: AgentInvocationMaterials, db: AppDatabase | undefined): AgentHostPorts['workspace'] {
  const tracker = createWorkspaceSnapshotTracker({
    db,
    sessionId: materials.sessionId,
    workDirManager: materials.workDirManager as import('../workDirManager').WorkDirManager | undefined,
    fallbackWorkDir: materials.workDir,
    onRebound: (e) => {
      getSecurityAuditLog().record({
        ts: Date.now(),
        lane: materials.lane ?? 'desktop',
        actor: 'system',
        event: 'workspace.rebound',
        sessionId: e.sessionId,
        reason: JSON.stringify({ fromProfileId: e.fromProfileId, toProfileId: e.toProfileId, revision: e.revision })
      })
    }
  })
  const initial = tracker.snapshot()
  return {
    workDir: initial.rootPath || materials.workDir,
    snapshot: () => tracker.snapshot(),
    refresh: () => tracker.refresh(),
    ...(materials.workDirManager !== undefined ? { workDirManager: materials.workDirManager } : {}),
    ...(materials.resolveWorkDir !== undefined ? { resolveWorkDir: materials.resolveWorkDir } : {}),
    userDataDir: materials.userDataDir
  }
}

/** 把宿主 FloatingNotificationManager 包装为 events.notify 出口实现（§5.5 收口）。 */
function wrapNotify(manager: FloatingNotificationManager): (event: AgentNotifyEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'confirm-request':
        manager.onConfirmRequest({
          requestId: event.requestId,
          sessionId: event.sessionId,
          sessionName: event.sessionName,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          createdAt: Date.now()
        })
        break
      case 'tool-result':
        manager.onToolResult(event.requestId, event.toolUseId)
        break
      case 'request-all-cancelled':
        manager.onAllCancelledForRequest(event.requestId)
        break
    }
  }
}

/** 材料中可空的可选事件出口归一为对象。 */
function buildEventSink(materials: AgentInvocationMaterials): AgentEventSink {
  return {
    onFact: materials.emitFactEvent,
    onSessionEvent: materials.emitSessionEvent as AgentEventSink['onSessionEvent'],
    ...(materials.onFileTreeChanged ? { onFileTreeChanged: (event) => materials.onFileTreeChanged?.(event) } : {}),
    ...(materials.onTitleGenerated ? { onTitleGenerated: (session) => materials.onTitleGenerated?.(session) } : {}),
    ...(materials.floatingNotificationManager ? { notify: wrapNotify(materials.floatingNotificationManager) } : {})
  }
}

export function assembleInvocation(materials: AgentInvocationMaterials): {
  invocation: AgentInvocation
  ports: AgentHostPorts & { observer: import('../../packages/agent-sdk/src/turn').AgentTurnObserver }
  agentSdk: {
    recoverProviderAttempt: NonNullable<import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']>
    resolveGateArgs(binding: PermitBinding, call?: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }>): Promise<ToolCallGateArgs>
    createSafetyPolicy(tools: ReturnType<typeof createRegisteredAgentTurnTools>, resolveToolName?: (providerToolName: string) => string): ReturnType<typeof createAgentSdkSafetyPolicy>
    createRegisteredTools(input: {
      registry?: import('../tools/plannedToolRegistry').TypedToolRegistry
      resolveRegisteredToolName?(providerToolName: string): string
      createExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>): unknown
      refreshExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: import('../../packages/agent-sdk/src/turn').ToolPreparationStage & { kind: 'recheck' }, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
    }): ReturnType<typeof createRegisteredAgentTurnTools>
    createConfirmationPort(
      policy: ReturnType<typeof createAgentSdkSafetyPolicy>,
      adapter: Omit<Parameters<typeof createAgentSdkConfirmationPort>[0], 'onApproved' | 'publish' | 'createChannel'> & Partial<Pick<Parameters<typeof createAgentSdkConfirmationPort>[0], 'publish' | 'createChannel'>> & { agentChannelFactory?: NonNullable<import('../confirmation/channels').ResolveConfirmChannelArgs['agentChannelFactory']> }
    ): ReturnType<typeof createAgentSdkConfirmationPort>
    createHostedTurnHost(input: {
      registeredTools: ReturnType<typeof createRegisteredAgentTurnTools>
      registry?: import('../tools/plannedToolRegistry').TypedToolRegistry
      authorizedToolNames: ReadonlySet<string>
      resolveRegisteredToolName?(providerToolName: string): string
      policy: ReturnType<typeof createAgentSdkSafetyPolicy>
      confirmation?: ConfirmationPort
      hostHistory?: import('../../packages/agent-sdk/src/history').HistoryPort
      sessionLedgerForInvocationTerminal?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['sessionLedgerForInvocationTerminal']
      applicationAdmission?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['applicationAdmission']
      deadlineAt?: number
      afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
      recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']
      refreshExecutionContext?: (call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: import('../../packages/agent-sdk/src/turn').ToolPreparationStage & { kind: 'recheck' }, current: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
    }): ReturnType<typeof createHostedAgentTurnHost>
    createHostedTurnRuntime(input: {
      registry?: import('../tools/plannedToolRegistry').TypedToolRegistry
      authorizedToolNames: ReadonlySet<string>
      resolveRegisteredToolName?(providerToolName: string): string
      createExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>): unknown
      refreshExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: import('../../packages/agent-sdk/src/turn').ToolPreparationStage & { kind: 'recheck' }, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
      maxToolRounds?: number
      applicationAdmission?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['applicationAdmission']
      deadlineAt?: number
      afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
      confirmationAdapter?: Omit<Parameters<typeof createAgentSdkConfirmationPort>[0], 'onApproved' | 'publish' | 'createChannel'> & Partial<Pick<Parameters<typeof createAgentSdkConfirmationPort>[0], 'publish' | 'createChannel'>> & { agentChannelFactory?: NonNullable<import('../confirmation/channels').ResolveConfirmChannelArgs['agentChannelFactory']> }
      recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']
      refreshExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: import('../../packages/agent-sdk/src/turn').ToolPreparationStage & { kind: 'recheck' }, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
    }): {
      registeredTools: ReturnType<typeof createRegisteredAgentTurnTools>
      policy: ReturnType<typeof createAgentSdkSafetyPolicy>
      confirmation: ReturnType<typeof createAgentSdkConfirmationPort>
      host: ReturnType<typeof createHostedAgentTurnHost>
      dispose(): Promise<void>
    }
  }
} {
  if (materials.acceptedTurn && (materials.acceptedTurn.requestId !== materials.requestId ||
    materials.acceptedTurn.sessionId !== materials.sessionId ||
    (materials.turnId !== undefined && materials.acceptedTurn.turnId !== materials.turnId))) {
    throw new Error('ACCEPTED_TURN_INVOCATION_IDENTITY_MISMATCH')
  }
  if (materials.acceptedTurn && materials.currentUserMessageId !== undefined &&
    materials.currentUserMessageId !== materials.acceptedTurn.currentUserMessageId) {
    throw new Error('ACCEPTED_TURN_USER_MESSAGE_ID_MISMATCH')
  }
  const currentUserMessageId = materials.currentUserMessageId ?? materials.acceptedTurn?.currentUserMessageId
  const acceptedTurnId = materials.acceptedTurn?.turnId ?? materials.turnId
  const runtimeTurnId = acceptedTurnId ?? materials.requestId
  const db = materials.appDb as AppDatabase | undefined
  const additionalContext: Record<string, unknown> = {}
  if (materials.approvalTaskDigest !== undefined) {
    additionalContext[AGENT_ADDITIONAL_CONTEXT_KEYS.approvalTaskDigest] = materials.approvalTaskDigest
  }
  if (materials.historyFacts !== undefined) {
    additionalContext[AGENT_ADDITIONAL_CONTEXT_KEYS.historyFacts] = materials.historyFacts
  }

  // locale 定值（请求优先、库回退在装配期完成；循环内不再查库）
  const resolvedLocale = resolveRequestLocale(materials.locale, db as never)

  // P7（偏差 16）：工具裁剪——嵌套调用相对父调用取交集（只能收窄不能加宽），违规装配期拒绝并落日志
  const parentTrim = materials.parentToolsTrim
  const childTrim = materials.toolsTrim
  let toolsTrim: { allow?: readonly string[]; deny?: readonly string[] } | undefined
  if (childTrim || parentTrim) {
    if (childTrim?.allow && parentTrim?.allow) {
      const childAllow = childTrim.allow
      const parentAllow = new Set(parentTrim.allow)
      const widened = childAllow.filter((name) => !parentAllow.has(name))
      if (widened.length > 0) {
        logAgentEvent('info', 'agent.tools.trim_widen_denied', {
          requestId: materials.requestId,
          sessionId: materials.sessionId,
          widened
        })
        throw new Error(`TOOLS_TRIM_WIDEN_DENIED(${widened.join(',')})`)
      }
      const denyUnion = [...new Set([...(childTrim.deny ?? []), ...(parentTrim.deny ?? [])])]
      toolsTrim = { allow: [...childAllow], ...(denyUnion.length > 0 ? { deny: denyUnion } : {}) }
    } else {
      const allowPick = childTrim?.allow ?? parentTrim?.allow
      const denyUnion2 = [...new Set([...(childTrim?.deny ?? []), ...(parentTrim?.deny ?? [])])]
      toolsTrim = {
        ...(allowPick ? { allow: [...allowPick] } : {}),
        ...(denyUnion2.length > 0 ? { deny: denyUnion2 } : {})
      }
    }
  }

  // P4（偏差 6）：effort 解析——显式档位 > enableThinking 兼容映射（true→medium）> off（子调用零成本档）；
  // 宿主按 ModelEntry 能力校验，不支持时按定死规则降级为 off 并留痕（不静默换档）
  const requestedEffort = materials.effort
    ?? (materials.options?.enableThinking === true ? 'medium' : 'off')
  let reasoningEffort = requestedEffort
  let reasoningDegraded: import('../../src/shared/agent/invocation').AgentReasoningProfile['degraded']
  if (db && reasoningEffort !== 'off') {
    const entry = readStoredModels(db).find((m) => m.name === materials.model)
    if (entry?.supportsThinking === false) {
      reasoningDegraded = { from: requestedEffort, to: 'off' }
      reasoningEffort = 'off'
      logAgentEvent('info', 'agent.profile.reasoning_degraded', {
        requestId: materials.requestId,
        sessionId: materials.sessionId,
        model: materials.model,
        from: requestedEffort,
        to: 'off',
        reason: 'model-not-support-thinking'
      })
    }
  }
  const reasoning = { effort: reasoningEffort, ...(reasoningDegraded ? { degraded: reasoningDegraded } : {}) }

  const invocation: AgentInvocation = {
    ...(materials.acceptedTurn ? { acceptedTurn: materials.acceptedTurn } : {}),
    session: { sessionId: materials.sessionId },
    messages: {
      list: materials.messages as AgentInvocation['messages']['list'],
      ...(currentUserMessageId !== undefined ? { currentUserMessageId } : {}),
      ...(materials.assistantMessageId !== undefined ? { assistantMessageId: materials.assistantMessageId } : {}),
      ...(materials.hasImageAttachments !== undefined ? { hasImageAttachments: materials.hasImageAttachments } : {})
    },
    profile: {
      model: materials.model,
      ...(materials.providerRouteId !== undefined ? { providerRouteId: materials.providerRouteId } : {}),
      ...(materials.llmServiceId !== undefined ? { llmServiceId: materials.llmServiceId } : {}),
      ...(materials.contextWindow !== undefined ? { contextWindow: materials.contextWindow } : {}),
      ...(materials.contextWindowTrusted !== undefined ? { contextWindowTrusted: materials.contextWindowTrusted } : {}),
      ...(materials.system !== undefined ? { system: materials.system } : {}),
      ...(materials.options !== undefined ? { options: materials.options } : {}),
      ...(resolvedLocale !== undefined ? { locale: resolvedLocale } : {}),
      ...(materials.projectMemoryEnabled !== undefined ? { projectMemoryEnabled: materials.projectMemoryEnabled } : {}),
      ...(materials.skillFragments !== undefined ? { skillFragments: materials.skillFragments } : {}),
      tools: {
        toolsConfig: materials.toolsConfig,
        ...(materials.browserConfig !== undefined ? { browserConfig: materials.browserConfig } : {}),
        ...(materials.shellConfig !== undefined ? { shellConfig: materials.shellConfig } : {}),
        ...(materials.wikiConfig !== undefined ? { wikiConfig: materials.wikiConfig } : {}),
        ...(materials.feishuConfig !== undefined ? { feishuConfig: materials.feishuConfig } : {}),
        ...(materials.wechatConfig !== undefined ? { wechatConfig: materials.wechatConfig } : {}),
        ...(materials.larkCliRunner !== undefined ? { larkCliRunner: materials.larkCliRunner } : {}),
        ...(toolsTrim ? { trim: toolsTrim } : {})
      },
      ...(materials.lane !== undefined ? { lane: materials.lane } : {}),
      reasoning
    },
    events: buildEventSink(materials),
    limits: {
      ...(materials.maxToolLoopRounds !== undefined ? { maxToolRounds: materials.maxToolLoopRounds } : {}),
      deadlineAt: materials.deadlineAt ?? (Date.now() + 10 * 60_000)
    },
    safety: {
      ...(materials.internalConfirmExemption !== undefined ? { recursionGuard: materials.internalConfirmExemption } : {})
    },
    additionalContext,
    trace: {
      requestId: materials.requestId,
      ...(acceptedTurnId !== undefined ? { turnId: acceptedTurnId } : {}),
      ...(materials.windowId !== undefined ? { windowId: materials.windowId } : {})
    },
    ...(materials.remoteContext !== undefined ? { driverContext: materials.remoteContext } : {})
  }

  // ===== P2（B1）：门控端口材料装配期解析 =====
  // lane 推导与 Core 外壳同一规则（显式 lane → remoteContext 推导 → desktop）
  const materialsLane = materials.lane
    ?? (materials.remoteContext
      ? materials.remoteContext.source === 'feishu'
        ? 'feishu'
        : 'wechat'
      : 'desktop')
  // P3：带来源解析 + 嵌套交集（floor 上界由调用方声明；放行集合只收窄）
  const withOrigin = db
    ? resolveEffectivePolicyRulesWithOrigin(db, materialsLane)
    : { rules: DEFAULT_POLICY_RULES as import('../../src/shared/confirmation/types').PolicyRule[], origins: {} as Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>, disabledRuleIds: [] }
  const effectiveRules = materials.policyRuleFloor
    ? intersectPolicyRulesWithFloor(withOrigin.rules, materials.policyRuleFloor)
    : withOrigin.rules
  // 档位来源：显式声明（无库宿主 / 测试收紧）优先；有库宿主读实际配置；否则 standard
  const explicitLanePackage = (materials as { policyLanePackage?: import('../../src/shared/policy/policyPackages').PolicyPackage })
    .policyLanePackage
  const lanePackage =
    explicitLanePackage ?? (db ? readPolicyPackages(db)[materialsLane] ?? 'standard' : 'standard')
  const resolveCurrentAuthorization = () => {
    const currentOrigin = db
      ? resolveEffectivePolicyRulesWithOrigin(db, materialsLane)
      : { rules: DEFAULT_POLICY_RULES as import('../../src/shared/confirmation/types').PolicyRule[], origins: {} as Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>, disabledRuleIds: [] }
    const currentRules = materials.policyRuleFloor
      ? intersectPolicyRulesWithFloor(currentOrigin.rules, materials.policyRuleFloor)
      : currentOrigin.rules
    const currentLanePackage = explicitLanePackage ?? (db ? readPolicyPackages(db)[materialsLane] ?? 'standard' : 'standard')
    const version = createHash('sha256').update(JSON.stringify({
      effectiveRules: currentRules,
      lanePackage: currentLanePackage,
      policyOrigins: currentOrigin.origins
    })).digest('hex')
    return { effectiveRules: currentRules, lanePackage: currentLanePackage, policyOrigins: currentOrigin.origins, disabledRuleIds: currentOrigin.disabledRuleIds, authorizationVersion: version }
  }
  const currentAuthorization = resolveCurrentAuthorization()
  const authorizationVersion = currentAuthorization.authorizationVersion
  const policy = db
    ? {
        effectiveRules,
        disabledPolicyRuleIds: currentAuthorization.disabledRuleIds,
        lanePackage,
        authorizationVersion,
        resolveCurrentAuthorization,
        decisionCache: new SqliteDecisionCache(getDbConnection(db)),
        shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) },
        policyOrigins: withOrigin.origins
      }
      : {
        // 无库宿主（内存端口 / 测试）：显式默认材料 + 留痕——不是门控侧静默回退
        effectiveRules: DEFAULT_POLICY_RULES,
        disabledPolicyRuleIds: [],
        lanePackage,
        authorizationVersion,
        resolveCurrentAuthorization,
        decisionCache: { lookup: () => null },
        shellPrecheck: { touchTrustedCommand: () => undefined }
      }
  if (!db) {
    logAgentEvent('info', 'agent.policy.default_materials', {
      requestId: materials.requestId,
      lane: materialsLane,
      reason: 'no-database-host'
    })
  }

  // ===== P2 批次 B：Core 脱库的装配期材料 =====
  // 真相类端口失败可观测（§2.4 标准 3）：落审计诊断 + 原样 rethrow——
  // 执行结论仍为调用显式失败（fail-cancelled 语义随异常传播保持），但不再静默。
  const persistObservable = <T>(op: string, fn: () => T): T => {
    try {
      return fn()
    } catch (e) {
      logAgentEvent('error', 'agent.persist.failed', {
        requestId: materials.requestId,
        sessionId: materials.sessionId,
        op,
        error: e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }
  const storage = {
    ...(materials.sessionEventLocation ? { sessionEventLocation: materials.sessionEventLocation } : {}),
    ...(db
      ? {
          loaded: { metadata: getSession(db, materials.sessionId)?.metadata },
          readSession: (sessionId: string) => getSession(db, sessionId),
          persist: {
            updateSessionMetadata: (sessionId: string, patch: Record<string, unknown>) =>
              persistObservable('updateSessionMetadata', () => updateSession(db, sessionId, patch as never)),
            scheduleTitleSuggestion: (input: Record<string, unknown>) =>
              persistObservable('scheduleTitleSuggestion', () => scheduleSessionTitleSuggestion({ ...input, db } as never)),
            recordUserAnswerFromDecision: (input: Record<string, unknown>) =>
              persistObservable('recordUserAnswerFromDecision', () => recordUserAnswerFromDecision({ ...input, db, audit: getSecurityAuditLog() } as never))
          }
        }
      : {})
  }
  // 暴露面规则与门控同源同判（P3：带来源解析；嵌套交集同样适用）
  const exposure = db ? { rules: effectiveRules } : undefined
  const mcpSnapshot: McpToolSnapshot = db
    ? buildSnapshotFromDb(db, { remoteContext: materialsLane !== 'desktop' })
    : { entries: new Map(), budgetDropped: [] }
  const mcp = db
    ? {
        snapshot: mcpSnapshot,
        resolveExecutor: (toolName: string, manager: McpConnectionManager) => {
          const entry = mcpSnapshot.entries.get(toolName)
          if (!entry) return undefined
          const profile = listProfiles(db).find((p) => p.id === entry.serverId)
          if (!profile) return undefined
          const oauthProvider =
            profile.auth.mode === 'oauth' ? createMcpOAuthClientProvider(db, profile) : undefined
          return createMcpToolExecutor(entry, {
            getSession: (serverId: string) =>
              manager.connect(profile, async (kind) => getSecret(db, serverId, kind), { oauthProvider }),
            getProfile: () => profile,
            invalidateSession: (serverId: string) => manager.disconnect(serverId),
            getRecentDiagnostics: (serverId: string) => getDiagnostics(db, serverId)
          })
        },
        executorDatabase: db
      }
    : { snapshot: mcpSnapshot }
  // 中2（评审复验）：审批 Agent / automation 内部会话（internal/hidden）的 LLM 开销在写入端口
  // 直接短路（toolChatLoop 只见端口，豁免判定留在有 db 的装配侧）
  const usageExempt = db
    ? (() => {
        const s = getSession(db, materials.sessionId)
        return s?.ownership === 'internal' || s?.visibility === 'hidden'
      })()
    : false
  const usage = db
    ? {
        recordStepUsage: usageExempt
          ? () => undefined
          : (input: Record<string, unknown>) => recordStepUsage(db, input as never),
        recordTurnSummary: usageExempt
          ? () => undefined
          : (input: Record<string, unknown>) => recordTurnSummary(db, {
              ...input,
              ...(turnToolAttribution ? { toolAttributionJson: JSON.stringify(turnToolAttribution) } : {})
            } as never)
      }
    : undefined
  const diagnostics = db
    ? { append: (serverId: string, entry: unknown) => safeAppendDiagnostic(db, serverId, entry as never) }
    : undefined
  const answerer = {
    ...(db ? { approvalDatabase: db } : {})
  }

  const attributionByModelTurn = new Map<number, StepAttribution>()
  let turnToolAttribution: import('../../src/shared/usageAttribution').TurnToolDimension | undefined
  const resolveAgentSdkToolName = (name: string): string => {
    const registry = getDefaultAgentRuntime().builtinRegistry as { get(name: string): unknown; entries?(): readonly Readonly<{ name: string }>[] }
    return resolveRegisteredToolName(name, registry)
  }
  const resolveAgentSdkGateArgs = async (
    binding: PermitBinding,
    call?: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown> }>,
    signal?: AbortSignal
  ): Promise<ToolCallGateArgs> => {
    if (signal?.aborted) throw new Error('POLICY_EVALUATION_CANCELLED')
    if (!call) throw new Error('AGENT_SDK_GATE_PREPARED_CALL_REQUIRED')
    if (call.invocationId !== binding.invocationId || call.toolCallId !== binding.toolCallId) throw new Error('AGENT_SDK_GATE_CALL_BINDING_MISMATCH')
    const toolName = resolveAgentSdkToolName(call.toolName)
    const current = resolveCurrentAuthorization()
    const currentBrowserConfig = binding.phase === 'recheck' ? materials.resolveBrowserConfig?.() ?? materials.browserConfig : materials.browserConfig
    const browserFacts = await resolveHostedBrowserGateFacts({
      sessionId: materials.sessionId,
      toolName,
      toolInput: structuredClone(call.input),
      browserConfig: currentBrowserConfig,
      remote: materialsLane !== 'desktop',
      peekCurrentUrl: (sessionId) => stagehandService.peekCurrentUrl(sessionId),
      assess: (sessionId, toolInput, config, failClosed) => assessActDanger(
        sessionId, toolInput, config, stagehandService, undefined,
        failClosed ? { failClosedOnUncertainty: true } : undefined
      ),
      onAssessing: () => materials.emitFactEvent({ type: 'tool-progress', id: call.toolCallId, seq: 0, text: '正在检查本次操作风险…' })
    })
    if (signal?.aborted) throw new Error('POLICY_EVALUATION_CANCELLED')
    const callerSupplement = await materials.resolveAgentSdkGateSupplement?.({ binding, toolName, toolInput: structuredClone(call.input), ...(signal ? { signal } : {}) })
    if (signal?.aborted) throw new Error('POLICY_EVALUATION_CANCELLED')
    const supplement = { ...browserFacts, ...(callerSupplement ?? {}) }
    const currentShellConfig = binding.phase === 'recheck' ? materials.resolveShellConfig?.() ?? materials.shellConfig : materials.shellConfig
    const currentWikiConfig = binding.phase === 'recheck' ? materials.resolveWikiConfig?.() ?? materials.wikiConfig : materials.wikiConfig
    return {
      toolName,
      toolInput: structuredClone(call.input),
      requestId: binding.requestId,
      toolUseId: binding.toolCallId,
      sessionId: materials.sessionId,
      workDir: materials.resolveWorkDir?.() ?? materials.workDir,
      userDataDir: materials.userDataDir,
      lane: materialsLane,
      remoteContext: materials.remoteContext,
      toolsConfig: binding.phase === 'recheck' ? materials.resolveToolsConfig?.() ?? materials.toolsConfig : materials.toolsConfig,
      ...(currentShellConfig !== undefined ? { shellConfig: currentShellConfig } : {}),
      ...(currentBrowserConfig !== undefined ? { browserConfig: currentBrowserConfig } : {}),
      ...(materials.feishuConfig !== undefined ? { feishuConfig: materials.feishuConfig } : {}),
      ...(materials.wechatConfig !== undefined ? { wechatConfig: materials.wechatConfig } : {}),
      ...(currentWikiConfig !== undefined ? { wikiConfig: currentWikiConfig } : {}),
      effectiveRules: current.effectiveRules,
      disabledPolicyRuleIds: current.disabledRuleIds,
      lanePackage: current.lanePackage,
      policyOrigins: current.policyOrigins,
      decisionCache: policy.decisionCache as import('../confirmation/toolCallGate').GateDecisionCache,
      shellPrecheck: policy.shellPrecheck,
      ...(mcpSnapshot.entries.get(toolName) ? { mcpEntry: mcpSnapshot.entries.get(toolName) } : {}),
      ...(materials.internalConfirmExemption ? { internalConfirmExemption: materials.internalConfirmExemption } : {}),
      ...(toolName === 'switch_work_dir' ? { factsProvider: ({ toolInput }: { toolName: string; toolInput: Record<string, unknown> }) => {
        const profiles = materials.workDirManager?.listProfiles()
        const status = classifyWorkDirProfileTarget({
          profile_id: typeof toolInput.profile_id === 'string' ? toolInput.profile_id : undefined,
          name: typeof toolInput.name === 'string' ? toolInput.name : undefined,
          alias: typeof toolInput.alias === 'string' ? toolInput.alias : undefined
        }, profiles)
        return [{ kind: 'workdir-profile-target', status: status ?? 'unknown' }]
      } } : {}),
      ...(supplement ?? {})
    }
  }
  const hostedGateComposition = {
    resolveGateArgs: resolveAgentSdkGateArgs,
    createSafetyPolicy: (registered: ReturnType<typeof createRegisteredAgentTurnTools>, resolveToolName = resolveAgentSdkToolName) => {
      const permitHandoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: registered.updateExecutionContext })
      return createAgentSdkSafetyPolicy({
        resolveGateArgs: (binding, call, signal) => resolveAgentSdkGateArgs(binding, call, signal),
        resolveToolCall: registered.getPreparedCall,
        resolveToolName,
        evaluateGate: evaluateToolCallGate,
        ...permitHandoff,
        onInitialGateResult: async (binding, result, args) => {
          await permitHandoff.onInitialGateResult?.(binding, result, args)
          const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: args.toolName, input: args.toolInput } as const
          const metadata: Record<string, unknown> = { decisionRuleId: result.decision.ruleId }
          if (result.fileAutoApproved === true && (args.toolName === 'write_file' || args.toolName === 'edit_file')) {
            const diff = await buildConfirmationDiff(args.workDir, args.toolName, args.toolInput)
            const bytesWritten = args.toolName === 'write_file'
              ? Buffer.byteLength(typeof args.toolInput.content === 'string' ? args.toolInput.content : '', 'utf8')
              : diff ? Buffer.byteLength(diff.newContent, 'utf8') : 0
            const stats = diff ? computeDiffLineStats(diff.oldContent, diff.newContent) : { add: 0, remove: 0 }
            metadata.autoApprovedWrite = { path: typeof args.toolInput.path === 'string' ? args.toolInput.path : '', added: stats.add, removed: stats.remove, bytesWritten }
          }
          registered.updateExecutionContext(call, (context) => Object.assign(context, metadata))
        },
        onConfirmed: (binding, result, args, answerer) => {
          permitHandoff.onConfirmed?.(binding, result, args, answerer)
          if (answerer !== 'user' || result.decision.type !== 'require-confirm' || args.toolName !== 'browser') return
          let cacheKey: import('../../src/shared/confirmation/types').CacheKey | undefined
          if (
            args.toolInput.action === 'navigate' &&
            (typeof args.toolInput.mode !== 'string' || args.toolInput.mode === 'open') &&
            typeof args.toolInput.url === 'string' && args.toolInput.url.trim()
          ) {
            const url = args.toolInput.url.trim()
            rememberBrowserSessionTrustedUrl(materials.sessionId, url)
            const host = extractHostname(url)
            if (host) cacheKey = { kind: 'domain', domain: host, level: 'domain-any-action', sessionId: materials.sessionId }
          } else if (args.toolInput.action === 'act' && !args.dangerAssessment?.dangerous) {
            const currentUrl = stagehandService.peekCurrentUrl(materials.sessionId)
            const host = currentUrl ? extractHostname(currentUrl) : null
            if (currentUrl && host) {
              rememberBrowserSessionActTrust(materials.sessionId, currentUrl)
              cacheKey = { kind: 'domain', domain: host, level: 'domain+action', sessionId: materials.sessionId }
            }
          }
          if (db && cacheKey) {
            storage.persist?.recordUserAnswerFromDecision({
              lane: materialsLane,
              sessionId: materials.sessionId,
              key: cacheKey,
              decision: result.decision,
              answererKind: 'user',
              source: 'user-confirm'
            })
          }
        }
      })
    },
    createRegisteredTools: (input: {
      registry?: import('../tools/plannedToolRegistry').TypedToolRegistry
      resolveRegisteredToolName?: (providerToolName: string) => string
      createExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>): unknown
      refreshExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: import('../../packages/agent-sdk/src/turn').ToolPreparationStage & { kind: 'recheck' }, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
    }) => {
      const runtime = getDefaultAgentRuntime()
      const turnId = runtimeTurnId
      const fileStateCache = new FileStateCache()
      const createExecutionContext = input.createExecutionContext ?? ((call) => ({
        workDir: materials.resolveWorkDir?.() ?? materials.workDir,
        userDataDir: materials.userDataDir,
        requestId: materials.requestId,
        toolUseId: call.toolCallId,
        audit: getSecurityAuditLog(),
        sessionId: materials.sessionId,
        sendProgress: (status: string, payload?: string | import('../tools/types').ToolProgressPayload) => {
          const progress = typeof payload === 'string' ? { message: payload } : payload ?? {}
          materials.emitFactEvent({
            type: 'tool-progress', id: call.toolCallId, seq: progress.seq ?? 0, text: progress.message ?? '',
            ...(progress.rawDelta !== undefined ? { rawDelta: progress.rawDelta } : {}),
            ...(progress.rawEncoding !== undefined ? { rawEncoding: progress.rawEncoding } : {}),
            ...(progress.processPid !== undefined ? { processPid: progress.processPid } : {}),
            ...(progress.processGroupId !== undefined ? { processGroupId: progress.processGroupId } : {}),
            ...(progress.processOwnerToken !== undefined ? { processOwnerToken: progress.processOwnerToken } : {})
          })
          if (status === 'error') logAgentEvent('error', 'tool.progress', { requestId: materials.requestId, sessionId: materials.sessionId, toolUseId: call.toolCallId, toolName: call.toolName, message: progress.message })
        },
        recordDiagnostic: (entry: { code: string; message: string }) => logAgentEvent('info', 'tool.result', {
          requestId: materials.requestId, sessionId: materials.sessionId, toolName: call.toolName, code: entry.code, diagnostic: entry.message
        }),
        signal: call.signal ?? new AbortController().signal,
        fileStateCache,
        toolsConfig: materials.toolsConfig,
        ...(materials.browserConfig !== undefined ? { browserConfig: materials.browserConfig } : {}),
        ...(materials.shellConfig !== undefined ? { shellConfig: materials.shellConfig } : {}),
        ...(materials.wikiConfig !== undefined ? { wikiConfig: materials.wikiConfig } : {}),
        ...(materials.feishuConfig !== undefined ? { feishuConfig: materials.feishuConfig } : {}),
        ...(materials.wechatConfig !== undefined ? { wechatConfig: materials.wechatConfig } : {}),
        ...(materials.workDirManager ? { workDirManager: materials.workDirManager } : {}),
        ...(materials.larkCliRunner ? { larkCliRunner: materials.larkCliRunner } : {}),
        ...(materials.remoteContext ? { remoteContext: materials.remoteContext } : {}),
        policyRevision: authorizationVersion,
        shellOutputMode: resolveEffectiveShellOutputMode(materials.shellConfig ?? undefined, undefined, materials.remoteContext?.source),
        ...(db ? { appDatabase: db } : {}),
        toolUserConfirmed: false,
        ...(materials.getBrowserDetectContext ? { getBrowserDetectContext: materials.getBrowserDetectContext } : {}),
        ...(resolvedLocale ? { requestLocale: resolvedLocale } : {}),
        lane: materialsLane,
        ...(materials.historyFacts ? { historyFacts: materials.historyFacts } : {})
      }))
      const refreshExecutionContext = async (call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: { confirmation?: { receipt: string } }, current: Record<string, unknown>) => {
        const refreshed = {
          ...current,
          workDir: materials.resolveWorkDir?.() ?? materials.workDir,
          browserConfig: materials.resolveBrowserConfig?.() ?? current.browserConfig ?? materials.browserConfig,
          toolsConfig: materials.resolveToolsConfig?.() ?? current.toolsConfig ?? materials.toolsConfig,
          shellConfig: materials.resolveShellConfig?.() ?? current.shellConfig ?? materials.shellConfig,
          signal: call.signal ?? current.signal,
          toolUserConfirmed: Boolean(stage.confirmation)
        }
        return input.refreshExecutionContext
          ? { ...refreshed, ...await input.refreshExecutionContext(call, stage as Extract<import('../../packages/agent-sdk/src/turn').ToolPreparationStage, { kind: 'recheck' }>, refreshed) }
          : refreshed
      }
      return createRegisteredAgentTurnTools({
        requestId: materials.requestId,
        turnId,
        registry: input.registry ?? runtime.builtinRegistry as unknown as import('../tools/plannedToolRegistry').TypedToolRegistry,
        permits: runtime.safetyPermits,
        admission: runtime.executionAdmission,
        createExecutionContext,
        refreshExecutionContext,
        resolveAuthorizationVersion: (_call, stage) => stage.kind === 'initial'
          ? authorizationVersion
          : resolveCurrentAuthorization().authorizationVersion,
        subscribeAuthorizationChanges: (call, listener) => runtime.policyAuthorizationChanges.subscribe(
          call.invocationId,
          materialsLane,
          listener
        ),
        currentAuthorizationVersion: () => resolveCurrentAuthorization().authorizationVersion,
        resolveRegisteredToolName: input.resolveRegisteredToolName ?? resolveAgentSdkToolName,
        workspaceRoot: materials.workDir,
        resolveWorkspaceRoot: materials.resolveWorkDir ?? (() => materials.workDir),
        toolRevocations: {
          getRegisteredTool: (name) => runtime.builtinRegistry.get(name),
          isToolRevoked: runtime.toolRevocations.isToolRevoked.bind(runtime.toolRevocations),
          onRevocation: runtime.toolRevocations.onRevocation.bind(runtime.toolRevocations)
        },
        registerActiveCancellation: (call, cancel) => registerActiveAgentToolCancellation(materials.sessionId, turnId, call.toolCallId, cancel)
      })
    },
    createConfirmationPort: (
      safetyPolicy: ReturnType<typeof createAgentSdkSafetyPolicy>,
      adapter: Omit<Parameters<typeof createAgentSdkConfirmationPort>[0], 'onApproved' | 'publish' | 'createChannel'> & Partial<Pick<Parameters<typeof createAgentSdkConfirmationPort>[0], 'publish' | 'createChannel'>> & { agentChannelFactory?: NonNullable<import('../confirmation/channels').ResolveConfirmChannelArgs['agentChannelFactory']> }
    ) => {
      const { agentChannelFactory, ...confirmationAdapter } = adapter
      const hostedAgentChannelFactory: NonNullable<ResolveConfirmChannelArgs['agentChannelFactory']> = (agentDeps) => new AgentChannel({
        ...agentDeps,
        admissionGate: getCallAdmissionGate(),
        approvalAdmission: materials.approvalAdmission ?? getDefaultAgentRuntime().approvalAdmission,
        ...(materials.deadlineAt !== undefined ? { deadlineAt: materials.deadlineAt } : {}),
        ...(materials.approvalTaskDigest ? { taskDigest: materials.approvalTaskDigest } : {}),
        invokeApproval: (invocation) => {
          if (!db) return Promise.resolve({ ok: false as const, cause: 'unavailable' as const })
          return import('../confirmation/approvalAgent').then(({ runApprovalAgent }) => runApprovalAgent({
            db,
            policyRuleFloor: materials.policyRuleFloor ?? effectiveRules,
            workDir: materials.resolveWorkDir?.() ?? materials.workDir,
            userDataDir: materials.userDataDir,
            getToolsConfig: () => materials.toolsConfig,
            ...(materials.shellConfig !== undefined ? { getShellConfig: () => materials.shellConfig ?? null } : {}),
            ...((materials.resolveBrowserConfig || materials.browserConfig) ? { getBrowserConfig: () => materials.resolveBrowserConfig?.() ?? materials.browserConfig! } : {}),
            getWorkDir: () => materials.resolveWorkDir?.() ?? materials.workDir,
            resolveWorkDirForSession: () => materials.resolveWorkDir?.() ?? materials.workDir,
            maxAuthorization: materialsLane === 'automation' ? 'low' : 'high',
            model: materials.model,
            ...(materials.baseUrl ? { baseUrl: materials.baseUrl } : {}),
            ...(materials.llmServiceId ? { credentialRef: `llm-service:${materials.llmServiceId}` } : {}),
            ...(materials.locale ? { locale: materials.locale } : {}),
            getApiKey: materials.getApiKey
          }, invocation))
        }
      })
      const publishConfirmation = confirmationAdapter.publish ?? ((call: Parameters<ConfirmationPort>[0]['call'], request: import('../../src/shared/confirmation/types').ConfirmRequest, confirmationId: string, context: GateConfirmationContext) => {
        const details = context as GateConfirmationContext & Record<string, unknown>
        const confirmationDecision = details.decision as GateConfirmationContext['decision'] & { answerer?: 'user' | 'agent' }
        const assessment = details.dangerAssessment as { dangerous?: boolean; userReason?: string; consequence?: string; source?: string; fillPreview?: unknown[] } | undefined
        const precheck = details.shellPrecheck as { hints?: unknown } | undefined
        const confirmDiff = details.confirmDiff as { oldContent: string; newContent: string; oldPath: string } | undefined
        const mcpEntry = details.mcpEntry as { serverId?: string; serverName?: string; originalName?: string; description?: string } | undefined
        const fact: import('../../src/shared/assistantFactAggregator').AssistantFactEvent = {
          type: 'confirm-requested',
          id: call.toolCallId,
          requestId: materials.requestId,
          turnId: runtimeTurnId,
          lane: materialsLane,
          confirmId: confirmationId,
          riskLevel: request.riskLevel === 'low' ? 'medium' : request.riskLevel,
          ...(request.memoryTiers.length ? { memoryTiers: request.memoryTiers } : {}),
          ...(confirmDiff ? { confirmDiff } : {}),
          ...(confirmationDecision.answerer === 'agent' ? { autoAnswerer: true } : {}),
          ...(confirmationDecision.answerer === 'user' && details.autoApproveFallback ? { autoAnswerer: false } : {}),
          ...(typeof details.currentPageUrl === 'string' ? { currentPageUrl: details.currentPageUrl } : {}),
          ...(assessment?.dangerous && assessment.source ? { dangerInfo: {
            userReason: assessment.userReason ?? '',
            consequence: (assessment.consequence ?? 'generic') as import('../../src/shared/domainTypes').BrowserActDangerInfo['consequence'],
            source: assessment.source as 'page-effect' | 'target-effect' | 'keyword',
            ...(assessment.fillPreview?.length ? { fillPreview: assessment.fillPreview as never } : {})
          } } : {}),
          ...(precheck?.hints ? { shellSecurityHints: precheck.hints as never } : {}),
          ...(details.autoApproveFallback ? { autoApproveFallback: details.autoApproveFallback as never } : {}),
          ...(mcpEntry?.serverId && mcpEntry.serverName && mcpEntry.originalName ? { mcp: {
            serverId: mcpEntry.serverId, serverName: mcpEntry.serverName,
            originalToolName: mcpEntry.originalName,
            ...(mcpEntry.description ? { description: mcpEntry.description } : {})
          } } : {})
        }
        materials.emitFactEvent(fact)
        if (confirmationDecision.answerer !== 'agent' && materialsLane === 'desktop') {
          buildEventSink(materials).notify?.({
            kind: 'confirm-request', requestId: materials.requestId, sessionId: materials.sessionId,
            sessionName: sessionDisplayNameRaw((db ? getSession(db, materials.sessionId) : undefined)?.name, materials.sessionId),
            toolUseId: call.toolCallId, toolName: call.toolName, input: call.input
          })
        }
      })
      return createAgentSdkConfirmationPort({
      ...confirmationAdapter,
      fallback: confirmationAdapter.fallback ?? (async (call, confirmation, context, primaryOutcome) => {
        if (!shouldFallbackToUser({
          lane: materialsLane,
          channelOutcome: primaryOutcome,
          chatAborted: confirmation.signal?.aborted ?? false,
          sharedApprovalRecoveryFailed: false
        })) return undefined
        const cause = primaryOutcome.cause
        getSecurityAuditLog().record({
          ts: Date.now(), event: 'confirm.answerer-fallback-to-user', lane: materialsLane,
          sessionId: materials.sessionId, requestId: materials.requestId, toolName: call.toolName,
          cause, actor: 'system'
        })
        const userChannel = channelFor({
          lane: materialsLane, requestId: materials.requestId, sessionId: materials.sessionId,
          toolName: call.toolName, toolUseId: call.toolCallId, audit: getSecurityAuditLog(),
          answererPolicy: { kind: 'user' }, suppressRequestAudit: true
        })
        // DesktopChannel synchronously registers the waiter before its first await. Start it before
        // publishing either the fact or floating notification so IPC can never race an absent waiter.
        const userResponse = userChannel.request({
          facts: context.facts, riskLevel: context.decision.riskLevel,
          memoryTiers: context.decision.memoryTiers, timeoutMs: null
        })
        const confirmDiff = await buildConfirmationDiff(
          materials.resolveWorkDir?.() ?? materials.workDir,
          call.toolName,
          call.input
        )
        await publishConfirmation(call, {
          facts: context.facts,
          riskLevel: context.decision.riskLevel,
          memoryTiers: context.decision.memoryTiers,
          timeoutMs: null
        }, confirmation.confirmationId, {
          ...context,
          decision: { ...context.decision, answerer: 'user' },
          ...(confirmDiff ? { confirmDiff } : {}),
          autoApproveFallback: {
            reasonCode: cause === 'timeout' ? 'approval_timeout' : cause === 'agent-undetermined' ? 'approval_undetermined' : 'approval_unavailable',
            reason: approvalFallbackReasonFor(cause === 'agent-undetermined' ? 'agent-undetermined' : cause === 'timeout' ? 'timeout' : 'unavailable', materials.locale)
          },
        })
        const userOutcome = await userResponse
        const attributed: ConfirmOutcome = userOutcome.kind === 'approved-with-action'
          ? { kind: 'rejected', cause: userOutcome.cause, answererKind: 'user' }
          : { ...userOutcome, answererKind: 'user' }
        return mapAgentSdkConfirmationOutcome(attributed, 'user')
      }),
      createChannel: confirmationAdapter.createChannel ?? ((call, confirmation) => channelFor({
        lane: materialsLane,
        requestId: materials.requestId,
        turnId: materials.acceptedTurn?.turnId ?? materials.turnId,
        sessionId: materials.sessionId,
        toolName: call.toolName,
        toolUseId: call.toolCallId,
        audit: getSecurityAuditLog(),
        answererPolicy: { kind: confirmation.answerer },
        agentChannelFactory: agentChannelFactory ?? hostedAgentChannelFactory,
        ...(materials.remoteContext?.imChannel ? {
          imChannel: materials.remoteContext.imChannel,
          buildImPending: (request) => ({
            sessionId: materials.sessionId,
            toolName: call.toolName,
            toolInput: call.input,
            messageId: materials.remoteContext!.messageId,
            matchKey: materials.remoteContext!.source === 'feishu'
              ? (materials.remoteContext!.chatId ?? '')
              : (materials.remoteContext!.userId ?? ''),
            context: materials.remoteContext!.source === 'feishu'
              ? materials.remoteContext!.chatId
              : materials.remoteContext!.inboundRaw,
            ...(materials.remoteContext!.authOwner ? { authOwner: materials.remoteContext!.authOwner } : {}),
            ...(materials.remoteContext!.authorizationGeneration != null
              ? { authorizationGeneration: materials.remoteContext!.authorizationGeneration }
              : {}),
            requestId: materials.requestId,
            memoryTiers: request.memoryTiers
          })
        } : {})
      })),
      publish: publishConfirmation,
      onApproved: (call, outcome) => markAgentSdkSafetyDecisionConfirmed(
        safetyPolicy,
        call,
        outcome.answerer === 'agent' ? 'agent' : 'user'
      )
      })
    },
    createHostedTurnHost: (input: {
      registeredTools: ReturnType<typeof createRegisteredAgentTurnTools>
      registry?: import('../tools/plannedToolRegistry').TypedToolRegistry
      authorizedToolNames: ReadonlySet<string>
      hostHistory?: import('../../packages/agent-sdk/src/history').HistoryPort
      policy: ReturnType<typeof createAgentSdkSafetyPolicy>
      confirmation?: ConfirmationPort
      sessionLedgerForInvocationTerminal?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['sessionLedgerForInvocationTerminal']
      applicationAdmission?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['applicationAdmission']
      deadlineAt?: number
      afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
      recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']
      resolveRegisteredToolName?: (providerToolName: string) => string
    }) => {
      const routeId = materials.providerRouteId
      if (!routeId) throw new Error('HOSTED_PROVIDER_ROUTE_REQUIRED')
      const runtime = getDefaultAgentRuntime()
      const history = input.hostHistory ?? ports.history
      if (!history) throw new Error('HOSTED_HISTORY_REQUIRED')
      const toolRegistry = input.registry ?? runtime.builtinRegistry as unknown as import('../tools/plannedToolRegistry').TypedToolRegistry
      const capabilities = new CapabilityRegistry()
      const safetyGate = new SafetyGate({ capabilities, permitStore: runtime.safetyPermits, policy: input.policy })
      const toolCallStepIds = new Map<string, string>()
      const toolStepId = (toolCallId: string) => toolCallStepIds.get(toolCallId) ?? materials.requestId
    return createHostedAgentTurnHost({
        invocationId: runtimeTurnId,
        turnId: runtimeTurnId,
        routeId,
        providerRegistry: runtime.modelProviders,
        toolRegistry,
        authorizedToolNames: input.authorizedToolNames,
        ...(input.resolveRegisteredToolName ? { resolveRegisteredToolName: input.resolveRegisteredToolName } : {}),
        capabilities,
        permits: runtime.safetyPermits,
        admission: runtime.executionAdmission,
        safetyGate,
        history,
        ...(input.sessionLedgerForInvocationTerminal ? { sessionLedgerForInvocationTerminal: input.sessionLedgerForInvocationTerminal } : {}),
        ...(input.applicationAdmission ? { applicationAdmission: input.applicationAdmission } : {}),
        ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
        prepareTool: input.registeredTools.prepareTool,
        discardPreparedTool: input.registeredTools.discardPreparedTool,
        ...(input.confirmation ? { confirmation: input.confirmation } : {}),
        toolExecution: input.registeredTools.toolExecution,
        ...(input.afterToolResult ? { afterToolResult: input.afterToolResult } : {}),
        observer: ports.observer,
        recordProviderAttemptUsage: ports.recordProviderAttemptUsage,
        recoverProviderAttempt: input.recoverProviderAttempt,
        recoverOutputLimit: createAgentSdkOutputRecovery({ location: materials.sessionEventLocation, turnId: runtimeTurnId, stepId: materials.requestId }),
        ...(ports.preflightModelRequest ? { preflightModelRequest: ports.preflightModelRequest as never } : {}),
        ...(ports.turnBoundary ? { turnBoundary: ports.turnBoundary as never } : {}),
        maxConcurrentTools: materials.toolExecutionConcurrency ?? runtime.toolExecutionConcurrency,
        maxModelTurns: Math.max(12, (materials.maxToolLoopRounds ?? 0) + 1),
        ...(materials.maxToolLoopRounds !== undefined ? { maxToolRounds: materials.maxToolLoopRounds } : {}),
        resourceLocks: (materials.resourceLocks ?? runtime.resourceLocks) as never,
        toolResourceKeys: input.registeredTools.toolResourceKeys,
        isApprovalCandidate: input.registeredTools.isApprovalCandidate,
        ...(materials.sessionEventLocation ? { sessionLedgerForToolResult: (call: { toolCallId: string; toolName: string; input: Record<string, unknown> }, execution: { output: unknown; isError?: boolean; auditRef?: string }) => {
          const record = execution.output && typeof execution.output === 'object' && !Array.isArray(execution.output) ? execution.output as Record<string, unknown> : undefined
          const result = projectAgentToolResult({
            success: typeof record?.success === 'boolean' ? record.success : !(execution.isError ?? false),
            ...('data' in (record ?? {}) ? { data: record!.data } : { data: execution.output }),
            ...(typeof record?.error === 'string' ? { error: record.error } : {}),
            ...(typeof record?.userMessage === 'string' ? { userMessage: record.userMessage } : {}),
            ...(typeof record?.decisionRuleId === 'string' ? { decisionRuleId: record.decisionRuleId } : {}),
            ...(record?.autoApprovedWrite && typeof record.autoApprovedWrite === 'object' ? { autoApprovedWrite: record.autoApprovedWrite as import('../../src/shared/domainTypes').AutoApprovedWriteMeta } : {})
          }, { workspaceRoot: materials.workDir, processTool: isProcessToolName(call.toolName) })
          if (execution.auditRef) result.auditRef = execution.auditRef
          return {
            location: materials.sessionEventLocation, stepId: toolStepId(call.toolCallId), result,
            requestId: materials.requestId, invocationRequestId: materials.requestId,
            ...(materialsLane ? { lane: materialsLane } : {}), turnId: runtimeTurnId
          }
        } } : {}),
        ...(materials.sessionEventLocation ? { sessionLedgerForNotDispatched: (call: { toolCallId: string }, _reason: string, result: Record<string, unknown>) => ({
          location: materials.sessionEventLocation, stepId: toolStepId(call.toolCallId), result,
          requestId: materials.requestId, invocationRequestId: materials.requestId,
          ...(materialsLane ? { lane: materialsLane } : {}), turnId: runtimeTurnId
        }) } : {}),
        ...(materials.sessionEventLocation ? {
          sessionLedgerForAttemptUsage: (attempt: Record<string, unknown>) => {
            const event = createAgentSdkUsageSessionEvent({ requestId: materials.requestId, turnId: runtimeTurnId, baseUrl: materials.baseUrl }, attempt)
            return event ? { location: materials.sessionEventLocation, requestUsage: event.payload } : {}
          },
          sessionLedgerForModelResponse: (message: import('../../packages/agent-sdk/src/turn').CanonicalTurnMessage, modelTurn: number, _attempt: number, committedSessionLedger?: unknown) => {
            let stepId = `${materials.requestId}:model:${modelTurn}`
            if (committedSessionLedger !== undefined) {
              if (!committedSessionLedger || typeof committedSessionLedger !== 'object' || Array.isArray(committedSessionLedger)) {
                throw new Error('HOST_COMMITTED_SESSION_LEDGER_INVALID')
              }
              const committed = committedSessionLedger as { location?: unknown; stepId?: unknown; toolCalls?: unknown }
              const expectedLocation = materials.sessionEventLocation!
              const locationMatches = committed.location && typeof committed.location === 'object' && !Array.isArray(committed.location) &&
                (committed.location as typeof expectedLocation).workDir === expectedLocation.workDir &&
                (committed.location as typeof expectedLocation).sessionId === expectedLocation.sessionId &&
                (committed.location as typeof expectedLocation).createdAt === expectedLocation.createdAt
              const calls = message.role === 'assistant' ? message.toolCalls ?? [] : []
              const committedCalls = Array.isArray(committed.toolCalls) ? committed.toolCalls : []
              const committedIds = committedCalls.flatMap((call) => call && typeof call === 'object' && !Array.isArray(call) && typeof (call as { toolUseId?: unknown }).toolUseId === 'string'
                ? [(call as { toolUseId: string }).toolUseId] : [])
              if (!locationMatches || typeof committed.stepId !== 'string' || !committed.stepId.trim() ||
                committedIds.length !== calls.length || calls.some((call) => !committedIds.includes(call.id))) {
                throw new Error('HOST_COMMITTED_SESSION_LEDGER_IDENTITY_MISMATCH')
              }
              stepId = committed.stepId
            }
            const toolCalls = (message.role === 'assistant' ? message.toolCalls ?? [] : []).map((call) => {
              toolCallStepIds.set(call.id, stepId)
              const canonicalName = normalizeExternalToolName(call.name).canonicalName
              const name = toolIdToOpenAiCompatibleApiToolName(canonicalName)
              const args = structuredClone(call.input)
              return {
                toolUseId: call.id, name,
                requestId: materials.requestId,
                invocationRequestId: materials.requestId,
                ...(materialsLane ? { lane: materialsLane } : {}),
                turnId: runtimeTurnId,
                args: name === 'toolkit_call' || name === 'toolkit.call' ? sanitizeCapabilityParamsForDisplay(args) : args
              }
            })
            return { location: materials.sessionEventLocation, stepId, toolCalls }
          }
        } : {})
      })
    },
    createHostedTurnRuntime: (input: {
      registry?: import('../tools/plannedToolRegistry').TypedToolRegistry
      authorizedToolNames: ReadonlySet<string>
      resolveRegisteredToolName?: (providerToolName: string) => string
      hostHistory?: import('../../packages/agent-sdk/src/history').HistoryPort
      afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
      createExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>): unknown
      refreshExecutionContext?(call: Readonly<{ invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }>, stage: import('../../packages/agent-sdk/src/turn').ToolPreparationStage & { kind: 'recheck' }, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
      maxToolRounds?: number
      applicationAdmission?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['applicationAdmission']
      deadlineAt?: number
      confirmationAdapter?: Omit<Parameters<typeof createAgentSdkConfirmationPort>[0], 'onApproved' | 'publish' | 'createChannel'> & Partial<Pick<Parameters<typeof createAgentSdkConfirmationPort>[0], 'publish' | 'createChannel'>> & { agentChannelFactory?: NonNullable<import('../confirmation/channels').ResolveConfirmChannelArgs['agentChannelFactory']> }
      recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']
    }) => {
      const runtime = getDefaultAgentRuntime()
      const baseRegistry = input.registry ?? runtime.builtinRegistry as unknown as TypedToolRegistry
      const mcpPorts = ports.mcp
      const mcpSnapshot = mcpPorts?.snapshot as McpToolSnapshot | undefined
      const manager = mcpSnapshot?.entries.size ? new McpConnectionManager({
        appendDiagnostic: (serverId, entry) => ports.diagnostics?.append(serverId, entry as never)
      }) : undefined
      let registry = baseRegistry
      if (manager && mcpSnapshot && mcpPorts?.resolveExecutor) {
        if (typeof baseRegistry.entries !== 'function') throw new Error('HOSTED_MCP_BASE_REGISTRY_NOT_ENUMERABLE')
        registry = createHostedMcpToolRegistry({
          base: baseRegistry as TypedToolRegistry,
          snapshot: mcpSnapshot,
          manager,
          resolveExecutor: (name, connectionManager) => mcpPorts.resolveExecutor?.(name, connectionManager) as import('../tools/types').ToolExecutor | undefined
        })
      } else if (mcpSnapshot?.entries.size) {
        throw new Error('HOSTED_MCP_EXECUTOR_PORT_REQUIRED')
      }
      const resolveToolName = input.resolveRegisteredToolName ?? ((name: string) => resolveRegisteredToolName(name, registry))
      const registeredTools = hostedGateComposition.createRegisteredTools({ ...input, registry, resolveRegisteredToolName: resolveToolName })
      const policy = hostedGateComposition.createSafetyPolicy(registeredTools, resolveToolName)
      const confirmation = hostedGateComposition.createConfirmationPort(policy, input.confirmationAdapter ?? {
        cancel: (call) => { cancelToolConfirm(materials.requestId, call.toolCallId, materials.sessionId) }
      })
      const host = hostedGateComposition.createHostedTurnHost({
        registeredTools,
        registry,
        authorizedToolNames: input.authorizedToolNames,
        ...(input.hostHistory ? { hostHistory: input.hostHistory } : {}),
        ...(input.afterToolResult ? { afterToolResult: input.afterToolResult } : {}),
        ...(input.maxToolRounds !== undefined ? { maxToolRounds: input.maxToolRounds } : {}),
        ...(input.applicationAdmission ? { applicationAdmission: input.applicationAdmission } : {}),
        ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
        policy,
        confirmation,
        recoverProviderAttempt: input.recoverProviderAttempt,
        ...(input.refreshExecutionContext ? { refreshExecutionContext: input.refreshExecutionContext } : {}),
        ...(materials.sessionEventLocation ? { sessionLedgerForInvocationTerminal: (terminal) => ({
          location: materials.sessionEventLocation,
          turnId: terminal.turnId,
          reason: terminal.sessionEventReason ?? terminal.status
        }) } : {}),
        resolveRegisteredToolName: resolveToolName
      })
      return { registeredTools, policy, confirmation, host, dispose: async () => { await manager?.shutdown() } }
    }
  }

  const ports = {
    toolExecutionConcurrency: materials.toolExecutionConcurrency ?? (() => {
      try { return getDefaultAgentRuntime().toolExecutionConcurrency } catch { return 2 }
    })(),
    resourceLocks: materials.resourceLocks ?? (() => {
      try { return getDefaultAgentRuntime().resourceLocks } catch { return undefined }
    })(),
    ...(materials.applicationAdmission ? { applicationAdmission: materials.applicationAdmission } : {}),
    invocationRuntime: materials.invocationRuntime ?? (() => {
      try { return getDefaultAgentRuntime().invocationRuntime } catch { return undefined }
    })(),
    approvalAdmission: materials.approvalAdmission ?? (() => {
      try { return getDefaultAgentRuntime().approvalAdmission } catch { return undefined }
    })(),
    toolRevocations: (() => {
      try {
        const runtime = getDefaultAgentRuntime()
        const revocations = runtime.toolRevocations
        return {
          registerToolRevocationRequest: revocations.registerToolRevocationRequest.bind(revocations),
          revokeToolForLane: revocations.revokeToolForLane.bind(revocations),
          revokeToolForAllLanes: revocations.revokeToolForAllLanes.bind(revocations),
          isToolRevoked: revocations.isToolRevoked.bind(revocations),
          clearToolRevocationRequest: revocations.clearToolRevocationRequest.bind(revocations),
          onRevocation: revocations.onRevocation.bind(revocations),
          getRegisteredTool: (name: string) => runtime.builtinRegistry.get(name)
        }
      } catch { return undefined }
    })(),
    executionAdmission: (() => {
      try { return getDefaultAgentRuntime().executionAdmission } catch { return undefined }
    })(),
    safetyPermits: (() => {
      try { return getDefaultAgentRuntime().safetyPermits } catch { return undefined }
    })(),
    ...((materials.agentSdkHistory || db) ? (() => {
      const history = materials.agentSdkHistory ?? new SqliteAgentHistory(getDbConnection(db!), 1, Date.now, materials.sessionId)
      return { history }
      })() : {}),
    policy,
    storage,
    exposure,
    mcp,
    usage,
    recordProviderAttemptUsage: createAgentSdkUsageRecorder({
      requestId: materials.requestId,
      sessionId: materials.sessionId,
      turnId: runtimeTurnId,
      model: materials.model,
      llmServiceId: materials.llmServiceId,
      baseUrl: materials.baseUrl,
      recordStepUsage: usage?.recordStepUsage,
      attributionForModelTurn: (modelTurn) => attributionByModelTurn.get(modelTurn),
      emitSessionEvent: materials.emitSessionEvent,
      emitFactEvent: materials.emitFactEvent
    }),
    observer: createAgentSdkDesktopObserver({
      requestId: materials.requestId,
      sessionId: materials.sessionId,
      turnId: runtimeTurnId,
      lane: materialsLane,
      model: materials.model,
      contextWindow: materials.contextWindow,
      windowId: materials.windowId,
      ...(materials.sessionEventLocation ? { sessionEventLocation: materials.sessionEventLocation } : {}),
      turnIdForRetry: runtimeTurnId,
      stageAssistantContentUntilTurnFinished: materials.remoteContext !== undefined,
      onRemoteTextActivity: materials.onRemoteTextActivity,
      assistantMessageId: materials.assistantMessageId,
      emitSessionEvent: materials.emitSessionEvent,
      onProviderRetry: (retry) => materials.emitSessionEvent({
        type: 'request_retry',
        payload: {
          turnId: runtimeTurnId,
          stepId: materials.requestId,
          requestId: retry.requestId,
          attempt: retry.attempt,
          backoffMs: 0,
          code: retry.code
        }
      }),
      emitFactEvent: materials.emitFactEvent,
      onUsageAttribution: ({ modelTurn, attribution }) => attributionByModelTurn.set(modelTurn, attribution),
      onTurnToolAttribution: (dimension) => { turnToolAttribution = dimension },
      notify: buildEventSink(materials).notify,
      onFileTreeChanged: materials.onFileTreeChanged,
      mapToolResult: (call, output, isError) => {
        const record = output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : undefined
        const projected = projectAgentToolResult({
          success: typeof record?.success === 'boolean' ? record.success : !isError,
          ...('data' in (record ?? {}) ? { data: record!.data } : { data: output }),
          ...(typeof record?.error === 'string' ? { error: record.error } : {}),
          ...(typeof record?.userMessage === 'string' ? { userMessage: record.userMessage } : {}),
          ...(typeof record?.decisionRuleId === 'string' ? { decisionRuleId: record.decisionRuleId } : {}),
          ...(record?.autoApprovedWrite && typeof record.autoApprovedWrite === 'object' ? { autoApprovedWrite: record.autoApprovedWrite as import('../../src/shared/domainTypes').AutoApprovedWriteMeta } : {})
        }, { workspaceRoot: materials.workDir, processTool: isProcessToolName(call.toolName) })
        if (projected.success && projected.autoApprovedWrite) {
          logAgentEvent('info', 'file.auto_approve', { requestId: materials.requestId, sessionId: materials.sessionId,
            toolUseId: call.toolCallId, tool: call.toolName, relPath: projected.autoApprovedWrite.path,
            bytesWritten: projected.autoApprovedWrite.bytesWritten, timestamp: Date.now() })
        }
        return projected
      }
    }),
    diagnostics,
    answerer,
    workspace: buildWorkspacePorts(materials, db),
    credentials: {
      resolveApiKey: () => materials.getApiKey(),
      ...(materials.baseUrl !== undefined ? { networkTarget: { baseUrl: materials.baseUrl } } : {})
    },
    ...(materials.appDb !== undefined ? { legacy: { appDb: materials.appDb } } : {}),
    ...(materials.getBrowserDetectContext !== undefined
      ? { hostFacts: { getBrowserDetectContext: () => materials.getBrowserDetectContext!() } }
      : {}),
    ...(materials.contextMeter !== undefined ? { contextMeter: materials.contextMeter } : {}),
    ...(materials.onTurnBoundary !== undefined ? { preflightModelRequest: createAgentSdkPreflightAdapter({
      compact: async (input) => materials.onTurnBoundary!({ ...input, phase: 'preflight', messages: input.messages as never })
    }) } : {}),
    ...(materials.onTurnBoundary !== undefined ? { turnBoundary: createAgentSdkTurnBoundaryAdapter({
      compact: async (input) => {
        const projection = input.plannerInputs
        if (!projection) return undefined
        const system = projection.system
        const messages = input.legacyMessages
        return materials.onTurnBoundary!({
          requestId: projection.requestId, windowId: projection.windowId, system, tools: projection.tools,
          surfaceSnapshot: projection.surfaceSnapshot, messages: messages as never, budget: projection.budget,
          contextUsage: projection.contextUsage,
          toolExecutionCheckpoint: projection.toolExecutionCheckpoint, requiredSurfaceSet: projection.requiredSurfaceSet
        })
      }
    }) } : {}),
    recoverProviderAttempt: createAgentSdkProviderRecovery({
      contextWindow: materials.contextWindow,
      contextWindowTrusted: materials.contextWindowTrusted,
      model: materials.model,
      llmServiceId: materials.llmServiceId,
      onEffortUnsupported: (error) => logAgentEvent('warn', 'llm.effort.unsupported', {
        requestId: materials.requestId,
        sessionId: materials.sessionId,
        model: materials.model,
        llmServiceId: materials.llmServiceId,
        requestedEffort: materials.effort,
        fallback: 'adaptive',
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  return { invocation, ports: ports as AgentHostPorts & { observer: import('../../packages/agent-sdk/src/turn').AgentTurnObserver }, agentSdk: { ...hostedGateComposition, recoverProviderAttempt: ports.recoverProviderAttempt! } }
}
