import type { AppDatabase } from '../database/sqliteStore'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import type { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { buildDeferredApprovalNotification, type DeferredApprovalNotificationDto } from './deferredApprovalNotification'

type TodoStore = ReturnType<typeof createDeferredTodoStore>
type IntentStore = ReturnType<typeof createSecurityActionIntentStore>
type SendInput = {
  todoId: string
  invocationId: string
  channel: 'feishu' | 'wechat'
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rule: { ruleId: string; factsHash: string }
  notificationVersion: number
  shortCode: string
  safeActionSummary: string
  userDelegation: string
  untrustedMaterial: string
}

export function createDeferredApprovalNotificationSender(input: {
  db: AppDatabase
  todoStore: TodoStore
  intentStore: IntentStore
  adapter: { send(dto: DeferredApprovalNotificationDto): Promise<unknown> }
  audit(event: { kind: 'deferred-approval-notification'; state: 'delivery_failed' | 'delivered'; todoId: string; invocationId: string; notificationVersion: number }): void
}) {
  const reviewed = new Map<string, { contentKey: string; dto: DeferredApprovalNotificationDto }>()
  return {
    async send(request: SendInput): Promise<{ status: 'not_ready' | 'invalidated' | 'delivery_pending' | 'delivered' }> {
      const intent = input.intentStore.get(request.invocationId)
      if (!intent || intent.todoId !== request.todoId || !input.intentStore.authorizeResume(request.invocationId)) return { status: 'not_ready' }
      const scopedTodo = input.todoStore.get(request.todoId, {
        channel: request.channel, identityKey: request.identityKey, ownerId: request.ownerId,
        authorizationEpoch: request.authorizationEpoch, rule: request.rule
      })
      if (!scopedTodo || scopedTodo.invocationId !== request.invocationId || scopedTodo.status !== 'pending') return { status: 'invalidated' }
      const key = `${request.todoId}:${request.notificationVersion}`
      const contentKey = JSON.stringify({ ...request, expiresAt: scopedTodo.expiresAt, channel: scopedTodo.channel })
      let cached = reviewed.get(key)
      if (cached && cached.contentKey !== contentKey) throw new Error('DEFERRED_NOTIFICATION_CONTENT_BINDING_CONFLICT')
      if (!cached) {
        cached = {
          contentKey,
          dto: buildDeferredApprovalNotification({
            channel: scopedTodo.channel, todoId: scopedTodo.todoId, notificationVersion: request.notificationVersion,
            shortCode: request.shortCode, expiresAt: scopedTodo.expiresAt, toolName: 'deferred-action',
            safeActionSummary: request.safeActionSummary, userDelegation: request.userDelegation,
            untrustedMaterial: request.untrustedMaterial
          })
        }
        reviewed.set(key, cached)
      }
      try {
        await input.adapter.send(cached.dto)
      } catch {
        input.audit({ kind: 'deferred-approval-notification', state: 'delivery_failed', todoId: request.todoId,
          invocationId: request.invocationId, notificationVersion: request.notificationVersion })
        return { status: 'delivery_pending' }
      }
      input.audit({ kind: 'deferred-approval-notification', state: 'delivered', todoId: request.todoId,
        invocationId: request.invocationId, notificationVersion: request.notificationVersion })
      return { status: 'delivered' }
    }
  }
}
