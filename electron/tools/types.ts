import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import type { ImConfirmPolicy } from '../../src/shared/imTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { BrowserDetectContext } from '../../src/shared/browserTypes'
import type { AppDatabase } from '../database'
import type { WorkDirManager } from '../workDirManager'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import type { ImChannel } from '../confirmation/imChannel'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'

export interface RemoteContext {
  source: 'feishu' | 'wechat'
  messageId: string
  confirmPolicy: ImConfirmPolicy
  /**
   * IM outbound target session: reply suffix, idle-touch and follow-up routing. Initialized to
   * the origin session and reassigned in place by `switch_session`; never used for assistant
   * message creation, streaming, DB status, progress cleanup or backup — those stay on
   * `originSessionId` for the lifetime of the request.
   */
  outboundSessionId?: string
  chatId?: string
  userId?: string
  contextToken?: string
  inboundRaw?: IncomingMessage
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  larkCliRunner?: LarkCliRunner
  /** 合并后的 IM 确认通道单例（lane 由实例决定）；主循环经 channelFor 直接调用。 */
  imChannel?: ImChannel
  /** Tool-loop timeout error text; platforms set when building remoteContext. */
  confirmTimeoutMessage?: string
  appendWorkDirSwitchAudit?: (profileId: string, profileName: string) => void | Promise<void>
  appendSessionSwitchAudit?: (entry: SessionSwitchAuditEntry) => void | Promise<void>
  /** Authorization generation captured at inbound guard / agent start. */
  authorizationGeneration?: number
  /** Authenticated owner from inbound guard snapshot (OpenId / WeChat userId). */
  authOwner?: string
  /** Work-dir profile id bound for this remote request (write-grant key). */
  workDirProfileId?: string
  /** Immutable request id for lease ownership. */
  requestId?: string
  /**
   * Origin session that owns assistant messages, streaming/completion state, DB writes,
   * progress cleanup and backup scheduling. Immutable for the lifetime of the request —
   * `switch_session` never migrates it.
   */
  originSessionId?: string
}

/** Gradual-migration aliases — prefer RemoteContext going forward. */
export type FeishuRemoteContext = RemoteContext & { source: 'feishu' }
export type WeChatRemoteContext = RemoteContext & { source: 'wechat' }

export type ToolProgressPayload = { message?: string; raw?: string; rawDelta?: string; rawEncoding?: string; seq?: number; processPid?: number; processGroupId?: number; processOwnerToken?: string }

export interface ToolExecutionContext {
  workDir: string
  userDataDir: string
  requestId: string
  toolUseId: string
  sessionId: string
  sendProgress: (status: string, payload?: string | ToolProgressPayload) => void
  /** 仅记录不含 pattern、cwd、命中文本或文件名的工具诊断。 */
  recordDiagnostic?: (entry: { code: string; message: string }) => void | Promise<void>
  /** run_shell 有效输出模式（主进程在 toolChatLoop 解析） */
  shellOutputMode?: 'plain' | 'terminal'
  signal: AbortSignal
  fileStateCache: import('../fileStateCache').FileStateCache
  toolsConfig: ToolsConfig
  wikiConfig?: WikiConfig
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  browserConfig?: BrowserConfig
  shellConfig?: ShellConfig | null
  /** gate/policy snapshot used to detect stale prepared shell plans. */
  policyRevision?: string
  appDatabase?: AppDatabase
  workDirManager?: WorkDirManager
  larkCliRunner?: LarkCliRunner
  remoteContext?: RemoteContext
  /** 用户已在确认卡片（或飞书确认）中明确批准执行本次工具调用 */
  toolUserConfirmed?: boolean
  getBrowserDetectContext?: () => BrowserDetectContext
}

import type { BrowserDependencyToolError } from '../../src/shared/browserTypes'
import { isProcessToolName } from '../../src/shared/processResultProjection'

export interface ToolExecutorResult {
  success: boolean
  data?: unknown
  error?: string
  userMessage?: string
  diagnostic?: {
    caseId: string
    retryable: boolean
    category: 'command' | 'environment' | 'executor' | 'transport' | 'policy'
  }
  duration?: number
  dependencyError?: BrowserDependencyToolError
}

export function validateToolExecutorResult(result: unknown): ToolExecutorResult {
  if (!result || typeof result !== 'object' || typeof (result as { success?: unknown }).success !== 'boolean') {
    return {
      success: false,
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      userMessage: '执行器返回结果异常，请稍后重试',
      data: { processResult: null, status: 'result_invalid' },
      diagnostic: { caseId: 'SHELL_RESULT_CONTRACT_VIOLATION', retryable: false, category: 'executor' }
    }
  }
  const normalized = result as ToolExecutorResult
  const status = normalized.data && typeof normalized.data === 'object'
    ? (normalized.data as { status?: unknown }).status
    : undefined
  if ((normalized.success && status === 'failed') || (!normalized.success && status === 'succeeded')) {
    return {
      ...normalized,
      success: false,
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      data: { ...(normalized.data as Record<string, unknown>), status: 'result_invalid' },
      diagnostic: { caseId: 'SHELL_RESULT_CONTRACT_VIOLATION', retryable: false, category: 'executor' }
    }
  }
  if (!normalized.success && !normalized.error) {
    return {
      ...normalized,
      success: false,
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      data: normalized.data ?? { processResult: null, status: 'result_invalid' }
    }
  }
  return normalized
}

function validateGenericToolExecutorResult(result: unknown): ToolExecutorResult {
  if (!result || typeof result !== 'object' || typeof (result as { success?: unknown }).success !== 'boolean') {
    return {
      success: false,
      error: 'TOOL_RESULT_CONTRACT_VIOLATION',
      userMessage: '工具返回结果异常，请稍后重试',
      data: null,
      diagnostic: { caseId: 'TOOL_RESULT_CONTRACT_VIOLATION', retryable: false, category: 'executor' }
    }
  }
  const normalized = result as ToolExecutorResult
  if (!normalized.success && !normalized.error) {
    return { ...normalized, error: 'TOOL_RESULT_CONTRACT_VIOLATION' }
  }
  return normalized
}

/** 按工具类型选择结果契约；进程终态规则不得污染普通/MCP 工具。 */
export function validateToolExecutorResultForTool(toolName: string, result: unknown): ToolExecutorResult {
  return isProcessToolName(toolName)
    ? validateToolExecutorResult(result)
    : validateGenericToolExecutorResult(result)
}

export interface ToolExecutor {
  name: string
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutorResult>
}
