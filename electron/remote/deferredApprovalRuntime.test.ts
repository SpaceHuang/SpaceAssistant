import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createSession } from '../database/operations'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createDeferredApprovalRuntime } from './deferredApprovalRuntime'
import { readDeferredCompletionWake } from './deferredCompletionWake'
import { getDbConnection } from '../database/sqliteStore'
import { releaseRemoteSession, resetRunningRemoteAgentRegistryForTests, tryClaimRemoteSession } from './remoteAgentRegistry'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'

function seedImPolicy(db: ReturnType<typeof createMemoryAppDb>, eventId: string): void {
  commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId })
}

describe('production deferred approval runtime composition', () => {
  it('rejects a trusted deferred approval, invalidates it, records a failed completion, and never dispatches', async () => {
    const db = createMemoryAppDb()
    const now = Date.now()
    const rule = { ruleId: 'write-rule', factsHash: 'a'.repeat(64) }
    const session = createSession(db, { name: 'rejected-deferred-approval' })
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'todo-rejected-runtime', invocationId: 'inv-rejected-runtime', channel: 'feishu',
      identityKey: 'chat-reject', ownerId: 'owner-reject', authorizationEpoch: 7, rule, workflowId: 'workflow-reject',
      taskId: 'task-reject', stepId: 'step-reject', planRevision: 1, originSessionId: session.id, createdAt: now,
      expiresAt: now + 60_000 }).todo
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, requestId: 'request-reject', turnId: 'turn-reject', toolCallId: 'tool-reject',
      toolName: 'memory_wiki_propose_schema_change', canonicalArgs: {}, contentVersions: {}, now,
      executionContext: { sessionId: todo.originSessionId, channel: 'feishu', ownerId: todo.ownerId, identityKey: todo.identityKey,
        authorizationEpoch: todo.authorizationEpoch, invocationId: todo.invocationId, toolName: 'memory_wiki_propose_schema_change',
        toolInput: {}, requestId: 'request-reject', turnId: 'turn-reject', toolCallId: 'tool-reject', providerRouteId: 'route-reject',
        messageId: 'source-message-reject', ruleId: rule.ruleId, factsHash: rule.factsHash } })
    const notificationDelivery = { resolveCurrent: vi.fn(() => ({ channel: 'feishu', identityKey: todo.identityKey,
      ownerId: todo.ownerId, todoId: todo.todoId, originSessionId: todo.originSessionId, notificationVersion: 1,
      currentNotificationVersion: 1, trustedMessageId: 'trusted-reject-notice', shortCode: '07', expiresAt: todo.expiresAt,
      authorizationEpoch: todo.authorizationEpoch, rule })) } as never
    const execute = vi.fn(async () => ({ dispatched: true }))
    const recoverCompletionWake = vi.fn()
    const audit = vi.fn()
    const runtime = createDeferredApprovalRuntime({ db, channel: 'feishu', todoStore,
      envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => todo.authorizationEpoch, maxParallel: 1,
      recheck: async () => ({ allowed: true }), dispatch: execute, audit, recoverCompletionWake })

    await expect(runtime.handleReply({ channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      messageId: 'untrusted-reject-reply', replyToMessageId: 'different-notice', text: '拒绝 07', now: now + 1 }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      authorizationEpoch: todo.authorizationEpoch, originSessionId: todo.originSessionId, rule })?.status).toBe('pending')
    expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toBeNull()

    await expect(runtime.handleReply({ channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      messageId: 'reject-reply-1', replyToMessageId: 'trusted-reject-notice', text: '拒绝 07', now: now + 1 }))
      .resolves.toMatchObject({ status: 'denied', sessionId: todo.originSessionId })

    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      authorizationEpoch: todo.authorizationEpoch, originSessionId: todo.originSessionId, rule })?.status).toBe('invalidated')
    expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toMatchObject({ state: 'completion_outboxed',
      result: { kind: 'failed', value: { code: 'USER_REJECTED' } } })
    expect(createDeferredExecutionResultStore(db).listCompletionOutbox(todo.todoId)).toMatchObject([{ state: 'pending' }])
    expect(readDeferredCompletionWake(db, todo.todoId)?.execution).toMatchObject({ state: 'completion_outboxed',
      result: { kind: 'failed', value: { code: 'USER_REJECTED' } } })
    expect(runtime.resume.listResumeRequests(todo.originSessionId)).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
    expect(recoverCompletionWake).toHaveBeenCalledWith(todo.originSessionId)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'deferred-approval.rejected', actor: 'user',
      todoId: todo.todoId, invocationId: todo.invocationId }))
    db.close()
  })

  it('binds a real SQLite notification to an approved resume and dispatches the same envelope for its origin session', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db, 'runtime-policy-1')
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
      executionContext: { sessionId: todo.originSessionId, channel: 'feishu', ownerId: todo.ownerId, identityKey: todo.identityKey,
        authorizationEpoch: todo.authorizationEpoch, invocationId: todo.invocationId, toolName: 'write_file',
        toolInput: { path: 'publish.md', content: 'original' }, requestId: 'request-original', turnId: 'turn-original',
        toolCallId: 'tool-original', providerRouteId: 'route-original', messageId: 'source-message',
        policyBehaviorVersion: todo.policyBehaviorVersion, policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch,
        ruleId: rule.ruleId, factsHash: rule.factsHash }, now })
    const audits: Array<{ event: string }> = []
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async (dto) => ({ messageId: dto.todoId === 'todo-other-track' ? 'trusted-notification-other-track' : 'trusted-notification' }) },
      audit: (event) => audits.push(event as { event: string }) })
    const notification = await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId,
      channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch,
      rule, safeActionSummary: 'publish update', userDelegation: 'publish the approved update', untrustedMaterial: '', now })
    expect(notification.state).toBe('delivered')
    const otherRule = { ruleId: 'other-track-write-rule', factsHash: 'e'.repeat(64) }
    const otherTodo = todoStore.create({ todoId: 'todo-other-track', invocationId: 'inv-other-track', channel: 'feishu',
      identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule: otherRule,
      workflowId: 'workflow-other', taskId: 'task-other', stepId: 'publish-other', planRevision: 1,
      originSessionId: 'other-track-session', createdAt: now, expiresAt: now + 60_000 }).todo
    intents.prepare({ invocationId: otherTodo.invocationId, envelopeInvocationId: otherTodo.invocationId,
      sessionId: otherTodo.originSessionId, workflowId: otherTodo.workflowId, taskId: otherTodo.taskId,
      stepId: otherTodo.stepId, planRevision: otherTodo.planRevision, now })
    intents.linkTodo(otherTodo.invocationId, otherTodo.todoId, now)
    intents.commitCheckpoint(otherTodo.invocationId, { checkpointId: 'other-track-checkpoint', workflowRevision: 1 }, now)
    const otherNotification = await notificationDelivery.createAndSend({ todoId: otherTodo.todoId, invocationId: otherTodo.invocationId,
      channel: 'feishu', identityKey: otherTodo.identityKey, ownerId: otherTodo.ownerId,
      authorizationEpoch: otherTodo.authorizationEpoch, rule: otherRule, safeActionSummary: 'other track action',
      userDelegation: 'do the other track action', untrustedMaterial: '', now })
    expect(otherNotification.state).toBe('delivered')
    const execute = vi.fn(async (_request, _todo, envelope) => ({ dispatched: envelope.integrityHash.length > 0 }))
    const runtime = createDeferredApprovalRuntime({ db, channel: 'feishu', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 7, maxParallel: 1,
      recheck: async (request, currentTodo, currentEnvelope) => ({ allowed: request.sessionId === currentTodo.originSessionId && currentEnvelope.invocationId === todo.invocationId }),
      dispatch: execute, audit: (event) => audits.push(event as { event: string }) })

    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', messageId: 'wrong-code-reply',
      replyToMessageId: 'trusted-notification', text: '批准 99', now: now + 1 })).resolves.toMatchObject({ status: 'rejected' })
    expect(runtime.resume.listResumeRequests(todo.originSessionId)).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
    await expect(runtime.handleReply({ channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      messageId: 'cross-track-short-code-reply', replyToMessageId: 'trusted-notification-other-track',
      text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 1 }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(runtime.resume.listResumeRequests(todo.originSessionId)).toHaveLength(0)
    expect(runtime.resume.listResumeRequests(otherTodo.originSessionId)).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      authorizationEpoch: 7, originSessionId: todo.originSessionId, rule })?.status).toBe('pending')
    expect(todoStore.get(otherTodo.todoId, { channel: 'feishu', identityKey: otherTodo.identityKey, ownerId: otherTodo.ownerId,
      authorizationEpoch: 7, originSessionId: otherTodo.originSessionId, rule: otherRule })?.status).toBe('pending')
    getDbConnection(db).prepare('UPDATE deferred_approval_notifications SET expires_at=? WHERE todo_id=?').run(now + 2, todo.todoId)
    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', messageId: 'expired-code-reply',
      replyToMessageId: 'trusted-notification', text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 3 }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(runtime.resume.listResumeRequests(todo.originSessionId)).toHaveLength(0)
    expect(execute).not.toHaveBeenCalled()
    getDbConnection(db).prepare('UPDATE deferred_approval_notifications SET expires_at=? WHERE todo_id=?').run(todo.expiresAt, todo.todoId)

    const reply = await runtime.handleReply({ channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', messageId: 'approval-reply',
      replyToMessageId: 'trusted-notification', text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 4 })

    expect(reply).toMatchObject({ status: 'resume_requested', sessionId: 'origin-session', dispatch: [{ status: 'dispatched' }] })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ requestId: 'request-original', turnId: 'turn-original', toolCallId: 'tool-original',
      canonicalArgs: { path: 'publish.md', content: 'original' } })
    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', authorizationEpoch: 7, originSessionId: todo.originSessionId, rule })?.status).toBe('consumed')
    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner-1', messageId: 'approval-reply',
      replyToMessageId: 'trusted-notification', text: `批准 ${notificationDelivery.list(todo.todoId)[0]!.shortCode}`, now: now + 2 }))
      .resolves.toMatchObject({ status: 'already_consumed' })
    expect(execute).toHaveBeenCalledOnce()
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
    seedImPolicy(db, 'runtime-policy-3')
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
      executionContext: { sessionId: todo.originSessionId, channel: 'wechat', ownerId: todo.ownerId, identityKey: todo.identityKey,
        authorizationEpoch: todo.authorizationEpoch, invocationId: todo.invocationId, toolName: 'write_file', toolInput: {},
        requestId: todo.invocationId, turnId: todo.invocationId, toolCallId: todo.invocationId, providerRouteId: 'route',
        policyBehaviorVersion: todo.policyBehaviorVersion, policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch,
        ruleId: rule.ruleId, factsHash: rule.factsHash }, now })
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
    seedImPolicy(db, 'runtime-policy-4')
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
      toolName: 'write_file', canonicalArgs: {}, contentVersions: {}, executionContext: { sessionId, channel: 'wechat', ownerId: todo.ownerId,
        identityKey: todo.identityKey, authorizationEpoch: todo.authorizationEpoch, invocationId: todo.invocationId, toolName: 'write_file',
        toolInput: {}, requestId: 'source-request', turnId: 'source-turn', toolCallId: 'source-tool', providerRouteId: 'route',
        policyBehaviorVersion: todo.policyBehaviorVersion, policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch,
        ruleId: rule.ruleId, factsHash: rule.factsHash }, now })
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
