import { describe, expect, it } from 'vitest'
import { projectApprovalPresentation } from './approvalPresentation'

describe('approval presentation projection', () => {
  it.each([
    ['queued', 'waiting', false], ['evaluating', 'evaluating', false], ['approved', 'approved', false],
    ['denied', 'denied', true], ['unavailable', 'incomplete', true], ['timed-out', 'incomplete', true], ['cancelled', 'cancelled', true]
  ] as const)('%s has an independent presentation state', (status, presentation, notExecuted) => {
    expect(projectApprovalPresentation({ status, reason: { summary: '理由' } })).toMatchObject({ presentation, notExecuted, reason: '理由' })
  })
})

describe('approval reason projection', () => {
  it('classifies incomplete script analysis without exposing script content', () => {
    expect(projectApprovalPresentation({ status: 'awaiting-user', reason: { summary: 'script-path-unknown-confirm' } }))
      .toMatchObject({ reasonCode: 'analysis-incomplete', reasonRuleId: 'script-path-unknown-confirm' })
  })

  it('preserves the exact policy rule identity for other asks', () => {
    expect(projectApprovalPresentation({ status: 'awaiting-user', reason: { summary: 'edit-confirm' } }))
      .toMatchObject({ reasonCode: 'policy-rule', reasonRuleId: 'edit-confirm' })
  })

  it('classifies changed facts independently when the approval record carries that cause', () => {
    expect(projectApprovalPresentation({ status: 'denied', cause: 'facts-changed', reason: { summary: 'POLICY_DENY' } }))
      .toMatchObject({ reasonCode: 'target-changed' })
  })
})
