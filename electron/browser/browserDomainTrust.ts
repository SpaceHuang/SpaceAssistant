import type { BrowserConfig } from '../../src/shared/domainTypes'
import { extractTrustableDomain } from '../../src/shared/browserDomainTrust'

export { extractTrustableDomain }

export function addTrustedDomain(config: BrowserConfig, domain: string): BrowserConfig {
  const d = domain.trim().toLowerCase()
  if (!d) return config
  const set = new Set((config.trustedDomains ?? []).map((x) => x.toLowerCase()))
  set.add(d)
  return { ...config, trustedDomains: [...set] }
}

export function removeTrustedDomains(config: BrowserConfig, domains: string[]): BrowserConfig {
  const remove = new Set(domains.map((d) => d.toLowerCase()))
  return {
    ...config,
    trustedDomains: (config.trustedDomains ?? []).filter((d) => !remove.has(d.toLowerCase()))
  }
}

export function addTrustedActDomain(config: BrowserConfig, domain: string): BrowserConfig {
  const d = domain.trim().toLowerCase()
  if (!d) return config
  const set = new Set((config.actTrustedDomains ?? []).map((x) => x.toLowerCase()))
  set.add(d)
  return { ...config, actTrustedDomains: [...set] }
}

export function removeTrustedActDomains(config: BrowserConfig, domains: string[]): BrowserConfig {
  const remove = new Set(domains.map((d) => d.toLowerCase()))
  return {
    ...config,
    actTrustedDomains: (config.actTrustedDomains ?? []).filter((d) => !remove.has(d.toLowerCase()))
  }
}
