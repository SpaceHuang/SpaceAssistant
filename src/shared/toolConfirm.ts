export type ToolConfirmOptions = {
  trustCommand?: string
  trustDomain?: string
  trustActDomain?: string
  /** MCP「本会话信任」（按 Session 作用域）。 */
  sessionId?: string
  trustMcpServerId?: string
  trustMcpToolName?: string
}

export type ToolConfirmHandler = (approved: boolean, options?: ToolConfirmOptions) => void
