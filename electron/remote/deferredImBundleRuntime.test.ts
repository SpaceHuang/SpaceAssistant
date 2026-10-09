import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredImBundleRuntime } from './deferredImBundleRuntime'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createSession } from '../database/operations'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { listWakeEvents } from '../database/wakeEvents'

describe('deferred IM bundle runtime', () => {
  it('composes durable ingress with the production epoch/task dispatch fence', async () => {
    const db = createMemoryAppDb()
    const todoStore = createDeferredTodoStore(db)
    const notificationDelivery = { resolveCurrent: vi.fn(() => null) } as never
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const runtime = createDeferredImBundleRuntime({
      db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 2, isOwnerAuthorized: () => true,
      recheckTask: () => true, dispatch, audit: vi.fn()
    })
    expect(runtime.resume).toBeDefined()
    expect(runtime.ingress).toBeDefined()
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })

  it('persists the executed tool result, completion outbox, and a safety recovery wake', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'bundle-completion' }).id
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'e'.repeat(64) }
    const todo = todoStore.create({ todoId: 'bundle-result-todo', invocationId: 'bundle-result-invocation', channel: 'feishu',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'bundle-checkpoint', workflowRevision: 1 })
    const envelopes = createDeferredEnvelopeStore(db)
    envelopes.put({ invocationId: todo.invocationId, requestId: 'original-request', turnId: 'turn', toolCallId: 'tool',
      toolName: 'write_file', canonicalArgs: {}, contentVersions: {},
      executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId,
        planRevision: 1, channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 3,
        invocationId: todo.invocationId, toolName: 'write_file', toolInput: {}, requestId: 'original-request', turnId: 'turn',
        toolCallId: 'tool', providerRouteId: 'provider' } })
    const dispatch = vi.fn(async () => ({ dispatched: true, result: { ok: false, error: 'provider rejected the write' } }))
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn(), onCompletionWake: vi.fn() })
    await runtime.resume.requestResume({ requestId: 'bundle-approval', todoId: todo.todoId, channel: 'feishu', identityKey: todo.identityKey,
      ownerId: todo.ownerId, authorizationEpoch: 3, rule, notificationVersion: 1, messageId: 'trusted', reasonKey: 'reply' })
    await expect(runtime.resume.dispatchPending(sessionId)).resolves.toEqual([{ requestId: 'bundle-approval', status: 'dispatched' }])

    expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toMatchObject({ state: 'completion_outboxed',
      result: { kind: 'failed', outputRef: `deferred-result:${todo.invocationId}`, value: { ok: false, error: 'provider rejected the write' } } })
    expect(createDeferredExecutionResultStore(db).listCompletionOutbox(todo.todoId)).toHaveLength(1)
    expect(listWakeEvents(db, sessionId)).toMatchObject([{ type: 'safety-recovery', payloadRef: { kind: 'safety-approval', approvalId: todo.todoId } }])
    const recoveredWake = vi.fn()
    const restarted = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn(), onCompletionWake: recoveredWake })
    await restarted.recoverPending()
    expect(recoveredWake).toHaveBeenCalledWith(sessionId)
    db.close()
  })
})
