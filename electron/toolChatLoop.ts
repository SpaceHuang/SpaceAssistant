import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import { ToolLoopRoundLimitError } from '../packages/agent-sdk/src/turn'
import type { PermitBoundToolExecutionPort } from '../packages/agent-sdk/src/toolExecutionPort'
import type { CanonicalModelMessage, PreparedModelCall } from '../packages/agent-sdk/src/model'
import type { ExecutionAdmissionCoordinator } from '../packages/agent-sdk/src/executionAdmission'
import type { SafetyPermitStore } from '../packages/agent-sdk/src/safetyPermit'
import {
  buildThinkingWireParams,
  consumeBaselineEffortAudit,
  consumeEffortMemoizedAudit,
  isEffortUnsupportedByUpstream
} from './effortFallback'
import { resolveThinkingAvailability } from '../src/shared/thinkingAvailability'
import type { NormalizedStopReason } from './stopReason'
import { resolveToolLoopModelOptions } from './toolLoopModelOptions'
import type { WorkDirManager } from './workDirManager'
import { FileStateCache } from './fileStateCache'
import { getCallAdmissionGate } from './runtime/callAdmissionGate'
import { coordinatorConfirmHook } from './tools/coordinatorConfirmationAdapter'
import { InvocationHistoryWriter, type HistoryEvent, type HistoryPort } from '../packages/agent-sdk/src/history'
import { CanonicalCompactionCommitUncertainError, toCanonicalModelMessages } from './runtime/canonicalHistory'
import { rebuildClaudeMessagesFromHistory } from './runtime/canonicalHistory'
import { planRunShellExecution, RunShellPlanError } from './tools/runShellPlan'
import type { PreparedShellExecution } from './shell/preparedShellExecution'
import { McpConnectionManager } from './mcp/mcpConnectionManager'
import { getDiagnostics, safeAppendDiagnostic } from './mcp/mcpDiagnostics'
import { createMcpToolExecutor } from './mcp/mcpToolExecutor'
import { createRegisteredMcpTool } from './mcp/registeredMcpTool'
import {
  buildSnapshotFromDb,
  type McpToolSnapshot
} from './mcp/mcpToolRegistry'
import { getSecret } from './mcp/mcpSecretStore'
import { createMcpOAuthClientProvider } from './mcp/mcpOauthService'
import { maskSensitiveArgs } from '../src/shared/mcpTypes'
import type {
  AutoApproveFallback,
  AutoApprovedWriteMeta,
  BrowserConfig,
  ShellConfig,
  ShellSecurityHints,
  ToolCallResultPersisted,
  ToolsConfig,
  WikiConfig
} from '../src/shared/domainTypes'
import { computeDiffLineStats } from '../src/shared/writeDiffStats'
import { sessionDisplayNameRaw } from '../src/shared/sessionDisplay'
import { evaluateFileToolAutoApproval } from './tools/writeFileAutoApproval'
import { buildToolCapabilityConventionHint } from '../src/shared/skillPrompt'
import { buildMcpToolCatalogSection } from '../src/shared/toolCatalogPrompt'
import { MCP_DEFERRED_SCHEMA_BUDGET_BYTES_DEFAULT } from '../src/shared/domainTypes'
import { getSkillByName } from './skills/skillScanner'
import { getCachedSkills } from './skills/skillCache'
import { recordStepUsage, recordTurnSummary, type UsageTurnOutcome } from './usageStats/usageStatsRecorder'
import { listProfiles } from './mcp/mcpConfigStore'
import type { BrowserDetectContext } from '../src/shared/browserTypes'
import { type ActDangerAssessment } from './browser/browserActionPolicy'
import { assessActDanger } from './browser/actDangerAssessor'
import {
  clearBrowserSessionActTrust,
  clearBrowserSessionTrust,
  isBrowserSessionActTrustedHost,
  rememberBrowserSessionActTrust,
  rememberBrowserSessionTrustedUrl
} from './browser/browserSessionTrust'
import { extractHostname, isTrustedDomain } from './browser/urlSecurity'
import { stagehandService } from './browser/stagehandService'
import type { HistoryFact } from '../src/shared/historyReader'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { LarkCliRunner } from './feishu/larkCliRunner'
import type { RemoteContext } from './tools/types'
import type {
  AgentEventSink,
  AgentHostPorts,
  AgentInvocation,
  AgentInvocationResult
} from '../src/shared/agent/invocation'
import { AGENT_ADDITIONAL_CONTEXT_KEYS } from '../src/shared/agent/invocation'
import type { WeChatConfig } from '../src/shared/wechatTypes'
import type {
  ConfirmAnswererPolicy, ExecutionLane } from '../src/shared/confirmation/types'
import { BROWSER_REMOTE_DISABLED_CODE } from '../src/shared/browserRemotePolicy'
import { SHELL_REMOTE_DISABLED_ERROR } from '../src/shared/shellToolDisplay'
import { resolveEffectiveShellOutputMode } from '../src/shared/shellOutputMode'
import { logShellConfirmOutcome, logShellPrecheck } from './shell/shellAgentLogger'
import { getBuiltinSensitivePrefixes } from './shell/shellSensitivePaths'
import { canShowShellTrustOption } from './shell/shellCommandTrust'
import type { SessionEventInput } from './sessionEvents'
import { buildToolCallGateArgs, evaluateToolCallGate, isOutboundWriteTool } from './confirmation/toolCallGate'
import { finalizeInvocationResult, HostedTurnFinalizedError } from './runtime/hostedTurnFinalization'
import type { HostedTurnFinalization } from './runtime/hostedTurnFinalization'
import { markHostedTurnFinalization } from './runtime/hostedTurnFinalization'
import type { HostCommittedModelResponse } from '../packages/agent-sdk/src/turn'
import { validateReadExecutionBoundary } from './confirmation/readExecutionBoundary'
import { buildWriteExecutionPermit } from './confirmation/writeExecutionPermit'
import { finalizeReadConfirmation, settleReadConfirmation } from './confirmation/readConfirmationFlow'
import { recordPolicyExecutionVeto } from './confirmation/audit'
import { recordUserAnswerFromDecision, recordSystemManagedCacheEntry } from './confirmation/decisionCacheWriter'
import { getSecurityAuditLog } from './confirmation/audit'
import { channelFor, type ResolveConfirmChannelArgs } from './confirmation/channels'
import { shouldFallbackToUser } from './confirmation/fallbackToUser'
import { approvalFallbackReasonFor } from './confirmation/fallbackReason'
import type { ConfirmationChannel } from '../src/shared/confirmation/types'
import { AgentChannel } from './confirmation/agentChannel'
import { loadEffectivePolicyRules } from './confirmation/policyRulesRuntime'
import { getBuiltinToolMetadata } from '../src/shared/builtinToolMetadata'
import { mapLegacyConfirmation, type LegacyConfirmationRejectReason, type LegacyPolicyCode } from './tools/coordinatorConfirmationAdapter'
import type { ConfirmAnswererKind, ConfirmOutcome, ConfirmOutcomeCause, ConfirmRequest } from '../src/shared/confirmation/types'
import {
  formatScriptDenyUserMessage,
  getRemoteTaskController
} from './remote/remoteTaskController'
import {
  checkRemoteTaskBudget,
  createRemoteTaskBudgetState,
  recordOutboundWrite,
  recordToolCall,
  type RemoteTaskBudgetState
} from './remote/remoteTaskBudget'
import { DEFAULT_REMOTE_TASK_BUDGET } from '../src/shared/imTypes'
import { recheckRemoteWriteAuthorization } from './remote/remoteWriteAuthorization'
import {
  logShellPathConfirm,
  logShellSecurityDeny,
  logShellWeakDenyOutcome,
  precheckRunShellTool,
  type RunShellPrecheckResult
} from './shell/shellToolLoopHelpers'
import {
  REMOTE_CONFIRM_TIMEOUT_MESSAGES,
  resolveRemoteContextConfirmPolicy
} from './remote/remoteConfirmPolicy'
import {
  beginLlm,
  clearRequest,
  endLlm
} from './remote/remoteSessionSwitchState'
import { shouldRequestImConfirm } from '../src/shared/remoteConfirmPolicy'
import {
  ChatCancelledError,
  clearChatCancel,
  registerChatCancel,
  throwIfChatCancelled
} from './chatCancelRegistry'
import { clearSessionActiveStream, registerSessionActiveStream } from './chatActiveStreams'
import { getCachedMemoryContent } from './projectMemory'
import { buildFinalSystemPrompt, resolveRequestLocale } from './llmSystemPrompt'
import type { AppLocale } from '../src/shared/locale'
import { stripThinkingBlocksFromAssistantMessages } from '../src/shared/stripThinkingFromApiMessages'
import {
  clearToolCancel,
  registerToolCancel,
  type ToolConfirmOutcome
} from './toolConfirmRegistry'
import * as toolConfirmRegistry from './toolConfirmRegistry'
import fs from 'fs/promises'
import path from 'path'
import { assertSafeToolInput } from './toolInputGuards'
import { logAgentEvent } from './agentLogger/agentLogger'
import { projectProcessResultForAgentLog } from '../src/shared/agentSafeProjection'
import { isProcessToolName } from '../src/shared/processResultProjection'
import {
  effectiveMaxTokensForBuiltinToolLoop,
  TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN
} from '../src/shared/llm/toolLoopMaxTokens'
import {
  checkWritePathConflict,
  claimWritePath,
  releaseWritePath,
  releaseAllWritePathsForSession
} from './toolWriteConflict'
import { computeDeferredPlan, computeEffectiveTools, authorizeToolCall } from './effectiveTools'
import { clearToolRevocationRequest, isToolRevoked, registerToolRevocationRequest } from './toolRevocationRegistry'
import { buildCommandRetryKey, shouldStopToolRetry } from './toolErrorRetryPolicy'
import type { ContextMeter } from '../src/shared/contextMeterService'
import { buildRequestHeaderPayload } from '../src/shared/requestContext'
import { sanitizeThinkingForReplay } from '../src/shared/sanitizeThinkingForReplay'
import { bindHostedRequiredUserMessage, canonicalHostedRequiredUserMessage, createHostedModelRequest } from './runtime/hostedModelRequest'

export const DESKTOP_TOOL_LOOP_MAX_ROUNDS = 500

const fileCaches = new Map<string, FileStateCache>()

export function getFileStateCacheForSession(sessionId: string): FileStateCache {
  let c = fileCaches.get(sessionId)
  if (!c) {
    c = new FileStateCache()
    fileCaches.set(sessionId, c)
  }
  return c
}

export function clearSessionToolResources(sessionId: string): void {
  fileCaches.delete(sessionId)
  releaseAllWritePathsForSession(sessionId)
  clearBrowserSessionTrust(sessionId)
  clearBrowserSessionActTrust(sessionId)
}

export type ClaudeContentBlockMessage = {
  role: 'user' | 'assistant'
  content: string | Array<unknown>
  id?: string
  timestamp?: number
}

function createHostedInvocationHistory(
  writer: InvocationHistoryWriter,
  history: NonNullable<AgentHostPorts['history']>
): import('../packages/agent-sdk/src/history').HistoryPort {
  return {
    appendBatch: async (events, expectedVersion) => {
      const currentVersion = await writer.currentOrPersistedVersion()
      if (currentVersion !== expectedVersion) throw new Error(`history version ${currentVersion} does not match ${expectedVersion}`)
      const appended = await writer.append(events)
      return { version: appended.version, duplicate: appended.duplicate }
    },
    read: (invocationId) => history.read(invocationId)
  }
}

export type RunToolChatSessionArgs = {
  onHostedTurnHandoff?: (input: Readonly<{
    request: PreparedModelCall['request']
    authorizedToolNames: ReadonlySet<string>
    /** FR3：延迟名集合（并入 capabilities known + authorized，门禁簿记零上下文成本）。 */
    deferredToolNames?: ReadonlySet<string>
    /** FR8：延迟工具未浮现直调判定（sessionLedger 持久化投影查询用）。 */
    deferredUnsurfacedCheck?: (toolName: string) => boolean
    resolveRegisteredToolName: (providerToolName: string) => string
    windowId?: string
    maxToolRounds?: number
    hostHistory?: import('../packages/agent-sdk/src/history').HistoryPort
    afterToolResult?: import('../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
    initialResponse?: HostCommittedModelResponse
    currentUserMessageId?: string
    requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  }>) => Promise<Readonly<{ result: RunToolChatSessionResult; finalization: HostedTurnFinalization }> | undefined>
  requestId: string
  /** 顶层父任务的绝对截止时间；缺省仅兼容旧入口，使用统一 10 分钟上限。 */
  deadlineAt?: number
  toolExecutionConcurrency?: number
  resourceLocks?: AgentHostPorts['resourceLocks']
  applicationAdmission?: AgentHostPorts['applicationAdmission']
  invocationRuntime?: import('./runtime/agentRuntime').InvocationRuntimeLike
  invocationLeaseState?: { current?: import('./runtime/agentRuntime').InvocationLeaseLike }
  approvalAdmission?: import('./runtime/agentRuntime').ApprovalAdmissionLike
  toolRevocations?: AgentHostPorts['toolRevocations']
  executionAdmission?: ExecutionAdmissionCoordinator
  safetyPermits?: SafetyPermitStore
  history?: AgentHostPorts['history']
  hostHistory?: import('../packages/agent-sdk/src/history').HistoryPort
  appendHistoryEvents?: (events: readonly Readonly<{ kind: HistoryEvent['kind']; payload: unknown }>[]) => Promise<void>
  sessionId: string
  /** 本回合规范 Turn ID；迁移期旧调用缺省时以 requestId 作为兼容 stream ID。 */
  turnId?: string
  /** 冻结执行配置里的 LLM 服务 ID（DIM3：同模型跨服务分开统计）。 */
  llmServiceId?: string
  windowId?: string
  model: string
  providerRouteId?: string
  contextWindow?: number
  contextWindowTrusted?: boolean
  baseUrl?: string
  messages: ClaudeContentBlockMessage[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  toolsConfig: ToolsConfig
  browserConfig?: BrowserConfig
  shellConfig?: ShellConfig | null
  wikiConfig?: WikiConfig
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  larkCliRunner?: LarkCliRunner
  /** 显式 lane（偏差 21）：由驱动源层解析后随调用传入；缺省回退 remoteContext 推导，最终 desktop。 */
  lane?: import('../src/shared/confirmation/types').ExecutionLane
  /**
   * P2-4 递归守卫标记（I5）：仅审批执行链传入 'approval-agent'（代码写死，不进配置）。
   * gate 看到 require-confirm + 该标记 → 改写为 deny(cause=recursion-blocked)。
   */
  internalConfirmExemption?: 'approval-agent'
  /** 工具执行轮数上界（有界调用方使用，如审批 Agent ≤3）；缺省不限。 */
  maxToolLoopRounds?: number
  /**
   * 已声明的任务（对比分析 §4-D，可信证据）：管家装配传任务 prompt 摘要，
   * 仅用于 agent 回答者线索包的任务相关性判断；缺省 = 无任务上下文。
   */
  approvalTaskDigest?: string
  remoteContext?: RemoteContext
  workDir: string
  workDirManager?: WorkDirManager
  resolveWorkDir?: () => string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  /** 用于达到累计 assistant 阈值后异步生成会话标题（不写则跳过） */
  locale?: AppLocale
  projectMemoryEnabled?: boolean
  /** P4：思维强度档位（装配期解析；发起时冻结，调用内不变）。 */
  reasoningEffort?: import('../src/shared/agent/invocation').AgentReasoningEffort
  skillFragments?: string[]
  /** 当轮 user 消息 id（tool loop 日志等） */
  currentUserMessageId?: string
  /** 由 Core 从当前授权会话事实构造，供 history.read 只读回查。 */
  historyFacts?: readonly HistoryFact[]
  assistantMessageId?: string
  hasImageAttachments?: boolean
  getBrowserDetectContext?: () => BrowserDetectContext
  /** 统一消息事实迁移端口（必填）：调用方显式声明过程事实往哪里说；无观察者时传 no-op。 */
  emitFactEvent: (event: AssistantFactEvent) => void
  /** Core 事件台账写入口（必填）：与 UI fact 通道分离，保存原始 NormalizedDelta。 */
  emitSessionEvent: (event: SessionEventInput) => void | Promise<void>
  /** 文件树失效通知出口；由装配方决定投给谁，未传即 no-op。 */
  onFileTreeChanged?: (event: import('../src/shared/fileTreeSync').FileTreeChangeEvent) => void
  /** 会话标题落库完成后的界面通知出口；未传即 no-op（落库照常）。 */
  onTitleGenerated?: (session: import('../src/shared/domainTypes').Session) => void
  /** Core 以 session event ledger 提供的唯一上下文测量适配器。 */
  contextMeter?: ContextMeter
  /** P1：events 出口对象随展开层注入（floatingNotificationManager 已收回为 events.notify，§5.5）。 */
  events?: AgentEventSink
  /** P2（B1）：门控端口材料（装配期解析注入；此处空对象仅类型占位，缺失会触发门控 fail-loud）。 */
  gatePolicy?: {
    effectiveRules: import('../src/shared/confirmation/types').PolicyRule[]
    disabledPolicyRuleIds?: readonly string[]
    /** 「自动」变换的档位来源（§2.1，与 effectiveRules 同源装配注入；缺省 standard） */
    lanePackage?: import('../src/shared/policy/policyPackages').PolicyPackage
    decisionCache: import('./confirmation/toolCallGate').GateDecisionCache
    shellPrecheck: { touchTrustedCommand: (command: string) => void }
    policyOrigins?: Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>
    /** 装配时冻结的授权材料版本；用于 dispatch claim 前检测策略快照变化。 */
    authorizationVersion?: string
    resolveCurrentAuthorization?: () => {
      effectiveRules: import('../src/shared/confirmation/types').PolicyRule[]
      disabledRuleIds: readonly string[]
      lanePackage: import('../src/shared/policy/policyPackages').PolicyPackage
      policyOrigins: Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>
      authorizationVersion: string
    }
  }
  /** P2 批次 B：宿主端口材料（展开层注入，循环体经端口消费，Core 不持库）。 */
  hostDiagnostics?: { append(serverId: string, entry: never): void }
  hostUsage?: {
    recordStepUsage?(input: Record<string, unknown>): void
    recordTurnSummary?(input: Record<string, unknown>): void
  }
  hostStorage?: {
    sessionMeta?: Record<string, unknown> | undefined
    sessionEventLocation?: { workDir: string; sessionId: string; createdAt: number }
    readSession?(sessionId: string): unknown
    persist?: {
      updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): void
      scheduleTitleSuggestion?(input: Record<string, unknown>): void
      recordUserAnswerFromDecision?(input: Record<string, unknown>): void
    }
  }
  hostExposureRules?: readonly import('../src/shared/confirmation/types').PolicyRule[]
  hostMcp?: {
    snapshot: McpToolSnapshot
    resolveExecutor?(toolName: string, manager: McpConnectionManager): import('./tools/types').ToolExecutor | undefined
    executorDatabase?: unknown
  }
  hostAnswerer?: {
    /** P3 契约路径重构遗留端口：审批内层独立数据库上下文（回答者已由 gate 决策派生，不再按 lane 查配置）。 */
    approvalDatabase?: unknown
  }
  /** P7（偏差 16）：按调用裁剪（装配层从 profile.tools.trim 平移）。 */
  toolsTrim?: { allow?: readonly string[]; deny?: readonly string[] }
}

/** SDK History adapter stays in the Electron Hosted boundary, outside shared invocation ports. */
export type RunToolChatSessionPorts = AgentHostPorts & { hostHistory?: HistoryPort }

/** Adapter input used only to preserve Desktop's existing compaction planner at the Hosted SDK boundary. */
export type HostedTurnBoundaryCallback = (input: {
  phase?: 'turn-boundary' | 'preflight'
  requestId: string
  windowId: string
  system: string
  tools: unknown[]
  surfaceSnapshot: ReturnType<typeof buildRequestHeaderPayload>['surfaceSnapshot']
  messages: ClaudeContentBlockMessage[]
  budget: ReturnType<typeof import('../src/shared/requestContext').buildRequestContextPayload>['budget']
  contextUsage?: ReturnType<typeof import('../src/shared/requestContext').buildRequestContextPayload>['contextUsage']
  toolExecutionCheckpoint: ReturnType<typeof buildRequestHeaderPayload>['toolExecutionCheckpoint']
  requiredSurfaceSet: string[]
}) => Promise<void | Readonly<{
  messages: readonly CanonicalModelMessage[]
  windowId?: string
  historyPayload?: Record<string, unknown>
  commitProjection?(): void | Promise<void>
}>>


class HostedTurnHandoffError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'HostedTurnHandoffError'
  }
}

class InvocationHistoryAlreadyTerminalError extends Error {
  constructor() {
    super('INVOCATION_HISTORY_STREAM_ALREADY_TERMINAL')
    this.name = 'InvocationHistoryAlreadyTerminalError'
  }
}

export type ToolLoopUsage = ReturnType<typeof normalizeAnthropicMessageUsage>

/** 工具 loop 最终返回的 usage：优先最后一轮，缺失时回退到最近有效轮次 */
export function pickToolLoopReturnUsage(
  currentRound: ToolLoopUsage | undefined,
  lastValid: ToolLoopUsage | undefined
): ToolLoopUsage | undefined {
  return currentRound ?? lastValid
}

export type RunToolChatSessionResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: ToolLoopUsage; finalSurfaceSnapshot?: ReturnType<typeof buildRequestHeaderPayload>['surfaceSnapshot']; finalSurfaceMessages?: ClaudeContentBlockMessage[] }
  | { ok: false; error: string; usage?: ToolLoopUsage; cancelled?: boolean }

/** 本回合的用量统计计数（runToolChatSession 作用域内创建、随回合结束丢弃，不引入跨模块累加器 —— 需求 §7.3.1）。 */
export type TurnUsageStats = {
  stepCount: number
  toolCallCount: number
  toolErrorCount: number
  toolSkippedCount: number
}

/**
 * 以 tool_result 终态为基准的三分类计数（需求 §2.4.0 恒等式）：
 * `tool_call_count = 执行成功 + 执行失败 + 未执行`；孤儿 tool_call（无 tool_result）不计入。
 */
export function noteToolResultForStats(stats: TurnUsageStats, result: ToolCallResultPersisted): void {
  stats.toolCallCount += 1
  if (result.notExecuted) {
    stats.toolSkippedCount += 1
  } else if (!result.success) {
    stats.toolErrorCount += 1
  }
}

/**
 * P1-D（D4）：确认拒绝 → notExecutedReason 的显式归类表。
 * agent-deny（安全审批机审拒绝）不再误标为 user_rejected——那会污染 token 统计、
 * UI 文案与错误归因；errorCode（远程只读/授权撤销）优先级最高，维持既有归类；
 * 通道终态按取消、撤销、超时、不可用分别归类；策略规则拒绝才归入 policy_denied。
 */
export function notExecutedReasonForConfirmation(input: {
  cause?: ConfirmOutcomeCause
  errorCode?: string
}): ToolCallResultPersisted['notExecutedReason'] {
  if (input.errorCode === 'REMOTE_READ_ONLY') return 'remote_read_only'
  if (input.errorCode === 'AUTHORIZATION_REVOKED') return 'authorization_revoked'
  switch (input.cause) {
    case 'agent-deny':
      return 'agent_denied'
    case 'agent-undetermined':
      return 'agent_undetermined'
    case 'timeout':
      return 'confirm_timeout'
    case 'unavailable':
      return 'confirm_unavailable'
    case 'cancelled':
      return 'confirm_cancelled'
    case 'recursion-blocked':
    case 'unparsable':
    case 'config-error':
    case 'no-answerer':
    case 'gate-materials-missing':
    case 'rules-violated':
      return 'policy_denied'
    default:
      // user-denied / 未走通道的既有拒绝路径：保底 user_rejected，迁移期行为不回归
      return 'user_rejected'
  }
}

/**
 * P2-F F3：无人档位下高风险操作的机审拒绝是安全设计的必然结果（§5.7），
 * 但拒绝必须可解释、可操作——理由要包含「如何获批」的可操作指引。
 * 只补可操作性，不改变安全策略、不预设放行结论。
 */
export function agentDenyHowToApproveGuidance(): string {
  return (
    '本次为安全审批的机审拒绝（当前执行档位下高风险且授权不足会必然拒绝，属预期安全策略）。' +
    '若确认该操作必要且安全，可用的获批途径：让用户在交互式会话中对确认卡片手动批准；' +
    '将命令加入信任列表（低风险简单命令可被信任放行）；' +
    '或把操作拆分为低风险只读步骤逐步完成。'
  )
}

/** confirm-requested 事件的风险级：取裁决结果与 medium 的较大值（评审 S7）。 */
export function confirmRequestedRiskLevel(gate: { decision: { type: string; riskLevel?: 'low' | 'medium' | 'high' } }): 'low' | 'medium' | 'high' {
  const order = { low: 0, medium: 1, high: 2 } as const
  const decided = gate.decision.type === 'require-confirm' ? gate.decision.riskLevel ?? 'medium' : 'medium'
  return order[decided] >= order.medium ? decided : 'medium'
}

/**
 * P1 适配层展开（基线 §6.2 → 既有内部字段名）：把 Invocation 契约 + 宿主端口展开为
 * 循环体既有的取用形状（旧变量名逐个对应），循环体不动（计划 §4 P1）。
 * electron 专属类型（消息块 / RemoteContext / WorkDirManager / AppDatabase / ContextMeter）
 * 的收窄集中在此，不进循环体。
 */
function expandInvocation(invocation: AgentInvocation, ports: AgentHostPorts): RunToolChatSessionArgs {
  const additional = invocation.additionalContext
  return {
    requestId: invocation.trace.requestId,
    deadlineAt: invocation.limits.deadlineAt,
    toolExecutionConcurrency: ports.toolExecutionConcurrency,
    resourceLocks: ports.resourceLocks,
    applicationAdmission: ports.applicationAdmission,
    invocationRuntime: ports.invocationRuntime,
    approvalAdmission: ports.approvalAdmission,
    toolRevocations: ports.toolRevocations,
    executionAdmission: ports.executionAdmission as ExecutionAdmissionCoordinator | undefined,
    safetyPermits: ports.safetyPermits as SafetyPermitStore | undefined,
    history: ports.history,
    sessionId: invocation.session.sessionId,
    turnId: invocation.trace.turnId,
    windowId: invocation.trace.windowId,
    llmServiceId: invocation.profile.llmServiceId,
    model: invocation.profile.model,
    providerRouteId: invocation.profile.providerRouteId,
    contextWindow: invocation.profile.contextWindow,
    contextWindowTrusted: invocation.profile.contextWindowTrusted,
    baseUrl: ports.credentials.networkTarget?.baseUrl as string | undefined,
    reasoningEffort: invocation.profile.reasoning?.effort ?? 'off',
    messages: invocation.messages.list as unknown as ClaudeContentBlockMessage[],
    system: invocation.profile.system,
    options: invocation.profile.options,
    toolsConfig: invocation.profile.tools.toolsConfig,
    browserConfig: invocation.profile.tools.browserConfig,
    shellConfig: invocation.profile.tools.shellConfig,
    wikiConfig: invocation.profile.tools.wikiConfig,
    feishuConfig: invocation.profile.tools.feishuConfig,
    wechatConfig: invocation.profile.tools.wechatConfig,
    larkCliRunner: invocation.profile.tools.larkCliRunner as LarkCliRunner | undefined,
    lane: invocation.profile.lane,
    internalConfirmExemption: invocation.safety.recursionGuard,
    maxToolLoopRounds: invocation.limits.maxToolRounds,
    approvalTaskDigest: additional[AGENT_ADDITIONAL_CONTEXT_KEYS.approvalTaskDigest] as string | undefined,
    remoteContext: invocation.driverContext as RemoteContext | undefined,
    workDir: ports.workspace.workDir,
    workDirManager: ports.workspace.workDirManager as WorkDirManager | undefined,
    resolveWorkDir: ports.workspace.resolveWorkDir,
    userDataDir: ports.workspace.userDataDir,
    getApiKey: () => ports.credentials.resolveApiKey(),
    locale: invocation.profile.locale as AppLocale | undefined,
    projectMemoryEnabled: invocation.profile.projectMemoryEnabled,
    skillFragments: invocation.profile.skillFragments,
    currentUserMessageId: invocation.messages.currentUserMessageId,
    historyFacts: additional[AGENT_ADDITIONAL_CONTEXT_KEYS.historyFacts] as readonly HistoryFact[] | undefined,
    assistantMessageId: invocation.messages.assistantMessageId,
    hasImageAttachments: invocation.messages.hasImageAttachments,
    getBrowserDetectContext: ports.hostFacts?.getBrowserDetectContext,
    emitFactEvent: (event) => invocation.events.onFact(event),
    emitSessionEvent: (event) => invocation.events.onSessionEvent(event),
    onFileTreeChanged: invocation.events.onFileTreeChanged,
    onTitleGenerated: invocation.events.onTitleGenerated,
    contextMeter: ports.contextMeter as ContextMeter | undefined,
    events: invocation.events,
    gatePolicy: ports.policy as RunToolChatSessionArgs['gatePolicy'],
    hostDiagnostics: ports.diagnostics as RunToolChatSessionArgs['hostDiagnostics'],
    hostUsage: ports.usage,
    hostStorage: {
      sessionMeta: ports.storage?.loaded?.metadata as Record<string, unknown> | undefined,
      sessionEventLocation: ports.storage?.sessionEventLocation,
      readSession: ports.storage?.readSession as RunToolChatSessionArgs['hostStorage'] extends { readSession?: infer F } ? F : never,
      persist: ports.storage?.persist as RunToolChatSessionArgs['hostStorage'] extends { persist?: infer P } ? P : never
    },
    hostExposureRules: ports.exposure?.rules,
    hostMcp: ports.mcp as RunToolChatSessionArgs['hostMcp'],
    hostAnswerer: ports.answerer as RunToolChatSessionArgs['hostAnswerer'],
    toolsTrim: invocation.profile.tools.trim
  }
}

export async function runToolChatSession(invocation: AgentInvocation, ports: RunToolChatSessionPorts, options: Pick<RunToolChatSessionArgs, 'onHostedTurnHandoff'> = {}): Promise<AgentInvocationResult> {
  const args = { ...expandInvocation(invocation, ports), ...options, hostHistory: ports.hostHistory }
  const executionId = args.turnId ?? args.requestId
  const historyWriter = args.history ? new InvocationHistoryWriter(args.history as never, { invocationId: executionId, turnId: executionId }) : undefined
  const appendHistoryEvents = async (events: readonly Readonly<{ kind: HistoryEvent['kind']; payload: unknown }>[]): Promise<void> => {
    if (!historyWriter) return
    await historyWriter.append(events)
  }
  if (historyWriter && args.history) args.hostHistory = createHostedInvocationHistory(historyWriter, args.history)
  const invocationLeaseState = ports.invocationRuntime
    ? { current: ports.invocationRuntime.acquireLease(executionId) }
    : undefined
  const chatSignal = registerChatCancel(executionId)
  // sessionId→活跃流反向登记：供 action.session.status/list 判定会话运行中（需求 §9.4，
  // 与下方 finally 的 clearSessionActiveStream 成对、按 requestId 粒度删除，重入安全）
  registerSessionActiveStream(args.sessionId, args.requestId)
  const requestLane = args.lane
    ?? (args.remoteContext
      ? args.remoteContext.source === 'feishu'
        ? 'feishu'
        : 'wechat'
      : 'desktop')
  registerToolRevocationRequest(args.requestId, requestLane, executionId)
  let mcpConnectionManager: McpConnectionManager | undefined
  const getMcpConnectionManager = (): McpConnectionManager => {
    if (!mcpConnectionManager) {
      mcpConnectionManager = new McpConnectionManager({
        appendDiagnostic: (serverId, entry) => args.hostDiagnostics?.append(serverId, entry as never)
      })
    }
    return mcpConnectionManager
  }
  // 用量统计收口（C16）：计数对象随本回合创建，inner 内就近累计，这里在返回前一次落库。
  // 三条链路（桌面 / 远程 / butler）共用本函数，Turn 数与工具计数对全部渠道生效。
  const turnUsageStats: TurnUsageStats = { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 }
  let turnOutcome: UsageTurnOutcome = 'failed'
  const appendTerminalHistory = async (kind: 'invocation-interrupted' | 'invocation-failed' | 'invocation-completed'): Promise<void> => {
    if (!historyWriter) return
    const status = kind === 'invocation-interrupted' ? 'interrupted' : kind === 'invocation-completed' ? 'completed' : 'failed'
    await appendHistoryEvents([{ kind, payload: { status } }])
  }
  try {
    if (historyWriter) {
      const existingHistory = await args.history!.read(args.requestId)
      const terminal = existingHistory.events.at(-1)
      if (terminal && ['invocation-interrupted', 'invocation-failed', 'invocation-completed'].includes(terminal.kind)) {
        throw new InvocationHistoryAlreadyTerminalError()
      }
    }
    if (!args.onHostedTurnHandoff) {
      throw new HostedTurnHandoffError(new Error('HOSTED_HANDOFF_REQUIRED'))
    }
    const result = await runToolChatSessionInner({ ...args, appendHistoryEvents, invocationLeaseState, chatSignal, getMcpConnectionManager, turnUsageStats })
    const finalization = await finalizeInvocationResult({
      result,
      counts: turnUsageStats,
      appendLegacyTerminal: () => appendTerminalHistory(result.ok ? 'invocation-completed' : result.cancelled ? 'invocation-interrupted' : 'invocation-failed'),
      onSummaryError: (error) => logAgentEvent('warn', 'tool.error', { requestId: args.requestId, toolName: 'hosted-turn-summary', message: error instanceof Error ? error.message : String(error) })
    })
    turnOutcome = finalization.outcome
    return result
  } catch (e) {
    if (e instanceof InvocationHistoryAlreadyTerminalError) throw e
    if (e instanceof HostedTurnFinalizedError) {
      turnOutcome = e.outcome
      if (e.outcome === 'cancelled') return { ok: false, error: e.message, cancelled: true }
      throw e
    }
    if (e instanceof ToolLoopRoundLimitError) {
      turnOutcome = 'failed'
      return { ok: false, error: e.message }
    }
    if (e instanceof HostedTurnHandoffError) {
      turnOutcome = 'failed'
      await appendTerminalHistory('invocation-failed')
      throw e.cause
    }
    if (e instanceof ChatCancelledError) {
      turnOutcome = 'cancelled'
      await appendTerminalHistory('invocation-interrupted')
      return { ok: false, error: e.message, cancelled: true }
    }
    if (e instanceof CanonicalCompactionCommitUncertainError) {
      turnOutcome = 'failed'
      if (historyWriter) {
        await historyWriter.append([{ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'compaction-cross-store-commit-uncertain', compactionId: e.compactionId } }])
      }
      throw e
    }
    turnOutcome = 'failed'
    await appendTerminalHistory('invocation-failed')
    throw e
  } finally {
    invocationLeaseState?.current?.release()
    // 中2（评审复验）：internal/hidden 会话（审批 Agent / automation）的用量不进统计
    const summaryInput = {
      turnId: args.turnId ?? args.requestId,
      sessionId: args.sessionId,
      outcome: turnOutcome,
      counts: turnUsageStats,
      model: args.model,
      llmServiceId: args.llmServiceId
    }
    args.hostUsage?.recordTurnSummary?.(summaryInput)
    if (chatSignal.aborted) {
      invocation.events.notify?.({ kind: 'request-all-cancelled', requestId: args.requestId })
    }
    clearChatCancel(executionId)
    clearSessionActiveStream(args.sessionId, args.requestId)
    clearToolRevocationRequest(args.requestId, executionId)
    clearRequest(args.sessionId, args.requestId)
    await mcpConnectionManager?.shutdown().catch(() => undefined)
  }
}

async function runToolChatSessionInner(
  args: RunToolChatSessionArgs & { chatSignal: AbortSignal; getMcpConnectionManager: () => McpConnectionManager; turnUsageStats: TurnUsageStats; hostHistory?: import('../packages/agent-sdk/src/history').HistoryPort }
): Promise<RunToolChatSessionResult> {
  const {
    requestId,
    toolExecutionConcurrency,
    sessionId,
    model,
    baseUrl,
    messages: initialMessages,
    system,
    options,
    toolsConfig,
    browserConfig,
    shellConfig,
    wikiConfig,
    feishuConfig,
    wechatConfig,
    larkCliRunner,
    remoteContext,
    workDir: initialWorkDir,
    workDirManager,
    resolveWorkDir,
    userDataDir,
    getApiKey,
    hostDiagnostics,
    hostUsage,
    hostStorage,
    hostExposureRules,
    hostMcp,
    hostAnswerer,
    toolsTrim,
    reasoningEffort,
    locale: payloadLocale,
    projectMemoryEnabled,
    chatSignal,
    applicationAdmission,
    resourceLocks,
    invocationRuntime,
    invocationLeaseState,
    getBrowserDetectContext,
    getMcpConnectionManager,
    events: invocationEvents,
    hasImageAttachments,
    turnUsageStats
  } = args
  // 台账事件与统计写入共用 Turn ID；requestId 仅供未迁移的旧调用兼容。
  const eventTurnId = args.turnId ?? args.requestId
  const contextWindowId = args.windowId ?? requestId
  const apiKey = await getApiKey()
  if (!apiKey) {
    logAgentEvent('error', 'llm.error', {
      requestId,
      sessionId,
      model,
      error: 'API key not configured'
    })
    return { ok: false, error: 'API key not configured' }
  }

  const sessionMeta = hostStorage?.sessionMeta
  const remoteBudgetState: RemoteTaskBudgetState | null = remoteContext
    ? createRemoteTaskBudgetState(
        requestId,
        (remoteContext.source === 'feishu'
          ? feishuConfig?.remoteTaskBudget
          : wechatConfig?.remoteTaskBudget) ?? DEFAULT_REMOTE_TASK_BUDGET
      )
    : null
  if (remoteContext) {
    getRemoteTaskController().ensureTask(requestId, {
      sessionId,
      maxConcurrent:
        (remoteContext.source === 'feishu'
          ? feishuConfig?.remoteTaskBudget?.maxConcurrentExecutions
          : wechatConfig?.remoteTaskBudget?.maxConcurrentExecutions) ??
        DEFAULT_REMOTE_TASK_BUDGET.maxConcurrentExecutions
    })
  }
  const shellOutputMode = resolveEffectiveShellOutputMode(shellConfig, sessionMeta, remoteContext?.source)
  const toolLoopOptions = resolveToolLoopModelOptions(options ?? {})
  const maxTokensEffective = effectiveMaxTokensForBuiltinToolLoop(options?.maxTokens)
  // Thinking 由 effort 档位映射（§7.3）：off → disabled、其余档 adaptive + output_config.effort 同发。
  // 上游拒绝 output_config 时的去强度降级与进程内记忆见 effortFallback（§7.4）。
  const { thinking, outputConfig: requestedOutputConfig } = buildThinkingWireParams(reasoningEffort ?? 'off')
  const maxConsecutiveToolErrors = 3
  const maxConsecutiveSafetyRejects = 5
  let lastRepeatedResultKey: string | undefined
  let repeatedResultCount = 0
  const noteRepeatedResult = (bucket: 'execution' | 'safety', toolName: string, message: string, identity?: string) => {
    const key = `${bucket}\0${toolName}\0${message}\0${identity ?? ''}`
    repeatedResultCount = key === lastRepeatedResultKey ? repeatedResultCount + 1 : 1
    lastRepeatedResultKey = key
    return repeatedResultCount
  }
  const afterToolResult: NonNullable<import('../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']> = async (call, result, source) => {
    const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
      ? result.output as Record<string, unknown>
      : undefined
    const errorText = typeof output?.error === 'string'
      ? output.error
      : typeof result.output === 'string' ? result.output : '执行失败'
    const processData = output?.data && typeof output.data === 'object' && !Array.isArray(output.data)
      ? output.data as Record<string, unknown>
      : undefined
    // FR8/§6.4：tool_search 成功后并入命中名（surfacedNames）；延迟工具未浮现直调 → deferredUnsurfaced 观测
    if (call.toolName === 'tool_search' && !(result.isError ?? output?.success === false)) {
      const matches = output?.data && typeof output.data === 'object' && !Array.isArray(output.data)
        ? (output.data as { matches?: Array<{ name?: unknown }> }).matches
        : undefined
      for (const match of Array.isArray(matches) ? matches : []) {
        if (match && typeof match.name === 'string') surfacedNames.add(match.name)
      }
    }
    if (deferredUnsurfacedCheck(call.toolName) && !(result.isError ?? output?.success === false)) {
      surfacedNames.add(call.toolName)
      logAgentEvent('info', 'tool.deferred_unsurfaced', {
        requestId: args.requestId,
        sessionId: args.sessionId,
        toolUseId: call.toolCallId,
        toolName: call.toolName
      })
    }
    if (isProcessToolName(call.toolName)) {
      let serialized = 'null'
      try {
        serialized = JSON.stringify(output?.data ?? null)
      } catch {
        serialized = '[unserializable]'
      }
      logAgentEvent(result.isError ?? output?.success === false ? 'warn' : 'info', 'tool.result', {
        requestId: args.requestId,
        sessionId: args.sessionId,
        toolUseId: call.toolCallId,
        toolName: call.toolName,
        success: !(result.isError ?? output?.success === false),
        ...projectProcessResultForAgentLog(output?.data, {
          fingerprint: (value) => createHash('sha256').update(value).digest('hex')
        }),
        dataBytes: output?.data == null ? 0 : Buffer.byteLength(serialized, 'utf8'),
        dataSha256: createHash('sha256').update(serialized).digest('hex'),
        outputTruncated: Boolean(processData?.truncated),
        outputRedacted: Boolean(processData && ('stdoutRedaction' in processData || 'stderrRedaction' in processData))
      })
    }
    if (source?.kind === 'safety-rejection') {
      if (noteRepeatedResult('safety', call.toolName, errorText) >= maxConsecutiveSafetyRejects) {
        throw new ToolLoopRoundLimitError(args.maxToolLoopRounds ?? maxConsecutiveSafetyRejects,
          `安全拒绝已连续出现 ${maxConsecutiveSafetyRejects} 次，已停止：${errorText}`)
      }
      return
    }
    if (result.isError ?? output?.success === false) {
      const data = output?.data
      const processData = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined
      const retryIdentity = call.toolName === 'run_shell' && processData
        ? buildCommandRetryKey({
          toolName: call.toolName,
          errorCode: errorText,
          status: typeof processData.status === 'string' ? processData.status : undefined,
          exitCode: typeof processData.exitCode === 'number' || processData.exitCode === null ? processData.exitCode : undefined,
          signal: typeof processData.signal === 'string' ? processData.signal : undefined,
          shellProfile: typeof processData.shell === 'string' ? processData.shell : undefined,
          planDigest: typeof processData.planDigest === 'string' ? processData.planDigest : undefined
        })
        : undefined
      const repeated = noteRepeatedResult('execution', call.toolName, errorText, retryIdentity) >= maxConsecutiveToolErrors
      if (shouldStopToolRetry(call.toolName, errorText, data, repeated)) {
        throw new ToolLoopRoundLimitError(args.maxToolLoopRounds ?? maxConsecutiveToolErrors,
          `同一工具错误已连续出现 ${maxConsecutiveToolErrors} 次，已停止：${errorText}`)
      }
      return
    }
    if (lastRepeatedResultKey?.includes(`\0${call.toolName}\0`)) {
      lastRepeatedResultKey = undefined
      repeatedResultCount = 0
    }
  }
  let effortOutputConfig = requestedOutputConfig
  let effortRetryUsed = false
  const thinkingAvailability = resolveThinkingAvailability(model, {
    effortUnsupportedByMemo: isEffortUnsupportedByUpstream(args.llmServiceId, model)
  })
  const baselineBlocksEffort = Boolean(effortOutputConfig && thinkingAvailability.source === 'baseline' && thinkingAvailability.unsupported.includes(reasoningEffort ?? 'off'))
  // 进程记忆仍优先；基线只有显式 null 时才跳过可选 output_config，键缺失保持原行为。
  if (effortOutputConfig && thinkingAvailability.source === 'memo') {
    effortOutputConfig = undefined
    if (consumeEffortMemoizedAudit(args.llmServiceId, model)) {
      logAgentEvent('info', 'llm.effort.unsupported_memoized', {
        requestId,
        sessionId,
        model,
        llmServiceId: args.llmServiceId,
        requestedEffort: reasoningEffort,
        reason: 'memo',
        fallback: 'adaptive'
      })
    }
  } else if (baselineBlocksEffort) {
    effortOutputConfig = undefined
    if (consumeBaselineEffortAudit(args.llmServiceId, model)) {
      logAgentEvent('info', 'llm.effort.unsupported', {
        requestId,
        sessionId,
        model,
        llmServiceId: args.llmServiceId,
        requestedEffort: reasoningEffort,
        reason: 'baseline_unsupported',
        fallback: 'adaptive'
      })
    }
  }

  if (maxTokensEffective !== toolLoopOptions.maxTokens) {
    logAgentEvent('info', 'llm.max_tokens_floor', {
      requestId,
      sessionId,
      configuredMaxTokens: toolLoopOptions.maxTokens,
      effectiveMaxTokens: maxTokensEffective,
      floor: TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN
    })
  }

  let messagesForApi: Anthropic.MessageParam[] = initialMessages.map((m) => ({
    ...(('id' in m && typeof m.id === 'string') ? { id: m.id } : {}),
    role: m.role,
    content: m.content as Anthropic.MessageParam['content']
  })) as Anthropic.MessageParam[]
  if (args.skillFragments?.length) {
    const fragmentMessage: Anthropic.MessageParam = { role: 'user', content: args.skillFragments.join('\n\n') }
    // fragment 必须固定注入在第一条 user 消息之前：它不落 DB，次轮 round:1 的重建历史不含
    // 上一 turn 的 fragment——若随「最后一条 user」移动，重建前缀从 item 0 整段错位，造成
    // turn 边界缓存全量失效（agent-context-token-cost-optimization §3.4.5 候选 A 静态比对结论）。
    const firstUserIndex = messagesForApi.map((message) => message.role).indexOf('user')
    messagesForApi.splice(firstUserIndex >= 0 ? firstUserIndex : messagesForApi.length, 0, fragmentMessage)
  }
  const invocationBaseMessages = structuredClone(messagesForApi)


  /** 口径 B：本次 invoke 传入的上下文中，已有多少条 API `assistant`（不含本轮 while 将追加的） */
  const historicalAssistantApiMessageCount = initialMessages.filter((m) => m.role === 'assistant').length

  const stripThinking = (msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
    // thinking 开启时须保留 assistant 消息中的 thinking/redacted_thinking（含 signature），
    // 否则多轮 tool loop 会触发 Anthropic 400（final assistant 须以 thinking 块开头）。
    if (reasoningEffort !== 'off') return sanitizeThinkingForReplay(msgs, /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl ?? ''))
    return stripThinkingBlocksFromAssistantMessages(msgs)
  }

  // 偏差 21：lane 一次解析、全点消费——exposure / MCP 注入 / 确认通道 / 审计归属全部使用显式值
  const effectiveLane = args.lane
    ?? (remoteContext
      ? remoteContext.source === 'feishu'
        ? ('feishu' as const)
        : ('wechat' as const)
      : ('desktop' as const))
  // 套餐/规则覆盖同样作用于 exposure 评估（§4 第 1 区）——P2 起装配期解析（ports.exposure）
  const exposureRules = hostExposureRules as import('../src/shared/confirmation/types').PolicyRule[] | undefined
  /** 请求级 MCP 工具快照：仅桌面 lane 注入（装配期构建，仍为首循环前）。 */
  const mcpSnapshot: McpToolSnapshot = hostMcp?.snapshot ?? { entries: new Map(), budgetDropped: [] }
  // FR5/§6.5：延迟加载计划（off 档 = 现状路径；档位/阈值取自 ToolsConfig，缺省 off/16 KiB）
  const deferredMode = toolsConfig.mcpDeferredLoading ?? 'off'
  const deferredThresholdBytes = toolsConfig.mcpDeferredSchemaBudgetBytes ?? MCP_DEFERRED_SCHEMA_BUDGET_BYTES_DEFAULT
  const mcpProfiles = hostMcp?.executorDatabase
    ? listProfiles(hostMcp.executorDatabase as Parameters<typeof listProfiles>[0])
    : []
  const deferredPlan = computeDeferredPlan({
    mcpSnapshot,
    profiles: mcpProfiles,
    mode: deferredMode,
    thresholdBytes: deferredThresholdBytes
  })
  const effectiveTools = computeEffectiveTools({
    builtinConfig: toolsConfig,
    feishuConfig,
    browserConfig,
    shellConfig,
    wechatConfig,
    remoteContext,
    exposureRules,
    mcpSnapshot,
    trim: toolsTrim,
    deferredPlan
  })
  const { tools, toolNames, authorizedToolNames, compatToInternal, deferredToolNames } = effectiveTools
  if (effectiveTools.deferredDegradedToEager && deferredPlan.mode === 'deferred') {
    // O4（边界 11）：tool_search 被裁出广告面，延迟计划整体失效回退 eager（agentLogger warn，不进 wire 面与会话事件流）
    logAgentEvent('warn', 'mcp.deferredDegradedToEager', {
      requestId,
      sessionId,
      lane: effectiveLane,
      deferredNames: [...deferredPlan.deferredNames]
    })
  }
  // FR8/D2 观测：本 invoke 内 tool_search 成功下发的延迟工具名；延迟工具执行时不在集合内 → deferredUnsurfaced
  const surfacedNames = new Set<string>()
  const deferredUnsurfacedCheck = (toolName: string): boolean =>
    deferredToolNames.has(toolName) && !surfacedNames.has(toolName)
  if (toolNames.includes('browser')) {
    stagehandService.resetInferenceCount(sessionId)
  }
  const appendCanonicalHistory = async (events: Array<{ kind: HistoryEvent['kind']; payload: unknown }>): Promise<void> => {
    if (events.length === 0) return
    await args.appendHistoryEvents?.(events)
  }
  const appendReplayUserMessage = async (content: string): Promise<void> => {
    const [message] = toCanonicalModelMessages([{ role: 'user', content }])
    if (!message) throw new Error('recovery prompt could not be represented in canonical history')
    await appendCanonicalHistory([{ kind: 'replay-message-committed', payload: { message } }])
  }
  const loopRound = 1

  throwIfChatCancelled(chatSignal)
  if (args.history) {
    const historySnapshot = await args.history.read(requestId)
    const historyOwnsBase = historySnapshot.events.some(({ kind }) => kind === 'invocation-context-committed' || kind === 'transcript-compacted')
    if (historyOwnsBase || historySnapshot.events.some(({ kind }) => kind === 'model-response-committed')) {
      const replayMessages = rebuildClaudeMessagesFromHistory(historySnapshot.events)
      messagesForApi = historyOwnsBase
        ? replayMessages as Anthropic.MessageParam[]
        : [...structuredClone(invocationBaseMessages), ...replayMessages] as Anthropic.MessageParam[]
    }
  }
  const memoryContent = getCachedMemoryContent()
  const baseSystemWithRecovery = typeof system === 'string' && system.trim().length > 0 ? system : undefined
  const mcpDeferredCount = deferredToolNames.size
  const capabilityHint = buildToolCapabilityConventionHint(toolNames, { mcpDeferredCount })
  const systemWithTools = baseSystemWithRecovery ? `${baseSystemWithRecovery}\n\n${capabilityHint}` : capabilityHint
  // P2：locale 装配期定值（请求优先 / 库回退在装配器完成），循环内不再查库
  const locale = payloadLocale as AppLocale
  // FR1/§6.2：延迟生效时构建「MCP 工具索引」区块（无延迟工具时为 null，不产生空区块）
  const mcpCatalog = deferredToolNames.size > 0
    ? buildMcpToolCatalogSection(
        deferredPlan.mode === 'deferred' ? deferredPlan.deferredEntries : [],
        args.contextWindow ?? 200_000
      )
    : null
  const systemPrompt = buildFinalSystemPrompt({
    system: systemWithTools,
    memoryContent,
    memoryEnabled: projectMemoryEnabled ?? true,
    locale,
    hasImageAttachments: hasImageAttachments ?? false,
    skillCatalog: getCachedSkills(userDataDir, resolveWorkDir?.() ?? initialWorkDir),
    contextWindow: args.contextWindow,
    ...(mcpCatalog ? { mcpCatalog } : {})
  })
  // requestId 按一次 provider 请求尝试定义；同一轮的 header/context/usage 必须共享它。
  const messagesStripped = stripThinking(messagesForApi)
    .filter((message) => message.role !== 'assistant' || typeof message.content === 'string' || message.content.length > 0)
  if (args.history) {
    const historySnapshot = await args.history.read(requestId)
    const historyOwnsBase = historySnapshot.events.some(({ kind }) => kind === 'invocation-context-committed' || kind === 'transcript-compacted')
    if (!historyOwnsBase) {
      const canonicalInputMessages = toCanonicalModelMessages(messagesStripped as unknown as import('../src/shared/api').ClaudeChatMessageWithBlocks[])
      const requiredUserMessage = args.currentUserMessageId
        ? messagesStripped.find((message) => (message as Anthropic.MessageParam & { id?: string }).id === args.currentUserMessageId)
        : undefined
      const canonicalRequiredUserMessage = requiredUserMessage
        ? canonicalHostedRequiredUserMessage(requiredUserMessage as unknown as ClaudeContentBlockMessage)
        : undefined
      await appendCanonicalHistory([{
        kind: 'invocation-context-committed',
        payload: {
          messages: canonicalInputMessages,
          ...(requiredUserMessage && canonicalRequiredUserMessage
            ? { requiredUserMessage: { id: args.currentUserMessageId, message: canonicalRequiredUserMessage } }
            : {})
        }
      }])
    }
  }
  logAgentEvent('info', 'llm.request', {
    requestId,
    turnId: eventTurnId,
    sessionId,
    lane: effectiveLane,
    loopRound,
    model,
    baseUrl,
    locale,
    ...(!args.onHostedTurnHandoff ? { system: systemPrompt, messages: messagesStripped } : {}),
    toolNames,
    maxTokens: maxTokensEffective,
    effort: reasoningEffort,
    // 评审 N2：降级 / 记忆跳过后 wire 已无 output_config，标注实际生效状态便于排障
    ...(requestedOutputConfig !== undefined && effortOutputConfig === undefined ? { effortSuppressed: true } : {})
  })
  beginLlm(sessionId, requestId)

  const retractAttemptPreview = () => undefined

  try {
    if (args.onHostedTurnHandoff) {
      const canonicalRequest = createHostedModelRequest({
        system: systemPrompt,
        messages: messagesStripped as unknown as ClaudeContentBlockMessage[],
        tools: tools as unknown as Array<{ name: string; description: string; input_schema: Record<string, unknown>; strict?: boolean }>,
        maxTokens: maxTokensEffective,
        thinking,
        ...(effortOutputConfig ? { effort: effortOutputConfig.effort as 'low' | 'medium' | 'high' | 'max' } : {}),
        ...(apiKey ? { apiKey } : {}),
        signal: chatSignal
      })
      const requiredUserMessage = args.currentUserMessageId
        ? bindHostedRequiredUserMessage({ id: args.currentUserMessageId, originalMessages: messagesStripped as unknown as ClaudeContentBlockMessage[], requestMessages: canonicalRequest.messages })
        : undefined
      if (args.currentUserMessageId && !requiredUserMessage) {
        throw new HostedTurnHandoffError(new Error('HOSTED_REQUIRED_USER_NOT_IN_REQUEST'))
      }
      if (!args.currentUserMessageId || requiredUserMessage) {
        try {
          const handoff = await args.onHostedTurnHandoff({
            request: canonicalRequest,
            authorizedToolNames,
            resolveRegisteredToolName: (providerToolName) => compatToInternal.get(providerToolName) ?? providerToolName,
            afterToolResult,
            // FR3/A 方案：延迟名随依赖传入，capabilities.define 并入 known + authorized（门禁簿记，零上下文成本）
            deferredToolNames,
            deferredUnsurfacedCheck,
            windowId: contextWindowId,
            ...(args.maxToolLoopRounds !== undefined ? { maxToolRounds: args.maxToolLoopRounds } : {}),
            ...(args.hostHistory ? { hostHistory: args.hostHistory } : {}),
            ...(args.applicationAdmission ? { applicationAdmission: args.applicationAdmission } : {}),
            ...(args.deadlineAt !== undefined ? { deadlineAt: args.deadlineAt } : {}),
            ...(args.currentUserMessageId ? { currentUserMessageId: args.currentUserMessageId } : {}),
            ...(requiredUserMessage ? { requiredUserMessage } : {})
          })
          if (!handoff) throw new Error('HOSTED_TURN_HANDOFF_MISSING_RESULT')
          return markHostedTurnFinalization(handoff.result, handoff.finalization)
        } catch (error) {
          if (error instanceof HostedTurnFinalizedError || error instanceof ToolLoopRoundLimitError) throw error
          throw new HostedTurnHandoffError(error)
        }
      }
    }
    throw new HostedTurnHandoffError(new Error('HOSTED_HANDOFF_REQUIRED'))
  } catch (error) {
    retractAttemptPreview()
    if (error instanceof ChatCancelledError || error instanceof HostedTurnFinalizedError || error instanceof HostedTurnHandoffError || error instanceof ToolLoopRoundLimitError) throw error
    throw new HostedTurnHandoffError(error)
  } finally {
    endLlm(sessionId, requestId)
  }
}
