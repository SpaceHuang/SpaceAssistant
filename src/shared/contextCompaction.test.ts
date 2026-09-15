import { describe, expect, it } from 'vitest'
import { planCompaction } from './contextCompaction'

const projection = (surfaceTokens: number, requiredTokens = 100) => ({ surfaceTokens, bodyTokens: surfaceTokens, requiredTokens, totalInputBudget: 1000, bodyBudget: 1000, targetBodyRatio: 0.5 })

describe('context compaction planner', () => {
  it('continues after no-op and separates action status from terminal status', () => {
    const calls: string[] = []
    const result = planCompaction({ projection: projection(900), maxSteps: 3, rules: [
      { id: 'prune', action: 'prune' }, { id: 'summarize', action: 'summarize' }
    ], actions: {
      prune: (p) => { calls.push('prune'); return { projection: p, status: 'no-op' } },
      summarize: (p) => { calls.push('summarize'); return { projection: { ...p, surfaceTokens: 400, bodyTokens: 400 }, status: 'applied' } }
    } })
    expect(calls).toEqual(['prune', 'summarize'])
    expect(result.status).toBe('target_reached')
  })

  it('returns fits_without_headroom when hard fit is possible but target is not', () => {
    const result = planCompaction({ projection: projection(900), maxSteps: 1, rules: [{ id: 'noop', action: 'prune' }], actions: { prune: (p) => ({ projection: p, status: 'no-op' }) } })
    expect(result.status).toBe('fits_without_headroom')
  })

  it('stops before actions when required content cannot fit', () => {
    const result = planCompaction({ projection: projection(1000, 1001), maxSteps: 3, rules: [{ id: 'prune', action: 'prune' }], actions: { prune: () => { throw new Error('must not run') } } })
    expect(result.status).toBe('uncompressible')
  })
})
