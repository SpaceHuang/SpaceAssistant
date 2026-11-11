import { describe, expect, it } from 'vitest'
import { createInvocationExtractorVersion } from './extractorVersion'

describe('createInvocationExtractorVersion', () => {
  it('canonicalizes component order and includes only participating extractors', () => {
    expect(createInvocationExtractorVersion({ 'script-analysis': 'v2', 'invocation-facts': 'v1' }))
      .toBe('{"invocation-facts":"v1","script-analysis":"v2"}')
    expect(createInvocationExtractorVersion({ 'invocation-facts': 'v1' })).toBe('{"invocation-facts":"v1"}')
  })

  it('rejects empty producer identities or versions', () => {
    expect(() => createInvocationExtractorVersion({ 'script-analysis': '' })).toThrow('EXTRACTOR_VERSION_COMPONENT_INVALID')
  })
})
