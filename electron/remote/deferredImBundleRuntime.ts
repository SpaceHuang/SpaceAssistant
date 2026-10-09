import type { AppDatabase } from '../database/sqliteStore'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import type { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import type { DeferredCallEnvelope } from '../confirmation/deferredEnvelopeStore'
import type { DeferredResumeRequest } from '../confirmation/deferredResumeRequestStore'
import type { DeferredTodoRecord } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredApprovalRuntime } from './deferredApprovalRuntime'
import { createDeferredImDispatchPorts } from './deferredImDispatch'
import { createDeferredApprovalCloseCoordinator } from './deferredApprovalCloseCoordinator'
import { remoteAuthorizationRegistry } from './remoteAuthorizationRegistry'
import { createDeferredResumeRequestStore } from '../confirmation/deferredResumeRequestStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { getDbConnection } from '../database/sqliteStore'

type DispatchInput = { request: DeferredResumeRequest; todo: DeferredTodoRecord; envelope: DeferredCallEnvelope }

/** Channel bundle composition: real SQLite stores, ingress, resume coordinator, and current fences. */
export function createDeferredImBundleRuntime(input: {
  db: AppDatabase
  channel: 'feishu' | 'wechat'
  todoStore: ReturnType<typeof createDeferredTodoStore>
  notificationDelivery: ReturnType<typeof createDeferredApprovalNotificationDelivery>
  isEnabled(): boolean
  getAuthorizationEpoch(): number
  maxParallel: number
  isOwnerAuthorized(todo: DeferredTodoRecord): boolean
  recheckTask(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean
  dispatch(input: DispatchInput): Promise<{ dispatched: boolean; result?: unknown }>
  onCompletionWake?(sessionId: string): void | Promise<void>
  scheduleRetry?: (delayMs: number, callback: () => void) => void
  recoverCompletionWake?: (sessionId: string) => void | Promise<void>
  audit(event: SecurityAuditEvent): void
}) {
  const executionResults = createDeferredExecutionResultStore(input.db)
  const envelopeStore = createDeferredEnvelopeStore(input.db)
  const resumeRequests = createDeferredResumeRequestStore(input.db)
  const recoverDispatchingExecutions = async (dispatchKey: string) => {
    const row = getDbConnection(input.db).prepare('SELECT todo_id FROM deferred_execution_results WHERE dispatch_key=?').get(dispatchKey) as { todo_id: string } | undefined
    if (row && executionResults.listCompletionOutbox(row.todo_id).length) {
      const result = executionResults.getByTodo(row.todo_id)?.result
      if (result) return { status: 'found' as const, dispatchKey, result }
    }
    return { status: 'unknown' as const }
  }
  const ports = createDeferredImDispatchPorts({
    db: input.db,
    channel: input.channel,
    getAuthorizationEpoch: input.getAuthorizationEpoch,
    isEnabled: input.isEnabled,
    isOwnerAuthorized: input.isOwnerAuthorized,
    recheckTask: input.recheckTask,
    dispatch: async (request, todo, envelope) => {
      const dispatchKey = request.requestId
      const started = executionResults.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey })
      if (!started.ok) return { dispatched: false }
      try {
        const outcome = await input.dispatch({ request, todo, envelope })
        if (!outcome.dispatched) {
          executionResults.markOutcomeUnknown(todo.todoId)
          return { dispatched: false }
        }
        const raw = outcome.result === undefined ? null : outcome.result
        const failed = Boolean(raw && typeof raw === 'object' &&
          ((raw as { ok?: unknown }).ok === false || (raw as { success?: unknown }).success === false))
        let value: unknown
        try { value = JSON.parse(JSON.stringify(raw)) as unknown }
        catch { value = { unavailable: true } }
        executionResults.commitResult(todo.todoId, {
          kind: failed ? 'failed' : 'completed', outputRef: `deferred-result:${todo.invocationId}`, value
        })
        input.onCompletionWake?.(todo.originSessionId)
        return { dispatched: true }
      } catch (error) {
        executionResults.markOutcomeUnknown(todo.todoId)
        throw error
      }
    }
  })
  const runtime = createDeferredApprovalRuntime({
    db: input.db,
    channel: input.channel,
    todoStore: input.todoStore,
    envelopeStore,
    notificationDelivery: input.notificationDelivery,
    isEnabled: input.isEnabled,
    getAuthorizationEpoch: input.getAuthorizationEpoch,
    maxParallel: input.maxParallel,
    recheck: ports.recheck,
    dispatch: ports.dispatch,
    audit: input.audit,
    recoverDispatchingExecutions,
    recoverCompletionWake: input.recoverCompletionWake ?? input.onCompletionWake,
    scheduleRetry: input.scheduleRetry
  })
  const closeCoordinator = createDeferredApprovalCloseCoordinator({
    db: input.db,
    advanceAuthorizationEpoch: (channel, reason) => remoteAuthorizationRegistry.advanceAuthorizationEpoch(channel, reason),
    port: {
      blockNewDispatch: async () => undefined,
      persistClosureFacts: async () => undefined,
      invalidatePendingTodos: async (scope) => {
        const result = input.todoStore.invalidateByScope({ ...scope, originSessionId: scope.sessionId })
        if (result.dispatchingTodoIds.length) throw new Error('DEFERRED_APPROVAL_DISPATCH_ALREADY_STARTED')
        return result
      },
      cancelResumeRequests: async (scope) => {
        const result = resumeRequests.invalidateByScope(scope)
        if (result.dispatching) throw new Error('DEFERRED_APPROVAL_DISPATCH_ALREADY_STARTED')
        return result
      },
      revokeConsumedPermits: async () => undefined,
      reconcile: async () => undefined,
      rollbackToUser: async () => undefined
    }
  })
  return { ...runtime, closeCoordinator, recoverDispatchingExecutions }
}
