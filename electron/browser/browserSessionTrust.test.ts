import { afterEach, describe, expect, it } from 'vitest'
import {
  clearBrowserSessionActTrust,
  clearBrowserSessionTrust,
  hostnamesForSessionTrust,
  isBrowserSessionActTrustedHost,
  isBrowserSessionTrustedHost,
  listBrowserSessionActTrustedHosts,
  rememberBrowserSessionActTrust,
  rememberBrowserSessionTrustedUrl,
  resetBrowserSessionTrustForTests
} from './browserSessionTrust'

describe('browserSessionTrust navigate', () => {
  afterEach(() => {
    resetBrowserSessionTrustForTests()
  })

  it('hostnamesForSessionTrust includes suffix domain for multi-label hosts', () => {
    expect(hostnamesForSessionTrust('www.sohu.com')).toEqual(
      expect.arrayContaining(['www.sohu.com', 'sohu.com'])
    )
  })

  it('remembers host after navigate confirm and matches subdomains', () => {
    rememberBrowserSessionTrustedUrl('sess-1', 'https://www.sohu.com/xtopic/foo')
    expect(isBrowserSessionTrustedHost('sess-1', 'www.sohu.com')).toBe(true)
    expect(isBrowserSessionTrustedHost('sess-1', 'news.sohu.com')).toBe(true)
    expect(isBrowserSessionTrustedHost('sess-1', 'example.com')).toBe(false)
  })

  it('isolates trust per session', () => {
    rememberBrowserSessionTrustedUrl('sess-a', 'https://example.com')
    expect(isBrowserSessionTrustedHost('sess-b', 'example.com')).toBe(false)
  })
})

describe('browserSessionTrust act', () => {
  afterEach(() => {
    resetBrowserSessionTrustForTests()
  })

  it('remembers act trust and matches subdomains', () => {
    rememberBrowserSessionActTrust('sess-1', 'https://www.github.com/repo')
    expect(isBrowserSessionActTrustedHost('sess-1', 'docs.github.com')).toBe(true)
    expect(listBrowserSessionActTrustedHosts('sess-1').length).toBeGreaterThan(0)
  })

  it('act trust isolated from navigate trust', () => {
    rememberBrowserSessionTrustedUrl('sess-1', 'https://example.com')
    expect(isBrowserSessionActTrustedHost('sess-1', 'example.com')).toBe(false)
    rememberBrowserSessionActTrust('sess-1', 'https://example.com')
    expect(isBrowserSessionTrustedHost('sess-1', 'example.com')).toBe(true)
    expect(isBrowserSessionActTrustedHost('sess-1', 'example.com')).toBe(true)
  })

  it('clearBrowserSessionActTrust removes act trust only', () => {
    rememberBrowserSessionActTrust('sess-1', 'https://github.com')
    rememberBrowserSessionTrustedUrl('sess-1', 'https://github.com')
    clearBrowserSessionActTrust('sess-1')
    expect(isBrowserSessionActTrustedHost('sess-1', 'github.com')).toBe(false)
    expect(isBrowserSessionTrustedHost('sess-1', 'github.com')).toBe(true)
  })

  it('clearBrowserSessionTrust clears navigate only', () => {
    rememberBrowserSessionActTrust('sess-1', 'https://github.com')
    rememberBrowserSessionTrustedUrl('sess-1', 'https://github.com')
    clearBrowserSessionTrust('sess-1')
    expect(isBrowserSessionTrustedHost('sess-1', 'github.com')).toBe(false)
    expect(isBrowserSessionActTrustedHost('sess-1', 'github.com')).toBe(true)
  })
})
