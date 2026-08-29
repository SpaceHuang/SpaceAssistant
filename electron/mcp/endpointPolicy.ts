/**
 * MCP Streamable HTTP endpoint 校验（纯逻辑，可测）：
 * - URL 规范化与校验：禁 userinfo/query/fragment；https 或 http 仅 loopback。
 * - 网络边界：仅公网地址与 loopback；拒绝私网、链路本地、组播与其他保留地址。
 * - 受控请求头黑名单。
 */

export type EndpointValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; code: string; message: string }

export class McpEndpointValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpEndpointValidationError'
  }
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255) return null
    nums.push(n)
  }
  return nums
}

function parseIpv6(host: string): string | null {
  if (!host.includes(':')) return null
  try {
    const hex = host.toLowerCase()
    // 简单结构校验：至少 2 段，允许 :: 压缩
    return /^[0-9a-f:]+$/.test(hex) ? hex : null
  } catch {
    return null
  }
}

function normalizeHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** loopback：localhost 与 127/8、::1。 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host).toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const v4 = parseIpv4(h)
  return v4 ? v4[0] === 127 : false
}

/** 私网/链路本地/组播/保留地址判定（公网与 loopback 之外一律拒绝）。 */
export function isPrivateOrReservedIp(host: string): boolean {
  const h = normalizeHost(host)
  const v4 = parseIpv4(h)
  if (v4) {
    const [a, b] = v4
    if (a === 0) return true
    if (a === 10) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT RFC6598
    if (a === 127) return false // loopback 允许
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0 && v4[2] === 0) return true // IETF 保留
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true // 组播与保留
    return false
  }
  const v6 = parseIpv6(h)
  if (v6) {
    if (v6 === '::' || v6 === '::1' || v6 === '0:0:0:0:0:0:0:1') return v6 === '::'
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true // unique local
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true
    if (v6.startsWith('ff')) return true // multicast
    if (v6.startsWith('::ffff:')) {
      const mapped = v6.slice('::ffff:'.length)
      return isPrivateOrReservedIp(mapped)
    }
    return false
  }
  return false
}

/** 供 DNS 解析后的实际 IP 校验（连接前后）。 */
export function assertEndpointIpAllowed(ip: string): boolean {
  return !isPrivateOrReservedIp(ip) || isLoopbackHost(ip)
}

export function validateMcpEndpoint(
  endpoint: string,
  _options?: { allowHttpLoopback?: boolean }
): EndpointValidationResult {
  let url: URL
  try {
    url = new URL(endpoint.trim())
  } catch {
    return { ok: false, code: 'invalid-url', message: 'MCP Endpoint 必须是完整绝对 URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'invalid-scheme', message: '仅支持 https，或 http 的 loopback 地址' }
  }
  if (url.username || url.password) {
    return { ok: false, code: 'userinfo-forbidden', message: 'Endpoint 不允许包含用户名/密码' }
  }
  if (url.search) {
    return { ok: false, code: 'query-forbidden', message: 'Endpoint 不允许包含 query 参数' }
  }
  if (url.hash) {
    return { ok: false, code: 'fragment-forbidden', message: 'Endpoint 不允许包含 fragment' }
  }

  const host = url.hostname
  if (url.protocol === 'http:' && !isLoopbackHost(host)) {
    return { ok: false, code: 'http-non-loopback', message: 'http:// 仅允许 loopback（localhost / 127.0.0.1 / ::1）' }
  }
  if (isPrivateOrReservedIp(host)) {
    return { ok: false, code: 'private-address', message: '拒绝私网、链路本地、组播及其他保留地址' }
  }

  url.hostname = url.hostname.toLowerCase()
  return { ok: true, normalized: url.origin + url.pathname }
}

export const CONTROLLED_HEADERS = [
  'host',
  'content-length',
  'connection',
  'cookie',
  'origin',
  'mcp-session-id'
]

const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function validateMcpHeaderName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || !HEADER_TOKEN_RE.test(trimmed)) return false
  const lower = trimmed.toLowerCase()
  return !CONTROLLED_HEADERS.includes(lower)
}
