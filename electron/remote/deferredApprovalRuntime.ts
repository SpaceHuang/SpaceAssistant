import type { AppDatabase } from '../database/sqliteStore'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import type { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import type { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredApprovalIngress, type parseDeferredApprovalReply } from './deferredApprovalIngress'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'

type TodoStore = ReturnType<typeof createDeferredTodoStore>
type EnvelopeStore = ReturnType<typeof createDeferredEnvelopeStore>
type NotificationDelivery = ReturnType<typeof createDeferredApprovalNotificationDelivery>

/** Production composition for a channel bundle: notification binding → ingress → durable resume → direct dispatch. */
export function createDeferredApprovalRuntime(input: {
  db: AppDatabase
  channel: 'feishu' | 'wechat'
  todoStore: TodoStore
  envelopeStore: EnvelopeStore
  notificationDelivery: NotificationDelivery
  isEnabled(): boolean
  getAuthorizationEpoch(): number
  maxParallel: number
  recheck: Parameters<typeof createDeferredResumeCoordinator>[0]['recheck']
  dispatch: Parameters<typeof createDeferredResumeCoordinator>[0]['dispatch']
  audit(event: SecurityAuditEvent): void
  scheduleRetry?: (delayMs: number, callback: () => void) => void
  recoverDispatchingExecutions?: Parameters<ReturnType<typeof createDeferredResumeCoordinator>['recoverDispatchingExecutions']>[0]
  recoverCompletionWake?: (sessionId: string) => void | Promise<void>
}) {
  const scheduledSessions = new Set<string>()
  const resume = createDeferredResumeCoordinator({
    db: input.db, channel: input.channel, todoStore: input.todoStore, envelopeStore: input.envelopeStore,
    maxParallel: input.maxParallel, recheck: input.recheck, dispatch: input.dispatch, audit: input.audit
  })
  const ingress = createDeferredApprovalIngress({
    db: input.db,
    isEnabled: input.isEnabled,
    resolveNotification: (channel, identityKey, ownerId, shortCode) => {
      if (channel !== input.channel) return []
      const row = input.notificationDelivery.resolveCurrent({
        channel, identityKey, ownerId, shortCode, authorizationEpoch: input.getAuthorizationEpoch()
      })
      return row ? [{
        channel: row.channel, identityKey: row.identityKey, ownerId: row.ownerId, todoId: row.todoId,
        notificationVersion: row.notificationVersion, currentNotificationVersion: row.notificationVersion,
        trustedMessageId: row.trustedMessageId ?? '', shortCode: row.shortCode, expiresAt: row.expiresAt,
        authorizationEpoch: row.authorizationEpoch, rule: row.rule
      }] : []
    },
    getTodo: (todoId, binding) => input.todoStore.get(todoId, {
      channel: binding.channel, identityKey: binding.identityKey, ownerId: binding.ownerId,
      authorizationEpoch: binding.authorizationEpoch, rule: binding.rule
    }),
    requestResume: (request, commitReceipt) => resume.requestResume(request, commitReceipt),
    audit: input.audit
  })

  const schedulePendingRetry = (sessionId: string, delayMs = 500) => {
    if (scheduledSessions.has(sessionId)) return
    scheduledSessions.add(sessionId)
    const callback = () => {
      scheduledSessions.delete(sessionId)
      void dispatchPending(sessionId)
    }
    if (input.scheduleRetry) input.scheduleRetry(delayMs, callback)
    else {
      const timer = setTimeout(callback, delayMs)
      timer.unref?.()
    }
  }
  const dispatchPending = async (sessionId: string) => {
    const results = await resume.dispatchPending(sessionId)
    if (results.some(({ status }) => status === 'session_busy' || status === 'parallel_full')) schedulePendingRetry(sessionId)
    return results
  }

  return {
    resume,
    ingress,
    async recoverPending() {
      if (input.recoverDispatchingExecutions) await resume.recoverDispatchingExecutions(input.recoverDispatchingExecutions)
      const results = []
      for (const sessionId of resume.listPendingSessionIds()) results.push({ sessionId, dispatch: await dispatchPending(sessionId) })
      const completionSessions = resume.listCompletionRecoverySessionIds?.() ?? []
      for (const sessionId of completionSessions) {
        await input.recoverCompletionWake?.(sessionId)
        results.push({ sessionId, completionWake: true })
      }
      return results
    },
    async handleReply(request: {
      channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; messageId: string
      replyToMessageId?: string; text: string; now?: number
    }) {
      if (request.channel !== input.channel) return { status: 'rejected' as const }
      const accepted = await ingress.handle(request)
      if (accepted.status !== 'resume_requested') return accepted
      const dispatched = await dispatchPending(accepted.sessionId)
      return { ...accepted, dispatch: dispatched }
    }
  }
}
