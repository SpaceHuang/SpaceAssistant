import { extractHostname, normalizeHostnameForTrust } from './urlSecurity'

/** 单会话内用户已批准的 navigate(open) 主机名（仅内存，删除会话即清除） */
const trustedHostsBySession = new Map<string, Set<string>>()

/** 登记用于子域匹配的主机名变体（如 www.sohu.com → 同时登记 sohu.com） */
export function hostnamesForSessionTrust(hostname: string): string[] {
  const h = normalizeHostnameForTrust(hostname)
  const out = new Set<string>([h])
  const parts = h.split('.')
  if (parts.length > 2) {
    out.add(parts.slice(-2).join('.'))
  }
  return [...out]
}

export function rememberBrowserSessionTrustedUrl(sessionId: string, url: string): void {
  const host = extractHostname(url)
  if (!host || !sessionId) return
  let set = trustedHostsBySession.get(sessionId)
  if (!set) {
    set = new Set()
    trustedHostsBySession.set(sessionId, set)
  }
  for (const h of hostnamesForSessionTrust(host)) {
    set.add(h)
  }
}

export function isBrowserSessionTrustedHost(sessionId: string, hostname: string): boolean {
  const set = trustedHostsBySession.get(sessionId)
  if (!set || set.size === 0) return false
  const h = normalizeHostnameForTrust(hostname)
  for (const t of set) {
    if (h === t || h.endsWith('.' + t)) return true
  }
  return false
}

export function clearBrowserSessionTrust(sessionId: string): void {
  trustedHostsBySession.delete(sessionId)
}

/** 测试用 */
export function resetBrowserSessionTrustForTests(): void {
  trustedHostsBySession.clear()
}
