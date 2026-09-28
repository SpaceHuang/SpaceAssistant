import { validateMcpEndpoint } from './endpointPolicy'
import type { EndpointPolicyOptions } from './endpointPolicy'

/**
 * OAuth discovery 专用 fetch（评审 S5）：SDK 默认 fetch 自动跟随重定向，会绕过 endpoint
 * 安全策略（公网 302 → 内网探测）。这里手动跟随每一跳并对目标重新过 endpointPolicy；
 * 被拦截的跳转返回合成 403（SDK 会吞掉 fetchFn 抛错，用状态码表达失败）并记录拦截态，
 * 供结论文案区分「不支持 OAuth」与「发现被安全策略拦截」。超时经 AbortSignal 强制收敛（评审 S4）。
 *
 * allowPrivateNetwork（评审追加）：per-profile 显式例外随调用方透传，
 * 使「内网 MCP + OAuth」组合的授权服务器发现同样可用；默认拒绝语义不变。
 */

export const DISCOVERY_TIMEOUT_MS = 5_000
export const DISCOVERY_MAX_REDIRECTS = 3

export function createSafeDiscoveryFetch(
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  onBlocked?: (target: URL) => void,
  policyOptions?: EndpointPolicyOptions
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const assertTargetAllowed = (target: URL): boolean => {
    const validation = validateMcpEndpoint(target.toString(), policyOptions)
    if (!validation.ok) {
      onBlocked?.(target)
      return false
    }
    return true
  }
  return async (url, init) => {
    let current = new URL(url.toString())
    if (!assertTargetAllowed(current)) {
      return new Response(null, { status: 403, statusText: 'endpoint policy blocked' })
    }
    for (let hop = 0; ; hop++) {
      const response = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      if (response.status < 300 || response.status >= 400) return response
      const location = response.headers.get('location')
      if (!location) return response
      if (hop >= DISCOVERY_MAX_REDIRECTS) {
        onBlocked?.(current)
        return new Response(null, { status: 508, statusText: 'redirect loop limit' })
      }
      current = new URL(location, current)
      if (!assertTargetAllowed(current)) {
        return new Response(null, { status: 403, statusText: 'endpoint policy blocked' })
      }
    }
  }
}
