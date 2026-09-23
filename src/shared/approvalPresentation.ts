import type { ApprovalStatus } from '../../packages/agent-core/src/approval'

export type ApprovalPresentationState = 'waiting' | 'evaluating' | 'approved' | 'denied' | 'incomplete' | 'cancelled'

export function projectApprovalPresentation(input: { status: ApprovalStatus; reason?: { summary: string } }): {
  presentation: ApprovalPresentationState; notExecuted: boolean; reason?: string
} {
  switch (input.status) {
    case 'requested': case 'queued': return { presentation: 'waiting', notExecuted: false, ...(input.reason ? { reason: input.reason.summary } : {}) }
    case 'evaluating': case 'awaiting-user': case 'submitting': return { presentation: 'evaluating', notExecuted: false, ...(input.reason ? { reason: input.reason.summary } : {}) }
    case 'approved': return { presentation: 'approved', notExecuted: false, ...(input.reason ? { reason: input.reason.summary } : {}) }
    case 'denied': return { presentation: 'denied', notExecuted: true, ...(input.reason ? { reason: input.reason.summary } : {}) }
    case 'cancelled': return { presentation: 'cancelled', notExecuted: true, ...(input.reason ? { reason: input.reason.summary } : {}) }
    default: return { presentation: 'incomplete', notExecuted: true, ...(input.reason ? { reason: input.reason.summary } : {}) }
  }
}
