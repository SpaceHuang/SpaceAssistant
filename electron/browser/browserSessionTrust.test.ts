import { afterEach, describe, expect, it } from 'vitest'
import {
  hostnamesForSessionTrust,
  isBrowserSessionTrustedHost,
  rememberBrowserSessionTrustedUrl,
  resetBrowserSessionTrustForTests
} from './browserSessionTrust'

describe('browserSessionTrust', () => {
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
