import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import { rememberBrowserSessionTrustedUrl, resetBrowserSessionTrustForTests } from './browserSessionTrust'
import { extractHostname, isTrustedDomain, validateUrl } from './urlSecurity'

const base = { ...DEFAULT_BROWSER_CONFIG, allowHttp: false }

describe('validateUrl', () => {
  afterEach(() => {
    resetBrowserSessionTrustForTests()
  })

  it('allows HTTPS URL after user confirmed navigate', () => {
    const r = validateUrl('https://example.com/docs', base, { userConfirmedNavigate: true })
    expect(r).toEqual({ valid: true, normalizedUrl: 'https://example.com/docs' })
  })

  it('allows trusted domain without confirm', () => {
    const cfg = { ...base, trustedDomains: ['docs.example.com'] }
    expect(validateUrl('https://docs.example.com/page', cfg).valid).toBe(true)
  })

  it('allows HTTP when allowHttp=true', () => {
    const cfg = { ...base, allowHttp: true, trustedDomains: ['example.com'] }
    expect(validateUrl('http://example.com', cfg).valid).toBe(true)
  })

  it('strips fragment from normalizedUrl', () => {
    const r = validateUrl('https://example.com#section', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.normalizedUrl).not.toContain('#section')
  })

  it('rejects unknown domain until confirmed', () => {
    const r = validateUrl('https://evil.com', base)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toContain('尚未授权')
  })

  it('allows navigate when user confirmed', () => {
    const r = validateUrl('https://sohu.com/page', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(true)
  })

  it('allows navigate when host was approved earlier in session', () => {
    rememberBrowserSessionTrustedUrl('sess-1', 'https://www.sohu.com/a')
    const r = validateUrl('https://news.sohu.com/b', base, { sessionId: 'sess-1' })
    expect(r.valid).toBe(true)
  })

  it('allows any domain when navigateRequiresConfirm is false', () => {
    const cfg = { ...base, navigateRequiresConfirm: false }
    expect(validateUrl('https://example.com', cfg).valid).toBe(true)
  })

  it('still rejects unsafe hosts when user confirmed', () => {
    const r = validateUrl('https://127.0.0.1', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects file protocol', () => {
    const r = validateUrl('file:///etc/passwd', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toBe('不允许的协议')
  })

  it('rejects HTTP when allowHttp=false', () => {
    const r = validateUrl('http://example.com', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toBe('不允许 HTTP')
  })

  it('rejects localhost', () => {
    const r = validateUrl('https://localhost', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.error).toBe('不允许 IP 地址或回环地址')
  })

  it('rejects 127.0.0.1', () => {
    const r = validateUrl('https://127.0.0.1', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects ::1', () => {
    const r = validateUrl('https://[::1]', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects private IP', () => {
    const r = validateUrl('https://192.168.1.1', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects public IP literal', () => {
    const r = validateUrl('https://8.8.8.8', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects invalid URL', () => {
    expect(validateUrl('not a url', base).valid).toBe(false)
  })

  it('rejects empty URL', () => {
    expect(validateUrl('', base).valid).toBe(false)
  })

  it('rejects URL without hostname', () => {
    expect(validateUrl('https://', base).valid).toBe(false)
  })

  it('rejects data protocol', () => {
    const r = validateUrl('data:text/html,<script>', base, { userConfirmedNavigate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects javascript pseudo protocol', () => {
    const r = validateUrl('javascript:alert(1)', base)
    expect(r.valid).toBe(false)
  })

  it('allows punycode when listed as trusted', () => {
    const cfg = { ...base, trustedDomains: ['xn--fiqs8s.com'] }
    expect(validateUrl('https://xn--fiqs8s.com', cfg).valid).toBe(true)
  })
})

describe('extractHostname', () => {
  it('extracts hostname from standard URL', () => {
    expect(extractHostname('https://example.com/path')).toBe('example.com')
  })

  it('returns null for invalid URL', () => {
    expect(extractHostname('not a url')).toBeNull()
  })

  it('strips port', () => {
    expect(extractHostname('https://example.com:8080/path')).toBe('example.com')
  })
})

describe('isTrustedDomain', () => {
  it('exact match', () => {
    expect(isTrustedDomain('docs.example.com', ['docs.example.com'])).toBe(true)
  })

  it('subdomain match when parent domain trusted', () => {
    expect(isTrustedDomain('docs.github.com', ['github.com'])).toBe(true)
    expect(isTrustedDomain('api.github.com', ['github.com'])).toBe(true)
    expect(isTrustedDomain('github.com', ['github.com'])).toBe(true)
  })

  it('no match for unrelated domain', () => {
    expect(isTrustedDomain('evil.com', ['example.com'])).toBe(false)
    expect(isTrustedDomain('notgithub.com', ['github.com'])).toBe(false)
  })

  it('empty list', () => {
    expect(isTrustedDomain('example.com', [])).toBe(false)
  })
})
