import dns from 'dns/promises'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { EventSourceInit } from 'eventsource'
import {
  McpEndpointValidationError,
  assertEndpointIpAllowed,
  isLoopbackHost,
  validateMcpEndpoint,
  validateMcpHeaderName
} from './endpointPolicy'
import type { EndpointPolicyOptions } from './endpointPolicy'

export { McpEndpointValidationError } from './endpointPolicy'

/**
 * Legacy SSE 传输安全封装：
 * - endpoint 校验与 DNS 解析校验复用 MCP HTTP 规则（per-profile allowPrivateNetwork 显式例外）。
 * - SSE GET 与 message POST 全部走 policy fetch，禁止跨 origin 与重定向。
 * - 不使用 OAuth provider；Bearer / 自定义头显式注入 GET 与 POST 两条路径。
 */
export type McpSseTransportOptions = {
  endpoint: string
  authHeaders?: Record<string, string>
  /** per-profile 显式例外：允许解析/连接私网地址（默认拒绝）。 */
  allowPrivateNetwork?: boolean
  onDiagnostic?: (line: string) => void
}

async function assertResolvedIpsAllowed(
  hostname: string,
  onDiagnostic: ((line: string) => void) | undefined,
  policyOptions?: EndpointPolicyOptions
): Promise<void> {
  if (isLoopbackHost(hostname)) return
  let addresses: Array<{ address: string }>
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch (error) {
    throw new McpEndpointValidationError(
      `Endpoint 域名解析失败：${error instanceof Error ? error.message : String(error)}`,
      'dns-resolve-failed'
    )
  }
  for (const { address } of addresses) {
    if (!assertEndpointIpAllowed(address, policyOptions?.allowPrivateNetwork === true)) {
      onDiagnostic?.(`Endpoint 解析到受限地址（${address}），已拒绝`)
      throw new McpEndpointValidationError(
        'Endpoint 解析到私网/保留地址，已拒绝。若该服务确实部署在内网，可在其 MCP 服务配置中开启「允许连接内网」后重试（需 https）',
        'resolved-private-address'
      )
    }
  }
}

function makePolicyFetch(
  configuredUrl: URL,
  onDiagnostic?: (line: string) => void
): typeof fetch {
  return async (input, init) => {
    const target =
      typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(String(input))
    if (target.origin !== configuredUrl.origin) {
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

export async function createSseTransport(options: McpSseTransportOptions): Promise<SSEClientTransport> {
  const policyOptions: EndpointPolicyOptions = { allowPrivateNetwork: options.allowPrivateNetwork === true }
  const validation = validateMcpEndpoint(options.endpoint, policyOptions)
  if (!validation.ok) {
    throw new McpEndpointValidationError(validation.message, validation.code)
  }
  const url = new URL(validation.normalized)
  await assertResolvedIpsAllowed(url.hostname, options.onDiagnostic, policyOptions)

  const authHeaders = options.authHeaders ?? {}
  for (const name of Object.keys(authHeaders)) {
    if (!validateMcpHeaderName(name)) {
      throw new McpEndpointValidationError(`受控请求头不允许: ${name}`)
    }
  }

  const policyFetch = makePolicyFetch(url, options.onDiagnostic)
  const eventSourceInit: EventSourceInit = {
    fetch: async (input, init) =>
      policyFetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...authHeaders
        }
      })
  }

  return new SSEClientTransport(url, {
    requestInit: { headers: authHeaders },
    eventSourceInit,
    fetch: policyFetch
  })
}
