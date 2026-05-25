import type { FeishuConfig } from '../../src/shared/feishuTypes'
import type { ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import type { FeishuConfirmManager } from '../feishu/feishuConfirmManager'

export interface FeishuRemoteContext {
  source: 'feishu'
  messageId: string
  confirmPolicy: FeishuConfig['remoteConfirmPolicy']
  feishuConfig?: FeishuConfig
  confirmManager?: FeishuConfirmManager
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
  larkCliRunner?: LarkCliRunner
  remoteContext?: FeishuRemoteContext
}

export interface ToolExecutorResult {
  success: boolean
  data?: unknown
  error?: string
  duration?: number
}

export interface ToolExecutor {
  name: string
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutorResult>
}
