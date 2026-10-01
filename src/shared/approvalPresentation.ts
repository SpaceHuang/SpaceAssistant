import type { ApprovalCause, ApprovalStatus } from './approvalTypes'

export type ApprovalPresentationState = 'waiting' | 'evaluating' | 'approved' | 'denied' | 'incomplete' | 'cancelled'
export type ApprovalReasonCode = 'policy-rule' | 'analysis-incomplete' | 'target-changed'

export function projectApprovalPresentation(input: { status: ApprovalStatus; cause?: ApprovalCause; reason?: { summary: string } }): {
  presentation: ApprovalPresentationState; notExecuted: boolean; reason?: string
  reasonCode?: ApprovalReasonCode; reasonRuleId?: string
} {
  const ruleId = input.reason?.summary
  const reasonCode: ApprovalReasonCode | undefined = input.cause === 'facts-changed'
    ? 'target-changed'
    : ruleId === 'script-path-unknown-confirm' || ruleId === 'script-unverified-language-confirm'
      ? 'analysis-incomplete'
      : ruleId ? 'policy-rule' : undefined
  const explanation = {
    ...(input.reason ? { reason: input.reason.summary } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(ruleId && reasonCode !== 'target-changed' ? { reasonRuleId: ruleId } : {})
  }
  switch (input.status) {
    case 'requested': case 'queued': return { presentation: 'waiting', notExecuted: false, ...explanation }
    case 'evaluating': case 'awaiting-user': case 'submitting': return { presentation: 'evaluating', notExecuted: false, ...explanation }
    case 'approved': return { presentation: 'approved', notExecuted: false, ...explanation }
    case 'denied': return { presentation: 'denied', notExecuted: true, ...explanation }
    case 'cancelled': return { presentation: 'cancelled', notExecuted: true, ...explanation }
    default: return { presentation: 'incomplete', notExecuted: true, ...explanation }
  }
}
