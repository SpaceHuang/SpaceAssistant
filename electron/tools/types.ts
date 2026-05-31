import type { FeishuConfig } from '../../src/shared/feishuTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { BrowserDetectContext } from '../../src/shared/browserTypes'
import type { AppDatabase } from '../database'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import type { FeishuConfirmManager } from '../feishu/feishuConfirmManager'

export interface FeishuRemoteContext {
  source: 'feishu'
  messageId: string
  confirmPolicy: FeishuConfig['remoteConfirmPolicy']
  feishuConfig?: FeishuConfig
  confirmManager?: FeishuConfirmManager
  larkCliRunner?: LarkCliRunner
  chatId?: string
  sessionId?: string
}

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
  browserConfig?: BrowserConfig
  shellConfig?: ShellConfig | null
  appDatabase?: AppDatabase
  larkCliRunner?: LarkCliRunner
  remoteContext?: FeishuRemoteContext
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
