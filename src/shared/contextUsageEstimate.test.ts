import { describe, expect, it } from 'vitest'
import {
  computeContextUsageDisplay,
  computeEstimatedOccupancy,
  computeTotalRequestInputTokens,
  estimateTokensFromToolResults,
  projectUsageAfterToolResults,
  resolveEffectiveMaximumContext
} from './contextUsageEstimate'

describe('computeTotalRequestInputTokens', () => {
  it('returns input when no cache fields', () => {
    expect(computeTotalRequestInputTokens({ input_tokens: 50_000 })).toBe(50_000)
  })

  it('sums Anthropic additive cache fields', () => {
    expect(computeTotalRequestInputTokens({ input_tokens: 50, cache_read_input_tokens: 100_000 })).toBe(100_050)
    expect(
      computeTotalRequestInputTokens({ input_tokens: 33, cache_creation_input_tokens: 2017 })
    ).toBe(2050)
  })

  it('treats OpenAI-compatible prompt total as already complete', () => {
    expect(
      computeTotalRequestInputTokens({ input_tokens: 100_000, cache_read_input_tokens: 80_000 })
    ).toBe(100_000)
  })

  it('uses Anthropic additive path when non-cached input dominates cache read', () => {
    expect(
      computeTotalRequestInputTokens({ input_tokens: 80_000, cache_read_input_tokens: 20_000 })
    ).toBe(100_000)
  })

  it('handles Anthropic cache read + create additive', () => {
    expect(
      computeTotalRequestInputTokens({
        input_tokens: 50,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0
      })
    ).toBe(100_050)
  })
})

describe('computeEstimatedOccupancy', () => {
  it('adds output tokens to total request input', () => {
    expect(computeEstimatedOccupancy({ input_tokens: 80_000, output_tokens: 5000 })).toBe(85_000)
  })

  it('includes cache in occupancy estimate', () => {
    expect(
      computeEstimatedOccupancy({ input_tokens: 50, cache_read_input_tokens: 100_000, output_tokens: 200 })
    ).toBe(100_250)
  })
})

describe('resolveEffectiveMaximumContext', () => {
  it('returns configured value when no provider cap is known', () => {
    expect(resolveEffectiveMaximumContext('claude-sonnet-4-6', 200_000)).toBe(200_000)
  })

  it('clamps configured maximum to known provider cap when config is higher', () => {
    expect(resolveEffectiveMaximumContext('deepseek-v4-pro', 2_000_000)).toBe(1_048_565)
  })

  it('keeps configured value when it is already below provider cap', () => {
    expect(resolveEffectiveMaximumContext('deepseek-v4-pro', 1_000_000)).toBe(1_000_000)
  })

  it('applies deepseek prefix fallback for unknown deepseek model ids', () => {
    expect(resolveEffectiveMaximumContext('deepseek-v4-custom', 5_000_000)).toBe(1_048_565)
  })
})

describe('computeContextUsageDisplay', () => {
  it('computes ring ratios from estimated occupancy', () => {
    const d = computeContextUsageDisplay({ input_tokens: 80_000, output_tokens: 5000 }, 200_000, 64_000)
    expect(d.estimatedOccupancy).toBe(85_000)
    expect(d.usedRatio).toBeCloseTo(85_000 / 200_000)
    expect(d.reservedRatio).toBeCloseTo(64_000 / 200_000)
    expect(d.freeRatio).toBeCloseTo(1 - 85_000 / 200_000 - 64_000 / 200_000)
    expect(d.percentUsed).toBe(42.5)
  })

  it('clamps when estimated occupancy plus output max exceeds context window', () => {
    const d = computeContextUsageDisplay(
      { input_tokens: 199_000, output_tokens: 1000 },
      200_000,
      64_000
    )
    expect(d.estimatedOccupancy).toBe(200_000)
    expect(d.usedRatio + d.reservedRatio).toBeCloseTo(1)
    expect(d.freeRatio).toBe(0)
  })
})

describe('estimateTokensFromToolResults', () => {
  it('estimates string tool_result content', () => {
    const text = 'x'.repeat(350)
    expect(estimateTokensFromToolResults([{ content: text }])).toBe(100)
  })

  it('sums multiple tool results', () => {
    expect(
      estimateTokensFromToolResults([
        { content: 'a'.repeat(35) },
        { content: 'b'.repeat(35) }
      ])
    ).toBe(20)
  })
})

describe('projectUsageAfterToolResults', () => {
  it('bumps input_tokens by estimated tool_result size', () => {
    const base = { input_tokens: 10_000, output_tokens: 200 }
    const projected = projectUsageAfterToolResults(base, [{ content: 'z'.repeat(350) }])
    expect(projected.input_tokens).toBe(10_100)
    expect(projected.output_tokens).toBe(200)
    expect(computeEstimatedOccupancy(projected)).toBeGreaterThan(computeEstimatedOccupancy(base))
  })

  it('returns same usage when tool results are empty', () => {
    const base = { input_tokens: 5000 }
    expect(projectUsageAfterToolResults(base, [])).toEqual(base)
  })
})
