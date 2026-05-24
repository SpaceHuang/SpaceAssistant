import { describe, expect, it } from 'vitest'
import { BLOCKED_BY_PLAN_MODE, shouldBlockToolInPlanMode } from './planModeAcl'
import type { PlanMeta } from '../../src/shared/planTypes'

const draftingPlan: PlanMeta = {
  planId: 'p1',
  status: 'drafting',
  planFilePath: '.spaceassistant/plans/x.md',
  currentStepIndex: 0,
  stepsTotal: 3,
  version: 1,
  createdAt: 1,
  approvedAt: null,
  cancelledAt: null,
  envSnapshot: { gitHead: null, timestamp: 1 }
}

describe('shouldBlockToolInPlanMode', () => {
  it('blocks write tools during planning phase', () => {
    const r = shouldBlockToolInPlanMode('write_file', undefined, 'planning')
    expect(r.blocked).toBe(true)
    expect(r.error).toContain(BLOCKED_BY_PLAN_MODE)
  })

  it('allows read tools during planning phase', () => {
    expect(shouldBlockToolInPlanMode('read_file', undefined, 'planning').blocked).toBe(false)
  })

  it('blocks write when session is awaiting_approval', () => {
    const meta = { plan: { ...draftingPlan, status: 'awaiting_approval' as const } }
    const r = shouldBlockToolInPlanMode('edit_file', meta, null)
    expect(r.blocked).toBe(true)
  })

  it('allows write in implementation phase', () => {
    const r = shouldBlockToolInPlanMode('write_file', { plan: draftingPlan }, 'implementation')
    expect(r.blocked).toBe(false)
  })
})
