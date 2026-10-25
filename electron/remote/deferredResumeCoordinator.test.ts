import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { isRequestLeaseOwner, releaseRemoteSession, resetRunningRemoteAgentRegistryForTests, tryClaimRemoteSession } from './remoteAgentRegistry'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'
import { getDbConnection } from '../database/sqliteStore'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'

describe('deferred resume request boundary', () => {
  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
  })

  it.each(['feishu', 'wechat'] as const)(
    're-enters policy reevaluation after a known pre-dispatch policy rejection on %s', async (channel) => {
      const db = createMemoryAppDb()
      const conn = getDbConnection(db)
      commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
        updatedAt: 1, eventId: `fresh-approval-${channel}-seed` })
      const sessionId = createSession(db, { name: `fresh-approval-${channel}` }).id
      const todoStore = createDeferredTodoStore(db)
      const rule = { ruleId: 'old-ask', factsHash: 'a'.repeat(64) }
      const todo = todoStore.create({ todoId: `fresh-approval-${channel}-todo`, invocationId: `fresh-approval-${channel}-invocation`,
        channel, identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task',
        stepId: 'step', planRevision: 1, originSessionId: sessionId, createdAt: 10, expiresAt: Date.now() + 60_000 }).todo
      const intents = createSecurityActionIntentStore(db)
      intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
        workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
      intents.linkTodo(todo.invocationId, todo.todoId)
      intents.commitCheckpoint(todo.invocationId, { checkpointId: `fresh-approval-${channel}-checkpoint`, workflowRevision: 1 })
      const envelopeStore = createDeferredEnvelopeStore(db)
      envelopeStore.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: {}, contentVersions: {},
        executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId,
          toolName: 'write_file', toolInput: {}, ruleId: rule.ruleId, factsHash: rule.factsHash,
          policyBehaviorVersion: todo.policyBehaviorVersion, policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch } })
      const reauthorize = vi.fn(async () => undefined)
      const coordinator = createDeferredResumeCoordinator({ db, channel, todoStore, envelopeStore, dispatch: async () => ({
        dispatched: false, failureCode: 'FRESH_APPROVAL_REQUIRED'
      }), maxParallel: 1, requirePolicyFence: true, recheck: async () => ({ allowed: true }),
      onFreshApprovalRequired: reauthorize })
      const requeue = vi.spyOn(todoStore, 'requeueConsumedAfterPolicyChange')
      await coordinator.requestResume({ requestId: `fresh-approval-${channel}-request`, todoId: todo.todoId, sessionId,
        channel, identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch,
        rule, notificationVersion: 1, messageId: 'owner-approved', reasonKey: 'owner-approved' })

      const result = await coordinator.dispatchPending(sessionId)
      expect(requeue).toHaveBeenCalledOnce()
      expect(result).toEqual([{ requestId: `fresh-approval-${channel}-request`, status: 'invalidated' }])
      expect(coordinator.getResumeRequest(`fresh-approval-${channel}-request`)?.state).toBe('invalidated')
      expect(todoStore.listInvalidatedByPolicyChange(channel)).toHaveLength(1)
      expect(reauthorize).toHaveBeenCalledOnce()
      db.close()
    }
  )

  it('persists an authenticated resume request while the session lease is busy, leaving todo pending without dispatch', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'resume-request-busy' }).id
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({
      todoId: 'resume-todo', invocationId: 'resume-invocation', channel: 'wechat', identityKey: 'identity', ownerId: 'owner',
      authorizationEpoch: 3, rule: { ruleId: 'write', factsHash: 'a'.repeat(64) }, workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, originSessionId: sessionId, createdAt: 10, expiresAt: Date.now() + 60_000
    }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'checkpoint-1', workflowRevision: 1 })
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: { path: 'report.txt', content: 'approved' },
      contentVersions: { document: 1 }, executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId } })
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const coordinator = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, dispatch, maxParallel: 2, recheck: async () => ({ allowed: true }) })
    expect(tryClaimRemoteSession(sessionId, 'ordinary-loop', 2)).toBe('ok')

    await expect(coordinator.requestResume({
      requestId: 'resume-request-1', todoId: todo.todoId, sessionId, channel: 'wechat', identityKey: 'identity', ownerId: 'owner',
      authorizationEpoch: 3, rule: todo.rule, notificationVersion: 1, messageId: 'trusted-message-1', reasonKey: 'reply-1'
    })).resolves.toMatchObject({ status: 'resume_requested' })

    expect(coordinator.getResumeRequest('resume-request-1')).toMatchObject({ todoId: todo.todoId, state: 'pending', messageId: 'trusted-message-1' })
    expect(todoStore.get(todo.todoId, { channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, originSessionId: sessionId, rule: todo.rule })?.status).toBe('pending')
    expect(dispatch).not.toHaveBeenCalled()
    expect(isRequestLeaseOwner(sessionId, 'ordinary-loop')).toBe(true)
    releaseRemoteSession(sessionId, 'ordinary-loop')
    db.close()
  })

  it('keeps multiple resume requests durable while an ordinary loop owns the shared session slot', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'resume-request-concurrent' }).id
    const todoStore = createDeferredTodoStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const intents = createSecurityActionIntentStore(db)
    const rule = { ruleId: 'write', factsHash: 'b'.repeat(64) }
    for (const suffix of ['a', 'b']) {
      const todo = todoStore.create({
      todoId: `todo-${suffix}`, invocationId: `invocation-${suffix}`, channel: 'feishu', identityKey: 'identity', ownerId: 'owner',
      authorizationEpoch: 4, rule, workflowId: 'workflow', taskId: 'task', stepId: `step-${suffix}`, planRevision: 2,
      originSessionId: sessionId, createdAt: 20, expiresAt: Date.now() + 60_000
      }).todo
      intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
        workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
      intents.linkTodo(todo.invocationId, todo.todoId)
      intents.commitCheckpoint(todo.invocationId, { checkpointId: `checkpoint-${suffix}`, workflowRevision: 2 })
      envelopeStore.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: { path: `${suffix}.txt`, content: 'approved' },
        contentVersions: { document: 1 }, executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId } })
    }
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const recheck = vi.fn(async () => ({ allowed: true }))
    const audit = vi.fn()
    const coordinator = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, dispatch, maxParallel: 1, recheck, audit })
    expect(tryClaimRemoteSession(sessionId, 'ordinary-loop', 1)).toBe('ok')

    const requests = await Promise.all(['a', 'b'].map((suffix) => coordinator.requestResume({
      requestId: `request-${suffix}`, todoId: `todo-${suffix}`, sessionId, channel: 'feishu', identityKey: 'identity', ownerId: 'owner',
      authorizationEpoch: 4, rule, notificationVersion: 1, messageId: `message-${suffix}`, reasonKey: `reply-${suffix}`
    })))
    expect(requests.map(({ status }) => status)).toEqual(['resume_requested', 'resume_requested'])
    expect(coordinator.listResumeRequests(sessionId).map(({ requestId, state }) => [requestId, state])).toEqual([
      ['request-a', 'pending'], ['request-b', 'pending']
    ])
    expect(dispatch).not.toHaveBeenCalled()
    expect(await coordinator.dispatchPending(sessionId)).toEqual([
      { requestId: 'request-a', status: 'session_busy' }
    ])
    expect(coordinator.listResumeRequests(sessionId).every(({ state }) => state === 'pending')).toBe(true)
    expect(isRequestLeaseOwner(sessionId, 'ordinary-loop')).toBe(true)
    releaseRemoteSession(sessionId, 'ordinary-loop')
    expect(await coordinator.dispatchPending(sessionId)).toEqual([
      { requestId: 'request-a', status: 'dispatched' }, { requestId: 'request-b', status: 'dispatched' }
    ])
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'deferred-approval.dispatch', actor: 'agent',
      todoId: 'todo-a', invocationId: 'invocation-a', executionState: 'consumed' }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ policyDomain: 'im', dispatchKey: 'request-a' }))
    expect(dispatch.mock.calls.map(([, , envelope]) => envelope.invocationId)).toEqual(['invocation-a', 'invocation-b'])
    expect(dispatch.mock.calls.map(([, , envelope]) => envelope.toolName)).toEqual(['write_file', 'write_file'])
    expect(coordinator.listResumeRequests(sessionId).map(({ state }) => state)).toEqual(['completed', 'completed'])
    expect(todoStore.get('todo-a', { channel: 'feishu', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 4, originSessionId: sessionId, rule })?.status).toBe('consumed')
    expect(todoStore.get('todo-b', { channel: 'feishu', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 4, originSessionId: sessionId, rule })?.status).toBe('consumed')
    db.close()
  })

  it('rolls back receipt and request together when the request insert fails', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'atomic-receipt-request' }).id
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'atomic-todo', invocationId: 'atomic-invocation', channel: 'wechat', identityKey: 'identity',
      ownerId: 'owner', authorizationEpoch: 3, rule: { ruleId: 'write', factsHash: 'c'.repeat(64) }, workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, originSessionId: sessionId, createdAt: 10, expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'atomic-checkpoint', workflowRevision: 1 })
    const envelopes = createDeferredEnvelopeStore(db)
    envelopes.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: {}, contentVersions: {}, executionContext: {} })
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_resume_request BEFORE INSERT ON deferred_resume_requests
      BEGIN SELECT RAISE(ABORT, 'injected request failure'); END`)
    const coordinator = createDeferredResumeCoordinator({ db, todoStore, envelopeStore: envelopes, dispatch: vi.fn(), maxParallel: 1,
      recheck: async () => ({ allowed: true }) })
    await expect(coordinator.requestResume({ requestId: 'atomic-request', reasonKey: 'atomic-reason', todoId: todo.todoId, sessionId,
      channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule: todo.rule,
      notificationVersion: 1, messageId: 'trusted', commitReceipt: () => {
        conn.prepare(`INSERT INTO deferred_approval_ingress_receipts(channel,identity_key,message_id,created_at) VALUES('wechat','identity','reply-atomic',10)`).run()
        return true
      } })).rejects.toThrow('injected request failure')
    expect(conn.prepare('SELECT count(*) AS count FROM deferred_approval_ingress_receipts WHERE message_id=?').get('reply-atomic')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT count(*) AS count FROM deferred_resume_requests WHERE request_id=?').get('atomic-request')).toEqual({ count: 0 })
    expect(todoStore.get(todo.todoId, { channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, originSessionId: sessionId, rule: todo.rule })?.status).toBe('pending')
    db.close()
  })

  it('fences an approved todo when the shared policy changes during dispatch recheck', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'resume-policy-fence' }).id
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'policy-seed' })
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'd'.repeat(64) }
    const todo = todoStore.create({ todoId: 'policy-fence-todo', invocationId: 'policy-fence-invocation', channel: 'wechat',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: 10, expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'policy-fence-checkpoint', workflowRevision: 1 })
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: { path: 'policy.txt', content: 'approved' },
      contentVersions: { document: 1 }, executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId,
        channel: 'wechat', ownerId: todo.ownerId, identityKey: todo.identityKey, authorizationEpoch: todo.authorizationEpoch,
        invocationId: todo.invocationId, toolName: 'write_file', toolInput: { path: 'policy.txt', content: 'approved' },
        requestId: todo.invocationId, turnId: todo.invocationId, toolCallId: todo.invocationId, providerRouteId: 'route',
        policyBehaviorVersion: todo.policyBehaviorVersion, policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch,
        ruleId: rule.ruleId, factsHash: rule.factsHash } })
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const coordinator = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, dispatch, maxParallel: 1, requirePolicyFence: true,
      recheck: async () => ({ allowed: true }), audit: () => {
        commitImPolicySnapshot(conn, { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
          snapshot: { selectedPackage: 'strict' }, updatedAt: 2, eventId: 'policy-change-during-recheck' })
      } })
    await coordinator.requestResume({ requestId: 'policy-fence-request', todoId: todo.todoId, sessionId, channel: 'wechat', identityKey: 'identity',
      ownerId: 'owner', authorizationEpoch: 3, rule, notificationVersion: 1, messageId: 'approved-message', reasonKey: 'approved-reply' })

    expect(await coordinator.dispatchPending(sessionId)).toEqual([{ requestId: 'policy-fence-request', status: 'invalidated' }])
    expect(dispatch).not.toHaveBeenCalled()
    expect(todoStore.get(todo.todoId, { channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, originSessionId: sessionId, rule })?.status).toBe('consumed')
    expect(coordinator.getResumeRequest('policy-fence-request')?.state).toBe('invalidated')
    db.close()
  })

  it('invalidates legacy todos that have no persisted shared policy fence', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'resume-missing-policy-fence' }).id
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'e'.repeat(64) }
    const todo = todoStore.create({ todoId: 'missing-policy-fence-todo', invocationId: 'missing-policy-fence-invocation', channel: 'wechat',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: 10, expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'missing-policy-fence-checkpoint', workflowRevision: 1 })
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const coordinator = createDeferredResumeCoordinator({ db, todoStore, envelopeStore: createDeferredEnvelopeStore(db), dispatch,
      maxParallel: 1, requirePolicyFence: true, recheck: async () => ({ allowed: true }) })
    await expect(coordinator.requestResume({ requestId: 'missing-policy-fence-request', todoId: todo.todoId, sessionId, channel: 'wechat',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, notificationVersion: 1, messageId: 'approved',
      reasonKey: 'approved-without-policy' })).resolves.toEqual({ status: 'invalidated' })
    expect(todoStore.get(todo.todoId, { channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, originSessionId: sessionId, rule })?.status).toBe('invalidated')
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })
})
