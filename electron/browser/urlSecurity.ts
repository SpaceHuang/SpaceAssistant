import { isIP } from 'node:net'
import type { BrowserConfig } from '../../src/shared/domainTypes'
import { isBrowserSessionTrustedHost } from './browserSessionTrust'

export type ValidateUrlOptions = {
  /** 用户已在工具确认卡片中批准本次 navigate */
  userConfirmedNavigate?: boolean
  /** 当前 SpaceAssistant 会话 id，用于会话内已批准域名 */
  sessionId?: string
}

export function normalizeHostnameForTrust(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

export type UrlValidationResult =
  | { valid: true; normalizedUrl: string }
  | { valid: false; error: string }

function normalizeHostname(hostname: string): string {
  return normalizeHostnameForTrust(hostname)
}

export function extractHostname(url: string): string | null {
  try {
    const u = new URL(url)
    const h = u.hostname
    if (!h) return null
    return normalizeHostname(h)
  } catch {
    return null
  }
}

export function isTrustedDomain(hostname: string, trustedDomains: string[]): boolean {
  if (trustedDomains.length === 0) return false
  const h = normalizeHostname(hostname)
  return trustedDomains.some((d) => normalizeHostname(d) === h)
}

function hostForIpCheck(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1)
  return hostname
}

function isLoopbackOrIp(hostname: string): boolean {
  const h = normalizeHostname(hostname)
  const ipHost = hostForIpCheck(h)
  if (h === 'localhost') return true
  if (isIP(ipHost) !== 0) return true
  return false
}

function isNavigateDomainAuthorized(
  hostname: string,
  config: BrowserConfig,
  options?: ValidateUrlOptions
): boolean {
  if (!config.navigateRequiresConfirm) return true
  if (options?.userConfirmedNavigate) return true
  if (options?.sessionId && isBrowserSessionTrustedHost(options.sessionId, hostname)) return true
  if (isTrustedDomain(hostname, config.trustedDomains)) return true
  return false
}

export function validateUrl(
  url: string,
  config: BrowserConfig,
  options?: ValidateUrlOptions
): UrlValidationResult {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { valid: false, error: '无效的 URL' }
  }

  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return { valid: false, error: '无效的 URL' }
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol === 'javascript:' || protocol === 'vbscript:') {
    return { valid: false, error: '无效的 URL' }
  }
  if (protocol === 'https:') {
    // ok
  } else if (protocol === 'http:' && config.allowHttp) {
    // ok
  } else if (protocol === 'http:') {
    return { valid: false, error: '不允许 HTTP' }
  } else {
    return { valid: false, error: '不允许的协议' }
  }

  const hostname = parsed.hostname
  if (!hostname) {
    return { valid: false, error: '无效的 URL' }
  }

  if (isLoopbackOrIp(hostname)) {
    return { valid: false, error: '不允许 IP 地址或回环地址' }
  }

  if (!isNavigateDomainAuthorized(hostname, config, options)) {
    return { valid: false, error: '该域名尚未授权，请先在确认卡片中批准访问' }
  }

  parsed.hash = ''
  const normalizedUrl = parsed.toString()
  return { valid: true, normalizedUrl }
}
