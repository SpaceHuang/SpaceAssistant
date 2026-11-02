import { describe, expect, it } from 'vitest'
import { STORAGE_PERF_BUDGET } from './storagePerfBudget'

describe('storage performance budgets', () => {
  it('defines explicit relative and absolute p95 ceilings for CI-selected storage lanes', () => {
    expect(STORAGE_PERF_BUDGET.relativeP95).toEqual({ multiplier: 2, allowanceMs: 5 })
    expect(STORAGE_PERF_BUDGET.apiShadowP95Ms).toBe(50)
    expect(STORAGE_PERF_BUDGET.globalSearchP95Ms).toBe(20)
    expect(STORAGE_PERF_BUDGET.multiSpillPreparedReadP95Ms).toBe(50)
    expect(STORAGE_PERF_BUDGET.multiSpillSearchP95Ms).toBe(20)
  })
})
