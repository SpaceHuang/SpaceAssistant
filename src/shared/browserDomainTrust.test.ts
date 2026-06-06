import { describe, expect, it } from 'vitest'
import { extractTrustableDomain } from './browserDomainTrust'

describe('extractTrustableDomain', () => {
  it('extracts second-level domain', () => {
    expect(extractTrustableDomain('https://docs.github.com/repo')).toBe('github.com')
  })

  it('handles co.uk public suffix', () => {
    expect(extractTrustableDomain('https://www.example.co.uk/path')).toBe('example.co.uk')
  })

  it('passes through localhost and IP', () => {
    expect(extractTrustableDomain('http://localhost:3000')).toBe('localhost')
    expect(extractTrustableDomain('http://192.168.1.1:8080/x')).toBe('192.168.1.1')
  })

  it('ignores port in hostname parsing via URL', () => {
    expect(extractTrustableDomain('https://example.com:8443/a')).toBe('example.com')
  })
})
