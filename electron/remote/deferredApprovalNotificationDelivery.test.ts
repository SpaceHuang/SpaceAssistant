import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'

function seed(db: ReturnType<typeof openDatabase>) {
  const todoStore = createDeferredTodoStore(db)
  const now = Date.now()
  const todo = todoStore.create({ todoId: 'delivery-todo', invocationId: 'delivery-invocation', channel: 'feishu',
    identityKey: 'delivery-chat', ownerId: 'delivery-owner', authorizationEpoch: 8,
    rule: { ruleId: 'write', factsHash: 'b'.repeat(64) }, workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 3,
    originSessionId: 'delivery-session', createdAt: now, expiresAt: now + 60_000 }).todo
  const intentStore = createSecurityActionIntentStore(db)
  intentStore.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: todo.originSessionId,
    workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
  intentStore.linkTodo(todo.invocationId, todo.todoId)
  intentStore.commitCheckpoint(todo.invocationId, { checkpointId: 'delivery-checkpoint', workflowRevision: 4 })
  return { todoStore, intentStore, todo, now }
}

const safeContent = { safeActionSummary: '更新项目说明', userDelegation: '请更新项目说明。', untrustedMaterial: 'raw command and token are omitted' }
const scope = { channel: 'feishu' as const, identityKey: 'delivery-chat', ownerId: 'delivery-owner', authorizationEpoch: 8 }

describe('deferred approval notification delivery reconciliation contract', () => {
  it('retains failed delivery as undelivered and retries only on the same authenticated scope with a rotated code/version', async () => {
    const temp = createTempDatabase('approval-notification-reconcile-')
    const stores = seed(temp.db)
    const adapter = { send: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ messageId: 'feishu-message-v2' }) }
    const allocateShortCode = vi.fn().mockReturnValueOnce('01').mockReturnValueOnce('02')
    const delivery = createDeferredApprovalNotificationDelivery({ db: temp.db, todoStore: stores.todoStore,
      intentStore: stores.intentStore, adapter, allocateShortCode, audit: vi.fn() })
    await expect(delivery.createAndSend({ todoId: stores.todo.todoId, invocationId: stores.todo.invocationId, ...scope, rule: stores.todo.rule, ...safeContent }))
      .resolves.toMatchObject({ state: 'undelivered', notificationVersion: 1 })
    expect(delivery.list(stores.todo.todoId)).toMatchObject([{ state: 'undelivered', trustedMessageId: null, notificationVersion: 1 }])
    expect(await delivery.retryForAuthenticatedInbound({ ...scope, now: stores.now + 1 }))
      .toMatchObject([{ state: 'delivered', notificationVersion: 2, messageId: 'feishu-message-v2' }])
    expect(allocateShortCode).toHaveBeenCalledTimes(2)
    expect(adapter.send.mock.calls.map(([dto]) => dto.shortCode)).toEqual(['01', '02'])
    expect(delivery.resolveCurrent({ ...scope, shortCode: '01' })).toBeNull()
    expect(delivery.resolveCurrent({ ...scope, shortCode: '02' })).toMatchObject({
      todoId: stores.todo.todoId, notificationVersion: 2, trustedMessageId: 'feishu-message-v2'
    })
    expect(stores.todoStore.get(stores.todo.todoId, { ...scope, rule: stores.todo.rule })?.expiresAt).toBe(stores.todo.expiresAt)
    temp.db.close()
    temp.cleanup()
  })

  it.each([
    ['identity mismatch', { ...scope, identityKey: 'other-chat' }],
    ['owner mismatch', { ...scope, ownerId: 'other-owner' }],
    ['authorization epoch mismatch', { ...scope, authorizationEpoch: 9 }]
  ])('does not redeliver for %s', async (_label, wrongScope) => {
    const temp = createTempDatabase('approval-notification-scope-')
    const stores = seed(temp.db)
    const adapter = { send: vi.fn().mockRejectedValue(new Error('offline')) }
    const delivery = createDeferredApprovalNotificationDelivery({ db: temp.db, todoStore: stores.todoStore,
      intentStore: stores.intentStore, adapter, allocateShortCode: () => '03', audit: vi.fn() })
    await delivery.createAndSend({ todoId: stores.todo.todoId, invocationId: stores.todo.invocationId, ...scope, rule: stores.todo.rule, ...safeContent })
    await expect(delivery.retryForAuthenticatedInbound({ ...wrongScope, now: stores.now + 1 })).resolves.toEqual([])
    expect(adapter.send).toHaveBeenCalledTimes(1)
    temp.db.close()
    temp.cleanup()
  })

  it('does not retry after todo TTL and never extends its expiry', async () => {
    const temp = createTempDatabase('approval-notification-ttl-')
    const stores = seed(temp.db)
    const adapter = { send: vi.fn().mockRejectedValue(new Error('offline')) }
    const delivery = createDeferredApprovalNotificationDelivery({ db: temp.db, todoStore: stores.todoStore,
      intentStore: stores.intentStore, adapter, allocateShortCode: () => '04', audit: vi.fn() })
    await delivery.createAndSend({ todoId: stores.todo.todoId, invocationId: stores.todo.invocationId, ...scope, rule: stores.todo.rule, ...safeContent })
    await expect(delivery.retryForAuthenticatedInbound({ ...scope, now: stores.todo.expiresAt })).resolves.toEqual([])
    expect(adapter.send).toHaveBeenCalledTimes(1)
    expect(stores.todoStore.get(stores.todo.todoId, { ...scope, rule: stores.todo.rule }, stores.todo.expiresAt)?.expiresAt).toBe(stores.todo.expiresAt)
    temp.db.close()
    temp.cleanup()
  })
})
