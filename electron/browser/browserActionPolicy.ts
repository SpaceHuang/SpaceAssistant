import type { BrowserConfig } from '../../src/shared/domainTypes'
import { isBrowserSessionTrustedHost } from './browserSessionTrust'
import { extractHostname, isTrustedDomain } from './urlSecurity'

export type BrowserAction = 'navigate' | 'observe' | 'extract' | 'act' | 'screenshot' | 'close'

export function browserActionNeedsConfirmation(
  action: BrowserAction,
  input: Record<string, unknown>,
  cfg: BrowserConfig,
  sessionId?: string
): boolean {
  if (action === 'act') {
    return cfg.actRequiresConfirm
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
