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
      total_tokens: 8000
    })
  })
})
