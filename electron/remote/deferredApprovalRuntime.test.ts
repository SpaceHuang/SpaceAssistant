import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredApprovalRuntime } from './deferredApprovalRuntime'
import { getDbConnection } from '../database/sqliteStore'
import { releaseRemoteSession, resetRunningRemoteAgentRegistryForTests, tryClaimRemoteSession } from './remoteAgentRegistry'

describe('production deferred approval runtime composition', () => {
  it('binds a real SQLite notification to an approved resume and dispatches the same envelope for its origin session', async () => {
    const db = createMemoryAppDb()
    const now = Date.now()
    const rule = { ruleId: 'write-rule', factsHash: 'a'.repeat(64) }
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'todo-production-runtime', invocationId: 'inv-production-runtime', channel: 'feishu',
      identityKey: 'chat-1', ownerId: 'owner-1', authorizationEpoch: 7, rule, workflowId: 'workflow-1', taskId: 'task-1',
      stepId: 'publish', planRevision: 2, originSessionId: 'origin-session', createdAt: now, expiresAt: now + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: todo.originSessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision, now })
    intents.linkTodo(todo.invocationId, todo.todoId, now)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'checkpoint-1', workflowRevision: 3 }, now)
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, requestId: 'request-original', turnId: 'turn-original', toolCallId: 'tool-original',
      toolName: 'write_file', canonicalArgs: { path: 'publish.md', content: 'original' }, contentVersions: { policy: 4 },
      executionContext: { sessionId: todo.originSessionId, lane: 'feishu', ownerId: todo.ownerId, identityKey: todo.identityKey,
        providerRouteId: 'route-original', messageId: 'source-message' }, now })
    const audits: Array<{ event: string }> = []
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'trusted-notification' }) }, audit: (event) => audits.push(event as { event: string }) })
    const notification = await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId,
      channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch,
      rule, safeActionSummary: 'publish update', userDelegation: 'publish the approved update', untrustedMaterial: '', now })
    expect(notification.state).toBe('delivered')
    const execute = vi.fn(async (_request, _todo, envelope) => ({ dispatched: envelope.integrityHash.length > 0 }))
    const runtime = createDeferredApprovalRuntime({ db, channel: 'feishu', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 7, maxParallel: 1,
      recheck: async (request, currentTodo, currentEnvelope) => ({ allowed: request.sessionId === currentTodo.originSessionId && currentEnvelope.invocationId === todo.invocationId }),
      dispatch: execute, audit: (event) => audits.push(event as { event: string }) })

    const reply = await runtime.handleReply({ channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', messageId: 'approval-reply',
      replyToMessageId: 'trusted-notification', text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 1 })

    expect(reply).toMatchObject({ status: 'resume_requested', sessionId: 'origin-session', dispatch: [{ status: 'dispatched' }] })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ requestId: 'request-original', turnId: 'turn-original', toolCallId: 'tool-original',
      canonicalArgs: { path: 'publish.md', content: 'original' } })
    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', authorizationEpoch: 7, rule })?.status).toBe('consumed')
    db.close()
  })

  it('keeps gate-closed replies rejected and never creates a resume request', async () => {
    const db = createMemoryAppDb()
    const todoStore = createDeferredTodoStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = { resolveCurrent: vi.fn(() => null) } as never
    const dispatch = vi.fn()
    const runtime = createDeferredApprovalRuntime({ db, channel: 'wechat', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => false, getAuthorizationEpoch: () => 1, maxParallel: 1,
      recheck: async () => ({ allowed: true }), dispatch, audit: vi.fn() })
    await expect(runtime.handleReply({ channel: 'wechat', identityKey: 'user', ownerId: 'user', messageId: 'reply', text: '批准 07' }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })

  it('commits the inbound receipt with the resume request through the production runtime', async () => {
    const db = createMemoryAppDb()
    const now = Date.now()
    const rule = { ruleId: 'write-rule', factsHash: 'd'.repeat(64) }
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'todo-receipt-runtime', invocationId: 'inv-receipt-runtime', channel: 'wechat',
      identityKey: 'wechat-user', ownerId: 'wechat-user', authorizationEpoch: 2, rule, workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, originSessionId: 'origin', createdAt: now, expiresAt: now + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: todo.originSessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision, now })
    intents.linkTodo(todo.invocationId, todo.todoId, now)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'receipt-checkpoint', workflowRevision: 1 }, now)
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: {}, contentVersions: {},
      executionContext: { sessionId: todo.originSessionId }, now })
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'trusted-approval' }) }, audit: vi.fn() })
    const notification = await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId,
      channel: 'wechat', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule,
      safeActionSummary: 'write file', userDelegation: 'write the file', untrustedMaterial: '', now })
    const runtime = createDeferredApprovalRuntime({ db, channel: 'wechat', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 2, maxParallel: 1, recheck: async () => ({ allowed: true }),
      dispatch: async () => ({ dispatched: false }), audit: vi.fn() })

    await runtime.handleReply({ channel: 'wechat', identityKey: todo.identityKey, ownerId: todo.ownerId, messageId: 'approval-reply-runtime',
      replyToMessageId: 'trusted-approval', text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 1 })

    expect(getDbConnection(db).prepare('SELECT channel,identity_key,message_id FROM deferred_approval_ingress_receipts WHERE message_id=?')
      .get('approval-reply-runtime')).toEqual({ channel: 'wechat', identity_key: 'wechat-user', message_id: 'approval-reply-runtime' })
    expect(runtime.resume.listResumeRequests(todo.originSessionId)).toHaveLength(1)
    db.close()
  })

  it('retries an approved resume after slot contention without another inbound reply', async () => {
    const db = createMemoryAppDb()
    const now = Date.now()
    const sessionId = 'resume-retry-session'
    const rule = { ruleId: 'write-rule', factsHash: 'f'.repeat(64) }
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'todo-resume-retry', invocationId: 'inv-resume-retry', channel: 'wechat',
      identityKey: 'retry-user', ownerId: 'retry-user', authorizationEpoch: 2, rule, workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, originSessionId: sessionId, createdAt: now, expiresAt: now + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1, now })
    intents.linkTodo(todo.invocationId, todo.todoId, now)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'retry-checkpoint', workflowRevision: 1 }, now)
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, requestId: 'source-request', turnId: 'source-turn', toolCallId: 'source-tool',
      toolName: 'write_file', canonicalArgs: {}, contentVersions: {}, executionContext: {}, now })
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'retry-notice' }) }, audit: vi.fn() })
    const notification = await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId,
      channel: 'wechat', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 2, rule,
      safeActionSummary: 'write file', userDelegation: 'write the file', untrustedMaterial: '', now })
    const scheduled: Array<() => void> = []
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const runtime = createDeferredApprovalRuntime({ db, channel: 'wechat', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 2, maxParallel: 1, recheck: async () => ({ allowed: true }), dispatch,
      audit: vi.fn(), scheduleRetry: (_delay, callback) => scheduled.push(callback) })
    expect(tryClaimRemoteSession(sessionId, 'ordinary-loop', 1)).toBe('ok')

    await runtime.handleReply({ channel: 'wechat', identityKey: todo.identityKey, ownerId: todo.ownerId, messageId: 'retry-reply',
      replyToMessageId: 'retry-notice', text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 1 })
    expect(dispatch).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    const recoveryScheduled: Array<() => void> = []
    const recoveredRuntime = createDeferredApprovalRuntime({ db, channel: 'wechat', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 2, maxParallel: 1, recheck: async () => ({ allowed: true }), dispatch,
      audit: vi.fn(), scheduleRetry: (_delay, callback) => recoveryScheduled.push(callback) })
    await expect(recoveredRuntime.recoverPending()).resolves.toMatchObject([{ sessionId, dispatch: [{ status: 'session_busy' }] }])
    expect(recoveryScheduled).toHaveLength(1)
    releaseRemoteSession(sessionId, 'ordinary-loop')
    recoveryScheduled[0]?.()
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(recoveredRuntime.resume.listResumeRequests(sessionId)).toMatchObject([{ state: 'completed' }])
    resetRunningRemoteAgentRegistryForTests()
    db.close()
  })
})
