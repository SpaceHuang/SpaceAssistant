import { describe, expect, it } from 'vitest'
import { planTurnBoundarySurfaceCompaction } from './turnBoundaryCompaction'

describe('turn boundary surface compaction', () => {
  it('keeps required current input and preserves facts while summarizing', () => {
    const result = planTurnBoundarySurfaceCompaction({
      projection: { surfaceTokens: 900, bodyTokens: 900, requiredTokens: 100, totalInputBudget: 1000, bodyBudget: 900, targetBodyRatio: .8 },
      items: [{ id: 'old', tokens: 300, required: false }, { id: 'current', tokens: 500, required: true }, { id: 'tail', tokens: 100, required: false }],
      shouldCompact: true,
      summaryCount: 0,
      checkpointId: 'checkpoint-1',
      checkpointTokens: 50
    })
    expect(result.status).toBe('target_reached')
    expect(result.items.map((item) => item.id)).toContain('current')
    expect(result.facts.map((item) => item.id)).toEqual(['old', 'current', 'tail'])
    expect(result.record?.shadowedRanges).toEqual([{ start: 'old', end: 'old' }])
  })
})
