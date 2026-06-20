import type { BrowserConfig } from '../../src/shared/domainTypes'
import {
  isBrowserSessionActTrustedHost,
  isBrowserSessionTrustedHost
} from './browserSessionTrust'
import { extractHostname, isTrustedDomain } from './urlSecurity'

export type BrowserAction = 'navigate' | 'observe' | 'extract' | 'act' | 'screenshot' | 'close'

/** 后果类别：驱动「可能后果」文案与视觉警示强度 */
export type ActDangerConsequence =
  | 'money'
  | 'data-loss'
  | 'account'
  | 'file'
  | 'unknown-site'
  | 'generic'

export type ActFillPreview = {
  selector: string
  method: string
  value: string
}

export type ActDangerAssessment = {
  dangerous: boolean
  source: 'page-effect' | 'target-effect' | 'keyword' | undefined
  userReason: string
  consequence: ActDangerConsequence | undefined
  detail?: string
  fillPreview?: ActFillPreview[]
}

export function isHighRiskInstruction(instruction: string, keywords: string[]): boolean {
  if (!instruction || keywords.length === 0) return false
  const lower = instruction.toLowerCase()
  return keywords.some((k) => k && lower.includes(k.toLowerCase()))
}

export function matchHighRiskKeyword(
  instruction: string,
  keywords: string[]
): string | undefined {
  if (!instruction || keywords.length === 0) return undefined
  const lower = instruction.toLowerCase()
  return keywords.find((k) => k && lower.includes(k.toLowerCase()))
}

export function keywordToConsequence(keyword: string): ActDangerConsequence {
  const k = keyword.toLowerCase()
  if (
    [
      '支付', '付款', '转账', '结账', 'checkout', 'pay', 'payment', 'transfer',
      '提交订单', '确认订单', 'place order', 'submit order', 'confirm order'
    ].some((w) => k.includes(w))
  ) {
    return 'money'
  }
  if (['删除', '移除', '清空', 'delete', 'remove', 'clear', 'destroy'].some((w) => k.includes(w))) {
    return 'data-loss'
  }
  if (
    ['登录', '登出', '注销', 'login', 'logout', 'sign in', 'sign out', 'register', '注册'].some(
      (w) => k.includes(w)
    )
  ) {
    return 'account'
  }
  if (['上传', '下载', 'upload', 'download'].some((w) => k.includes(w))) {
    return 'file'
  }
  return 'generic'
}

export function browserActionNeedsConfirmation(
  action: BrowserAction,
  input: Record<string, unknown>,
  cfg: BrowserConfig,
  sessionId?: string,
  currentPageUrl?: string,
  danger?: ActDangerAssessment | null
): boolean {
  if (action === 'act') {
    if (!cfg.actRequiresConfirm) return false
    if (danger?.dangerous) return true
    if (!cfg.actSessionTrustEnabled) return true
    const host = currentPageUrl ? extractHostname(currentPageUrl) : null
    if (!host) return true
    if (isTrustedDomain(host, cfg.actTrustedDomains)) return false
    if (sessionId && isBrowserSessionActTrustedHost(sessionId, host)) return false
    return true
  }
  if (action === 'navigate') {
    const mode = typeof input.mode === 'string' ? input.mode : 'open'
    if (mode !== 'open') return false
    if (!cfg.navigateRequiresConfirm) return false
    const url = typeof input.url === 'string' ? input.url : ''
    const host = extractHostname(url)
    if (!host) return true
    if (sessionId && isBrowserSessionTrustedHost(sessionId, host)) return false
    return !isTrustedDomain(host, cfg.trustedDomains)
  }
  return false
}

export function browserActionConsumesInference(action: BrowserAction): boolean {
  return action === 'observe' || action === 'extract' || action === 'act'
}

export function browserActionNeedsRateLimit(action: BrowserAction): boolean {
  return (
    action === 'navigate' ||
    action === 'observe' ||
    action === 'extract' ||
    action === 'act'
  )
}

export function resolveRateLimitDomain(
  action: BrowserAction,
  input: Record<string, unknown>,
  sessionLastUrl?: string,
  pageUrl?: string
): string | null {
  if (action === 'navigate') {
    const mode = typeof input.mode === 'string' ? input.mode : 'open'
    if (mode === 'open') {
      const url = typeof input.url === 'string' ? input.url : ''
      return extractHostname(url)
    }
  }
  const url = sessionLastUrl ?? pageUrl
  if (!url) return null
  return extractHostname(url)
}
