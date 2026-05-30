import type { FeishuConfig } from '../../src/shared/feishuTypes'
import type { BrowserConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
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

export interface ToolExecutionContext {
  workDir: string
  userDataDir: string
  requestId: string
  toolUseId: string
  sessionId: string
  sendProgress: (status: string, message?: string) => void
  signal: AbortSignal
  fileStateCache: import('../fileStateCache').FileStateCache
  toolsConfig: ToolsConfig
  wikiConfig?: WikiConfig
  feishuConfig?: FeishuConfig
  browserConfig?: BrowserConfig
  appDatabase?: AppDatabase
  larkCliRunner?: LarkCliRunner
  remoteContext?: FeishuRemoteContext
  /** 用户已在确认卡片（或飞书确认）中明确批准执行本次工具调用 */
  toolUserConfirmed?: boolean
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
