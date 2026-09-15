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

  it('uses reset as the first action after three committed summaries', () => {
    const result = planTurnBoundarySurfaceCompaction({
      projection: { surfaceTokens: 1000, bodyTokens: 1000, requiredTokens: 100, totalInputBudget: 1200, bodyBudget: 1000, targetBodyRatio: .8 },
      items: [{ id: 'current', tokens: 100, required: true }, { id: 'old-1', tokens: 300, required: false }, { id: 'old-2', tokens: 300, required: false }, { id: 'tail', tokens: 300, required: false }],
      shouldCompact: true, summaryCount: 3, checkpointId: 'checkpoint-reset', checkpointTokens: 20
    })
    expect(result.actions[0]?.action).toBe('reset')
    expect(result.items.map((item) => item.id)).toEqual(['checkpoint-reset', 'current', 'tail'])
  })
})
