import { describe, expect, it } from 'vitest'
import {
  THINKING_EFFORT_LEVELS,
  deriveThinkingEffortFromLegacyEnabled,
  isThinkingEffort,
  normalizeThinkingEffort,
  resolveGlobalThinkingEffort
} from './thinkingEffort'

describe('isThinkingEffort', () => {
  it('accepts exactly the four contract levels', () => {
    expect(THINKING_EFFORT_LEVELS).toEqual(['off', 'low', 'medium', 'high'])
    for (const level of THINKING_EFFORT_LEVELS) {
      expect(isThinkingEffort(level)).toBe(true)
    }
  })

  it('rejects server-only and malformed values (OQ-1: xhigh/max not exposed)', () => {
    expect(isThinkingEffort('xhigh')).toBe(false)
    expect(isThinkingEffort('max')).toBe(false)
    expect(isThinkingEffort(true)).toBe(false)
    expect(isThinkingEffort(undefined)).toBe(false)
    expect(isThinkingEffort('')).toBe(false)
  })
})

describe('normalizeThinkingEffort', () => {
  it('passes valid values through', () => {
    expect(normalizeThinkingEffort('low', 'medium')).toBe('low')
    expect(normalizeThinkingEffort('high', 'medium')).toBe('high')
  })

  it('falls back on missing or invalid values', () => {
    expect(normalizeThinkingEffort(undefined, 'medium')).toBe('medium')
    expect(normalizeThinkingEffort('xhigh', 'off')).toBe('off')
    expect(normalizeThinkingEffort(42, 'low')).toBe('low')
  })
})

describe('deriveThinkingEffortFromLegacyEnabled', () => {
  // §8.1 迁移等价表：'false' → off；'true' → medium；缺失 → medium（现网默认开启语义）
  it('maps legacy disabled to off', () => {
    expect(deriveThinkingEffortFromLegacyEnabled(false)).toBe('off')
    expect(deriveThinkingEffortFromLegacyEnabled('false')).toBe('off')
  })

  it('maps legacy enabled and missing to medium (equivalent to assembler true→medium)', () => {
    expect(deriveThinkingEffortFromLegacyEnabled(true)).toBe('medium')
    expect(deriveThinkingEffortFromLegacyEnabled('true')).toBe('medium')
    expect(deriveThinkingEffortFromLegacyEnabled(undefined)).toBe('medium')
    expect(deriveThinkingEffortFromLegacyEnabled('')).toBe('medium')
  })
})

describe('resolveGlobalThinkingEffort', () => {
  it('prefers the new key when valid (both keys present: effort wins)', () => {
    expect(resolveGlobalThinkingEffort('low', 'true')).toBe('low')
    expect(resolveGlobalThinkingEffort('off', 'true')).toBe('off')
  })

  it('derives from the legacy boolean when the new key is missing (§7.1 迁移双读)', () => {
    expect(resolveGlobalThinkingEffort(undefined, 'false')).toBe('off')
    expect(resolveGlobalThinkingEffort(undefined, 'true')).toBe('medium')
    expect(resolveGlobalThinkingEffort(undefined, undefined)).toBe('medium')
  })

  it('ignores an invalid new key and derives from legacy', () => {
    expect(resolveGlobalThinkingEffort('bogus', 'false')).toBe('off')
  })
})
