import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG, mergeBrowserConfig } from '../../src/shared/domainTypes'
import { addTrustedActDomain, addTrustedDomain, removeTrustedActDomains } from './browserDomainTrust'

describe('browserDomainTrust act', () => {
  it('addTrustedActDomain dedupes and lowercases', () => {
    let cfg = DEFAULT_BROWSER_CONFIG
    cfg = addTrustedActDomain(cfg, 'GitHub.com')
    cfg = addTrustedActDomain(cfg, 'github.com')
    expect(cfg.actTrustedDomains).toEqual(['github.com'])
  })

  it('removeTrustedActDomains batch removes', () => {
    let cfg = addTrustedActDomain(DEFAULT_BROWSER_CONFIG, 'a.com')
    cfg = addTrustedActDomain(cfg, 'b.com')
    cfg = removeTrustedActDomains(cfg, ['a.com'])
    expect(cfg.actTrustedDomains).toEqual(['b.com'])
  })

  it('does not affect navigate trustedDomains', () => {
    let cfg = addTrustedDomain(DEFAULT_BROWSER_CONFIG, 'nav.com')
    cfg = addTrustedActDomain(cfg, 'act.com')
    expect(cfg.trustedDomains).toEqual(['nav.com'])
    expect(cfg.actTrustedDomains).toEqual(['act.com'])
  })
})

describe('mergeBrowserConfig act fields', () => {
  it('defaults missing act trust fields', () => {
    const merged = mergeBrowserConfig({ enabled: true })
    expect(merged.actSessionTrustEnabled).toBe(true)
    expect(merged.actTrustedDomains).toEqual([])
    expect(merged.actHighRiskKeywords.length).toBeGreaterThan(0)
  })
})
