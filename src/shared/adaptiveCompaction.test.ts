import { describe, expect, it } from 'vitest'
import { adaptiveRules, pruneSurface } from './adaptiveCompaction'

describe('adaptive compaction preset', () => {
  it('keeps active tool loop at prune-only and exposes data-only rules', () => {
    expect(adaptiveRules.filter((r) => r.phase === 'tool_loop').map((r) => r.action)).toEqual(['prune'])
    expect(adaptiveRules.every((r) => typeof r.id === 'string' && typeof r.action === 'string')).toBe(true)
  })
  it('prunes only post-cache content and reports no-op when nothing is eligible', () => {
    const result = pruneSurface({ surfaceTokens: 100, bodyTokens: 80, requiredTokens: 20, totalInputBudget: 100, bodyBudget: 80, targetBodyRatio: .8 }, [{ id: 'stable', tokens: 30, cacheBoundary: true }, { id: 'new', tokens: 20, cacheBoundary: false }])
    expect(result.status).toBe('applied')
    expect(result.items[0]?.tokens).toBe(30)
    expect(result.items[1]?.tokens).toBe(4)
    expect(pruneSurface({ surfaceTokens: 10, bodyTokens: 5, requiredTokens: 5, totalInputBudget: 100, bodyBudget: 95, targetBodyRatio: .8 }, [{ id: 'stable', tokens: 5, cacheBoundary: true }]).status).toBe('no-op')
  })
})
