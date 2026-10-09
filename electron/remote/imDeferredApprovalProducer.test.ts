import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { ensureImTurnTaskControl } from '../database/taskControl'
import { createDeferredTodoCapacityController } from '../confirmation/deferredTodoCapacity'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createImDeferredApprovalProducer } from './imDeferredApprovalProducer'
import { createDeferredImBundleRuntime } from './deferredImBundleRuntime'
import type { RemoteContext } from '../tools/types'

describe('production IM deferred approval producer', () => {
  it('persists exact invocation, task checkpoint, todo, and safe notification before returning deferred', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'origin-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-1', userMessageId: 'user-message-1' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({
      db, todoStore, intentStore, adapter: { send: async () => ({ messageId: 'notice-1' }) }, audit: vi.fn()
    })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 4,
      resolveTaskDigest: () => 'Write the approved project summary.' })
    const remoteContext: RemoteContext = {
      source: 'feishu', messageId: 'platform-message-1', confirmPolicy: 'im_confirm', chatId: 'chat-1', userId: 'owner',
      authOwner: 'owner', originSessionId: sessionId, requestId: 'request-1', turnId: 'turn-1', currentUserMessageId: 'user-message-1',
      taskBinding: binding.taskBinding, providerRouteId: 'anthropic:route-1', model: 'model-1', workDirProfileId: 'profile-1'
    }
    const confirmation = { call: { invocationId: 'turn-1', toolCallId: 'call-1', toolName: 'write_file', input: { path: 'summary.md', content: 'approved' } },
      modelTurn: 1, confirmationId: 'call-1', answerer: 'agent' as const, reasonCode: 'write-rule',
      context: { facts: { actionClass: 'write', summary: { text: 'Write summary.md' } }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } } }
    const deferred = await producer.defer(confirmation.call, { kind: 'denied', answerer: 'agent', cause: 'agent-deny' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }, remoteContext)

    expect(deferred).toMatchObject({ kind: 'deferred', invocationId: 'turn-1', checkpointRef: { checkpointId: 'deferred:turn-1' } })
    const factsHash = (getDbConnection(db).prepare('SELECT facts_hash FROM deferred_todos WHERE todo_id=?').get(deferred!.todoId) as { facts_hash: string }).facts_hash
    const todo = todoStore.get(deferred!.todoId, { channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner', authorizationEpoch: 4,
      rule: { ruleId: 'write-rule', factsHash } })
    expect(todo).toMatchObject({ status: 'pending', originSessionId: sessionId, taskId: binding.taskBinding.taskId, stepId: 'request' })
    expect(envelopeStore.get('turn-1')).toMatchObject({ requestId: 'request-1', turnId: 'turn-1', toolCallId: 'call-1', canonicalArgs: confirmation.call.input })
    expect(intentStore.authorizeResume('turn-1')).toBe(true)
    expect(notificationDelivery.list(deferred!.todoId)).toMatchObject([{ state: 'delivered', trustedMessageId: 'notice-1' }])
    db.close()
  })

  it('fails closed without the exact authenticated task binding or user delegation', async () => {
    const db = createMemoryAppDb()
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const producer = createImDeferredApprovalProducer({ db, channel: 'wechat', todoStore, capacity, intentStore,
      envelopeStore: createDeferredEnvelopeStore(db),
      notificationDelivery: { createAndSend: vi.fn() } as never, isEnabled: () => true, getAuthorizationEpoch: () => 1,
      resolveTaskDigest: () => undefined })
    const context = { facts: { actionClass: 'write' }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } }
    await expect(producer.defer({ invocationId: 'i', toolCallId: 'c', toolName: 'write_file', input: {} },
      { kind: 'denied', answerer: 'agent', cause: 'agent-deny' }, { call: {} as never, modelTurn: 1, confirmationId: 'c', answerer: 'agent', reasonCode: 'rule', context },
      context, { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }, { source: 'wechat', authOwner: 'owner' } as RemoteContext))
      .resolves.toBeUndefined()
    expect(todoStore).toBeDefined()
    db.close()
  })

  it('preserves an admitted todo after notification failure and retries it on the next authenticated inbound', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'undelivered-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-undelivered', userMessageId: 'user-message' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const send = vi.fn().mockRejectedValueOnce(new Error('temporary channel outage')).mockResolvedValueOnce({ messageId: 'notice-after-retry' })
    const delivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore, adapter: { send }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore,
      envelopeStore: createDeferredEnvelopeStore(db), notificationDelivery: delivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 2, resolveTaskDigest: () => 'Publish the report.' })
    const context: RemoteContext = { source: 'feishu', messageId: 'origin', confirmPolicy: 'im_confirm', chatId: 'chat', userId: 'owner',
      authOwner: 'owner', originSessionId: sessionId, requestId: 'request-undelivered', turnId: 'turn-undelivered', currentUserMessageId: 'user-message',
      taskBinding: binding.taskBinding, providerRouteId: 'route', model: 'model', workDirProfileId: 'profile' }
    const confirmation = { call: { invocationId: 'turn-undelivered', toolCallId: 'call', toolName: 'write_file', input: { path: 'report.md' } },
      modelTurn: 1, confirmationId: 'call', answerer: 'agent' as const, reasonCode: 'write-rule',
      context: { facts: { actionClass: 'write' }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } } }
    const deferred = await producer.defer(confirmation.call, { kind: 'denied', answerer: 'agent', cause: 'agent-deny' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }, context)
    expect(deferred).toMatchObject({ kind: 'deferred', invocationId: 'turn-undelivered' })
    expect(getDbConnection(db).prepare('SELECT state FROM deferred_todos WHERE invocation_id=?').get('turn-undelivered')).toEqual({ state: 'pending' })
    expect(capacity.counts({ identityKey: 'chat' }).identity).toBe(1)
    expect(delivery.list(deferred!.todoId)).toMatchObject([{ state: 'undelivered', trustedMessageId: null }])

    await expect(delivery.retryForAuthenticatedInbound({ channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 2 }))
      .resolves.toMatchObject([{ todoId: deferred!.todoId, state: 'delivered', messageId: 'notice-after-retry' }])
    expect(delivery.resolveCurrent({ channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 2,
      shortCode: delivery.list(deferred!.todoId)[1]!.shortCode })).toMatchObject({ trustedMessageId: 'notice-after-retry' })
    db.close()
  })

  it('closes the real producer → trusted reply → fenced origin-session dispatch path', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'e2e-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-e2e', userMessageId: 'user-e2e' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intents = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'trusted-e2e' }) }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore: intents, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 3, resolveTaskDigest: () => 'Create the report.' })
    const context: RemoteContext = { source: 'feishu', messageId: 'origin', confirmPolicy: 'im_confirm', chatId: 'chat-e2e', userId: 'owner',
      authOwner: 'owner', originSessionId: sessionId, requestId: 'request-e2e', turnId: 'turn-e2e', currentUserMessageId: 'user-e2e',
      taskBinding: binding.taskBinding, providerRouteId: 'route-e2e', model: 'model', workDirProfileId: 'profile' }
    const confirmation = { call: { invocationId: 'turn-e2e', toolCallId: 'call-e2e', toolName: 'write_file', input: { path: 'report.md', content: 'approved' } },
      modelTurn: 1, confirmationId: 'call-e2e', answerer: 'agent' as const, reasonCode: 'write-rule',
      context: { facts: { actionClass: 'write', summary: { text: 'Create report.md' } }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } } }
    const deferred = await producer.defer(confirmation.call, { kind: 'denied', answerer: 'agent', cause: 'agent-deny' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }, context)
    expect(deferred).toMatchObject({ kind: 'deferred' })
    const dispatch = vi.fn(async ({ todo, envelope }: { todo: { invocationId: string }; envelope: { requestId: string; canonicalArgs: unknown } }) => ({
      dispatched: todo.invocationId === 'turn-e2e' && envelope.requestId === 'request-e2e' && JSON.stringify(envelope.canonicalArgs) === JSON.stringify(confirmation.call.input)
    }))
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true,
      recheckTask: (todo, envelope) => {
        const row = getDbConnection(db).prepare('SELECT data_json FROM im_task_control WHERE session_id=? AND workflow_id=? AND task_id=?').get(todo.originSessionId, todo.workflowId, todo.taskId) as { data_json: string }
        const taskData = JSON.parse(row.data_json) as { outstandingInvocations: Array<{ invocationId: string; todoId: string; stepId: string }> }
        return envelope.executionContext.workflowId === todo.workflowId && taskData.outstandingInvocations.some((entry) => entry.invocationId === todo.invocationId && entry.todoId === todo.todoId)
      }, dispatch, audit: vi.fn() })
    const notification = notificationDelivery.list(deferred!.todoId)[0]!
    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'chat-e2e', ownerId: 'owner', messageId: 'reply-e2e',
      replyToMessageId: notification.trustedMessageId!, text: `批准 ${notification.shortCode}` })).resolves.toMatchObject({ status: 'resume_requested', sessionId, dispatch: [{ status: 'dispatched' }] })
    expect(dispatch).toHaveBeenCalledOnce()
    db.close()
  })
})
