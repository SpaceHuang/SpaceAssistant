/** Host-owned projection shape for approval facts; kept independent of runtime packages. */
export type ApprovalStatus =
  | 'requested' | 'queued' | 'evaluating' | 'awaiting-user' | 'submitting'
  | 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

export type ApprovalCause =
  | 'agent-approved' | 'agent-deny' | 'policy-denied' | 'user-denied'
  | 'approval-queue-full' | 'approval-queue-timeout' | 'provider-rate-limit'
  | 'provider-unavailable' | 'config-error' | 'unparsable' | 'evaluation-timeout'
  | 'cancelled' | 'interrupted' | 'recursion-blocked' | 'facts-changed' | 'authorization-revoked'

export interface ApprovalRecord {
  schemaVersion: 1
  approvalId: string
  attemptId: string
  toolUseId: string
  answerer: 'agent' | 'user' | 'policy'
  status: ApprovalStatus
  cause?: ApprovalCause
  reason?: { summary: string; nextStep?: string }
  requestedAt: number
  queuedAt?: number
  startedAt?: number
  settledAt?: number
  deadlineAt?: number
  retryAfterAt?: number
  revision: number
}
