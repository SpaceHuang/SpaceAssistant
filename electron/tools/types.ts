import type { ToolsConfig } from '../../src/shared/domainTypes'

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
