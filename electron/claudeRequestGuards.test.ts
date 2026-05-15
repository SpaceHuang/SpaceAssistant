import { describe, expect, it } from 'vitest'
import { assertValidModel, assertValidOptionalAnthropicBaseUrl, assertValidRequestId } from './claudeRequestGuards'

describe('claudeRequestGuards', () => {
  it('assertValidRequestId trims and validates', () => {
    expect(assertValidRequestId('  abc  ')).toBe('abc')
    expect(() => assertValidRequestId('')).toThrow()
  })

  it('assertValidModel trims and validates', () => {
    expect(assertValidModel(' claude-1 ')).toBe('claude-1')
    expect(() => assertValidModel('')).toThrow()
  })

  it('assertValidOptionalAnthropicBaseUrl accepts http(s) only', () => {
    expect(assertValidOptionalAnthropicBaseUrl(undefined)).toBeUndefined()
    expect(assertValidOptionalAnthropicBaseUrl('')).toBeUndefined()
    expect(assertValidOptionalAnthropicBaseUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com')
    expect(() => assertValidOptionalAnthropicBaseUrl('ftp://x')).toThrow()
  })
})
