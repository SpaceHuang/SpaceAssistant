import Anthropic from '@anthropic-ai/sdk'
import { toolIdToOpenAiCompatibleApiToolName } from '../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../src/shared/toolNameCompatibility'
import { projectUsageAfterToolResults } from '../src/shared/contextUsageEstimate'
import { normalizeAnthropicMessageUsage } from './anthropicUsageNormalize'
import { createAnthropicClient } from './anthropicClientFactory'
import { buildClaudeToolLoopStreamParams } from './claudeToolLoopStreamParams'
import { normalizeStopReason, type NormalizedStopReason } from './stopReason'
import { resolveToolLoopModelOptions } from './toolLoopModelOptions'
import { sanitizeAnthropicToolsPayloadForStrictGateways } from './anthropicToolPayload'
import type { WorkDirManager } from './workDirManager'
import { FileStateCache } from './fileStateCache'
import { getRegisteredTool, getToolExecutor } from './tools/builtinExecutors'
import { executeRegisteredTool } from './tools/toolInvocationCoordinator'
import { coordinatorConfirmHook } from './tools/coordinatorConfirmationAdapter'
import { executePreparedShellExecution } from './tools/runShellExecutor'
import { planRunShellExecution, RunShellPlanError } from './tools/runShellPlan'
import type { PreparedShellExecution } from './shell/preparedShellExecution'
import { validateToolExecutorResultForTool, type ToolExecutorResult } from './tools/types'
import { projectAgentToolResult, serializeAgentToolResult } from '../src/shared/agentToolResult'
import { projectProcessResultForAgentLog } from '../src/shared/agentSafeProjection'
import { isProcessToolName } from '../src/shared/processResultProjection'
import { buildCommandRetryKey, shouldStopToolRetry } from './toolErrorRetryPolicy'
import { McpConnectionManager } from './mcp/mcpConnectionManager'
import { getDiagnostics, safeAppendDiagnostic } from './mcp/mcpDiagnostics'
import { createMcpToolExecutor } from './mcp/mcpToolExecutor'
import {
  buildSnapshotFromDb,
  type McpToolSnapshot
} from './mcp/mcpToolRegistry'
import { getSecret } from './mcp/mcpSecretStore'
import { createMcpOAuthClientProvider } from './mcp/mcpOauthService'
import { createHash } from 'crypto'
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
import { activateRecoverySkillInState } from '../src/shared/browserDependencyRecovery'
import { buildToolCapabilityConventionHint } from '../src/shared/skillPrompt'
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
import {
  formatDependencyRecoveryToolContent,
  resolveDependencyRecoverySkill
} from './browser/browserDependencyRecovery'
import type { HistoryFact } from '../src/shared/historyReader'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import { scheduleSessionTitleSuggestion, reachedCumulativeAssistantTurnsForTitleSuggest } from './sessionTitleSuggest'
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
import type { ExecutionLane } from '../src/shared/confirmation/types'
import { BROWSER_REMOTE_DISABLED_CODE } from '../src/shared/browserRemotePolicy'
import { SHELL_REMOTE_DISABLED_ERROR } from '../src/shared/shellToolDisplay'
import { resolveEffectiveShellOutputMode } from '../src/shared/shellOutputMode'
import { logShellConfirmOutcome, logShellPrecheck } from './shell/shellAgentLogger'
import { getBuiltinSensitivePrefixes } from './shell/shellSensitivePaths'
import { canShowShellTrustOption } from './shell/shellCommandTrust'
import type { SessionEventInput } from './sessionEvents'
import { evaluateToolCallGate, isOutboundWriteTool } from './confirmation/toolCallGate'
import { recordUserAnswerFromDecision, recordSystemManagedCacheEntry } from './confirmation/decisionCacheWriter'
import { getSecurityAuditLog } from './confirmation/audit'
import { channelFor } from './confirmation/channels'
import { resolveLaneAnswererPolicy } from './confirmation/answererConfig'
import { AgentChannel } from './confirmation/agentChannel'
import { loadEffectivePolicyRules } from './confirmation/policyRulesRuntime'
import { getBuiltinToolMetadata } from '../src/shared/builtinToolMetadata'
import { mapLegacyConfirmation, type LegacyConfirmationRejectReason, type LegacyPolicyCode } from './tools/coordinatorConfirmationAdapter'
import type { ConfirmAnswererKind, ConfirmOutcomeCause, ConfirmRequest } from '../src/shared/confirmation/types'
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
import { buildRemoteProgressHookContext } from './remote/buildRemoteProgressContext'
import {
  onRemoteTextSegmentClosed,
  onRemoteThinkingActive,
  onRemoteToolProgress,
  onRemoteToolStateChange
} from './remote/remoteProgressHooks'
import {
  REMOTE_CONFIRM_TIMEOUT_MESSAGES,
  resolveRemoteContextConfirmPolicy
} from './remote/remoteConfirmPolicy'
import {
  beginLlm,
  beginTool,
  clearRequest,
  endLlm,
  endTool
} from './remote/remoteSessionSwitchState'
import { shouldRequestImConfirm } from '../src/shared/remoteConfirmPolicy'
import {
  ChatCancelledError,
  clearChatCancel,
  registerChatCancel,
  throwIfChatCancelled
} from './chatCancelRegistry'
import { getCachedMemoryContent } from './projectMemory'
import { buildFinalSystemPrompt, resolveRequestLocale } from './llmSystemPrompt'
import type { AppLocale } from '../src/shared/locale'
import { stripThinkingBlocksFromAssistantMessages } from '../src/shared/stripThinkingFromApiMessages'
import {
  clearToolCancel,
  registerToolCancel,
  type ToolConfirmOutcome
} from './toolConfirmRegistry'
import fs from 'fs/promises'
import path from 'path'
import { resolveSafePathReal } from './pathSecurity'
import { assertSafeToolInput } from './toolInputGuards'
import { buildProcessToolLogErrorFields, logAgentEvent, logAgentError } from './agentLogger/agentLogger'
import { sanitizeToolErrorString, toToolUserError } from './tools/toolUserErrors'
import { mergeStreamedToolInputsIntoContent, normalizeToolUseInputRecord } from './toolUseInputMerge'
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
import { compactOversizedToolResultContent } from '../src/shared/oversizedToolResult'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/shared/toolResultLimits'
import { computeEffectiveTools, authorizeToolCall } from './effectiveTools'
import { clearToolRevocationRequest, isToolRevoked, registerToolRevocationRequest } from './toolRevocationRegistry'
import { buildRequestContextPayload, buildRequestHeaderPayload } from '../src/shared/requestContext'
import { extractToolPairIds, validateSurfaceForSend } from '../src/shared/surfacePreflight'
import { computeContextPressure, shouldCompact } from '../src/shared/contextMeter'
import type { ContextMeter } from '../src/shared/contextMeterService'
import { planToolLoopCompaction } from '../src/shared/adaptiveCompaction'
import { decideOverflowRecovery, selectRecoveryMessages } from '../src/shared/overflowRecovery'
import { computeReplaySurfaceFingerprint, computeShadowedRanges, excludeReplayOnlyMessages, projectReplaySurface, projectReplaySurfaceWithSources, surfaceItemIdentities, surfaceItemIdentitiesForProjectionSubset, surfaceItemIdentity } from '../src/shared/surfaceReplay'
import { computeCompactionSummaryHash } from '../src/shared/compactionEvents'
import { normalizeAnthropicEvent } from './anthropicStreamDelta'
import { sanitizeThinkingForReplay } from '../src/shared/sanitizeThinkingForReplay'
import {
  MAX_OUTPUT_RECOVERIES,
  buildOutputRecoveryMessage,
  buildTruncatedToolResults,
  classifyOutputRecovery
} from './outputRecovery'

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

function parseToolInput(baseInput: unknown, partialJson: string): unknown {
  const fallback = baseInput ?? {}
  const jsonText = partialJson.trim()
  if (!jsonText) return fallback
  try {
    return JSON.parse(jsonText)
  } catch {
    return fallback
  }
}

function augmentToolInputValidationError(
  baseMessage: string,
  stopReason: NormalizedStopReason | undefined,
  toolName: string,
  inputObj: Record<string, unknown>
): string {
  if (stopReason !== 'max_tokens') return baseMessage
  if (toolName === 'write_file' && typeof inputObj.content !== 'string') {
    return `${baseMessage}（本轮 stop_reason 为 max_tokens：输出在写完 write_file 的完整参数前被截断。工具循环已将 max_tokens 下限抬到至少 ${TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN}；超长报告请在设置中继续提高 max_tokens，或分多次 write_file / edit_file 写入。）`
  }
  if (
    toolName === 'edit_file' &&
    (typeof inputObj.old_string !== 'string' || typeof inputObj.new_string !== 'string')
  ) {
    return `${baseMessage}（本轮 stop_reason 为 max_tokens，可能是 edit_file 参数未生成完毕即被截断。请提高 max_tokens 或缩小单次替换范围。）`
  }
  if (toolName === 'run_script' && typeof inputObj.code !== 'string') {
    return `${baseMessage}（本轮 stop_reason 为 max_tokens，可能是 run_script 的 code 未生成完毕即被截断。请提高 max_tokens 或缩短脚本。）`
  }
  return baseMessage
}

function logToolLoopError(
  fields: Record<string, unknown>,
  err: unknown,
  userMessage?: string
): void {
  const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined
  const user =
    userMessage ??
    (typeof err === 'string'
      ? sanitizeToolErrorString(err, toolName)
      : toToolUserError(err, { toolName }))
  const safeFields = { ...fields }
  if ((toolName === 'run_shell' || toolName === 'run_script') && safeFields.input && typeof safeFields.input === 'object') {
    const input = safeFields.input as Record<string, unknown>
    safeFields.inputFingerprint = createHash('sha256').update(String(input.command ?? input.code ?? '')).digest('hex')
    delete safeFields.input
  }
  if (toolName === 'run_shell' || toolName === 'run_script') {
    logAgentEvent('error', 'tool.error', {
      ...safeFields,
      ...buildProcessToolLogErrorFields(err, user)
    })
    return
  }
  logAgentError('tool.error', safeFields, err, user)
}

function processResultLogData(result: ToolExecutorResult): Record<string, unknown> {
  const data = result.data as Record<string, unknown> | null | undefined
  let serialized = 'null'
  try {
    serialized = JSON.stringify(data ?? null)
  } catch {
    serialized = '[unserializable]'
  }
  return {
    ...projectProcessResultForAgentLog(data, {
      fingerprint: (value) => createHash('sha256').update(value).digest('hex')
    }),
    dataBytes: data ? Buffer.byteLength(serialized, 'utf8') : 0,
    dataSha256: createHash('sha256').update(serialized).digest('hex'),
    outputTruncated: Boolean(data && typeof data === 'object' && 'truncated' in data && data.truncated),
    outputRedacted: Boolean(data && typeof data === 'object' && ('stdoutRedaction' in data || 'stderrRedaction' in data))
  }
}

function formatToolResultPayload(
  r: ToolExecutorResult,
  options: { workspaceRoot?: string; processTool?: boolean } = {}
): string {
  return serializeAgentToolResult(r, options)
}

/** 执行失败桶阈值（既有行为不变）。 */
const MAX_CONSECUTIVE_SAME_TOOL_ERROR = 3
/** P1-3 安全拒绝桶阈值（计划 §12-3 定值 5）：安全拒绝与执行失败分开计数，管家「换方案」能力不被压制。 */
const MAX_CONSECUTIVE_SAFETY_REJECT = 5

type ToolErrorBucket = 'exec' | 'safety'

function compactToolResultContentForApi(
  content: string,
  ctx: { requestId?: string; sessionId?: string; toolUseId: string }
): string {
  const result = compactOversizedToolResultContent(content)
  if (result.compacted) {
    logAgentEvent('warn', 'tool.result.oversized.compacted', {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      originalLength: result.originalLength,
      compactedLength: result.content.length,
      maxChars: MAX_TOOL_RESULT_CONTENT_CHARS
    })
  }
  return result.content
}

function buildToolErrorResult(
  toolUseId: string,
  error: string,
  logCtx?: { requestId: string; sessionId: string },
  result?: ToolExecutorResult,
  options: { workspaceRoot?: string; processTool?: boolean } = {}
): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: compactToolResultContentForApi(result ? formatToolResultPayload(result, options) : serializeAgentToolResult({
      success: false,
      error,
      userMessage: error,
      data: { processResult: null }
    }, options), {
      requestId: logCtx?.requestId,
      sessionId: logCtx?.sessionId,
      toolUseId
    }),
    is_error: true
  }
}

function makeToolErrorRepeatTracker() {
  let lastKey: string | null = null
  let count = 0
  return {
    noteFailure(toolName: string, error: string, identity?: string, bucket: ToolErrorBucket = 'exec'): boolean {
      // P1-3：键内并入来源分桶——安全拒绝（策略 deny / 确认拒绝）与执行失败互不累计
      const key = `${bucket}\0${toolName}\0${error}\0${identity ?? ''}`
      if (key === lastKey) count++
      else {
        lastKey = key
        count = 1
      }
      return count >= (bucket === 'safety' ? MAX_CONSECUTIVE_SAFETY_REJECT : MAX_CONSECUTIVE_SAME_TOOL_ERROR)
    },
    noteSuccess(toolName: string): void {
      if (lastKey?.includes(`\0${toolName}\0`)) {
        lastKey = null
        count = 0
      }
    }
  }
}

async function maybeBuildConfirmDiff(
  workDir: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<{ oldContent: string; newContent: string; oldPath: string } | undefined> {
  const rel = typeof input.path === 'string' ? input.path : ''
  if (!rel || (toolName !== 'edit_file' && toolName !== 'write_file')) return undefined
  try {
    const abs = await resolveSafePathReal(workDir, rel)
    let oldContent = ''
    try {
      oldContent = await fs.readFile(abs, 'utf8')
    } catch {
      oldContent = ''
    }
    let newContent = ''
    if (toolName === 'write_file') {
      newContent = typeof input.content === 'string' ? input.content : ''
    } else {
      const oldS = typeof input.old_string === 'string' ? input.old_string : ''
      const newS = typeof input.new_string === 'string' ? input.new_string : ''
      const replaceAll = Boolean(input.replace_all)
      if (oldS === '' && !oldContent) newContent = newS
      else {
        const occ = oldS === '' ? 0 : oldContent.split(oldS).length - 1
        if (occ === 1 || replaceAll) {
          newContent = replaceAll ? oldContent.split(oldS).join(newS) : oldContent.replace(oldS, newS)
        } else {
          newContent = oldContent
        }
      }
    }
    return { oldContent, newContent, oldPath: rel }
  } catch {
    return undefined
  }
}

export type RunToolChatSessionArgs = {
  requestId: string
  sessionId: string
  /** 本回合真实 Turn ID（C17）：桌面 / 远程 / butler 三个调用方各传现成值；缺省回退 sessionId 占位（桌面包装层仍会覆写台账 payload）。 */
  turnId?: string
  /** 冻结执行配置里的 LLM 服务 ID（DIM3：同模型跨服务分开统计）。 */
  llmServiceId?: string
  windowId?: string
  model: string
  contextWindow?: number
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
  appendCompactionTransaction?: (start: Record<string, unknown>, summary: Record<string, unknown>) => Promise<unknown>
  /** Core 以 session event ledger 提供的唯一上下文测量适配器。 */
  contextMeter?: ContextMeter
  /** 成功完成 provider 请求后，在下一轮发送前执行 turn-boundary 规划。 */
  onTurnBoundary?: (input: { requestId: string; windowId: string; system: string; tools: unknown[]; surfaceSnapshot: ReturnType<typeof buildRequestHeaderPayload>['surfaceSnapshot']; messages: ClaudeContentBlockMessage[]; budget: ReturnType<typeof buildRequestContextPayload>['budget']; contextUsage?: ReturnType<typeof buildRequestContextPayload>['contextUsage']; toolExecutionCheckpoint: ReturnType<typeof buildRequestHeaderPayload>['toolExecutionCheckpoint']; requiredSurfaceSet: string[] }) => Promise<void>
  /** P1：events 出口对象随展开层注入（floatingNotificationManager 已收回为 events.notify，§5.5）。 */
  events?: AgentEventSink
  /** P2（B1）：门控端口材料（装配期解析注入；此处空对象仅类型占位，缺失会触发门控 fail-loud）。 */
  gatePolicy?: {
    effectiveRules: import('../src/shared/confirmation/types').PolicyRule[]
    decisionCache: import('./confirmation/toolCallGate').GateDecisionCache
    shellPrecheck: { touchTrustedCommand: (command: string) => void }
  }
  /** P2 批次 B：宿主端口材料（展开层注入，循环体经端口消费，Core 不持库）。 */
  hostDiagnostics?: { append(serverId: string, entry: never): void }
  hostUsage?: {
    recordStepUsage?(input: Record<string, unknown>): void
    recordTurnSummary?(input: Record<string, unknown>): void
  }
  hostStorage?: {
    sessionMeta?: Record<string, unknown> | undefined
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
    policy: ReturnType<typeof import('./confirmation/answererConfig').resolveLaneAnswererPolicy>
    approvalDatabase?: unknown
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

function failToolLoopWithLastUsage(
  requestId: string,
  sessionId: string,
  error: string,
  lastValidUsage?: ToolLoopUsage,
  emitFactEvent?: (event: AssistantFactEvent) => void
): Extract<RunToolChatSessionResult, { ok: false }> {
  if (lastValidUsage) {
    emitFactEvent?.({ type: 'usage-updated', usage: lastValidUsage })
  }
  return {
    ok: false,
    error,
    ...(lastValidUsage ? { usage: lastValidUsage } : {})
  }
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
    sessionId: invocation.session.sessionId,
    turnId: invocation.trace.turnId,
    windowId: invocation.trace.windowId,
    llmServiceId: invocation.profile.llmServiceId,
    model: invocation.profile.model,
    contextWindow: invocation.profile.contextWindow,
    baseUrl: invocation.profile.baseUrl,
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
    appendCompactionTransaction: ports.storage?.appendCompactionTransaction,
    contextMeter: ports.contextMeter as ContextMeter | undefined,
    onTurnBoundary: ports.turnBoundary as RunToolChatSessionArgs['onTurnBoundary'],
    events: invocation.events,
    gatePolicy: ports.policy as RunToolChatSessionArgs['gatePolicy'],
    hostDiagnostics: ports.diagnostics as RunToolChatSessionArgs['hostDiagnostics'],
    hostUsage: ports.usage,
    hostStorage: {
      sessionMeta: ports.storage?.loaded?.metadata as Record<string, unknown> | undefined,
      readSession: ports.storage?.readSession as RunToolChatSessionArgs['hostStorage'] extends { readSession?: infer F } ? F : never,
      persist: ports.storage?.persist as RunToolChatSessionArgs['hostStorage'] extends { persist?: infer P } ? P : never
    },
    hostExposureRules: ports.exposure?.rules,
    hostMcp: ports.mcp as RunToolChatSessionArgs['hostMcp'],
    hostAnswerer: ports.answerer as RunToolChatSessionArgs['hostAnswerer']
  }
}

export async function runToolChatSession(invocation: AgentInvocation, ports: AgentHostPorts): Promise<AgentInvocationResult> {
  const args = expandInvocation(invocation, ports)
  const chatSignal = registerChatCancel(args.requestId)
  const requestLane = args.lane
    ?? (args.remoteContext
      ? args.remoteContext.source === 'feishu'
        ? 'feishu'
        : 'wechat'
      : 'desktop')
  registerToolRevocationRequest(args.requestId, requestLane)
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
  try {
    const result = await runToolChatSessionInner({ ...args, chatSignal, getMcpConnectionManager, turnUsageStats })
    turnOutcome = result.ok ? 'completed' : result.cancelled ? 'cancelled' : 'failed'
    return result
  } catch (e) {
    if (e instanceof ChatCancelledError) {
      turnOutcome = 'cancelled'
      return { ok: false, error: e.message, cancelled: true }
    }
    turnOutcome = 'failed'
    throw e
  } finally {
    args.hostUsage?.recordTurnSummary?.({
      turnId: args.turnId ?? args.sessionId,
      sessionId: args.sessionId,
      outcome: turnOutcome,
      counts: turnUsageStats,
      model: args.model,
      llmServiceId: args.llmServiceId
    })
    if (chatSignal.aborted) {
      invocation.events.notify?.({ kind: 'request-all-cancelled', requestId: args.requestId })
    }
    clearChatCancel(args.requestId)
    clearToolRevocationRequest(args.requestId)
    clearRequest(args.requestId)
    await mcpConnectionManager?.shutdown().catch(() => undefined)
  }
}

async function runToolChatSessionInner(
  args: RunToolChatSessionArgs & { chatSignal: AbortSignal; getMcpConnectionManager: () => McpConnectionManager; turnUsageStats: TurnUsageStats }
): Promise<RunToolChatSessionResult> {
  const {
    requestId,
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
    locale: payloadLocale,
    projectMemoryEnabled,
    chatSignal,
    getBrowserDetectContext,
    getMcpConnectionManager,
    events: invocationEvents,
    hasImageAttachments,
    turnUsageStats
  } = args
  // 台账事件与统计写入共用的 Turn ID：真实 turnId 优先，缺省回退 sessionId（现状占位）。
  const eventTurnId = args.turnId ?? sessionId
  let contextWindowId = args.windowId ?? requestId
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

  const client = createAnthropicClient(apiKey, baseUrl, {
    onRetry: async ({ attempt, backoffMs, code }) => {
      await args.emitSessionEvent?.({ type: 'request_retry', payload: { turnId: eventTurnId, stepId: requestId, requestId, attempt, backoffMs, code } })
    }
  })
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
  const thinking = toolLoopOptions.enableThinking ? ({ type: 'adaptive' as const }) : ({ type: 'disabled' as const })

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
    const lastUserIndex = messagesForApi.map((message) => message.role).lastIndexOf('user')
    messagesForApi.splice(lastUserIndex >= 0 ? lastUserIndex : messagesForApi.length, 0, fragmentMessage)
  }

  /** 口径 B：本次 invoke 传入的上下文中，已有多少条 API `assistant`（不含本轮 while 将追加的） */
  const historicalAssistantApiMessageCount = initialMessages.filter((m) => m.role === 'assistant').length

  const stripThinking = (msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
    // thinking 开启时须保留 assistant 消息中的 thinking/redacted_thinking（含 signature），
    // 否则多轮 tool loop 会触发 Anthropic 400（final assistant 须以 thinking 块开头）。
    if (toolLoopOptions.enableThinking) return sanitizeThinkingForReplay(msgs)
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
  const effectiveTools = computeEffectiveTools({
    builtinConfig: toolsConfig,
    feishuConfig,
    browserConfig,
    shellConfig,
    wechatConfig,
    remoteContext,
    exposureRules,
    mcpSnapshot
  })
  const { tools, toolNames, authorizedToolNames, compatToInternal } = effectiveTools
  if (toolNames.includes('browser')) {
    stagehandService.resetInferenceCount(sessionId)
  }
  let loopRound = 0
  let lastValidUsage: ToolLoopUsage | undefined
  let lastRequestContext: ReturnType<typeof buildRequestContextPayload> | undefined
  let lastRequestHeader: ReturnType<typeof buildRequestHeaderPayload> | undefined
  let overflowRetries = 0
  let outputRecoveryRetries = 0
  let answerRecoveryText = ''
  let needsFinalAnswerReconciliation = false
  /** 本会话单次 invoke 内标题摘要至多尝试调度一次（避免历史已达标且工具多轮时重复触发） */
  let titleSuggestScheduledThisInvoke = false
  const toolErrorRepeat = makeToolErrorRepeatTracker()
  let recoverySkillFragment = ''

  /**
   * Preflight 恢复必须和 provider overflow 使用同一套事务语义：先以最终 wire
   * surface 计算输入指纹，再生成可回放的保留面，提交 start/summary/end，最后
   * 才允许下一轮重新序列化并发送。这样 preflight 不会绕过压缩台账直接删历史。
   */
  const recoverBeforeSend = async (
    inputHeader: ReturnType<typeof buildRequestHeaderPayload>,
    inputMessages: Anthropic.MessageParam[],
    retry: number,
    totalInputBudget: number
  ): Promise<boolean> => {
    const stableReplayPrefix = (messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
      const replayable = excludeReplayOnlyMessages(messages, args.skillFragments)
      let currentIndex = args.currentUserMessageId
        ? replayable.findIndex((message) => (message as Anthropic.MessageParam & { id?: string }).id === args.currentUserMessageId)
        : -1
      if (currentIndex < 0) {
        for (let index = replayable.length - 1; index >= 0; index--) {
          const message = replayable[index]!
          if (message.role !== 'user' || !Array.isArray(message.content) || !message.content.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result')) {
            if (message.role === 'user') { currentIndex = index; break }
          }
        }
      }
      return currentIndex >= 0 ? replayable.slice(0, currentIndex + 1) : replayable
    }
    // 中途工具轮的 assistant 仍会继续增长，不能进入跨轮 replay 指纹；
    // provider retry 仍使用完整 recoveredMessages，只有持久化匹配面截到当前 user。
    const replayInputMessages = stableReplayPrefix(inputMessages)
    const inputProjection = projectReplaySurfaceWithSources(replayInputMessages)
    const inputSurface = inputProjection.messages
    const selectedMessages = selectRecoveryMessages(inputMessages as unknown as ClaudeContentBlockMessage[], args.currentUserMessageId) as unknown as Anthropic.MessageParam[]
    const skillFragmentText = args.skillFragments?.join('\n\n')
    const skillFragmentMessage = skillFragmentText
      ? inputMessages.find((message) => message.role === 'user' && message.content === skillFragmentText)
      : undefined
    const recoveredMessages = skillFragmentMessage && !selectedMessages.includes(skillFragmentMessage)
      ? [skillFragmentMessage, ...selectedMessages]
      : selectedMessages
    // 是否发生缩减必须比较真实 provider surface；replay projection 会隐藏工具消息，
    // 不能据此把“已删除旧工具对”误判成 no-op。
    if (JSON.stringify(recoveredMessages) === JSON.stringify(inputMessages)) return false
    const replayOutputMessages = stableReplayPrefix(recoveredMessages)
    const outputProjection = projectReplaySurfaceWithSources(replayOutputMessages)
    const outputSurface = outputProjection.messages
    if (outputSurface.length === 0) return false

    const outputHeader = buildRequestHeaderPayload({
      requestId: `${requestId}:recovery:${retry}`,
      system: inputHeader.system,
      tools: inputHeader.tools,
      messages: recoveredMessages,
      requiredSurfaceSet: inputHeader.requiredSurfaceSet,
      toolExecutionCheckpoint: { ...inputHeader.toolExecutionCheckpoint, replayForbidden: true }
    })
    const outputPairs = extractToolPairIds(recoveredMessages as unknown as Array<{ content?: unknown }>)
    const outputIds = recoveredMessages.map((message, index) => (message as unknown as { id?: string }).id ?? surfaceItemIdentity(message, index))
    const outputPreflight = validateSurfaceForSend({
      ids: outputIds,
      requiredIds: inputHeader.requiredSurfaceSet,
      currentUserMessageId: args.currentUserMessageId ?? '',
      fingerprint: outputHeader.surfaceSnapshot.fingerprint,
      expectedFingerprint: outputHeader.surfaceSnapshot.fingerprint,
      estimatedTotalInputTokens: outputHeader.surfaceSnapshot.surfaceTokens,
      totalInputBudget,
      toolUses: outputPairs.toolUses,
      toolResults: outputPairs.toolResults
    })
    if (!outputPreflight.ok && outputPreflight.reason === 'token_budget_exceeded') return false
    if (!outputPreflight.ok) return false

    const inputItems = surfaceItemIdentities(inputSurface).map((id) => ({ id }))
    const outputItems = surfaceItemIdentitiesForProjectionSubset(inputProjection, outputProjection).map((id) => ({ id }))
    const inputFingerprint = computeReplaySurfaceFingerprint(inputHeader.system, inputSurface)
    const outputFingerprint = computeReplaySurfaceFingerprint(inputHeader.system, outputSurface)
    const shadowedRanges = computeShadowedRanges(inputItems, outputItems)
    if (!shadowedRanges.length || !args.appendCompactionTransaction) return false
    const compactionId = `${contextWindowId}:preflight:${requestId}:${retry}`
    const outputWindowId = `${contextWindowId}:reset:${requestId}:${retry}`
    const candidate = { kind: 'reset', requiredMessageId: args.currentUserMessageId ?? null, shadowedRanges }
    await args.appendCompactionTransaction(
      { compactionId, windowId: contextWindowId, inputSurfaceFingerprint: inputFingerprint, surfaceBoundaryId: inputItems[inputItems.length - 1]?.id, targetTokens: outputHeader.surfaceSnapshot.surfaceTokens },
      { compactionId, windowId: contextWindowId, inputWindowId: contextWindowId, outputWindowId, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: outputFingerprint, shadowedRanges, requiredSurfaceSet: inputHeader.requiredSurfaceSet, toolExecutionCheckpoint: { ...outputHeader.toolExecutionCheckpoint }, candidate }
    )
    messagesForApi = recoveredMessages
    contextWindowId = outputWindowId
    args.emitFactEvent?.({ type: 'compaction-committed', compactionId, windowId: contextWindowId, outputSurfaceFingerprint: outputFingerprint })
    return true
  }

  while (true) {
    loopRound++
    throwIfChatCancelled(chatSignal)
    const memoryContent = getCachedMemoryContent()
    const baseSystemWithRecovery = typeof system === 'string' && system.trim().length > 0 ? system : undefined
    const capabilityHint = buildToolCapabilityConventionHint(toolNames)
    const systemWithTools = baseSystemWithRecovery ? `${baseSystemWithRecovery}\n\n${capabilityHint}` : capabilityHint
    // P2：locale 装配期定值（请求优先 / 库回退在装配器完成），循环内不再查库
    const locale = payloadLocale as AppLocale
    const systemPrompt = buildFinalSystemPrompt({
      system: systemWithTools,
      memoryContent,
      memoryEnabled: projectMemoryEnabled ?? true,
      locale,
      hasImageAttachments: hasImageAttachments ?? false,
      skillCatalog: getCachedSkills(userDataDir, resolveWorkDir?.() ?? initialWorkDir),
      contextWindow: args.contextWindow
    })
    // requestId 按一次 provider 请求尝试定义；同一轮的 header/context/usage 必须共享它。
    const attemptRequestId = `${requestId}:round:${loopRound}`
    const messagesStripped = stripThinking(recoverySkillFragment ? [...messagesForApi, { role: 'user', content: recoverySkillFragment }] : messagesForApi)
    const wireMessages = messagesStripped.map((message) => {
      const { id: _internalId, ...wireShape } = message as Anthropic.MessageParam & { id?: string }
      return wireShape
    })
    const toolLoopStreamParams = buildClaudeToolLoopStreamParams({
      model,
      max_tokens: maxTokensEffective,
      system: systemPrompt,
      messages: wireMessages as Anthropic.MessageParam[],
      tools: tools as Anthropic.Tool[],
      thinking,
      cacheControl: true
    })
    // 计划面先冻结为不含内部 id 的协议中立表示；wire 面只接受 serializer 最终产物。
    // 两者必须独立计算，才能捕获 serializer 在发送前改变消息/工具的漂移。
    const plannedMessages = wireMessages
    const requestHeader = buildRequestHeaderPayload({ requestId: attemptRequestId, system: systemPrompt ?? '', tools: tools as unknown as unknown[], messages: plannedMessages, requiredSurfaceSet: args.currentUserMessageId ? [args.currentUserMessageId] : [], toolExecutionCheckpoint: { completedToolUseIds: extractToolPairIds(messagesStripped as unknown as Array<{ content?: unknown }>).toolUses, replayForbidden: false } })
    const wireHeader = buildRequestHeaderPayload({ requestId: attemptRequestId, system: systemPrompt ?? '', tools: tools as unknown as unknown[], messages: toolLoopStreamParams.messages as unknown[], requiredSurfaceSet: requestHeader.requiredSurfaceSet, toolExecutionCheckpoint: requestHeader.toolExecutionCheckpoint })
    const requestContext = buildRequestContextPayload({ requestId: attemptRequestId, provider: 'anthropic', model, contextWindow: args.contextWindow, maxTokensEffective, surfaceSnapshot: requestHeader.surfaceSnapshot, windowId: contextWindowId, decision: { decisionId: attemptRequestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' } })
    lastRequestHeader = requestHeader
    lastRequestContext = requestContext
    const surfaceIds = (messagesForApi as unknown as ClaudeContentBlockMessage[]).map((message, index) => message.id ?? `message-${index}`)
    const toolPairs = extractToolPairIds(messagesStripped as unknown as Array<{ content?: unknown }>)
    const preflight = validateSurfaceForSend({
      ids: surfaceIds,
      requiredIds: args.currentUserMessageId ? [args.currentUserMessageId] : [],
      currentUserMessageId: args.currentUserMessageId ?? '',
      fingerprint: wireHeader.surfaceSnapshot.fingerprint,
      expectedFingerprint: requestHeader.surfaceSnapshot.fingerprint,
      estimatedTotalInputTokens: wireHeader.surfaceSnapshot.surfaceTokens,
      totalInputBudget: requestContext.budget.totalInputBudget,
      toolUses: toolPairs.toolUses,
      toolResults: toolPairs.toolResults
    })
    if (!preflight.ok) {
      if (preflight.reason === 'token_budget_exceeded' && overflowRetries < 1) {
        overflowRetries += 1
        const recovered = await recoverBeforeSend(requestHeader, messagesStripped, overflowRetries, requestContext.budget.totalInputBudget)
        if (recovered) {
          await args.emitSessionEvent?.({ type: 'request_retry', payload: { turnId: eventTurnId, stepId: requestId, requestId, attempt: overflowRetries, backoffMs: 0, code: 'preflight_context_overflow' } })
          continue
        }
      }
      return { ok: false, error: `Context preflight failed: ${preflight.reason}` }
    }
    await args.emitSessionEvent?.({ type: 'request_header', payload: { route: 'anthropic.messages.stream', ...requestHeader } })
    await args.emitSessionEvent?.({ type: 'request_context', payload: requestContext })

    logAgentEvent('info', 'llm.request', {
      requestId,
      sessionId,
      loopRound,
      model,
      baseUrl,
      locale,
      system: systemPrompt,
      messages: messagesStripped,
      toolNames,
      maxTokens: maxTokensEffective,
      enableThinking: toolLoopOptions.enableThinking
    })
    beginLlm(sessionId, requestId)

    let content: Anthropic.ContentBlock[]
    let stopReason: NormalizedStopReason | undefined
    let usage: ToolLoopUsage | undefined

    try {
      const stream = client.messages.stream({
        ...toolLoopStreamParams
      } as Parameters<typeof client.messages.stream>[0])

      const contentBlockTypes = new Map<number, string>()
      const contentBlocks: Array<unknown> = []
      const pendingToolUseByIndex = new Map<number, { id: string; name: string; input: unknown; partialJson: string }>()
      const pendingTextByIndex = new Map<number, string>()

      for await (const evt of stream) {
      throwIfChatCancelled(chatSignal)
      const normalizedDelta = normalizeAnthropicEvent(evt, contentBlockTypes)
      if (normalizedDelta) {
        await args.emitSessionEvent?.({
          type: 'assistant_chunk',
          payload: { turnId: eventTurnId, stepId: requestId, messageId: args.assistantMessageId, delta: normalizedDelta }
        })
      }
      if (normalizedDelta?.type === 'tool_call_delta') {
        const pending = pendingToolUseByIndex.get(normalizedDelta.index)
        if (pending) pending.partialJson += normalizedDelta.partialJson
      }
      if (normalizedDelta?.type === 'reasoning_delta' && normalizedDelta.text.length > 0) {
        args.emitFactEvent?.({ type: 'thinking-delta', text: normalizedDelta.text })
        if (remoteContext) onRemoteThinkingActive(buildRemoteProgressHookContext(sessionId, locale))
      }
      if (normalizedDelta?.type === 'text_delta' && normalizedDelta.text.length > 0) {
        args.emitFactEvent?.({ type: 'content-delta', text: normalizedDelta.text })
        const prev = pendingTextByIndex.get(normalizedDelta.index) ?? ''
        pendingTextByIndex.set(normalizedDelta.index, prev + normalizedDelta.text)
      }
      if (evt?.type === 'content_block_start') {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = (evt as { content_block?: { type?: string } }).content_block?.type
        if (index >= 0 && typeof blockType === 'string') {
          contentBlockTypes.set(index, blockType)
          if (blockType === 'tool_use') {
            const block = (evt as { content_block?: { id?: string; name?: string; input?: unknown } }).content_block ?? {}
            pendingToolUseByIndex.set(index, {
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : '',
              input: block.input,
              partialJson: ''
            })
          } else if (blockType === 'text') {
            pendingTextByIndex.set(index, '')
          }
        }
      }
      if (evt?.type === 'message_start') {
        const startUsage = (evt as { message?: { usage?: unknown } }).message?.usage
        if (startUsage && typeof startUsage === 'object') {
          const partial = normalizeAnthropicMessageUsage({ usage: startUsage }, baseUrl)
          if (partial) {
            usage = { ...partial, output_tokens: usage?.output_tokens }
            lastValidUsage = usage
            args.emitFactEvent?.({ type: 'usage-updated', usage })
          }
        }
      }
      if (evt?.type === 'message_delta') {
        const evtUsage = (evt as { usage?: unknown }).usage
        if (evtUsage && typeof evtUsage === 'object') {
          const partial = normalizeAnthropicMessageUsage({ usage: evtUsage }, baseUrl)
          if (partial) usage = partial
        }
      }
      if (evt?.type === 'content_block_stop') {
        const index = typeof (evt as { index?: number }).index === 'number' ? (evt as { index: number }).index : -1
        const blockType = contentBlockTypes.get(index)
        if (index >= 0 && blockType === 'text') {
          const text = pendingTextByIndex.get(index) ?? ''
          pendingTextByIndex.delete(index)
          if (text.length > 0) {
            contentBlocks.push({ type: 'text', text })
            if (remoteContext) {
              onRemoteTextSegmentClosed(buildRemoteProgressHookContext(sessionId, locale), text)
            }
          }
        } else if (index >= 0 && blockType === 'tool_use') {
          const pending = pendingToolUseByIndex.get(index)
          pendingToolUseByIndex.delete(index)
          if (pending && pending.id && pending.name) {
            const normalizedName = normalizeExternalToolName(pending.name)
            const compatName = toolIdToOpenAiCompatibleApiToolName(normalizedName.canonicalName)
            const toolUseBlock = {
              type: 'tool_use',
              id: pending.id,
              name: compatName,
              input: parseToolInput(pending.input, pending.partialJson)
            }
            await args.emitSessionEvent?.({
              type: 'tool_call',
              payload: { turnId: eventTurnId, stepId: requestId, toolUseId: pending.id, name: compatName, args: normalizeToolUseInputRecord(toolUseBlock.input) }
            })
            const mcpEntry = mcpSnapshot.entries.get(compatName)
            args.emitFactEvent?.({
              type: 'tool-use', id: pending.id, toolName: compatName,
              input: normalizeToolUseInputRecord(toolUseBlock.input),
              ...(mcpEntry ? { mcp: { serverId: mcpEntry.serverId, serverName: mcpEntry.serverName, originalToolName: mcpEntry.originalName, description: mcpEntry.description } } : {})
            })
            contentBlocks.push(toolUseBlock)
            logAgentEvent('info', 'tool.request', {
              requestId,
              sessionId,
              loopRound,
              toolUseId: pending.id,
              toolName: compatName,
              input: toolUseBlock.input
              ,...(normalizedName.originalName ? { originalToolName: normalizedName.originalName } : {})
            })
          }
        }
      }
    }

      const res = (await stream.finalMessage()) as { content?: unknown[]; stop_reason?: string }
      const finalContent = Array.isArray(res?.content) ? res.content : []
      const rawContent = finalContent.length > 0 ? finalContent : contentBlocks
      content = mergeStreamedToolInputsIntoContent(rawContent, contentBlocks) as Anthropic.ContentBlock[]
      stopReason = normalizeStopReason(typeof res?.stop_reason === 'string' ? res.stop_reason : undefined)
      const finalUsage = normalizeAnthropicMessageUsage(res, baseUrl)
      usage = finalUsage ?? usage
      if (finalUsage) {
        await args.emitSessionEvent?.({
          type: 'request_usage',
          payload: { schemaVersion: 1, requestId: attemptRequestId, usage: finalUsage, source: 'api' }
        })
        // Token 用量统计：每次 LLM 调用即时落一行 usage_step_facts（异步容错，不阻断对话）。
        hostUsage?.recordStepUsage?.({
          sessionId,
          turnId: eventTurnId,
          stepId: attemptRequestId,
          usage: finalUsage,
          baseUrl,
          model,
          llmServiceId: args.llmServiceId
        })
        turnUsageStats.stepCount += 1
        const finalSurfaceMessages = [...messagesForApi, { role: 'assistant' as const, content: content as Anthropic.ContentBlock[] }]
        const finalHeader = buildRequestHeaderPayload({ requestId: attemptRequestId, system: requestHeader.system, tools: requestHeader.tools, messages: finalSurfaceMessages, requiredSurfaceSet: requestHeader.requiredSurfaceSet, toolExecutionCheckpoint: requestHeader.toolExecutionCheckpoint })
        const finalProjection = computeContextPressure({
          currentSurface: finalHeader.surfaceSnapshot,
          anchor: { requestId: attemptRequestId, surfaceTokens: requestHeader.surfaceSnapshot.surfaceTokens, surfaceFingerprint: requestHeader.surfaceSnapshot.fingerprint, systemFingerprint: requestHeader.surfaceSnapshot.systemFingerprint, toolsFingerprint: requestHeader.surfaceSnapshot.toolsFingerprint, provider: 'anthropic', model, estimatorVersion: requestContext.budget.estimatorVersion, serializationVersion: requestContext.budget.serializationVersion, realUsage: finalUsage, contextWindow: requestContext.contextWindow.tokens },
          budget: requestContext.budget,
          decision: { decisionId: attemptRequestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' },
          contextWindow: requestContext.contextWindow,
          provider: 'anthropic',
          model
        })
        lastRequestHeader = finalHeader
        lastRequestContext = { ...lastRequestContext, contextUsage: finalProjection }
        args.emitFactEvent?.({ type: 'context-projection-updated', projection: finalProjection })
        await args.emitSessionEvent?.({ type: 'request_context', payload: buildRequestContextPayload({ requestId: attemptRequestId, provider: 'anthropic', model, contextWindow: args.contextWindow, maxTokensEffective, surfaceSnapshot: finalHeader.surfaceSnapshot, contextUsage: finalProjection, planningStatus: finalProjection.surfaceTokens <= requestContext.budget.totalInputBudget ? 'fits_without_headroom' : 'exhausted', windowId: contextWindowId, decision: { decisionId: attemptRequestId, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' } }) })
      }
      if (usage) {
        lastValidUsage = usage
        args.emitFactEvent?.({ type: 'usage-updated', usage })
      }

      logAgentEvent('info', 'llm.response', {
        requestId,
        sessionId,
        loopRound,
        stopReason,
        content,
        usage
      })
    } catch (e) {
      if (e instanceof ChatCancelledError) throw e
      const error = e instanceof Error ? e.message : String(e)
      const recovery = decideOverflowRecovery({ error: e, retries: overflowRetries, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true })
      if (recovery.action === 'reset_and_retry_provider') {
        overflowRetries = recovery.nextRetry
        const recovered = lastRequestHeader && lastRequestContext
          ? await recoverBeforeSend(lastRequestHeader, messagesForApi, overflowRetries, lastRequestContext.budget.totalInputBudget)
          : false
        if (!recovered) {
          return failToolLoopWithLastUsage( requestId, sessionId, error, lastValidUsage, args.emitFactEvent)
        }
        await args.emitSessionEvent?.({ type: 'request_retry', payload: { turnId: eventTurnId, stepId: requestId, requestId, attempt: overflowRetries, backoffMs: 0, code: 'provider_context_overflow' } })
        continue
      }
      logAgentEvent('error', 'llm.error', {
        requestId,
        sessionId,
        loopRound,
        model,
        error,
        stack: e instanceof Error ? e.stack : undefined
      })
      return failToolLoopWithLastUsage( requestId, sessionId, error, lastValidUsage, args.emitFactEvent)
    } finally {
      endLlm(sessionId, requestId)
    }

    const toolUses = content.filter((b) =>
      Boolean(b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use')
    ) as Array<{ type: 'tool_use'; id: string; name: string; input: unknown }>

    // 必须先使用与下一轮相同的 replay 清理，再判断是否追加 assistant。
    // 否则无签名 thinking-only 截断会在下一轮变成空 assistant 消息。
    const replayableAssistantContent = stripThinking([
      { role: 'assistant', content: content as Anthropic.ContentBlock[] }
    ])[0]?.content
    const safeAssistantContent = Array.isArray(replayableAssistantContent)
      ? replayableAssistantContent.filter((block) => {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') return true
        const id = (block as { id?: unknown }).id
        return typeof id === 'string' && id.trim().length > 0
      })
      : replayableAssistantContent
    if (Array.isArray(safeAssistantContent) && safeAssistantContent.length > 0) {
      messagesForApi = [...messagesForApi, { role: 'assistant', content: safeAssistantContent as Anthropic.ContentBlock[] }]
    }

    const outputRecoveryKind = classifyOutputRecovery({ stopReason, content })
    if (toolUses.length > 0 && needsFinalAnswerReconciliation && outputRecoveryKind !== 'output_truncated_with_tools') {
      answerRecoveryText += content
        .filter((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
        .map((block) => ((block as { text?: unknown }).text ?? ''))
        .filter((value): value is string => typeof value === 'string')
        .join('')
      needsFinalAnswerReconciliation = true
    }
    if (outputRecoveryKind === 'output_truncated_with_tools') {
      // 工具轮也可能已经向用户展示正文，必须保留在最终恢复正文链中。
      const truncatedToolText = content
        .filter((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
        .map((block) => ((block as { text?: unknown }).text ?? ''))
        .filter((value): value is string => typeof value === 'string')
        .join('')
      answerRecoveryText += truncatedToolText
      needsFinalAnswerReconciliation = true
      const failedResults = buildTruncatedToolResults(toolUses.filter((tool) => typeof tool.id === 'string' && tool.id.trim().length > 0))
      if (failedResults.length > 0) {
        messagesForApi = [...messagesForApi, { role: 'user', content: failedResults }]
        for (const failedResult of failedResults) {
          const result: ToolCallResultPersisted = {
            success: false,
            error: 'model_output_token_limit',
            userMessage: failedResult.content,
            // §7.6 #15：输出截断整体放弃，未进入执行流程 → 未执行
            notExecuted: true,
            notExecutedReason: 'model_output_truncated'
          }
          await args.emitSessionEvent?.({ type: 'tool_result', payload: { turnId: eventTurnId, stepId: requestId, toolUseId: failedResult.tool_use_id, result } })
          // 第 15 处 tool_result 发出点（绕过 recordToolResult）：同样计入三分类统计（需求 §2.4.0）。
          noteToolResultForStats(turnUsageStats, result)
          args.emitFactEvent?.({ type: 'tool-result', id: failedResult.tool_use_id, result })
        }
      }
      if (outputRecoveryRetries >= MAX_OUTPUT_RECOVERIES) {
        return failToolLoopWithLastUsage( requestId, sessionId, 'model_output_token_limit_exhausted', lastValidUsage, args.emitFactEvent)
      }
      outputRecoveryRetries += 1
      const recoveryMessage = buildOutputRecoveryMessage({ attempt: outputRecoveryRetries, causeRequestId: attemptRequestId, hadVisibleText: truncatedToolText.length > 0, hadToolUse: true })
      messagesForApi = [...messagesForApi, { role: 'user', content: recoveryMessage.content }]
      await args.emitSessionEvent?.({ type: 'request_retry', payload: { turnId: eventTurnId, stepId: requestId, requestId: attemptRequestId, attempt: outputRecoveryRetries, backoffMs: 0, code: 'model_output_token_limit' } })
      logAgentEvent('warn', 'llm.output_recovery', { requestId, sessionId, causeRequestId: attemptRequestId, attempt: outputRecoveryRetries, toolCount: toolUses.length, failedToolResultCount: failedResults.length, usage })
      continue
    }
    if (outputRecoveryKind === 'output_truncated_without_tools') {
      const text = content
        .filter((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
        .map((block) => ((block as { text?: unknown }).text ?? ''))
        .filter((value): value is string => typeof value === 'string')
        .join('')
      answerRecoveryText += text
      if (text.length > 0) needsFinalAnswerReconciliation = true
      if (outputRecoveryRetries >= MAX_OUTPUT_RECOVERIES) {
        return failToolLoopWithLastUsage(
          requestId,
          sessionId,
          'model_output_token_limit_exhausted',
          lastValidUsage,
          args.emitFactEvent
        )
      }
      outputRecoveryRetries += 1
      const recoveryMessage = buildOutputRecoveryMessage({
        attempt: outputRecoveryRetries,
        causeRequestId: attemptRequestId,
        hadVisibleText: text.length > 0
      })
      messagesForApi = [...messagesForApi, { role: 'user', content: recoveryMessage.content }]
      await args.emitSessionEvent?.({
        type: 'request_retry',
        payload: {
          turnId: eventTurnId,
          stepId: requestId,
          requestId: attemptRequestId,
          attempt: outputRecoveryRetries,
          backoffMs: 0,
          code: 'model_output_token_limit'
        }
      })
      logAgentEvent('warn', 'llm.output_recovery', {
        requestId,
        sessionId,
        causeRequestId: attemptRequestId,
        attempt: outputRecoveryRetries,
        maxRecoveries: MAX_OUTPUT_RECOVERIES,
        stopReason,
        hadVisibleText: text.length > 0,
        usage
      })
      continue
    }

    if (
      hostStorage?.persist?.scheduleTitleSuggestion &&
      !titleSuggestScheduledThisInvoke &&
      reachedCumulativeAssistantTurnsForTitleSuggest(historicalAssistantApiMessageCount, loopRound)
    ) {
      titleSuggestScheduledThisInvoke = true
      hostStorage.persist.scheduleTitleSuggestion({
        onTitleGenerated: (session: import('../src/shared/domainTypes').Session) => args.onTitleGenerated?.(session),
        sessionId,
        model,
        baseUrl,
        messagesForApi,
        getApiKey
      })
    }

    if (toolUses.length === 0) {
      const returnUsage = pickToolLoopReturnUsage(usage, lastValidUsage)
      const explicitText = content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('')
      const compatibleThinkingText = !explicitText && (stopReason === undefined || stopReason === 'end_turn')
        ? content.filter((block) => block.type === 'thinking').map((block) => block.type === 'thinking' ? block.thinking : '').join('')
        : ''
      const finalRoundText = explicitText || compatibleThinkingText
      const finalText = answerRecoveryText ? answerRecoveryText + finalRoundText : finalRoundText
      const hasOutputRecovery = outputRecoveryRetries > 0
      if (needsFinalAnswerReconciliation || hasOutputRecovery) args.emitFactEvent?.({ type: 'content-reconciled', text: finalText })
      args.emitFactEvent?.({ type: 'source-completed' })
      if (args.onTurnBoundary && lastRequestHeader && lastRequestContext) {
        await args.onTurnBoundary({ requestId, windowId: contextWindowId, system: lastRequestHeader.system, tools: lastRequestHeader.tools, surfaceSnapshot: lastRequestHeader.surfaceSnapshot, messages: messagesForApi, budget: lastRequestContext.budget, contextUsage: lastRequestContext.contextUsage, toolExecutionCheckpoint: lastRequestHeader.toolExecutionCheckpoint, requiredSurfaceSet: lastRequestHeader.requiredSurfaceSet })
      }
      const finalContent = answerRecoveryText || hasOutputRecovery
        ? ([{ type: 'text', text: finalText }] as Anthropic.ContentBlock[])
        : content
      return { ok: true, content: finalContent, stopReason: stopReason ?? 'end_turn', ...(returnUsage && { usage: returnUsage }), ...(lastRequestHeader ? { finalSurfaceSnapshot: lastRequestHeader.surfaceSnapshot, finalSurfaceMessages: messagesForApi } : {}) }
    }

    if (toolNames.length === 0) {
      return failToolLoopWithLastUsage(
        requestId,
        sessionId,
        'unexpected_tool_call_with_no_tools',
        lastValidUsage,
        args.emitFactEvent,
      )
    }

    // 轮数上界（审批 Agent 等有界调用方传入）：达到上界后不再执行工具，终止循环——
    // 未获最终裁决的 fail-closed 由调用方（approvalAgent）兜底处理
    if (args.maxToolLoopRounds != null && loopRound > args.maxToolLoopRounds) {
      return failToolLoopWithLastUsage(
        requestId,
        sessionId,
        `TOOL_LOOP_MAX_ROUNDS_EXCEEDED(${args.maxToolLoopRounds})`,
        lastValidUsage,
        args.emitFactEvent,
      )
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    const emitToolResultFact = (toolUseId: string, result: ToolCallResultPersisted) => {
      args.emitFactEvent?.({ type: 'tool-result', id: toolUseId, result })
    }
    const recordToolResult = async (
      block: Anthropic.ToolResultBlockParam,
      result: ToolCallResultPersisted
    ): Promise<void> => {
      toolResults.push(block)
      await args.emitSessionEvent?.({
        type: 'tool_result',
        payload: { turnId: eventTurnId, stepId: requestId, toolUseId: block.tool_use_id, result }
      })
      noteToolResultForStats(turnUsageStats, result)
      emitToolResultFact(block.tool_use_id, result)
    }
    const fileCache = getFileStateCacheForSession(sessionId)
    let abortRepeatedToolError: string | null = null
    let toolResultCompacted = false

    for (const tu of toolUses) {
      throwIfChatCancelled(chatSignal)
      const workDir = resolveWorkDir ? resolveWorkDir() : initialWorkDir
      const toolUseId = tu.id
      const toolName = tu.name
      // B1：API 返回的是 sanitize 后的 compat 名，回向解析为内部注册名（可能含点号）再授权与查找
      const resolvedToolName = compatToInternal.get(toolName) ?? toolName
      const processTool = isProcessToolName(toolName)
      const inputObj = normalizeToolUseInputRecord(tu.input)

      const authorization = authorizeToolCall(resolvedToolName, authorizedToolNames)
      if (!authorization.ok) {
        const error = toolName.startsWith('mcp_')
          ? `${authorization.error}: MCP 工具已变更或服务不可用`
          : authorization.error
        logAgentEvent('warn', 'tool.error', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName
        })
        await recordToolResult(buildToolErrorResult(toolUseId, error, { requestId, sessionId }), { success: false, error, notExecuted: true, notExecutedReason: 'not_authorized' })
        continue
      }
      if (isToolRevoked(requestId, resolvedToolName)) {
        await recordToolResult(buildToolErrorResult(toolUseId, 'tool_authorization_revoked', { requestId, sessionId }), { success: false, error: 'tool_authorization_revoked', notExecuted: true, notExecutedReason: 'authorization_revoked' })
        continue
      }

      const registeredTool = getRegisteredTool(resolvedToolName)
      const builtinExec = getToolExecutor(resolvedToolName)
      const exec =
        builtinExec ??
        (mcpSnapshot.entries.has(resolvedToolName)
          ? hostMcp?.resolveExecutor?.(resolvedToolName, getMcpConnectionManager())
          : undefined)
      if (!registeredTool && !exec) {
        const unknownToolError = toolName.startsWith('mcp_')
          ? 'MCP 工具已变更或服务不可用'
          : `未知工具: ${toolName}`
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          unknownToolError,
          unknownToolError
        )
        await recordToolResult(buildToolErrorResult(toolUseId, unknownToolError, { requestId, sessionId }), { success: false, error: unknownToolError, notExecuted: true, notExecutedReason: 'unknown_tool' })
        if (toolErrorRepeat.noteFailure(toolName, unknownToolError)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${unknownToolError}`
          break
        }
        continue
      }

      try {
        assertSafeToolInput(toolName, inputObj)
      } catch (e) {
        const base = e instanceof Error ? e.message : String(e)
        const msg = augmentToolInputValidationError(base, stopReason, toolName, inputObj)
        const userMsg = sanitizeToolErrorString(msg, toolName)
        logToolLoopError(
          {
            requestId,
            sessionId,
            assistantMessageId: args.assistantMessageId,
            loopRound,
            toolUseId,
            toolName,
            input: inputObj
          },
          e,
          userMsg
        )
        await recordToolResult(buildToolErrorResult(toolUseId, userMsg, { requestId, sessionId }), { success: false, error: userMsg })
        if (toolErrorRepeat.noteFailure(toolName, userMsg)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${userMsg}`
          break
        }
        continue
      }

      // 远程预算：工具调用计数门控（计数留执行链路；出站写预算由 gate 上下文承载）
      if (remoteBudgetState) {
        const budgetCheck = checkRemoteTaskBudget(remoteBudgetState, 'tool_call')
        if (!budgetCheck.ok) {
          const pauseMsg = `${budgetCheck.message}（继续 / 回桌面 / 停止）`
          logAgentEvent('info', 'remote.budget.pause', {
            requestId,
            sessionId,
            toolUseId,
            toolName,
            reason: budgetCheck.reason
          })
          getSecurityAuditLog().record({
            ts: Date.now(),
            event: 'budget.exhausted',
            lane: effectiveLane,
            origin: { kind: 'direct-owner' },
            sessionId,
            toolName,
            reason: budgetCheck.reason,
            actor: 'system'
          })
          await recordToolResult(buildToolErrorResult(toolUseId, pauseMsg, { requestId, sessionId }), { success: false, error: pauseMsg, notExecuted: true, notExecutedReason: 'remote_budget_exhausted' })
          abortRepeatedToolError = pauseMsg
          break
        }
        recordToolCall(remoteBudgetState)
      }

      const sendProgress = (status: string, payload?: string | import('./tools/types').ToolProgressPayload) => {
        let message: string | undefined
        let raw: string | undefined
        let rawDelta: string | undefined
        let rawEncoding: string | undefined
        let seq: number | undefined
        let processPid: number | undefined
        let processGroupId: number | undefined
        let processOwnerToken: string | undefined
        if (typeof payload === 'string') {
          message = payload
        } else if (payload) {
          message = payload.message
          raw = payload.raw
          rawDelta = payload.rawDelta
          rawEncoding = payload.rawEncoding
          seq = payload.seq
          processPid = payload.processPid
          processGroupId = payload.processGroupId
          processOwnerToken = payload.processOwnerToken
        }
        if (status === 'error') {
          logAgentEvent('error', 'tool.progress', {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            status,
            message
          })
        }
        if (message || rawDelta) {
          args.emitFactEvent?.({ type: 'tool-progress', id: toolUseId, seq: seq ?? 0, text: message ?? '', ...(rawDelta === undefined ? {} : { rawDelta }), ...(rawEncoding === undefined ? {} : { rawEncoding }), ...(processPid !== undefined ? { processPid } : {}), ...(processGroupId !== undefined ? { processGroupId } : {}), ...(processOwnerToken !== undefined ? { processOwnerToken } : {}) })
        }
        if (remoteContext && message?.trim()) {
          onRemoteToolProgress(
            buildRemoteProgressHookContext(sessionId, locale),
            {
              toolName,
              input: inputObj,
              status: 'executing',
              progressOutput: message
            },
            message
          )
        }
      }

      // 浏览器 act 危险评估（gate 的事实输入；评估留执行链路）
      let dangerAssessment: ActDangerAssessment | null = null
      if (toolName === 'browser' && inputObj.action === 'act' && sessionId && browserConfig) {
        const remoteActPath = Boolean(remoteContext)
        const shouldAssess =
          remoteActPath || browserConfig.actRequiresConfirm === true
        if (shouldAssess) {
          sendProgress('analyzing_risk', '正在检查本次操作…')
          try {
            dangerAssessment = await assessActDanger(
              sessionId,
              inputObj,
              browserConfig,
              stagehandService,
              undefined,
              remoteActPath ? { failClosedOnUncertainty: true } : undefined
            )
          } catch {
            dangerAssessment = remoteActPath
              ? {
                  dangerous: true,
                  source: 'page-effect',
                  userReason: '无法可靠判断本次页面操作风险，需确认后继续',
                  consequence: 'generic',
                  detail: 'assess_error'
                }
              : null
          }
        }
      }

      const currentPageUrl =
        toolName === 'browser' && sessionId ? stagehandService.peekCurrentUrl(sessionId) : undefined

      // ===== §5.5 直线流程：门控判定（组装上下文 → 事实提取 → decide → policy.decision 审计）=====
      const gate = await evaluateToolCallGate({
        toolName: resolvedToolName,
        toolInput: inputObj,
        sessionId,
        workDir,
        userDataDir,
        lane: effectiveLane,
        remoteContext,
        toolsConfig,
        shellConfig,
        browserConfig,
        feishuConfig,
        wechatConfig,
        // 缺料时保持 undefined 传递：由门控入口 fail-loud（B1 禁止静默回退）
        effectiveRules: args.gatePolicy?.effectiveRules as import('../src/shared/confirmation/types').PolicyRule[],
        decisionCache: args.gatePolicy?.decisionCache as import('./confirmation/toolCallGate').GateDecisionCache,
        shellPrecheck: args.gatePolicy?.shellPrecheck as { touchTrustedCommand: (command: string) => void },
        remoteBudgetState,
        dangerAssessment,
        currentPageUrl,
        mcpEntry: mcpSnapshot.entries.get(resolvedToolName),
        internalConfirmExemption: args.internalConfirmExemption
      })

      // run_shell 预检拒绝（validator 性质，gate 前置短路）
      if (gate.shellPrecheckDeny) {
        const command = typeof inputObj.command === 'string' ? inputObj.command : ''
        logShellSecurityDeny({
          requestId,
          sessionId,
          command,
          reason: gate.shellPrecheckDeny.auditReason,
          validatorId: gate.shellPrecheckDeny.validatorId,
          denyType: gate.shellPrecheckDeny.denyType
        })
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          gate.shellPrecheckDeny.error,
          gate.shellPrecheckDeny.error
        )
        await recordToolResult(buildToolErrorResult(toolUseId, gate.shellPrecheckDeny.error, { requestId, sessionId }), { success: false, error: gate.shellPrecheckDeny.error, notExecuted: true, notExecutedReason: 'policy_denied' })
        if (toolErrorRepeat.noteFailure(toolName, gate.shellPrecheckDeny.error)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${gate.shellPrecheckDeny.error}`
          break
        }
        continue
      }
      const shellPrecheck: RunShellPrecheckResult | null = gate.shellPrecheck
        ? {
            ok: true,
            ...gate.shellPrecheck,
            legacyAutoAllowEligible: gate.shellPrecheck.legacyAutoAllowEligible,
            legacyPolicy: gate.shellPrecheck.legacyPolicy
          }
        : null
      const shellSecurityHints: ShellSecurityHints | undefined = gate.shellPrecheck?.hints
      let preparedShellExecution: PreparedShellExecution | undefined
      const shellPolicyRevision = JSON.stringify({
        type: gate.decision.type,
        ruleId: gate.decision.ruleId,
        riskLevel: gate.decision.type === 'require-confirm' ? gate.decision.riskLevel : undefined,
        memoryTiers: gate.decision.type === 'require-confirm' ? gate.decision.memoryTiers : []
      })
      if (toolName === 'run_shell') {
        try {
          preparedShellExecution = await planRunShellExecution(inputObj, {
            workDir,
            userDataDir,
            shellConfig,
            policyRevision: shellPolicyRevision
          })
        } catch (error) {
          const code = error instanceof RunShellPlanError ? error.code : 'SHELL_PLAN_INVALID'
          const message = error instanceof Error ? error.message : String(error)
          logToolLoopError({ requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj }, message, message)
          // §10.3：不传 result 时内容会退化成「只有错误码」，模型必须再试错一轮才知道哪条语法错了。
          // 这里把计划错误的结构化 data（signals/hints/expectedDialect…）交给同一投影管道。
          const planDetails = error instanceof RunShellPlanError ? error.details : undefined
          const planResult: ToolExecutorResult | undefined = planDetails
            ? { success: false, error: code, userMessage: message, data: { code, ...planDetails } }
            : undefined
          await recordToolResult(
            buildToolErrorResult(toolUseId, code, { requestId, sessionId }, planResult, {
              workspaceRoot: workDir,
              processTool: true
            }),
            { success: false, error: message }
          )
          if (toolErrorRepeat.noteFailure(toolName, code)) {
            abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${code}`
            break
          }
          continue
        }
      }
      if (gate.shellPrecheck) {
        logShellPrecheck({
          requestId,
          sessionId,
          toolUseId,
          loopRound,
          command: typeof inputObj.command === 'string' ? inputObj.command : '',
          verdict: gate.shellPrecheck.analysis.verdict,
          skipConfirm: gate.shellPrecheck.legacyAutoAllowEligible,
          hints: gate.shellPrecheck.hints
        })
      }

      // 出站写预算耗尽 → 预算三选暂停流程（规则 remote-outbound-budget-pause-* 的映射）
      if (gate.budgetPause) {
        const pauseMsg = gate.budgetPause.message
        logAgentEvent('info', 'remote.budget.pause', {
          requestId,
          sessionId,
          toolUseId,
          toolName,
          reason: gate.budgetPause.reason
        })
        getSecurityAuditLog().record({
          ts: Date.now(),
          event: 'budget.exhausted',
          lane: effectiveLane,
          origin: { kind: 'direct-owner' },
          sessionId,
          toolName,
          reason: gate.budgetPause.reason,
          actor: 'system'
        })
        await recordToolResult(buildToolErrorResult(toolUseId, pauseMsg, { requestId, sessionId }), { success: false, error: pauseMsg, notExecuted: true, notExecutedReason: 'budget_paused' })
        abortRepeatedToolError = pauseMsg
        break
      }

      // 其余 deny → 用户可见错误（远程硬阻断 / 脚本危险 / 缓存 deny 等）
      if (gate.decision.type === 'deny') {
        let denyMsg = gate.decision.reason
        if (toolName === 'run_script' && gate.rawScriptAnalysis) {
          denyMsg = formatScriptDenyUserMessage(gate.rawScriptAnalysis.reason)
          logAgentEvent('info', 'script.deny', {
            requestId,
            sessionId,
            toolUseId,
            patterns: gate.rawScriptAnalysis.patterns,
            remote: Boolean(remoteContext)
          })
        }
        const blockedReason = gate.decision.ruleId.startsWith('remote-deny-')
          ? 'feishu_remote_write_blocked'
          : undefined
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          denyMsg,
          toolName === 'run_script' && gate.rawScriptAnalysis
            ? `script deny patterns=${gate.rawScriptAnalysis.patterns.join(',')}`
            : denyMsg
        )
        await recordToolResult(buildToolErrorResult(toolUseId, denyMsg, { requestId, sessionId }), { success: false, error: denyMsg, notExecuted: true, notExecutedReason: 'policy_denied' })
        // P1-3：策略 deny 属安全拒绝桶（阈值 5），不与执行失败共用计数
        if (toolErrorRepeat.noteFailure(toolName, denyMsg, undefined, 'safety')) {
          abortRepeatedToolError = `安全拒绝已连续出现 ${MAX_CONSECUTIVE_SAFETY_REJECT} 次，已停止：${denyMsg}`
          break
        }
        continue
      }
      if (toolName === 'run_script' && gate.rawScriptAnalysis) {
        logAgentEvent('info', gate.decision.type === 'require-confirm' ? 'script.ask' : 'script.allow.execute', {
          requestId,
          sessionId,
          toolUseId,
          patterns: gate.rawScriptAnalysis.patterns,
          remote: Boolean(remoteContext)
        })
      }

      // 判定通过：出站写记账（原相对位置：确认前）
      if (remoteBudgetState && isOutboundWriteTool(toolName, inputObj)) {
        recordOutboundWrite(remoteBudgetState)
      }

      let outcome: ToolConfirmOutcome = 'approved'
      let rejectReason: LegacyConfirmationRejectReason = 'user'
      /** rejectReason='policy' 时的细分来源（迁移期保持既有文案与 errorCode 可对照）。 */
      let rejectPolicyCode: LegacyPolicyCode | undefined
      /** 本次确认的回答者（I3：非 user 不得产生任何记忆写入）；缺省 user 保持既有路径等价。 */
      let confirmAnswererKind: ConfirmAnswererKind = 'user'
      /** 本次确认的结束原因（审计五问之「到底拿没拿到裁决」）。 */
      let confirmOutcomeCause: ConfirmOutcomeCause = 'user-approved'
      /** 通道裁决附带的模型可读理由（ConfirmOutcome.reason.summary，P1-2 回传）。 */
      let channelRejectSummary: string | undefined
      const autoApproveFallback: AutoApproveFallback | undefined = gate.autoApproveFallback
      if (autoApproveFallback) {
        logAgentEvent('info', 'file.auto_approve.fallback', {
          requestId,
          sessionId,
          toolUseId,
          toolName,
          relPath: typeof inputObj.path === 'string' ? inputObj.path : '',
          reason: autoApproveFallback.reason,
          reasonCode: autoApproveFallback.reasonCode
        })
      }
      // 桌面写/编辑自动批准：构建 diff/字节 meta（纯展示，判定已在 gate 完成）
      let fileAutoApproved = false
      let fileAutoApproveMeta: AutoApprovedWriteMeta | undefined
      if (gate.decision.type === 'auto-allow' && gate.decision.ruleId === 'desktop-auto-approve') {
        fileAutoApproved = true
        const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''
        const diff = await maybeBuildConfirmDiff(workDir, toolName, inputObj)
        let bytesWritten = 0
        if (toolName === 'write_file') {
          const content = typeof inputObj.content === 'string' ? inputObj.content : ''
          bytesWritten = Buffer.byteLength(content, 'utf8')
        } else if (diff) {
          bytesWritten = Buffer.byteLength(diff.newContent, 'utf8')
        }
        const stats = diff
          ? computeDiffLineStats(diff.oldContent, diff.newContent)
          : { add: 0, remove: 0 }
        fileAutoApproveMeta = {
          path: relPath,
          added: stats.add,
          removed: stats.remove,
          bytesWritten,
          ...(diff ? { diff } : {})
        }
      }
      const needsConfirm = gate.decision.type === 'require-confirm'
      const confirmMemoryTiers =
        gate.decision.type === 'require-confirm' ? gate.decision.memoryTiers : []
      const mcpEntryForConfirm = gate.mcpEntry

      if (needsConfirm) {
        const confirmLane = effectiveLane
        const askViaIm = remoteContext
          ? shouldRequestImConfirm(resolveRemoteContextConfirmPolicy(remoteContext, wechatConfig))
          : true
        if (remoteContext && !askViaIm) {
          // 远程只读策略：不发 IM 确认，直接拒绝
          outcome = 'rejected'
          rejectReason = 'policy'
          rejectPolicyCode = 'remote_read_only'
          logAgentEvent('info', 'tool.confirm.remote_read_only_reject', {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            remoteSource: remoteContext.source,
            confirmPolicy: remoteContext.confirmPolicy
          })
        } else {
          // 确认前展示（链路差异，纯展示不归通道）：远程进度 hook / 桌面卡片 + 浮动通知
          if (remoteContext) {
            onRemoteToolStateChange(buildRemoteProgressHookContext(sessionId, locale), {
              toolName,
              input: inputObj,
              status: 'confirming',
              progressOutput: undefined
            })
          } else {
          const useDiff =
            toolsConfig.confirmMode === 'diff' ||
            toolsConfig.confirmMode === 'auto' ||
            Boolean(autoApproveFallback)
          const diff = useDiff ? await maybeBuildConfirmDiff(workDir, toolName, inputObj) : undefined
          const actDanger =
            toolName === 'browser' && inputObj.action === 'act' && dangerAssessment?.dangerous
              ? dangerAssessment
              : null
          const actCurrentHost = currentPageUrl ? extractHostname(currentPageUrl) : null
          const sessionTrustedHint =
            !!actCurrentHost &&
            !!sessionId &&
            !actDanger &&
            isBrowserSessionActTrustedHost(sessionId, actCurrentHost)
              ? true
              : undefined
          const dangerInfo = actDanger
            ? {
                userReason: actDanger.userReason,
                consequence: actDanger.consequence ?? 'generic',
                source: actDanger.source!,
                ...(actDanger.fillPreview?.length ? { fillPreview: actDanger.fillPreview } : {})
              }
            : undefined
          args.emitFactEvent?.({
            type: 'confirm-requested',
            id: toolUseId,
            riskLevel: toolName === 'run_script' || toolName === 'run_lark_cli' || toolName === 'run_shell' ? 'high' : 'medium',
            ...(confirmMemoryTiers.length ? { memoryTiers: confirmMemoryTiers } : {}),
            ...(diff ? { confirmDiff: diff } : {}),
            ...(shellSecurityHints ? { shellSecurityHints } : {}),
            ...(autoApproveFallback ? { autoApproveFallback } : {}),
            ...(currentPageUrl ? { currentPageUrl } : {}),
            ...(dangerInfo ? { dangerInfo } : {}),
            ...(sessionTrustedHint ? { sessionTrustedHint: true as const } : {}),
            ...(mcpEntryForConfirm ? {
              mcp: {
                serverId: mcpEntryForConfirm.serverId,
                serverName: mcpEntryForConfirm.serverName,
                originalToolName: mcpEntryForConfirm.originalName,
                ...(mcpEntryForConfirm.description ? { description: mcpEntryForConfirm.description } : {})
              }
            } : {})
          })
          // 通知浮动通知管理器（P1：经 events.notify 出口，宿主实例由装配器包装）
          if (invocationEvents?.notify) {
            const session = hostStorage?.readSession?.(sessionId) as { name?: string } | undefined
            invocationEvents?.notify({
              kind: 'confirm-request',
              requestId,
              sessionId,
              sessionName: sessionDisplayNameRaw(session?.name, sessionId),
              toolUseId,
              toolName,
              input: inputObj
            })
          }
          }
          // §5.5 统一通道分发：channelFor(lane)；confirm.* 审计由通道内部以同一 requestId 落
          // P1-4：timeoutMs 真实消费决策层给的值（现状恒 null → 通道回退 5min 默认）；P2 起回答者配置可覆盖
          const confirmReq: ConfirmRequest = {
            facts: gate.facts,
            riskLevel: gate.decision.type === 'require-confirm' ? gate.decision.riskLevel : gate.facts.baseRiskLevel,
            memoryTiers: confirmMemoryTiers,
            timeoutMs: gate.decision.type === 'require-confirm' ? gate.decision.timeoutMs : null
          }
          // P2 回答者接线（I1）：回答者按配置解析（缺省值表）；kind='agent' 经工厂挂 AgentChannel，
          // invokeApproval 延迟加载审批执行链（避免 toolChatLoop ↔ approvalAgent 循环依赖）。
          const answererPolicy = hostAnswerer?.policy ?? resolveLaneAnswererPolicy(undefined, confirmLane)
          const channelOutcome = await channelFor({
            lane: confirmLane,
            requestId,
            toolUseId,
            sessionId,
            toolName,
            audit: getSecurityAuditLog(),
            answererPolicy,
            agentChannelFactory: (agentDeps) =>
              new AgentChannel({
                ...agentDeps,
                // D 任务声明透传（可信证据）：管家链路有任务上下文，桌面/IM 链路缺省无
                ...(args.approvalTaskDigest ? { taskDigest: args.approvalTaskDigest } : {}),
                invokeApproval: (inv) =>
                  import('./confirmation/approvalAgent').then((m) =>
                    m.runApprovalAgent(
                      {
                        db: hostAnswerer?.approvalDatabase as never,
                        workDir,
                        userDataDir,
                        getToolsConfig: () => toolsConfig,
                        ...(shellConfig !== undefined ? { getShellConfig: () => shellConfig } : {}),
                        ...(browserConfig ? { getBrowserConfig: () => browserConfig } : {}),
                        getWorkDir: () => (resolveWorkDir ? resolveWorkDir() : workDir),
                        // P1-1：凭证对配对传入——复用外层会话已解析的 model/baseUrl/getApiKey，
                        // 审批请求打用户实际服务端点（中转/自定义端点下不失效）；Profile 机制落地后按 approvalProfileId 解析独立快模型
                        model,
                        ...(baseUrl ? { baseUrl } : {}),
                        getApiKey
                      },
                      inv
                    )
                  )
              }),
            ...(remoteContext?.imChannel
              ? {
                  imChannel: remoteContext.imChannel,
                  buildImPending: () => ({
                    sessionId,
                    toolName,
                    toolInput: inputObj,
                    messageId: remoteContext.messageId,
                    matchKey:
                      remoteContext.source === 'feishu'
                        ? (remoteContext.chatId ?? '')
                        : (remoteContext.userId ?? ''),
                    context:
                      remoteContext.source === 'feishu' ? remoteContext.chatId : remoteContext.inboundRaw,
                    trustEligible:
                      toolName === 'run_shell' && shellPrecheck?.ok
                        ? canShowShellTrustOption(
                            shellPrecheck.analysis,
                            typeof inputObj.command === 'string' ? inputObj.command : undefined
                          )
                        : false,
                    ...(remoteContext.authOwner ? { authOwner: remoteContext.authOwner } : {}),
                    ...(remoteContext.authorizationGeneration != null
                      ? { authorizationGeneration: remoteContext.authorizationGeneration }
                      : {}),
                    requestId
                  })
                }
              : {})
          }).request(confirmReq)
          outcome =
            channelOutcome.kind === 'approved'
              ? 'approved'
              : channelOutcome.kind === 'timeout'
                ? 'timeout'
                : 'rejected'
          // 回答者与结束原因随 outcome 记录（缺省视为 user，保持既有桌面/IM 路径行为等价）
          if (channelOutcome.kind !== 'approved-with-action') {
            confirmAnswererKind = channelOutcome.answererKind ?? 'user'
            confirmOutcomeCause = channelOutcome.cause
            channelRejectSummary = channelOutcome.reason?.summary
          }
        }
        if (!remoteContext) {
          // 用户已确认/拒绝/超时，不再属于「待确认」；勿等到工具执行完毕才清除
          invocationEvents?.notify?.({ kind: 'tool-result', requestId, toolUseId })
          if (toolName === 'run_shell' && shellSecurityHints) {
            const command = typeof inputObj.command === 'string' ? inputObj.command : ''
            if (outcome === 'approved' && shellSecurityHints.requiresRiskAck) {
              if (shellSecurityHints.securityWarning) {
                logShellWeakDenyOutcome({
                  requestId,
                  sessionId,
                  command,
                  outcome: 'confirm',
                  hints: shellSecurityHints
                })
              } else {
                logShellPathConfirm({
                  requestId,
                  sessionId,
                  command,
                  outcome: 'confirm',
                  hints: shellSecurityHints
                })
              }
            } else if (outcome === 'rejected' && shellSecurityHints.requiresRiskAck) {
              if (shellSecurityHints.securityWarning) {
                logShellWeakDenyOutcome({
                  requestId,
                  sessionId,
                  command,
                  outcome: 'reject',
                  hints: shellSecurityHints
                })
              } else {
                logShellPathConfirm({
                  requestId,
                  sessionId,
                  command,
                  outcome: 'reject',
                  hints: shellSecurityHints
                })
              }
            }
          }
          logAgentEvent('info', 'tool.confirm', {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            outcome
          })
          throwIfChatCancelled(chatSignal)
        } else if (outcome === 'approved') {
          // 同步授权段（硬不变量）：IM 回答回来后与执行同一同步段完成租约/代际复核 + grant issue/reserve，
          // 期间无任何 await（防 TOCTOU，等价原 :1470 注释语义）
          const recheck = recheckRemoteWriteAuthorization(remoteContext, sessionId)
          if (!recheck.ok) {
            outcome = 'rejected'
            rejectReason = 'policy'
            rejectPolicyCode = 'authorization_revoked'
            logAgentEvent('warn', 'tool.confirm.authorization_revoked', {
              requestId,
              sessionId,
              toolUseId,
              toolName,
              expectedGeneration: remoteContext.authorizationGeneration,
              currentGeneration: recheck.currentGeneration,
              leaseOk: recheck.leaseOk,
              hasAuthOwner: recheck.hasAuthOwner
            })
          }
        }
      }

      // B3：remote-write 记忆缓存命中（记N 会话信任）同样过 owner/租约/代际复核——
      // 缓存命中不得跳过撤销检查，否则撤销/换绑后新 owner 会继承旧授权的写权限。
      if (
        outcome === 'approved' &&
        remoteContext &&
        gate.decision.type === 'auto-allow' &&
        gate.decision.ruleId === 'cache-hit' &&
        gate.decision.cacheKey?.kind === 'remote-write'
      ) {
        const recheck = recheckRemoteWriteAuthorization(remoteContext, sessionId)
        if (!recheck.ok) {
          outcome = 'rejected'
          rejectReason = 'policy'
          rejectPolicyCode = 'authorization_revoked'
          logAgentEvent('warn', 'tool.confirm.authorization_revoked', {
            requestId,
            sessionId,
            toolUseId,
            toolName,
            via: 'remote-write-cache-hit',
            expectedGeneration: remoteContext.authorizationGeneration,
            currentGeneration: recheck.currentGeneration,
            leaseOk: recheck.leaseOk,
            hasAuthOwner: recheck.hasAuthOwner
          })
        }
      }

      if (toolName === 'run_shell' && shellPrecheck?.ok) {
        const command = typeof inputObj.command === 'string' ? inputObj.command : ''
        logShellConfirmOutcome({
          requestId,
          sessionId,
          toolUseId,
          loopRound,
          command,
          outcome: shellPrecheck.legacyAutoAllowEligible && !needsConfirm ? 'skip_confirm' : outcome,
          skipConfirm: shellPrecheck.legacyAutoAllowEligible,
          hints: shellSecurityHints
        })
      }

      // 收窄 legacy confirm 状态为 coordinator 合同；下方仍保留既有文案和审计分支。
      const confirmationDecision = mapLegacyConfirmation({ outcome, needsConfirm, rejectReason, policyCode: rejectPolicyCode })
      if (needsConfirm) {
        args.emitFactEvent?.({
          type: 'tool-confirmed',
          id: toolUseId,
          approved: outcome === 'approved',
          ...(outcome !== 'approved' ? { reason: rejectReason ?? outcome } : {})
        })
      }

      if (outcome === 'timeout') {
        const timeoutError =
          remoteContext?.confirmTimeoutMessage ??
          (remoteContext
            ? REMOTE_CONFIRM_TIMEOUT_MESSAGES[remoteContext.source]
            : REMOTE_CONFIRM_TIMEOUT_MESSAGES.wechat)
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          timeoutError,
          timeoutError
        )
        await recordToolResult(buildToolErrorResult(toolUseId, timeoutError, { requestId, sessionId }), { success: false, error: timeoutError, notExecuted: true, notExecutedReason: 'confirm_timeout' })
        invocationEvents?.notify?.({ kind: 'tool-result', requestId, toolUseId })
        if (toolErrorRepeat.noteFailure(toolName, timeoutError)) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${timeoutError}`
          break
        }
        continue
      }
      if (
        outcome === 'approved' &&
        toolName === 'browser' &&
        inputObj.action === 'navigate' &&
        (typeof inputObj.mode !== 'string' || inputObj.mode === 'open') &&
        typeof inputObj.url === 'string' &&
        inputObj.url.trim()
      ) {
        // I3：记忆只源于人类——非 user 回答者（如审批 Agent）的批准不产生任何记忆写入
        if (confirmAnswererKind !== 'user') {
          logAgentEvent('info', 'tool.confirm.non_human_answerer_skip_memory', {
            requestId,
            sessionId,
            loopRound,
            toolUseId,
            toolName,
            answererKind: confirmAnswererKind,
            cause: confirmOutcomeCause
          })
        } else {
          rememberBrowserSessionTrustedUrl(sessionId, inputObj.url.trim())
          // 会话级信任双写 decision_cache（navigate 档 domain-any-action，键带 sessionId）——P2 经 persist 端口
          if (hostStorage?.persist?.recordUserAnswerFromDecision) {
            const navHost = extractHostname(inputObj.url.trim())
            if (navHost) {
              if (gate.decision.type !== 'require-confirm') {
                throw new Error('MEMORY_WRITE_REQUIRES_CONFIRM_DECISION')
              }
              hostStorage.persist.recordUserAnswerFromDecision({
                lane: effectiveLane,
                sessionId,
                key: { kind: 'domain', domain: navHost, level: 'domain-any-action', sessionId },
                decision: gate.decision,
                answererKind: confirmAnswererKind,
                source: 'user-confirm'
              })
            }
          }
        }
      }
      if (
        outcome === 'approved' &&
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        !dangerAssessment?.dangerous
      ) {
        const actUrl = stagehandService.peekCurrentUrl(sessionId)
        if (actUrl) {
          // I3：记忆只源于人类——非 user 回答者（如审批 Agent）的批准不产生任何记忆写入
          if (confirmAnswererKind !== 'user') {
            logAgentEvent('info', 'tool.confirm.non_human_answerer_skip_memory', {
              requestId,
              sessionId,
              loopRound,
              toolUseId,
              toolName,
              answererKind: confirmAnswererKind,
              cause: confirmOutcomeCause
            })
          } else {
            rememberBrowserSessionActTrust(sessionId, actUrl)
            // 会话级信任双写 decision_cache（act 档 domain+action，键带 sessionId）——P2 经 persist 端口
            if (hostStorage?.persist?.recordUserAnswerFromDecision) {
              const actHost = extractHostname(actUrl)
              if (actHost) {
                if (gate.decision.type !== 'require-confirm') {
                  throw new Error('MEMORY_WRITE_REQUIRES_CONFIRM_DECISION')
                }
                hostStorage.persist.recordUserAnswerFromDecision({
                  lane: effectiveLane,
                  sessionId,
                  key: { kind: 'domain', domain: actHost, level: 'domain+action', sessionId },
                  decision: gate.decision,
                  answererKind: confirmAnswererKind,
                  source: 'user-confirm'
                })
              }
            }
            logAgentEvent('info', 'browser.act.sessionTrust.remember', {
              sessionId,
              host: extractHostname(actUrl),
              timestamp: Date.now()
            })
          }
        }
      }
      if (
        outcome === 'approved' &&
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        dangerAssessment?.dangerous
      ) {
        logAgentEvent('info', 'browser.act.danger.confirmedNoTrust', {
          sessionId,
          source: dangerAssessment.source,
          userReason: dangerAssessment.userReason,
          consequence: dangerAssessment.consequence,
          timestamp: Date.now()
        })
      }

      if (!confirmationDecision.approved) {
        // P1-2 拒绝理由回传：优先通道裁决的 reason.summary（模型可读、可据此改方案）；
        // 无理由时按来源回退既有文案，迁移期文案逐一对照不回归。
        const rejectedError =
          confirmationDecision.errorCode === 'REMOTE_READ_ONLY'
            ? '远程只读策略禁止执行需确认的工具。请在设置中将「远程写确认策略」改为「微信/飞书确认」，或开启「大模型生成的脚本自动允许执行」。'
            : confirmationDecision.errorCode === 'AUTHORIZATION_REVOKED'
              ? '远程授权已撤销或当前请求不再持有执行租约，已拒绝执行此工具'
              : (channelRejectSummary ?? '用户拒绝执行此工具')
        // §7.6 #11：确认未批准覆盖三类来源（用户拒绝 / 远程只读 / 授权撤销），均未进入执行流程
        const notExecutedReason: ToolCallResultPersisted['notExecutedReason'] =
          confirmationDecision.errorCode === 'REMOTE_READ_ONLY'
            ? 'remote_read_only'
            : confirmationDecision.errorCode === 'AUTHORIZATION_REVOKED'
              ? 'authorization_revoked'
              : 'user_rejected'
        logToolLoopError(
          { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
          rejectedError,
          rejectedError
        )
        await recordToolResult(buildToolErrorResult(toolUseId, rejectedError, { requestId, sessionId }), { success: false, error: rejectedError, notExecuted: true, notExecutedReason })
        invocationEvents?.notify?.({ kind: 'tool-result', requestId, toolUseId })
        // P1-3：确认拒绝属安全拒绝桶（阈值 5）——管家 Agent 被拒后可改方案推进，Turn 不因 3 次拒绝而中止
        if (toolErrorRepeat.noteFailure(toolName, rejectedError, undefined, 'safety')) {
          abortRepeatedToolError = `安全拒绝已连续出现 ${MAX_CONSECUTIVE_SAFETY_REJECT} 次，已停止：${rejectedError}`
          break
        }
        continue
      }

      const relPath = typeof inputObj.path === 'string' ? inputObj.path : ''
      if (relPath && (toolName === 'write_file' || toolName === 'edit_file')) {
        const conflict = checkWritePathConflict(sessionId, relPath, workDir)
        if (conflict) {
          logToolLoopError(
            { requestId, sessionId, loopRound, toolUseId, toolName, input: inputObj },
            conflict,
            conflict
          )
          await recordToolResult(buildToolErrorResult(toolUseId, conflict, { requestId, sessionId }), { success: false, error: conflict })
          if (toolErrorRepeat.noteFailure(toolName, conflict)) {
            abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${conflict}`
            break
          }
          continue
        }
        claimWritePath(sessionId, relPath, workDir)
      }

      const signal = registerToolCancel(requestId, toolUseId)
      if (
        !needsConfirm &&
        toolName === 'browser' &&
        inputObj.action === 'act' &&
        !dangerAssessment?.dangerous &&
        currentPageUrl &&
        browserConfig?.actRequiresConfirm
      ) {
        const host = extractHostname(currentPageUrl)
        const persistent = host ? isTrustedDomain(host, browserConfig.actTrustedDomains) : false
        const sessionTrusted = host && sessionId ? isBrowserSessionActTrustedHost(sessionId, host) : false
        if (host && (persistent || sessionTrusted)) {
          sendProgress(
            'trust_auto_approved',
            `已信任「${host}」的常规操作，自动执行（敏感操作仍会询问）`
          )
          logAgentEvent('info', 'browser.act.trustAutoApproved', {
            sessionId,
            host,
            layer: persistent ? 'persistent' : 'session',
            timestamp: Date.now()
          })
        }
      }

      let execResult: ToolExecutorResult
      let execThrew = false
      const execStartedAt = Date.now()
      const toolUserConfirmed = needsConfirm && outcome === 'approved'
      if (isToolRevoked(requestId, resolvedToolName)) {
        await recordToolResult(buildToolErrorResult(toolUseId, 'tool_authorization_revoked', { requestId, sessionId }), { success: false, error: 'tool_authorization_revoked', notExecuted: true, notExecutedReason: 'authorization_revoked' })
        continue
      }
      if (remoteContext) {
        onRemoteToolStateChange(buildRemoteProgressHookContext(sessionId, locale), {
          toolName,
          input: inputObj,
          status: 'executing',
          progressOutput: undefined
        })
      }
      if (toolUserConfirmed && toolName === 'browser') {
        sendProgress('preparing', '正在准备浏览器…')
      }
      const trackSwitchToolInFlight = toolName === 'switch_session'
      if (!trackSwitchToolInFlight) {
        beginTool(sessionId, requestId, toolName)
      }
      try {
        try {
          const executionContext = {
            workDir,
            userDataDir,
            requestId,
            toolUseId,
            sessionId,
            sendProgress,
            recordDiagnostic: (entry: { code: string; message: string }) => {
              logAgentEvent('info', 'tool.result', {
                requestId,
                sessionId,
                toolName,
                code: entry.code,
                diagnostic: entry.message
              })
            },
            signal,
            fileStateCache: fileCache,
            toolsConfig,
            browserConfig,
            shellConfig,
            policyRevision: shellPolicyRevision,
            shellOutputMode,
            appDatabase: hostMcp?.executorDatabase as import('./database').AppDatabase,
            workDirManager,
            wikiConfig,
            feishuConfig,
            wechatConfig,
            larkCliRunner,
            remoteContext,
            toolUserConfirmed,
            getBrowserDetectContext,
            historyFacts: args.historyFacts
          }
          execResult = preparedShellExecution
            ? await executePreparedShellExecution(preparedShellExecution, executionContext, execStartedAt, {
                requestId,
                sessionId,
                toolUseId,
                command: preparedShellExecution.command,
                cwd: preparedShellExecution.cwd,
                shell: preparedShellExecution.spawnSpec.shellId,
                timeoutSec: preparedShellExecution.timeoutMs / 1000,
                ioMaxBytes: preparedShellExecution.ioMaxBytes,
                environmentFingerprint: preparedShellExecution.dependencySnapshot.environmentFingerprint,
                planDigest: preparedShellExecution.planDigest
              })
            : registeredTool
              ? await executeRegisteredTool(registeredTool, inputObj, {
                  requestId,
                  toolUseId,
                  signal,
                  executionContext
                }, {
                  confirm: coordinatorConfirmHook({ outcome, needsConfirm, rejectReason })
                }) as ToolExecutorResult
            : await exec!.execute(inputObj, executionContext)
          if (toolName === 'browser' && browserConfig) {
            stagehandService.scheduleIdleClose(sessionId, browserConfig.idleTimeoutSec)
          }
        } catch (e) {
          execThrew = true
          const userErr = toToolUserError(e, { toolName })
          execResult = { success: false, error: userErr }
          logToolLoopError(
            {
              requestId,
              sessionId,
              loopRound,
              toolUseId,
              toolName,
              input: inputObj,
              phase: 'execute_throw'
            },
            e,
            userErr
          )
        }
      } finally {
        clearToolCancel(requestId, toolUseId)
        if (!trackSwitchToolInFlight) {
          endTool(sessionId, requestId, toolName)
        }
        if (relPath && (toolName === 'write_file' || toolName === 'edit_file')) {
          releaseWritePath(sessionId, relPath)
        }
      }

      execResult = validateToolExecutorResultForTool(toolName, execResult)

      const durationMs = Date.now() - execStartedAt
      if (execResult.success && fileAutoApproved && (toolName === 'write_file' || toolName === 'edit_file')) {
        logAgentEvent('info', 'file.auto_approve', {
          requestId,
          sessionId,
          toolUseId,
          tool: toolName,
          relPath: fileAutoApproveMeta?.path ?? (typeof inputObj.path === 'string' ? inputObj.path : ''),
          bytesWritten: fileAutoApproveMeta?.bytesWritten ?? 0,
          timestamp: Date.now()
        })
      }

      if (execResult.success) {
        logAgentEvent('info', 'tool.result', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          success: true,
          ...((toolName === 'run_shell' || toolName === 'run_script') ? processResultLogData(execResult) : { data: execResult.data }),
          durationMs
        })
        toolErrorRepeat.noteSuccess(toolName)
      } else {
        const rawError = execResult.error ?? '执行失败'
        const userErr = execResult.userMessage ?? (execThrew ? (execResult.error ?? '执行失败') : sanitizeToolErrorString(rawError, toolName))
        if (!execThrew) {
          execResult = { ...execResult, userMessage: userErr }
          logToolLoopError(
            {
              requestId,
              sessionId,
              loopRound,
              toolUseId,
              toolName,
          ...((toolName === 'run_shell' || toolName === 'run_script') ? { inputFingerprint: createHash('sha256').update(String(inputObj.command ?? inputObj.code ?? '')).digest('hex') } : { input: inputObj }),
              durationMs
            },
            rawError,
            userErr
          )
        }
        logAgentEvent('info', 'tool.result', {
          requestId,
          sessionId,
          loopRound,
          toolUseId,
          toolName,
          success: false,
          ...(toolName === 'run_shell' || toolName === 'run_script'
            ? { errorCode: buildProcessToolLogErrorFields(rawError, userErr).error }
            : { error: userErr }),
          ...((toolName === 'run_shell' || toolName === 'run_script') ? processResultLogData(execResult) : {}),
          durationMs
        })
      }

      const rawPayload = formatToolResultPayload(execResult, {
        workspaceRoot: workDir,
        processTool
      })
      let payload = compactToolResultContentForApi(rawPayload, {
        requestId,
        sessionId,
        toolUseId
      })
      if (payload !== rawPayload) toolResultCompacted = true
      const recoverySkill =
        execResult.dependencyError &&
        resolveDependencyRecoverySkill(execResult.dependencyError.errorCode)

      let toolResultBlock: Anthropic.ToolResultBlockParam
      if (execResult.success) {
        toolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: payload
        }
      } else if (recoverySkill && execResult.dependencyError) {
        if (!recoverySkillFragment && hostStorage?.persist?.updateSessionMetadata && hostStorage.readSession) {
          const cur = hostStorage.readSession(sessionId) as { skillsState?: Parameters<typeof activateRecoverySkillInState>[0] } | undefined
          if (cur) {
            hostStorage.persist.updateSessionMetadata(sessionId, {
              skillsState: activateRecoverySkillInState(cur.skillsState, recoverySkill)
            })
            const skill = getSkillByName(userDataDir, workDir, recoverySkill)
            if (skill) {
              recoverySkillFragment = `<skill name="${skill.meta.name}" path="${skill.filePath}">\n${skill.content.trim()}\n</skill>`
            }
          }
        }
        toolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: compactToolResultContentForApi(
            formatDependencyRecoveryToolContent(execResult.dependencyError),
            { requestId, sessionId, toolUseId }
          )
        }
        if (toolErrorRepeat.noteFailure(toolName, execResult.error ?? 'dependency')) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${execResult.error ?? '依赖未就绪'}`
        }
      } else {
        const execError = execResult.error ?? '执行失败'
        toolResultBlock = buildToolErrorResult(toolUseId, execError, { requestId, sessionId }, execResult, {
          workspaceRoot: workDir,
          processTool
        })
        const processData = execResult.data && typeof execResult.data === 'object' ? execResult.data as Record<string, unknown> : undefined
        const retryIdentity = toolName === 'run_shell' && processData
          ? buildCommandRetryKey({
            toolName,
            errorCode: execError,
            status: typeof processData.status === 'string' ? processData.status : undefined,
            exitCode: typeof processData.exitCode === 'number' || processData.exitCode === null ? processData.exitCode : undefined,
            signal: typeof processData.signal === 'string' ? processData.signal : undefined,
            shellProfile: typeof processData.shell === 'string' ? processData.shell : undefined,
            planDigest: typeof processData.planDigest === 'string' ? processData.planDigest : undefined
          })
          : undefined
        if (shouldStopToolRetry(toolName, execError, execResult.data, toolErrorRepeat.noteFailure(toolName, execError, retryIdentity))) {
          abortRepeatedToolError = `同一工具错误已连续出现 ${MAX_CONSECUTIVE_SAME_TOOL_ERROR} 次，已停止：${execError}`
        }
      }
      const factResult = projectAgentToolResult({
        success: execResult.success,
        data: execResult.data,
        error: execResult.error,
        userMessage: execResult.userMessage,
      }, { workspaceRoot: workDir, processTool }) as ToolCallResultPersisted
      await recordToolResult(toolResultBlock, {
        ...factResult,
        ...(execResult.dependencyError ? { dependencyRecovery: execResult.dependencyError } : {}),
        ...(execResult.success && fileAutoApproveMeta ? { autoApprovedWrite: fileAutoApproveMeta } : {})
        ,...(execResult.displayData ? { displayData: execResult.displayData } : {})
      })
      if (execResult.success) {
        if (toolName === 'write_file' || toolName === 'edit_file') {
          const rel = typeof inputObj.path === 'string' ? inputObj.path.trim() : ''
          if (rel) args.onFileTreeChanged?.({ kind: 'paths', relPaths: [rel] })
        } else if (toolName === 'run_shell' || toolName === 'run_script') {
          args.onFileTreeChanged?.({ kind: 'refreshExpanded' })
        }
      }
      invocationEvents?.notify?.({ kind: 'tool-result', requestId, toolUseId })
      if (abortRepeatedToolError) break
    }

    messagesForApi = [...messagesForApi, { role: 'user', content: toolResults }]
    if (lastValidUsage && toolResults.length > 0) {
      const projected = projectUsageAfterToolResults(lastValidUsage, toolResults)
      args.emitFactEvent?.({ type: 'usage-updated', usage: projected, projected: true })
      if (lastRequestHeader && lastRequestContext) {
        const nextHeader = buildRequestHeaderPayload({ requestId: `${requestId}:surface:${loopRound}`, system: lastRequestHeader.system, tools: lastRequestHeader.tools, messages: [...messagesForApi], requiredSurfaceSet: lastRequestHeader.requiredSurfaceSet, toolExecutionCheckpoint: { completedToolUseIds: extractToolPairIds(messagesForApi as unknown as Array<{ content?: unknown }>).toolUses, replayForbidden: false } })
        const nextProjectionInput = {
          currentSurface: nextHeader.surfaceSnapshot,
          budget: lastRequestContext.budget,
          decision: { decisionId: `${requestId}:round:${loopRound}`, phase: 'tool_loop' as const, reason: 'proactive' as const, ruleVersion: 'adaptive-v1' },
          contextWindow: lastRequestContext.contextWindow,
          provider: lastRequestContext.provider,
          model: lastRequestContext.model
        }
        const nextProjection = args.contextMeter?.measure(nextProjectionInput) ?? computeContextPressure({
          ...nextProjectionInput,
          anchor: { requestId: lastRequestContext.requestId, surfaceTokens: lastRequestHeader.surfaceSnapshot.surfaceTokens, surfaceFingerprint: lastRequestHeader.surfaceSnapshot.fingerprint, systemFingerprint: lastRequestHeader.surfaceSnapshot.systemFingerprint, toolsFingerprint: lastRequestHeader.surfaceSnapshot.toolsFingerprint, provider: lastRequestContext.provider, model: lastRequestContext.model, estimatorVersion: lastRequestContext.budget.estimatorVersion, serializationVersion: lastRequestContext.budget.serializationVersion, realUsage: lastValidUsage, contextWindow: lastRequestContext.contextWindow.tokens }
        })
        const toolLoopPlan = planToolLoopCompaction({
          projection: { surfaceTokens: nextProjection.surfaceTokens, bodyTokens: nextProjection.bodyTokens, requiredTokens: lastRequestContext.budget.requiredTokens, totalInputBudget: lastRequestContext.budget.totalInputBudget, bodyBudget: lastRequestContext.budget.bodyBudget, targetBodyRatio: lastRequestContext.budget.targetBodyRatio },
          shouldCompact: shouldCompact(nextProjection, lastRequestContext.budget),
          prune: (projection) => ({ projection, status: toolResultCompacted ? 'applied' : 'no-op' })
        })
        args.emitFactEvent?.({ type: 'context-projection-updated', projection: nextProjection })
        await args.emitSessionEvent?.({ type: 'request_context', payload: buildRequestContextPayload({ requestId: `${requestId}:surface:${loopRound}`, provider: lastRequestContext.provider, model: lastRequestContext.model, contextWindow: lastRequestContext.contextWindow.tokens, maxTokensEffective: lastRequestContext.maxTokensEffective, surfaceSnapshot: nextHeader.surfaceSnapshot, contextUsage: nextProjection, planningStatus: toolLoopPlan.status, windowId: contextWindowId, decision: { decisionId: `${requestId}:round:${loopRound}`, phase: 'tool_loop', reason: 'proactive', ruleVersion: 'adaptive-v1' } }) })
      }
    }
    if (abortRepeatedToolError) {
      return failToolLoopWithLastUsage( requestId, sessionId, abortRepeatedToolError, lastValidUsage, args.emitFactEvent)
    }
  }
}

