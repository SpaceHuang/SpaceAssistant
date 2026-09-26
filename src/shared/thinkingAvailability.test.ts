import { describe, expect, it } from 'vitest'
import { resolveThinkingAvailability } from './thinkingAvailability'
import { MODEL_BASELINE } from './modelBaseline'

describe('resolveThinkingAvailability', () => {
  it('uses explicit baseline nulls as unsupported effort levels', () => {
    expect(resolveThinkingAvailability('deepseek-v4-pro', { effortUnsupportedByMemo: false }))
      .toEqual({ unsupported: ['low', 'medium'], source: 'baseline' })
  })

  it('keeps unknown models fail-open and memo takes precedence', () => {
    expect(resolveThinkingAvailability('unlisted', { effortUnsupportedByMemo: false }))
      .toEqual({ unsupported: [], source: 'unknown' })
    expect(resolveThinkingAvailability('claude-sonnet-4-6', { effortUnsupportedByMemo: true }))
      .toEqual({ unsupported: ['low', 'medium', 'high'], source: 'memo' })
  })

  it('never treats off as an unsupported level', () => {
    const result = resolveThinkingAvailability('deepseek-v4-pro', { effortUnsupportedByMemo: false })
    expect(result.unsupported).not.toContain('off')
  })

  it('treats missing keys as unknown support and malformed maps as unknown', () => {
    MODEL_BASELINE['test-missing-effort-key'] = {
      maximumContext: 1,
      maxTokens: 1,
      isVision: false,
      reasoning: true,
      thinkingLevelMap: { high: null },
      sourceProvider: 'test'
    }
    MODEL_BASELINE['test-malformed-effort-map'] = {
      maximumContext: 1,
      maxTokens: 1,
      isVision: false,
      reasoning: true,
      thinkingLevelMap: { low: 12 } as never,
      sourceProvider: 'test'
    }
    expect(resolveThinkingAvailability('test-missing-effort-key', { effortUnsupportedByMemo: false }))
      .toEqual({ unsupported: ['high'], source: 'baseline' })
    expect(resolveThinkingAvailability('test-malformed-effort-map', { effortUnsupportedByMemo: false }))
      .toEqual({ unsupported: [], source: 'unknown' })
    delete MODEL_BASELINE['test-missing-effort-key']
    delete MODEL_BASELINE['test-malformed-effort-map']
  })
})
