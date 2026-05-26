import { describe, expect, it } from 'vitest'
import { derivePlanExecutionUiState } from './planExecutionUiState'

describe('derivePlanExecutionUiState', () => {
  it('marks resume busy when session is running', () => {
    const state = derivePlanExecutionUiState({
      sessionRunning: true,
      planActionLoading: false,
      activePlanId: 'p1',
      planDrafting: false
    })
    expect(state.resumeButtonBusy).toBe(true)
    expect(state.resumeButtonDisabled).toBe(true)
  })

  it('marks resume busy when plan action loading', () => {
    const state = derivePlanExecutionUiState({
      sessionRunning: false,
      planActionLoading: true,
      activePlanId: 'p1',
      planDrafting: false
    })
    expect(state.resumeButtonBusy).toBe(true)
    expect(state.resumeButtonDisabled).toBe(true)
  })

  it('allows resume when idle between steps', () => {
    const state = derivePlanExecutionUiState({
      sessionRunning: false,
      planActionLoading: false,
      activePlanId: 'p1',
      planDrafting: false
    })
    expect(state.resumeButtonBusy).toBe(false)
    expect(state.resumeButtonDisabled).toBe(false)
  })

  it('disables resume during plan drafting overlay', () => {
    const state = derivePlanExecutionUiState({
      sessionRunning: false,
      planActionLoading: false,
      activePlanId: 'p1',
      planDrafting: true
    })
    expect(state.resumeButtonBusy).toBe(false)
    expect(state.resumeButtonDisabled).toBe(true)
  })
})
