import { describe, expect, it } from 'vitest'
import { normalizeAnthropicMessageUsage, pickInputTokensFromUsageObject } from './anthropicUsageNormalize'

describe('pickInputTokensFromUsageObject', () => {
  it('falls back to total_tokens when standard fields are missing', () => {
    expect(pickInputTokensFromUsageObject({ total_tokens: 12_000 })).toBe(12_000)
  })

  it('prefers input_tokens over total_tokens', () => {
    expect(pickInputTokensFromUsageObject({ input_tokens: 5000, total_tokens: 12_000 })).toBe(5000)
  })
})

describe('normalizeAnthropicMessageUsage', () => {
  it('normalizes usage with total_tokens only', () => {
    expect(normalizeAnthropicMessageUsage({ usage: { total_tokens: 8000, output_tokens: 500 } })).toEqual({
      input_tokens: 8000,
      output_tokens: 500,
      total_tokens: 8000,
      cacheSemantics: 'additive'
    })
  })

  it('annotates subset semantics for OpenAI-shaped usage', () => {
    expect(
      normalizeAnthropicMessageUsage({
        usage: {
          prompt_tokens: 100_000,
          output_tokens: 500,
          prompt_tokens_details: { cached_tokens: 80_000 }
        }
      })
    ).toEqual({
      input_tokens: 100_000,
      output_tokens: 500,
      prompt_tokens: 100_000,
      cache_read_input_tokens: 80_000,
      cacheSemantics: 'subset'
    })
  })

  it('annotates additive semantics for Anthropic native cache fields', () => {
    expect(
      normalizeAnthropicMessageUsage(
        {
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            cache_read_input_tokens: 100_000
          }
        },
        'https://api.anthropic.com'
      )
    ).toEqual({
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 100_000,
      cacheSemantics: 'additive'
    })
  })
})
