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
import { remoteAuthorizationRegistry, type RemoteAuthorizationRegistry } from './remoteAuthorizationRegistry'
import { createDeferredResumeRequestStore } from '../confirmation/deferredResumeRequestStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { getDbConnection } from '../database/sqliteStore'
import { confirmationAuthorizationRegistry } from '../confirmation/confirmationAuthorizationRegistry'
import { remoteWriteGrantRegistry } from './remoteWriteGrantRegistry'

type DispatchInput = { request: DeferredResumeRequest; todo: DeferredTodoRecord; envelope: DeferredCallEnvelope }

/** Channel bundle composition: real SQLite stores, ingress, resume coordinator, and current fences. */
export function createDeferredImBundleRuntime(input: {
  db: AppDatabase
  channel: 'feishu' | 'wechat'
  authorizationRegistry?: RemoteAuthorizationRegistry
  todoStore: ReturnType<typeof createDeferredTodoStore>
  notificationDelivery: ReturnType<typeof createDeferredApprovalNotificationDelivery>
  isEnabled(): boolean
  getAuthorizationEpoch(): number
  maxParallel: number
  isOwnerAuthorized(todo: DeferredTodoRecord): boolean
  recheckTask(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean
  recheckAttachment?(todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): boolean | Promise<boolean>
  dispatch(input: DispatchInput): Promise<{ dispatched: boolean; result?: unknown; failureReason?: string }>
  onCompletionWake?(sessionId: string): void | Promise<void>
  scheduleRetry?: (delayMs: number, callback: () => void) => void
  recoverCompletionWake?: (sessionId: string) => void | Promise<void>
  audit(event: SecurityAuditEvent): void
}) {
  const authorizationRegistry = input.authorizationRegistry ?? remoteAuthorizationRegistry
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
    ...(input.recheckAttachment ? { recheckAttachment: input.recheckAttachment } : {}),
    dispatch: async (request, todo, envelope) => {
      const dispatchKey = request.requestId
      const started = executionResults.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey })
      if (!started.ok) return { dispatched: false }
      try {
        const outcome = await input.dispatch({ request, todo, envelope })
        if (!outcome.dispatched) {
          // The dispatch port explicitly reports that it did not enter the executor. This is
          // a known non-execution, not an uncertain side effect: persist a failure receipt and
          // wake the conversation so the owner is told the approved action did not run.
          const value = outcome.result === undefined
            ? { success: false, error: outcome.failureReason ?? '本次操作未能启动，因此没有执行。' }
            : outcome.result
          executionResults.commitResult(todo.todoId, {
            kind: 'failed', outputRef: `deferred-result:${todo.invocationId}`, value
          })
          input.onCompletionWake?.(todo.originSessionId)
          return { dispatched: true }
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
    advanceAuthorizationEpoch: (channel, reason) => authorizationRegistry.advanceAuthorizationEpoch(channel, reason),
    port: {
      blockNewDispatch: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        const row = getDbConnection(input.db).prepare(`SELECT state,authorization_epoch FROM deferred_approval_closures
          WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
          .get(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId) as { state?: string; authorization_epoch?: number } | undefined
        if (row?.state === 'closed' || row?.state !== 'closing' || row.authorization_epoch !== scope.authorizationEpoch) {
          throw new Error('DEFERRED_APPROVAL_CLOSE_FENCE_MISSING')
        }
      },
      persistClosureFacts: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        const now = Date.now()
        const connection = getDbConnection(input.db)
        connection.prepare(`INSERT INTO deferred_approval_closures(channel,identity_key,owner_id,session_id,authorization_epoch,tombstone,state,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(channel,identity_key,owner_id,session_id) DO UPDATE SET
          authorization_epoch=excluded.authorization_epoch,tombstone=excluded.tombstone,state=excluded.state,updated_at=excluded.updated_at`)
          .run(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId, scope.authorizationEpoch, scope.tombstone, 'closing', now)
        input.db.save()
        input.audit({ event: 'settings.policy-change', ts: now, lane: scope.channel, policyDomain: 'im', sessionId: scope.sessionId,
          reason: 'deferred_approval_close', before: 'enabled', after: 'disabled', actor: 'system' })
      },
      invalidatePendingTodos: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        const result = input.todoStore.invalidateByScope({ ...scope, originSessionId: scope.sessionId })
        if (result.dispatchingTodoIds.length) throw new Error('DEFERRED_APPROVAL_DISPATCH_ALREADY_STARTED')
        return result
      },
      cancelResumeRequests: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        const result = resumeRequests.invalidateByScope(scope)
        if (result.dispatching) throw new Error('DEFERRED_APPROVAL_DISPATCH_ALREADY_STARTED')
        return result
      },
      revokeConsumedPermits: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        confirmationAuthorizationRegistry.revokeByChannel(scope.channel)
        remoteWriteGrantRegistry.revokeByChannel(scope.channel, 'manual')
      },
      reconcile: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        const row = getDbConnection(input.db).prepare(`SELECT state FROM deferred_approval_closures
          WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
          .get(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId) as { state?: string } | undefined
        if (!row || row.state !== 'closing' && row.state !== 'reconciliation_required') throw new Error('DEFERRED_APPROVAL_CLOSE_RECONCILIATION_MISSING')
      },
      rollbackToUser: async (scope) => {
        if (scope.channel !== input.channel) throw new Error('DEFERRED_APPROVAL_CLOSE_CHANNEL_MISMATCH')
        const row = getDbConnection(input.db).prepare(`SELECT state FROM deferred_approval_closures
          WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
          .get(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId) as { state?: string } | undefined
        if (!row || row.state !== 'reconciliation_required') throw new Error('DEFERRED_APPROVAL_ROLLBACK_NOT_RECONCILED')
        input.audit({ event: 'settings.policy-change', ts: Date.now(), lane: scope.channel, policyDomain: 'im', sessionId: scope.sessionId,
          reason: 'deferred_approval_close_complete', before: 'enabled', after: 'disabled', actor: 'system' })
      }
    }
  })
  return {
    ...runtime,
    closeCoordinator,
    recoverDispatchingExecutions,
    async recoverPending() {
      const closeResults = await closeCoordinator.reconcilePending()
      if (closeResults.some(({ result }) => result.status !== 'closed')) return []
      return runtime.recoverPending()
    }
  }
}
