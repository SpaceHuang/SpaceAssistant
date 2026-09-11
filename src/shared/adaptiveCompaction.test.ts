import { describe, expect, it } from 'vitest'
import { adaptiveRules, getCompactionRules, planAdaptiveCompaction, planToolLoopCompaction, pruneSurface, selectCompactionRules } from './adaptiveCompaction'

describe('adaptive compaction preset', () => {
  it('routes tool-loop pressure through prune only', () => {
    const projection = { surfaceTokens: 900, bodyTokens: 900, requiredTokens: 10, totalInputBudget: 1000, bodyBudget: 1000, targetBodyRatio: .5 }
    const result = planToolLoopCompaction({ projection, shouldCompact: true, prune: (current) => ({ projection: { ...current, surfaceTokens: 400, bodyTokens: 400 }, status: 'applied' }) })
    expect(result.status).toBe('target_reached')
    expect(result.actions.map((action) => action.action)).toEqual(['prune'])
  })

  it('does not plan an action when the projection is below the trigger', () => {
    const projection = { surfaceTokens: 400, bodyTokens: 400, requiredTokens: 10, totalInputBudget: 1000, bodyBudget: 1000, targetBodyRatio: .5 }
    const result = planToolLoopCompaction({ projection, shouldCompact: false, prune: () => { throw new Error('must not prune') } })
    expect(result).toEqual({ status: 'fits_without_headroom', projection, actions: [] })
  })
  it('keeps active tool loop at prune-only and exposes data-only rules', () => {
    expect(adaptiveRules.filter((r) => r.phase === 'tool_loop').map((r) => r.action)).toEqual(['prune'])
    expect(adaptiveRules.every((r) => typeof r.id === 'string' && typeof r.action === 'string' && typeof r.reason === 'string')).toBe(true)
    expect(adaptiveRules[0]).toMatchObject({ reason: 'provider_overflow', action: 'reset' })
    expect(adaptiveRules.filter((r) => r.phase === 'tool_loop').map((r) => r.action)).toEqual(['prune'])
  })
  it('prunes only post-cache content and reports no-op when nothing is eligible', () => {
    const result = pruneSurface({ surfaceTokens: 100, bodyTokens: 80, requiredTokens: 20, totalInputBudget: 100, bodyBudget: 80, targetBodyRatio: .8 }, [{ id: 'stable', tokens: 30, cacheBoundary: true }, { id: 'new', tokens: 20, cacheBoundary: false }])
    expect(result.status).toBe('applied')
    expect(result.items[0]?.tokens).toBe(30)
    expect(result.items[1]?.tokens).toBe(4)
    expect(pruneSurface({ surfaceTokens: 10, bodyTokens: 5, requiredTokens: 5, totalInputBudget: 100, bodyBudget: 95, targetBodyRatio: .8 }, [{ id: 'stable', tokens: 5, cacheBoundary: true }]).status).toBe('no-op')
  })

  it('switches behavior by replacing rule data, without changing the engine', () => {
    expect(getCompactionRules('classic').map((r) => r.action)).toEqual(['prune', 'summarize'])
    expect(getCompactionRules('reset-first')[0]?.action).toBe('reset')
  })
  it('selects only rules applicable to the current phase and reason', () => {
    expect(selectCompactionRules(adaptiveRules, { phase: 'tool_loop', reason: 'should_compact' }).map((r) => r.action)).toEqual(['prune'])
    expect(selectCompactionRules(adaptiveRules, { phase: 'turn_boundary', reason: 'provider_overflow' }).map((r) => r.action)).toEqual(['reset'])
  })
  it('runs the selected rule set through the generic engine', () => {
    const actions = {
      prune: (p: any) => ({ projection: p, status: 'no-op' as const }),
      summarize: (p: any) => ({ projection: { ...p, surfaceTokens: 400, bodyTokens: 400 }, status: 'applied' as const }),
      reset: (p: any) => ({ projection: { ...p, surfaceTokens: 300, bodyTokens: 300 }, status: 'applied' as const })
    }
    const result = planAdaptiveCompaction({ projection: { surfaceTokens: 900, bodyTokens: 900, requiredTokens: 10, totalInputBudget: 1000, bodyBudget: 1000, targetBodyRatio: .5 }, phase: 'tool_loop', reason: 'should_compact', actions, maxSteps: 3 })
    expect(result.actions.map((a) => a.action)).toEqual(['prune'])
    expect(result.status).toBe('fits_without_headroom')
  })
})
