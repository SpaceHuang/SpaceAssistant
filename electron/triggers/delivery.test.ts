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
    const deliver = createRuntimeTriggerDelivery({ enqueue, read: () => record, update: vi.fn(() => record), expire: vi.fn(), authorize, queueScope: () => ({ kind: 'desktop' }) })
    expect(deliver('trigger-1')).toMatchObject({ kind: 'enqueued', messageId: 'message-1' })
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'runtime-trigger:trigger-1', content: '运行时事件待处理：trigger-1' }))
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain('private source body')
  })

  it('does not deliver a sync match before the SDK accepts its pause', () => {
    const enqueue = vi.fn()
    const record = { id: 'sync-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', event: {}, definition: { condition: { type: 'session_steps', mode: 'sync' } }, result: {}, revision: 1 }
    const deliver = createRuntimeTriggerDelivery({ enqueue, read: () => record, update: vi.fn(() => record), expire: vi.fn(), authorize, queueScope: () => ({ kind: 'desktop' }) })
    expect(deliver('sync-1')).toEqual({ kind: 'deferred', case: 'sync-pause-not-accepted' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('expires a matched sync record before queue insertion when its deadline has passed', () => {
    const enqueue = vi.fn()
    const expire = vi.fn()
    const record = { id: 'sync-expired', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', expiresAt: 100,
      event: {}, definition: { condition: { type: 'session_steps', mode: 'sync' } }, result: { pauseAcceptedBySdk: true }, revision: 4 }
    const deliver = createRuntimeTriggerDelivery({ enqueue, expire, now: () => 101, read: () => record, update: vi.fn(() => record), authorize,
      queueScope: () => ({ kind: 'desktop' }) })
    expect(deliver(record.id)).toEqual({ kind: 'deferred', case: 'not-matched' })
    expect(expire).toHaveBeenCalledWith(record.id, record.revision)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('delivers an offline time match whose scheduled occurrence was before expiry', () => {
    const enqueue = vi.fn(({ content }: { content: string }) => ({ receipt: { queuedMessageId: 'offline-message' }, persisted: { message: { id: 'offline-message', content } } }))
    const record = { id: 'offline-time', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', expiresAt: 100,
      matchedAt: 200, event: { type: 'time', occurredAt: 50 }, definition: { condition: { type: 'time' } }, result: {}, revision: 2 }
    const deliver = createRuntimeTriggerDelivery({ enqueue, read: () => record, update: vi.fn(() => record), expire: vi.fn(), now: () => 200,
      authorize, queueScope: () => ({ kind: 'desktop' }) })
    expect(deliver(record.id)).toMatchObject({ kind: 'enqueued', messageId: 'offline-message' })
    expect(enqueue).toHaveBeenCalledOnce()
  })

  it('reuses the durable queue receipt when the trigger result write fails after enqueue', () => {
    let record: any = { id: 'crash-window', ownerSessionId: 'owner', receiverSessionId: 'receiver', state: 'matched', event: {},
      definition: { condition: { type: 'time' } }, result: {}, revision: 1 }
    let durableReceipt: { queuedMessageId?: string } | undefined
    let messageWriteShouldFail = true
    const enqueue = vi.fn(({ content }: { content: string }) => {
      durableReceipt ??= { queuedMessageId: 'durable-message' }
      return { receipt: durableReceipt, persisted: { message: { id: 'durable-message', content } } }
    })
    const update = vi.fn((_id: string, expectedRevision: number, patch: any) => {
      if (record.revision !== expectedRevision) return null
      if ('messageId' in patch && messageWriteShouldFail) {
        messageWriteShouldFail = false
        return null
      }
      record = { ...record, ...patch, revision: record.revision + 1 }
      return record
    })
    const deliver = createRuntimeTriggerDelivery({ enqueue, read: () => record, update, expire: vi.fn(), authorize,
      queueScope: () => ({ kind: 'desktop' }), readReceipt: () => durableReceipt })

    expect(deliver(record.id)).toEqual({ kind: 'failed', case: 'delivery-write-conflict' })
    expect(durableReceipt).toEqual({ queuedMessageId: 'durable-message' })
    expect(deliver(record.id)).toEqual({ kind: 'enqueued', messageId: 'durable-message' })
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(record.messageId).toBe('durable-message')
  })
})
