import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { PlanDisplayEntry } from '../../../shared/planTypes'
import { planPanelActionsStore } from '../../services/planPanelActionsStore'
import type { PlanPanelActions } from './PlanPanelActionsContext'
import { derivePlanExecutionUiState } from './planExecutionUiState'
import { PlanPlanCard } from './PlanPlanCard'

function displayEntry(over: Partial<PlanDisplayEntry> = {}): PlanDisplayEntry {
  return {
    planId: 'plan-1',
    planFilePath: 'plans/a.md',
    title: '测试计划',
    status: 'executing',
    version: 1,
    createdAt: 1,
    approvedAt: 2,
    currentStepIndex: 1,
    stepsTotal: 3,
    ...over
  }
}

function stubActions(over: Partial<PlanPanelActions> = {}) {
  const planExecutionUiState =
    over.planExecutionUiState ??
    derivePlanExecutionUiState({
      sessionRunning: false,
      planActionLoading: false,
      activePlanId: 'plan-1',
      planDrafting: false
    })
  planPanelActionsStore.set({
    requestComposerFocus: vi.fn(),
    onApproveAndExecute: vi.fn(async () => {}),
    onPlanResume: vi.fn(async () => {}),
    onPlanCancel: vi.fn(async () => {}),
    onPlanRejectWithFeedback: vi.fn(async () => {}),
    planActionLoading: false,
    planExecutionUiState,
    ...over
  })
}

describe('PlanPlanCard resume button', () => {
  beforeEach(() => {
    stubActions()
  })

  afterEach(() => {
    planPanelActionsStore.set(null)
  })

  it('shows 继续执行 for active executing plan', () => {
    render(<PlanPlanCard entry={displayEntry()} activePlanId="plan-1" />)
    expect(screen.getByRole('button', { name: '继续执行' })).toBeDefined()
  })

  it('shows 开始执行 for active approved plan', () => {
    render(
      <PlanPlanCard entry={displayEntry({ status: 'approved', currentStepIndex: 0 })} activePlanId="plan-1" />
    )
    expect(screen.getByRole('button', { name: '开始执行' })).toBeDefined()
  })

  it('hides controls for non-active executing plan', () => {
    render(<PlanPlanCard entry={displayEntry()} activePlanId="other-plan" />)
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull()
  })

  it('hides controls for completed plan', () => {
    render(<PlanPlanCard entry={displayEntry({ status: 'completed' })} activePlanId="plan-1" />)
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull()
  })

  it('disables resume when session is running in step_manual', () => {
    stubActions({
      planExecutionUiState: derivePlanExecutionUiState({
        sessionRunning: true,
        planActionLoading: false,
        activePlanId: 'plan-1',
        planDrafting: false,
        executionMode: 'step_manual'
      })
    })
    render(<PlanPlanCard entry={displayEntry()} activePlanId="plan-1" />)
    const btn = screen.getByRole('button', { name: /执行中/ })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('does not show resume on readonly card', () => {
    render(<PlanPlanCard entry={displayEntry()} activePlanId="plan-1" readonly />)
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull()
  })

  it('shows 暂停执行 when auto mode is running', () => {
    stubActions({
      planExecutionUiState: derivePlanExecutionUiState({
        sessionRunning: true,
        planActionLoading: false,
        activePlanId: 'plan-1',
        planDrafting: false,
        runState: 'running',
        executionMode: 'auto'
      })
    })
    render(<PlanPlanCard entry={displayEntry()} activePlanId="plan-1" />)
    expect(screen.getByRole('button', { name: '暂停执行' })).toBeDefined()
  })
})
