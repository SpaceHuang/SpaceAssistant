import type { CacheKey } from './confirmation/types'

export type ToolConfirmOptions = {
  trustCommand?: string
  trustDomain?: string
  trustActDomain?: string
  /** MCP「本会话信任」（按 Session 作用域）。 */
  sessionId?: string
  trustMcpServerId?: string
  trustMcpToolName?: string
  /** 用户在确认卡片选择的"记忆档位"（规范化缓存键；approve 时由执行链路写缓存）。 */
  memoryTier?: CacheKey
}

export type ToolConfirmHandler = (approved: boolean, options?: ToolConfirmOptions) => void
