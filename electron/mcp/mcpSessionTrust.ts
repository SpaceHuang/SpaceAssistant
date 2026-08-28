/**
 * MCP 确认卡片「本会话信任」：作用域绑定当前聊天 Session（产品确认 2026-08-28），
 * 切换/新建会话即失效，不写入长期设置；应用重启清空。
 */

const trusted = new Set<string>()

function trustKey(sessionId: string, serverId: string, originalToolName: string): string {
  return `${sessionId}\0${serverId}\0${originalToolName}`
}

export function rememberMcpSessionTrust(
  sessionId: string,
  serverId: string,
  originalToolName: string
): void {
  trusted.add(trustKey(sessionId, serverId, originalToolName))
}

export function isMcpSessionTrusted(
  sessionId: string,
  serverId: string,
  originalToolName: string
): boolean {
  return trusted.has(trustKey(sessionId, serverId, originalToolName))
}

export function clearMcpSessionTrustForSession(sessionId: string): void {
  const prefix = `${sessionId}\0`
  for (const key of trusted) {
    if (key.startsWith(prefix)) trusted.delete(key)
  }
}

export function clearAllMcpSessionTrust(): void {
  trusted.clear()
}
