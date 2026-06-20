import { describe, expect, it } from 'vitest'
import {
  annotateUsageCacheSemantics,
  inferCacheSemanticsFromRawUsage,
  resolveUsageCacheSemanticsFromBaseUrl
} from './usageCacheSemantics'

describe('resolveUsageCacheSemanticsFromBaseUrl', () => {
  it('returns additive for empty baseUrl', () => {
    expect(resolveUsageCacheSemanticsFromBaseUrl()).toBe('additive')
    expect(resolveUsageCacheSemanticsFromBaseUrl('')).toBe('additive')
  })

  it('returns additive for anthropic.com', () => {
    expect(resolveUsageCacheSemanticsFromBaseUrl('https://api.anthropic.com')).toBe('additive')
  })

  it('returns additive for deepseek anthropic endpoint', () => {
    expect(resolveUsageCacheSemanticsFromBaseUrl('https://api.deepseek.com/anthropic')).toBe('additive')
  })

  it('returns subset for openai.com', () => {
    expect(resolveUsageCacheSemanticsFromBaseUrl('https://api.openai.com/v1')).toBe('subset')
  })
})

describe('inferCacheSemanticsFromRawUsage', () => {
  it('detects OpenAI subset from prompt_tokens_details', () => {
    expect(
      inferCacheSemanticsFromRawUsage({
        prompt_tokens: 100_000,
        prompt_tokens_details: { cached_tokens: 80_000 }
      })
    ).toBe('subset')
  })

  it('detects Anthropic additive from native cache fields', () => {
    expect(
      inferCacheSemanticsFromRawUsage({
        input_tokens: 500,
        cache_read_input_tokens: 100_000
      })
    ).toBe('additive')
  })

  it('falls back to baseUrl when raw fields are ambiguous', () => {
    expect(inferCacheSemanticsFromRawUsage({ input_tokens: 1000 }, 'https://api.openai.com/v1')).toBe(
      'subset'
    )
  })
})

describe('annotateUsageCacheSemantics', () => {
  it('preserves existing cacheSemantics', () => {
    expect(
      annotateUsageCacheSemantics({ input_tokens: 100, cacheSemantics: 'subset' })
    ).toEqual({ input_tokens: 100, cacheSemantics: 'subset' })
  })

  it('annotates from raw usage', () => {
    expect(
      annotateUsageCacheSemantics(
        { input_tokens: 500, cache_read_input_tokens: 100_000 },
        { rawUsage: { input_tokens: 500, cache_read_input_tokens: 100_000 } }
      )
    ).toEqual({
      input_tokens: 500,
      cache_read_input_tokens: 100_000,
      cacheSemantics: 'additive'
    })
  })
})
