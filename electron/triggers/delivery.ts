import type { QueueScope } from '../../src/shared/queueScope'
import type { RuntimeTriggerRecord } from '../sessionStorage/public/model'

export type RuntimeTriggerDeliveryResult =
  | Readonly<{ kind: 'enqueued'; messageId: string }>
  | Readonly<{ kind: 'deferred'; case: 'not-matched' | 'sync-pause-not-accepted' }>
  | Readonly<{ kind: 'failed'; case: 'delivery-receipt-missing' | 'delivery-message-missing' | 'delivery-write-conflict' }>

export type RuntimeTriggerAuthorizationBinding = Readonly<{
  bindingVersion: 1
  requestId: string
  ownerSessionId: string
  receiverSessionId: string
  queueScope: QueueScope
  sourceIdentity: Readonly<Record<string, unknown>>
  payloadDigest: string
  policyRevision: string
  authorizationGeneration: string
  runtimeGeneration: string
}>

/** Queue only a fixed wake marker. The matched event remains in the trigger record. */
export function createRuntimeTriggerDelivery(input: {
  read(triggerId: string): RuntimeTriggerRecord | null
  update(triggerId: string, expectedRevision: number, patch: Partial<Pick<RuntimeTriggerRecord, 'messageId' | 'result' | 'updatedAt'>>): RuntimeTriggerRecord | null
  expire: (triggerId: string, expectedRevision: number) => unknown
  authorize(trigger: RuntimeTriggerRecord, queueScope: QueueScope): RuntimeTriggerAuthorizationBinding | null
  queueScope(receiverSessionId: string): QueueScope
  enqueue(input: { sessionId: string; requestId: string; content: string; queueScope: QueueScope }): {
    receipt: { queuedMessageId?: string }
    persisted: { message: { id: string; content: string } }
  }
  readReceipt?(input: { sessionId: string; requestId: string; queueScope: QueueScope }): { queuedMessageId?: string } | undefined
  now?: () => number
}) {
  const now = input.now ?? Date.now
  return (triggerId: string): RuntimeTriggerDeliveryResult => {
    const trigger = input.read(triggerId)
    if (!trigger || trigger.state !== 'matched') return { kind: 'deferred', case: 'not-matched' }
    const sync = trigger.definition.condition.type === 'session_steps' && trigger.definition.condition.mode === 'sync'
    // Sync matches are accepted only at a live SDK checkpoint. Other sources may be
    // matched from a pre-expiry fact during recovery and must remain deliverable offline.
    if (sync && now() >= trigger.expiresAt) {
      input.expire(trigger.id, trigger.revision)
      return { kind: 'deferred', case: 'not-matched' }
    }
    if (sync && trigger.result?.pauseAcceptedBySdk !== true) return { kind: 'deferred', case: 'sync-pause-not-accepted' }
    const requestId = `runtime-trigger:${trigger.id}`
    const queueScope = input.queueScope(trigger.receiverSessionId)
    try {
      const authorization = input.authorize(trigger, queueScope)
      if (!authorization || authorization.bindingVersion !== 1 || authorization.requestId !== requestId ||
        authorization.ownerSessionId !== trigger.ownerSessionId || authorization.receiverSessionId !== trigger.receiverSessionId ||
        JSON.stringify(authorization.queueScope) !== JSON.stringify(queueScope) || !authorization.sourceIdentity || !authorization.payloadDigest ||
        !authorization.authorizationGeneration || !authorization.policyRevision || !authorization.runtimeGeneration) {
        return { kind: 'failed', case: 'delivery-write-conflict' }
      }
      if (JSON.stringify(trigger.result?.authorization) !== JSON.stringify(authorization)) {
        const bound = input.update(trigger.id, trigger.revision, { result: { ...(trigger.result ?? {}), authorization }, updatedAt: now() })
        if (!bound) return { kind: 'failed', case: 'delivery-write-conflict' }
      }
      const marker = `运行时事件待处理：${trigger.id}`
      const queued = input.enqueue({ sessionId: trigger.receiverSessionId, requestId, queueScope, content: marker })
      const messageId = queued.receipt.queuedMessageId ?? queued.persisted.message.id
      if (!messageId || messageId !== queued.persisted.message.id || queued.persisted.message.content !== marker) return { kind: 'failed', case: 'delivery-message-missing' }
      const receipt = input.readReceipt?.({ sessionId: trigger.receiverSessionId, requestId, queueScope })
      if (receipt && receipt.queuedMessageId !== messageId) return { kind: 'failed', case: 'delivery-receipt-missing' }
      if (trigger.messageId && trigger.messageId !== messageId) return { kind: 'failed', case: 'delivery-receipt-missing' }
      if (!trigger.messageId) {
        const current = input.read(trigger.id)
        const saved = current && input.update(trigger.id, current.revision, { messageId, updatedAt: now() })
        if (!saved) return { kind: 'failed', case: 'delivery-write-conflict' }
      }
      return { kind: 'enqueued', messageId }
    } catch {
      return { kind: 'failed', case: 'delivery-receipt-missing' }
    }
  }
}
