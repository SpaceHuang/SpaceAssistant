import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { FeishuConfig } from '../../src/shared/feishuTypes'
import type { ImConfirmPolicy } from '../../src/shared/imTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { BrowserDetectContext } from '../../src/shared/browserTypes'
import type { AppDatabase } from '../database'
import type { WorkDirManager } from '../workDirManager'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import type { FeishuConfirmManager } from '../feishu/feishuConfirmManager'
import type { WeChatConfirmManager } from '../wechat/weChatConfirmManager'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'

export type RemoteConfirmDecision = 'y' | 'n' | 'timeout'

export type RemoteConfirmPayload = {
  sessionId: string
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  messageId: string
  chatId?: string
  userId?: string
  inboundRaw?: IncomingMessage
}

/** Shared confirm-manager surface used by remote session tools (pending checks). */
export type RemoteConfirmManager = FeishuConfirmManager | WeChatConfirmManager

export interface RemoteContext {
  source: 'feishu' | 'wechat'
  messageId: string
  confirmPolicy: ImConfirmPolicy
  sessionId?: string
  chatId?: string
  userId?: string
  contextToken?: string
  inboundRaw?: IncomingMessage
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  larkCliRunner?: LarkCliRunner
  confirmManager?: RemoteConfirmManager
  /** Platform adapter set when building remoteContext; prefer over source if/else in bridge. */
  requestToolConfirm?: (payload: RemoteConfirmPayload) => Promise<RemoteConfirmDecision>
  /** Tool-loop timeout error text; platforms set when building remoteContext. */
  confirmTimeoutMessage?: string
  appendWorkDirSwitchAudit?: (profileId: string, profileName: string) => void | Promise<void>
  appendSessionSwitchAudit?: (entry: SessionSwitchAuditEntry) => void | Promise<void>
}

/** Gradual-migration aliases — prefer RemoteContext going forward. */
export type FeishuRemoteContext = RemoteContext & { source: 'feishu' }
export type WeChatRemoteContext = RemoteContext & { source: 'wechat' }

export type ToolProgressPayload = { message?: string; raw?: string; rawDelta?: string; seq?: number }

export interface ToolExecutionContext {
  workDir: string
  userDataDir: string
  requestId: string
  toolUseId: string
  sessionId: string
  sendProgress: (status: string, payload?: string | ToolProgressPayload) => void
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
  appDatabase?: AppDatabase
  workDirManager?: WorkDirManager
  larkCliRunner?: LarkCliRunner
  remoteContext?: RemoteContext
  /** 用户已在确认卡片（或飞书确认）中明确批准执行本次工具调用 */
  toolUserConfirmed?: boolean
  getBrowserDetectContext?: () => BrowserDetectContext
}

import type { BrowserDependencyToolError } from '../../src/shared/browserTypes'

export interface ToolExecutorResult {
  success: boolean
  data?: unknown
  error?: string
  duration?: number
  dependencyError?: BrowserDependencyToolError
}

export interface ToolExecutor {
  name: string
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutorResult>
}
