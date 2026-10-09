import type { ApprovalInvocationResult } from './types'

/** 进入异步待办前由可信审批 gate 给出的资格结论。 */
export type DeferredApprovalEligibility =
  | { kind: 'not-requested' }
  | { kind: 'eligible'; todoId: string }
  | { kind: 'config-error' | 'locked' | 'critical' | 'recursion-blocked' }

/** 审批调用结果的跨边界表达；deferred 只表示已持久化待办，不代表动作已执行。 */
export type DeferredApprovalResult =
  | { kind: 'approve'; verdict: Extract<ApprovalInvocationResult, { ok: true }>['verdict'] }
  | { kind: 'deny'; summary?: string; cause?: 'agent-deny' | 'config-error' | 'locked' | 'critical' | 'recursion-blocked' }
  | { kind: 'undetermined'; summary: string }
  | { kind: 'unavailable'; summary?: string }
  | { kind: 'timeout'; summary?: string }
  | { kind: 'unparsable'; summary?: string }
  | { kind: 'deferred'; todoId: string; cause?: 'agent-deny' | 'agent-undetermined' | 'unavailable' | 'timeout' | 'unparsable' | 'outbound-requires-human' | 'insufficient-delegation-evidence' }

/** 只允许有效 approve 且通过可信 gate 的结果映射为 deferred。 */
export function mapDeferredApprovalResult(
  result: ApprovalInvocationResult,
  eligibility: DeferredApprovalEligibility
): DeferredApprovalResult {
  if (!result.ok) {
    if (result.cause === 'config-error') return { kind: 'deny', cause: 'config-error', summary: result.summary }
    return { kind: result.cause, summary: result.summary }
  }

  if (result.verdict.kind === 'deny') return { kind: 'deny', cause: 'agent-deny', summary: result.verdict.reason.summary }
  if (result.verdict.kind === 'undetermined') return { kind: 'undetermined', summary: result.verdict.reason.summary }

  if (eligibility.kind === 'not-requested') return { kind: 'approve', verdict: result.verdict }
  if (eligibility.kind === 'eligible') return { kind: 'deferred', todoId: eligibility.todoId }
  return { kind: 'deny', cause: eligibility.kind, summary: '异步审批资格未通过' }
}

/** JSON boundary validator: accepts only the explicit shared result variants. */
export function parseDeferredApprovalResult(value: unknown): DeferredApprovalResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'deferred' && typeof candidate.todoId === 'string' && candidate.todoId.length > 0) {
    const allowedCauses = ['agent-deny', 'agent-undetermined', 'unavailable', 'timeout', 'unparsable', 'outbound-requires-human', 'insufficient-delegation-evidence'] as const
    if (candidate.cause !== undefined && !allowedCauses.includes(candidate.cause as typeof allowedCauses[number])) return null
    return { kind: 'deferred', todoId: candidate.todoId, ...(candidate.cause !== undefined ? { cause: candidate.cause as typeof allowedCauses[number] } : {}) }
  }
  if (candidate.kind === 'approve' && candidate.verdict && typeof candidate.verdict === 'object') {
    const verdict = candidate.verdict as Record<string, unknown>
    if ((verdict.kind === 'approve' || verdict.kind === 'deny' || verdict.kind === 'undetermined') && verdict.reason && typeof verdict.reason === 'object') {
      return { kind: 'approve', verdict: verdict as DeferredApprovalResult & never }
    }
  }
  if (candidate.kind === 'deny') return { kind: 'deny', ...(typeof candidate.summary === 'string' ? { summary: candidate.summary } : {}) }
  if (candidate.kind === 'undetermined' && typeof candidate.summary === 'string') return { kind: 'undetermined', summary: candidate.summary }
  if (candidate.kind === 'unavailable' || candidate.kind === 'timeout' || candidate.kind === 'unparsable') {
    return { kind: candidate.kind, ...(typeof candidate.summary === 'string' ? { summary: candidate.summary } : {}) }
  }
  return null
}
