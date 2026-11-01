import { describe, expect, it, vi } from 'vitest'
import { createRuntimeTriggerDelivery } from './delivery'

describe('runtime trigger delivery', () => {
  const authorize = (trigger: { id: string; ownerSessionId: string; receiverSessionId: string }, queueScope: { kind: 'desktop' }) => ({
    bindingVersion: 1 as const, requestId: `runtime-trigger:${trigger.id}`, ownerSessionId: trigger.ownerSessionId, receiverSessionId: trigger.receiverSessionId,
    queueScope, sourceIdentity: { kind: 'time' }, payloadDigest: 'digest', policyRevision: 'policy-1', authorizationGeneration: 'auth-1', runtimeGeneration: 'runtime-1'
  })
  it('enqueues one fixed neutral marker and never copies matched source payload', () => {
    const enqueue = vi.fn(({ content }: { content: string }) => ({ receipt: { queuedMessageId: 'message-1' }, persisted: { message: { id: 'message-1', content } }, duplicate: false }))
    const record = { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', event: { text: 'private source body' }, definition: { condition: { type: 'time' } }, result: {}, revision: 1 }
    const deliver = createRuntimeTriggerDelivery({ enqueue, read: () => record, update: vi.fn(() => record), authorize, queueScope: () => ({ kind: 'desktop' }) })
    expect(deliver('trigger-1')).toMatchObject({ kind: 'enqueued', messageId: 'message-1' })
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'runtime-trigger:trigger-1', content: '运行时事件待处理：trigger-1' }))
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('private source body')
  })

  it('does not deliver a sync match before the SDK accepts its pause', () => {
    const enqueue = vi.fn()
    const record = { id: 'sync-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', event: {}, definition: { condition: { type: 'session_steps', mode: 'sync' } }, result: {}, revision: 1 }
    const deliver = createRuntimeTriggerDelivery({ enqueue, read: () => record, update: vi.fn(() => record), authorize, queueScope: () => ({ kind: 'desktop' }) })
    expect(deliver('sync-1')).toEqual({ kind: 'deferred', case: 'sync-pause-not-accepted' })
    expect(enqueue).not.toHaveBeenCalled()
  })
})
