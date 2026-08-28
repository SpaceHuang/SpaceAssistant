import dns from 'dns/promises'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  assertEndpointIpAllowed,
  isLoopbackHost,
  validateMcpEndpoint,
  validateMcpHeaderName
} from './endpointPolicy'

/**
 * Streamable HTTP 传输安全封装：
 * - endpoint 校验（URL 边界 + 私网/保留地址拒绝）。
 * - DNS 解析后校验目标 IP（防 DNS rebinding）。
 * - 认证头注入（Bearer / 自定义头，token 不进日志）。
 * - 禁止跟随跨 origin 重定向（3xx 视为连接失败）。
 * - Mcp-Session-Id 由 SDK 传输管理。
 */

export class McpEndpointValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpEndpointValidationError'
  }
}

export type McpHttpTransportOptions = {
  endpoint: string
  authHeaders?: Record<string, string>
  authProvider?: OAuthClientProvider
  /** OAuth 授权服务器 origin 白名单（如 GitHub 的 github.com）；仅放行这些跨源端点。 */
  allowedExtraOrigins?: string[]
  onDiagnostic?: (line: string) => void
}

async function assertResolvedIpsAllowed(
  hostname: string,
  onDiagnostic?: (line: string) => void
): Promise<void> {
  if (isLoopbackHost(hostname)) return
  let addresses: Array<{ address: string }>
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch (error) {
    throw new McpEndpointValidationError(
      `Endpoint 域名解析失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  for (const { address } of addresses) {
    if (!assertEndpointIpAllowed(address)) {
      onDiagnostic?.(`Endpoint 解析到受限地址（${address}），已拒绝`)
      throw new McpEndpointValidationError('Endpoint 解析到私网/保留地址，已拒绝')
    }
  }
}

function makePolicyFetch(
  configuredUrl: URL,
  allowedExtraOrigins: ReadonlySet<string>,
  onDiagnostic?: (line: string) => void
): typeof fetch {
  return async (input, init) => {
    const target =
      typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input))
    if (target.origin !== configuredUrl.origin && !allowedExtraOrigins.has(target.origin)) {
      onDiagnostic?.(`跨 origin 请求被拒绝（${target.origin}）`)
      throw new McpEndpointValidationError('跨 origin 重定向/请求被拒绝')
    }
    const response = await fetch(input, { ...init, redirect: 'manual' })
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      onDiagnostic?.(`服务返回重定向（${response.status}），已拒绝`)
      throw new McpEndpointValidationError(
        `服务返回重定向（${response.status}）；请改为配置最终 endpoint，跨 origin 重定向被拒绝`
      )
    }
    return response
  }
}

export async function createStreamableHttpTransport(
  options: McpHttpTransportOptions
): Promise<StreamableHTTPClientTransport> {
  const validation = validateMcpEndpoint(options.endpoint)
  if (!validation.ok) {
    throw new McpEndpointValidationError(validation.message)
  }
  const url = new URL(validation.normalized)
  await assertResolvedIpsAllowed(url.hostname, options.onDiagnostic)

  const authHeaders = options.authHeaders ?? {}
  for (const name of Object.keys(authHeaders)) {
    if (!validateMcpHeaderName(name)) {
      throw new McpEndpointValidationError(`受控请求头不允许: ${name}`)
    }
  }
  const allowedExtraOrigins = new Set<string>()
  for (const origin of options.allowedExtraOrigins ?? []) {
    try {
      allowedExtraOrigins.add(new URL(origin).origin)
    } catch {
      options.onDiagnostic?.(`忽略非法 OAuth origin: ${origin}`)
    }
  }

  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: authHeaders },
    ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    fetch: makePolicyFetch(url, allowedExtraOrigins, options.onDiagnostic),
    // 不自动重连重放：取消/失败不重试 tools/call
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1
    }
  })
}
