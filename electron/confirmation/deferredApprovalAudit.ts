import type { SecurityAuditEvent, SecurityAuditEventKind } from '../../src/shared/confirmation/types'

export function buildDeferredApprovalAuditEvent(input: {
  kind: 'pending' | 'approved' | 'dispatch' | 'notification' | 'result'
  lane: 'wechat' | 'feishu'
  sessionId: string
  todoId: string
  invocationId: string
  consumed?: boolean
  executionState?: 'completed' | 'failed' | 'outcome_unknown'
  notificationState?: 'undelivered' | 'delivered'
  ts?: number
  userText?: string
  command?: string
  absolutePath?: string
}): SecurityAuditEvent {
  if (![input.sessionId, input.todoId, input.invocationId].every((value) => value.trim())) {
    throw new TypeError('DEFERRED_APPROVAL_AUDIT_CAUSAL_ID_REQUIRED')
  }
  const eventByKind: Record<typeof input.kind, SecurityAuditEventKind> = {
    pending: 'deferred-approval.pending', approved: 'deferred-approval.approved',
    dispatch: 'deferred-approval.dispatch', notification: 'deferred-approval.notification', result: 'deferred-approval.result'
  }
  const actor = input.kind === 'approved' ? 'user' : input.kind === 'pending' || input.kind === 'dispatch' || input.kind === 'result' ? 'agent' : 'system'
  const executionState = input.kind === 'dispatch'
    ? input.consumed ? 'consumed' : 'dispatching'
    : input.kind === 'result' ? input.executionState : undefined
  return {
    ts: input.ts ?? Date.now(), event: eventByKind[input.kind], lane: input.lane, sessionId: input.sessionId,
    todoId: input.todoId, invocationId: input.invocationId, actor,
    ...(executionState ? { executionState } : {}),
    ...(input.notificationState ? { notificationState: input.notificationState } : {})
  }
}

export function createDeferredApprovalAuditSink(log: { record(event: SecurityAuditEvent): void }) {
  return (event: SecurityAuditEvent) => log.record(event)
}
