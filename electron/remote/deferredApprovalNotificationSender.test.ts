import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationSender } from './deferredApprovalNotificationSender'

function setup() {
  const db = createMemoryAppDb()
  const todoStore = createDeferredTodoStore(db)
  const todo = todoStore.create({ todoId: 'notify-todo', invocationId: 'notify-invocation', channel: 'wechat',
    identityKey: 'notify-identity', ownerId: 'notify-owner', authorizationEpoch: 3,
    rule: { ruleId: 'write', factsHash: 'c'.repeat(64) }, workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1,
    originSessionId: 'session', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
  const intents = createSecurityActionIntentStore(db)
  intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: todo.originSessionId,
    workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
  intents.linkTodo(todo.invocationId, todo.todoId)
  return { db, todoStore, todo, intents }
}

const content = {
  notificationVersion: 1, shortCode: '12', expiresAt: 20_000,
  safeActionSummary: '更新项目说明', userDelegation: '请更新项目说明。',
  untrustedMaterial: 'token=sk-secret1234567890 /Users/person/private.txt'
}

describe('deferred approval notification sender', () => {
  it('waits for checkpoint commit and preserves todo/invocation correlation in safe audit on retry', async () => {
    const f = setup()
    const adapter = { send: vi.fn().mockRejectedValueOnce(new Error('temporary outbound failure')).mockResolvedValueOnce(undefined) }
    const audit = vi.fn()
    const sender = createDeferredApprovalNotificationSender({ db: f.db, todoStore: f.todoStore, intentStore: f.intents, adapter, audit })
    const request = { todoId: f.todo.todoId, invocationId: f.todo.invocationId, channel: f.todo.channel,
      identityKey: f.todo.identityKey, ownerId: f.todo.ownerId, authorizationEpoch: f.todo.authorizationEpoch, rule: f.todo.rule, ...content }
    await expect(sender.send(request))
      .resolves.toMatchObject({ status: 'not_ready' })
    expect(adapter.send).not.toHaveBeenCalled()
    f.intents.commitCheckpoint(f.todo.invocationId, { checkpointId: 'notify-checkpoint', workflowRevision: 2 })
    await expect(sender.send(request))
      .resolves.toMatchObject({ status: 'delivery_pending' })
    expect(f.todoStore.get(f.todo.todoId, { channel: 'wechat', identityKey: f.todo.identityKey, ownerId: f.todo.ownerId,
      authorizationEpoch: f.todo.authorizationEpoch, rule: f.todo.rule })?.status).toBe('pending')
    await expect(sender.send(request))
      .resolves.toMatchObject({ status: 'delivered' })
    expect(adapter.send).toHaveBeenCalledTimes(2)
    expect(adapter.send.mock.calls[0]?.[0]).toBe(adapter.send.mock.calls[1]?.[0])
    expect(adapter.send.mock.calls[0]?.[0].text).not.toContain('sk-secret1234567890')
    expect(audit.mock.calls).toEqual([
      [expect.objectContaining({ kind: 'deferred-approval-notification', state: 'delivery_failed', todoId: 'notify-todo', invocationId: 'notify-invocation', notificationVersion: 1 })],
      [expect.objectContaining({ kind: 'deferred-approval-notification', state: 'delivered', todoId: 'notify-todo', invocationId: 'notify-invocation', notificationVersion: 1 })]
    ])
    f.db.close()
  })
})
