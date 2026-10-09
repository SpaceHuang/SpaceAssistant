import type { DeferredTodoRecord } from '../confirmation/deferredTodoStore'
import type { DeferredCallEnvelope } from '../confirmation/deferredEnvelopeStore'
import type { DeferredResumeRequest } from '../confirmation/deferredResumeRequestStore'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { getTaskControlRecord } from '../database/taskControl'

export function recheckDeferredTaskControl(db: AppDatabase, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean {
  const context = envelope.executionContext
  const workflowId = context.workflowId
  const taskId = context.taskId
  const stepId = context.stepId
  const planRevision = context.planRevision
  if (typeof workflowId !== 'string' || typeof taskId !== 'string' || typeof stepId !== 'string' ||
    !Number.isInteger(planRevision) || workflowId !== todo.workflowId || taskId !== todo.taskId ||
    stepId !== todo.stepId || planRevision !== todo.planRevision) return false
  const control = getTaskControlRecord(db, { sessionId: todo.originSessionId, ownerId: todo.ownerId, workflowId, taskId })
  if (!control || control.controlState !== 'active' || control.planRevision !== todo.planRevision) return false
  const steps = Array.isArray(control.data.steps) ? control.data.steps as Array<{ stepId?: unknown }> : []
  const invocations = Array.isArray(control.data.outstandingInvocations)
    ? control.data.outstandingInvocations as Array<{ invocationId?: unknown; todoId?: unknown; stepId?: unknown }> : []
  return steps.some((step) => step.stepId === todo.stepId) && invocations.some((entry) =>
    entry.invocationId === todo.invocationId && entry.todoId === todo.todoId && entry.stepId === todo.stepId)
}

/** Shared production fence for direct IM deferred dispatch. It is checked both before permit claim
 * by the resume coordinator and again at the executor boundary immediately before the side effect. */
export function createDeferredImDispatchPorts(input: {
  db?: AppDatabase
  channel: 'feishu' | 'wechat'
  getAuthorizationEpoch(): number
  isEnabled(): boolean
  isOwnerAuthorized(todo: DeferredTodoRecord): boolean
  recheckTask(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean
  dispatch(request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): Promise<{ dispatched: boolean }>
}) {
  const recheck = async (_request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope) => {
    const context = envelope.executionContext
    const identityMatches = context.channel === input.channel && context.sessionId === todo.originSessionId &&
      context.ownerId === todo.ownerId && context.identityKey === todo.identityKey &&
      context.authorizationEpoch === todo.authorizationEpoch && context.invocationId === todo.invocationId &&
      context.toolName === envelope.toolName && JSON.stringify(context.toolInput) === JSON.stringify(envelope.canonicalArgs) &&
      context.requestId === envelope.requestId && context.turnId === envelope.turnId && context.toolCallId === envelope.toolCallId &&
      typeof context.providerRouteId === 'string' && context.providerRouteId.trim().length > 0
    const allowed = input.isEnabled() && todo.channel === input.channel &&
      todo.authorizationEpoch === input.getAuthorizationEpoch() && input.isOwnerAuthorized(todo) &&
      identityMatches && input.recheckTask(todo, envelope)
    return { allowed }
  }

  return {
    recheck,
    async dispatch(request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope) {
      if (input.db) {
        const closure = getDbConnection(input.db).prepare(`SELECT state,authorization_epoch FROM deferred_approval_closures
          WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
          .get(todo.channel, todo.identityKey, todo.ownerId, todo.originSessionId) as { state: string; authorization_epoch: number } | undefined
        if (closure && closure.state !== 'closed') return { dispatched: false }
      }
      if (!(await recheck(request, todo, envelope)).allowed) return { dispatched: false }
      return input.dispatch(request, todo, envelope)
    }
  }
}
