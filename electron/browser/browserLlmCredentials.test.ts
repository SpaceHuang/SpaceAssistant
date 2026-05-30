import { describe, expect, it } from 'vitest'
import { formatStagehandModelForV3 } from './browserLlmCredentials'

describe('formatStagehandModelForV3', () => {
  it('passes through provider/model format', () => {
    expect(formatStagehandModelForV3('anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
  })

  it('maps deepseek chat model with anthropic base URL', () => {
    expect(
      formatStagehandModelForV3('deepseek-v4-pro', 'https://api.deepseek.com/anthropic')
    ).toBe('anthropic/deepseek-v4-pro')
  })

  it('maps claude model names', () => {
    expect(formatStagehandModelForV3('claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
  })

  it('maps gpt models to openai', () => {
    expect(formatStagehandModelForV3('gpt-4o')).toBe('openai/gpt-4o')
  })
})
