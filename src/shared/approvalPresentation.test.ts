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
