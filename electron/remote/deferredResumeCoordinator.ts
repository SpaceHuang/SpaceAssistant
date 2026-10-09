import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import type { DeferredTodoAuthorization, DeferredTodoRecord } from '../confirmation/deferredTodoStore'
import { createDeferredResumeRequestStore, type DeferredResumeRequest } from '../confirmation/deferredResumeRequestStore'
import type { DeferredCallEnvelope } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { getWakeEventRecoveryDelayMs } from '../database/wakeEvents'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { buildDeferredApprovalAuditEvent } from '../confirmation/deferredApprovalAudit'
import { releaseRemoteSession, tryClaimRemoteSession } from './remoteAgentRegistry'

type TodoStore = {
  get(todoId: string, context: DeferredTodoAuthorization, now?: number): DeferredTodoRecord | null
  claimForDispatch(todoId: string, context: DeferredTodoAuthorization, now?: number): DeferredTodoRecord | null
  markConsumed(todoId: string, context: DeferredTodoAuthorization, now?: number): boolean
  invalidate(todoId: string, now?: number): boolean
  invalidateByScope(scope: { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; originSessionId: string }, now?: number): { invalidatedTodoIds: string[]; dispatchingTodoIds: string[] }
  invalidateAssociated(input: { originSessionId: string; workflowId: string; taskId: string; throughPlanRevision: number; now?: number }): unknown
}

type ResumeInput = {
  requestId: string
  todoId: string
  channel: 'feishu' | 'wechat'
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rule: { ruleId: string; factsHash: string }
  notificationVersion: number
  messageId: string
  reasonKey: string
  now?: number
  commitReceipt?: () => boolean
}

export function createDeferredResumeCoordinator(input: {
  db: AppDatabase
  channel?: 'feishu' | 'wechat'
  todoStore: TodoStore
  maxParallel: number
  envelopeStore: { get(invocationId: string): DeferredCallEnvelope | null }
  recheck(request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): Promise<{ allowed: boolean }>
  dispatch(request: DeferredResumeRequest, todo: DeferredTodoRecord, envelope: DeferredCallEnvelope): Promise<{ dispatched: boolean }>
  audit?(event: SecurityAuditEvent): void
}) {
  const requests = createDeferredResumeRequestStore(input.db)
  const intents = createSecurityActionIntentStore(input.db)
  const executionResults = createDeferredExecutionResultStore(input.db)
  const scopeClosed = (scope: { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; sessionId: string }): boolean =>
    getDbConnection(input.db).prepare(`SELECT 1 FROM deferred_approval_closures WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
      .get(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId) !== undefined
  const contextFor = (request: Pick<ResumeInput, 'channel' | 'identityKey' | 'ownerId' | 'authorizationEpoch' | 'rule'>): DeferredTodoAuthorization => ({
    channel: request.channel, identityKey: request.identityKey, ownerId: request.ownerId,
    authorizationEpoch: request.authorizationEpoch, rule: request.rule
  })

  const coordinator = {
    async requestResume(request: ResumeInput, commitReceipt?: () => boolean): Promise<{ status: 'resume_requested' | 'invalidated'; duplicate?: boolean }> {
      const todo = input.todoStore.get(request.todoId, contextFor(request), request.now)
      if (!todo || todo.status !== 'pending' || todo.invocationId.trim() === '' || todo.originSessionId.trim() === '' ||
        scopeClosed({ channel: todo.channel, identityKey: todo.identityKey, ownerId: todo.ownerId, sessionId: todo.originSessionId }) ||
        !intents.authorizeResume(todo.invocationId)) return { status: 'invalidated' }
      const created = runInTransaction(getDbConnection(input.db), () => {
        const inserted = commitReceipt?.()
        if (inserted === false) return null
        const requestResult = requests.create({
          requestId: request.requestId, reasonKey: request.reasonKey, todoId: todo.todoId, invocationId: todo.invocationId,
          sessionId: todo.originSessionId, channel: todo.channel, identityKey: todo.identityKey, ownerId: todo.ownerId,
          authorizationEpoch: todo.authorizationEpoch, rule: todo.rule, notificationVersion: request.notificationVersion,
          messageId: request.messageId, now: request.now
        })
        return requestResult
      })
      if (!created) return { status: 'invalidated' }
      return { status: 'resume_requested', duplicate: created.duplicate }
    },

    getResumeRequest(requestId: string): DeferredResumeRequest | null { return requests.get(requestId) },
    listPendingSessionIds(): string[] { return requests.listPendingSessionIds(input.channel) },
    listCompletionRecoverySessionIds(): Array<{ sessionId: string; delayMs: number }> {
      if (!input.channel) return []
      const conn = getDbConnection(input.db)
      const rows = conn.prepare(`SELECT DISTINCT t.origin_session_id AS session_id FROM deferred_todos t
        JOIN deferred_execution_results r ON r.todo_id=t.todo_id
        JOIN deferred_completion_outbox o ON o.todo_id=t.todo_id
        JOIN wake_events w ON w.session_id=t.origin_session_id AND w.event_type='safety-recovery'
          AND json_extract(w.payload_ref_json,'$.approvalId')=t.todo_id
        WHERE t.channel=? AND r.state IN ('completion_outboxed','delivered') AND o.state IN ('pending','delivered')
          AND w.status IN ('pending','claimed')
        ORDER BY t.origin_session_id`).all(input.channel) as Array<{ session_id: string }>
      return rows.flatMap(({ session_id }) => {
        const delayMs = getWakeEventRecoveryDelayMs(input.db, session_id)
        return delayMs === null ? [] : [{ sessionId: session_id, delayMs }]
      })
    },
    recoverDispatchingExecutions: async (queryResult: Parameters<ReturnType<typeof createDeferredExecutionResultStore>['recover']>[1]) => {
      if (!input.channel) return []
      const conn = getDbConnection(input.db)
      const rows = conn.prepare(`SELECT r.dispatch_key FROM deferred_execution_results r
        JOIN deferred_todos t ON t.todo_id=r.todo_id WHERE t.channel=? AND r.state='dispatching'
        ORDER BY r.dispatch_started_at,r.dispatch_key`).all(input.channel) as Array<{ dispatch_key: string }>
      const recovered = []
      for (const { dispatch_key } of rows) recovered.push({ dispatchKey: dispatch_key, result: await executionResults.recover(dispatch_key, queryResult) })
      return recovered
    },
    listResumeRequests(sessionId: string): DeferredResumeRequest[] { return requests.list(sessionId) },
    invalidatePendingTodos(scope: { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; sessionId: string }) {
      return input.todoStore.invalidateByScope({ ...scope, originSessionId: scope.sessionId })
    },
    cancelPendingResumeRequests(scope: { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; sessionId: string }) {
      return requests.invalidateByScope({ ...scope, sessionId: scope.sessionId })
    },

    async dispatchPending(sessionId: string): Promise<Array<{ requestId: string; status: 'dispatched' | 'session_busy' | 'parallel_full' | 'invalidated' | 'outcome_unknown' }>> {
      const results: Array<{ requestId: string; status: 'dispatched' | 'session_busy' | 'parallel_full' | 'invalidated' | 'outcome_unknown' }> = []
      for (const request of requests.listPending(sessionId, input.channel)) {
        if (scopeClosed({ channel: request.channel, identityKey: request.identityKey, ownerId: request.ownerId, sessionId: request.sessionId })) {
          input.todoStore.invalidate(request.todoId)
          requests.invalidateByTodo(request.todoId)
          results.push({ requestId: request.requestId, status: 'invalidated' })
          continue
        }
        const lease = tryClaimRemoteSession(request.sessionId, request.requestId, input.maxParallel)
        if (lease !== 'ok') {
          results.push({ requestId: request.requestId, status: lease })
          break
        }
        try {
          const authorization = contextFor(request)
          const todo = input.todoStore.get(request.todoId, authorization)
          if (!todo || todo.status !== 'pending' || todo.invocationId !== request.invocationId || todo.originSessionId !== request.sessionId ||
            todo.workflowId.trim() === '' || todo.taskId.trim() === '' || todo.stepId.trim() === '' ||
            !intents.authorizeResume(todo.invocationId)) {
            requests.invalidateByTodo(request.todoId)
            results.push({ requestId: request.requestId, status: 'invalidated' })
            continue
          }
          const envelope = input.envelopeStore.get(request.invocationId)
          if (!envelope || envelope.invocationId !== todo.invocationId) {
            input.todoStore.invalidate(request.todoId)
            requests.invalidateByTodo(request.todoId)
            results.push({ requestId: request.requestId, status: 'invalidated' })
            continue
          }
          const latest = await input.recheck(request, todo, envelope)
          if (!latest.allowed) {
            input.todoStore.invalidate(request.todoId)
            requests.invalidateByTodo(request.todoId)
            results.push({ requestId: request.requestId, status: 'invalidated' })
            continue
          }
          const claimed = runInTransaction(getDbConnection(input.db), () => {
            const currentTodo = input.todoStore.claimForDispatch(request.todoId, authorization)
            if (!currentTodo || !requests.setState(request.requestId, 'pending', 'dispatching')) return false
            if (!input.todoStore.markConsumed(request.todoId, authorization)) throw new Error('DEFERRED_RESUME_CONSUME_FAILED')
            return true
          })
          if (!claimed) {
            requests.invalidateByTodo(request.todoId)
            results.push({ requestId: request.requestId, status: 'invalidated' })
            continue
          }
          input.audit?.(buildDeferredApprovalAuditEvent({ kind: 'dispatch', lane: todo.channel, sessionId: todo.originSessionId,
            todoId: todo.todoId, invocationId: todo.invocationId, consumed: true }))
          try {
            const dispatched = await input.dispatch(request, todo, envelope)
            if (!dispatched.dispatched) {
              requests.setState(request.requestId, 'dispatching', 'outcome_unknown')
              input.audit?.(buildDeferredApprovalAuditEvent({ kind: 'result', lane: todo.channel, sessionId: todo.originSessionId,
                todoId: todo.todoId, invocationId: todo.invocationId, executionState: 'outcome_unknown' }))
              results.push({ requestId: request.requestId, status: 'outcome_unknown' })
              continue
            }
            requests.setState(request.requestId, 'dispatching', 'completed')
            results.push({ requestId: request.requestId, status: 'dispatched' })
          } catch {
            requests.setState(request.requestId, 'dispatching', 'outcome_unknown')
            input.audit?.(buildDeferredApprovalAuditEvent({ kind: 'result', lane: todo.channel, sessionId: todo.originSessionId,
              todoId: todo.todoId, invocationId: todo.invocationId, executionState: 'outcome_unknown' }))
            results.push({ requestId: request.requestId, status: 'outcome_unknown' })
          }
        } finally {
          releaseRemoteSession(request.sessionId, request.requestId)
        }
      }
      return results
    }
  }
  return coordinator
}
