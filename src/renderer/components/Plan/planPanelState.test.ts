import { describe, expect, it } from 'vitest'
import {
  SESSION_META_DISPLAY_PLANS,
  SESSION_META_PENDING_PLAN,
  SESSION_META_PLAN_DRAFTING
} from '../../../shared/planTypes'
import {
  buildPlanApprovalImpactText,
  derivePlanPanelMainState,
  hasExecutingDisplayPlan
} from './planPanelState'

describe('derivePlanPanelMainState', () => {
  it('returns pending_approval when pending_plan awaiting', () => {
    const state = derivePlanPanelMainState({
      [SESSION_META_PENDING_PLAN]: {
        planId: 'p',
        status: 'awaiting_approval',
        planFilePath: 'x.md',
        currentStepIndex: 0,
        stepsTotal: 1,
        version: 1,
        createdAt: 1,
        approvedAt: null,
        cancelledAt: null,
        envSnapshot: { gitHead: null, timestamp: 1 }
      }
    })
    expect(state).toBe('pending_approval')
  })

  it('returns plans when display_plans non-empty', () => {
    expect(
      derivePlanPanelMainState({
        [SESSION_META_DISPLAY_PLANS]: [
          {
            planId: 'a',
            planFilePath: 'a.md',
            title: 'A',
            status: 'completed',
            version: 1,
            createdAt: 1,
            approvedAt: 2,
            currentStepIndex: 0,
            stepsTotal: 1
          }
        ]
      })
    ).toBe('plans')
  })

  it('returns empty otherwise', () => {
    expect(derivePlanPanelMainState({})).toBe('empty')
    expect(derivePlanPanelMainState({ [SESSION_META_PLAN_DRAFTING]: true })).toBe('empty')
  })
})

describe('buildPlanApprovalImpactText', () => {
  it('describes executing plan progress', () => {
    const text = buildPlanApprovalImpactText([
      {
        planId: 'e',
        planFilePath: 'e.md',
        title: '旧计划',
        status: 'executing',
        version: 1,
        createdAt: 1,
        approvedAt: 2,
        currentStepIndex: 2,
        stepsTotal: 5
      }
    ])
    expect(text).toContain('执行中')
    expect(text).toContain('第 3/5 步')
  })

  it('detects executing display plans', () => {
    expect(
      hasExecutingDisplayPlan([
        {
          planId: 'e',
          planFilePath: 'e.md',
          title: 'T',
          status: 'executing',
          version: 1,
          createdAt: 1,
          approvedAt: null,
          currentStepIndex: 0,
          stepsTotal: 3
        }
      ])
    ).toBe(true)
  })
})
