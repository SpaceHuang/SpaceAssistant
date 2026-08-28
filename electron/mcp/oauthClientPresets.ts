/**
 * OAuth Client 预设目录（只读，随版本发布）。
 * 加入准入门槛（2026-08-28 产品确认）：服务商公开注册依据 + loopback 回调验证 + 集成测试；
 * 无法核实则目录留空，不阻塞主链路（手工 clientId 兜底始终可用）。
 */

export interface McpOAuthClientPreset {
  presetId: string
  displayName: string
  /** 允许的 MCP Server origin（精确匹配）。 */
  serverOrigin: string
  /** Authorization Server issuer（精确匹配）。 */
  issuer: string
  /** 公开 clientId（public client，不保存 secret）。 */
  clientId: string
  allowedScopes: string[]
  /** loopback 回调策略（桌面应用固定端口）。 */
  redirectUriPolicy: 'loopback'
}

/**
 * 首批预设（2026-08-28）：仅 GitHub 候选；因尚无公开 OAuth App 注册依据与
 * loopback 回调验证证据，本期目录留空。后续按同一准入门槛逐个迭代接入。
 */
export const MCP_OAUTH_CLIENT_PRESETS: McpOAuthClientPreset[] = []

/** 精确匹配：MCP Server origin 与 Authorization Server issuer 均须逐字符一致。 */
export function matchOauthClientPreset(
  serverOrigin: string,
  issuer: string,
  presets: readonly McpOAuthClientPreset[] = MCP_OAUTH_CLIENT_PRESETS
): McpOAuthClientPreset | undefined {
  const origin = normalizeOrigin(serverOrigin)
  const normalizedIssuer = issuer.replace(/\/+$/, '')
  return presets.find(
    (p) =>
      normalizeOrigin(p.serverOrigin) === origin &&
      p.issuer.replace(/\/+$/, '') === normalizedIssuer
  )
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value)
    return url.origin.toLowerCase()
  } catch {
    return value.toLowerCase().replace(/\/+$/, '')
  }
}
