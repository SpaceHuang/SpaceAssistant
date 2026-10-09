import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { openDatabase } from '../database'
import { putTaskControlRecord } from '../database/taskControl'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredResumeRequestStore } from '../confirmation/deferredResumeRequestStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'
import { createDeferredTodoTaskControlSafetyPort } from './deferredTodoTaskControlAdapter'
import { createImTaskControlCoordinator } from './imTaskControlCoordinator'
import { resetRunningRemoteAgentRegistryForTests } from './remoteAgentRegistry'

function setup(executor: () => Promise<void>, recheck: () => Promise<{ allowed: boolean }> = async () => ({ allowed: true })) {
  const db = createMemoryAppDb()
  const sessionId = createSession(db, { name: 'cancel-resume-dispatch-integration' }).id
  const todoStore = createDeferredTodoStore(db)
  const todo = todoStore.create({ todoId: 'cancel-todo', invocationId: 'cancel-invocation', channel: 'wechat',
    identityKey: 'cancel-identity', ownerId: 'cancel-owner', authorizationEpoch: 5,
    rule: { ruleId: 'publish', factsHash: '9'.repeat(64) }, workflowId: 'cancel-workflow', taskId: 'cancel-task', stepId: 'publish',
    planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
  const intents = createSecurityActionIntentStore(db)
  intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
    workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
  intents.linkTodo(todo.invocationId, todo.todoId)
  intents.commitCheckpoint(todo.invocationId, { checkpointId: 'cancel-checkpoint', workflowRevision: 1 })
  const envelopeStore = createDeferredEnvelopeStore(db)
  envelopeStore.put({ invocationId: todo.invocationId, toolName: 'publish', canonicalArgs: { content: 'approved' },
    contentVersions: { document: 1 }, executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId } })
  const executorCalls = vi.fn(executor)
  const resume = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, maxParallel: 2,
    recheck, dispatch: async () => { await executorCalls(); return { dispatched: true } } })
  return { db, sessionId, todo, todoStore, resume, executorCalls }
}

async function authorizeAndTrackTask(input: ReturnType<typeof setup>) {
  const { db, sessionId, todo, resume } = input
  await resume.requestResume({ requestId: 'cancel-resume-request', todoId: todo.todoId, channel: 'wechat',
    identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule: todo.rule,
    notificationVersion: 1, messageId: 'trusted-notice', reasonKey: 'cancel-reason' })
  putTaskControlRecord(db, { sessionId, ownerId: todo.ownerId, workflowId: todo.workflowId, taskId: todo.taskId,
    planRevision: todo.planRevision, expectedRevision: null, data: { status: 'active',
      steps: [{ stepId: todo.stepId, instruction: 'Publish' }],
      outstandingInvocations: [{ invocationId: todo.invocationId, todoId: todo.todoId, stepId: todo.stepId }] } })
  const port = createDeferredTodoTaskControlSafetyPort({ todoStore: input.todoStore,
    dispatchDeferred: async (request) => {
      const result = await resume.dispatchPending(sessionId)
      return result.some((entry) => entry.requestId === 'cancel-resume-request' && entry.status === 'dispatched')
        ? { dispatched: true } : { dispatched: false }
    } })
  return createImTaskControlCoordinator({ db, safetyPort: port })
}

describe('task.cancel and real deferred dispatcher race', () => {
  afterEach(() => resetRunningRemoteAgentRegistryForTests())

  it('cancellation commits first, invalidates todo/request, and keeps the final executor at zero calls', async () => {
    const flow = setup(async () => undefined)
    const controls = await authorizeAndTrackTask(flow)
    const cancel = await controls.cancel({ sessionId: flow.sessionId, ownerId: flow.todo.ownerId, workflowId: flow.todo.workflowId,
      taskId: flow.todo.taskId, expectedRevision: 1 })
    expect(cancel).toMatchObject({ status: 'cancelled' })
    expect(await flow.resume.dispatchPending(flow.sessionId)).toMatchObject([{ status: 'invalidated' }])
    expect(flow.executorCalls).not.toHaveBeenCalled()
    expect(flow.todoStore.get(flow.todo.todoId, { channel: 'wechat', identityKey: flow.todo.identityKey, ownerId: flow.todo.ownerId,
      authorizationEpoch: flow.todo.authorizationEpoch, rule: flow.todo.rule })?.status).toBe('invalidated')
    flow.db.close()
  })

  it('dispatch begins first, then reports action_started while the real executor runs once', async () => {
    let releaseExecutor!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const hold = new Promise<void>((resolve) => { releaseExecutor = resolve })
    const flow = setup(async () => { signalStarted(); await hold })
    const controls = await authorizeAndTrackTask(flow)
    const dispatching = controls.resumeDeferred({ sessionId: flow.sessionId, ownerId: flow.todo.ownerId,
      workflowId: flow.todo.workflowId, taskId: flow.todo.taskId, planRevision: flow.todo.planRevision, todoId: flow.todo.todoId })
    await started
    await expect(controls.cancel({ sessionId: flow.sessionId, ownerId: flow.todo.ownerId, workflowId: flow.todo.workflowId,
      taskId: flow.todo.taskId, expectedRevision: 1 })).resolves.toMatchObject({ status: 'action_started' })
    releaseExecutor()
    await expect(dispatching).resolves.toMatchObject({ status: 'dispatched' })
    expect(flow.executorCalls).toHaveBeenCalledTimes(1)
    flow.db.close()
  })

  it.each(['cancel', 'revise'] as const)('%s interleaved with final authorization recheck reports action_started and dispatches only after recheck', async (operation) => {
    let releaseRecheck!: () => void
    let signalRecheck!: () => void
    const recheckStarted = new Promise<void>((resolve) => { signalRecheck = resolve })
    const recheckGate = new Promise<void>((resolve) => { releaseRecheck = resolve })
    const flow = setup(async () => undefined, async () => {
      signalRecheck()
      await recheckGate
      return { allowed: true }
    })
    const controls = await authorizeAndTrackTask(flow)
    const dispatch = controls.resumeDeferred({ sessionId: flow.sessionId, ownerId: flow.todo.ownerId,
      workflowId: flow.todo.workflowId, taskId: flow.todo.taskId, planRevision: flow.todo.planRevision, todoId: flow.todo.todoId })
    await recheckStarted
    const controlOperation = operation === 'cancel'
      ? controls.cancel({ sessionId: flow.sessionId, ownerId: flow.todo.ownerId, workflowId: flow.todo.workflowId,
          taskId: flow.todo.taskId, expectedRevision: 1 })
      : controls.revisePlan({ sessionId: flow.sessionId, ownerId: flow.todo.ownerId, workflowId: flow.todo.workflowId,
          taskId: flow.todo.taskId, expectedRevision: 1, newRevision: 2,
          newSteps: [{ stepId: 'publish-v2', instruction: 'Publish' }], stepMapping: [{ fromStepId: 'publish', toStepId: 'publish-v2' }] })
    await expect(controlOperation).resolves.toMatchObject({ status: 'action_started' })
    expect(flow.executorCalls).not.toHaveBeenCalled()
    releaseRecheck()
    await expect(dispatch).resolves.toMatchObject({ status: 'dispatched' })
    expect(flow.executorCalls).toHaveBeenCalledTimes(1)
    flow.db.close()
  })

  it('recovers a crash after cancel request commit but before todo invalidation without allowing old dispatch', async () => {
    const temp = createTempDatabase('cancel-before-invalidation-resume-')
    const sessionId = createSession(temp.db, { name: 'cancel-before-invalidation-resume' }).id
    const rule = { ruleId: 'publish', factsHash: 'a'.repeat(64) }
    const todoStore = createDeferredTodoStore(temp.db)
    const todo = todoStore.create({ todoId: 'crash-todo', invocationId: 'crash-invocation', channel: 'wechat',
      identityKey: 'crash-identity', ownerId: 'crash-owner', authorizationEpoch: 2, rule,
      workflowId: 'crash-workflow', taskId: 'crash-task', stepId: 'publish', planRevision: 1, originSessionId: sessionId,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(temp.db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'crash-cp', workflowRevision: 1 })
    const envelopeStore = createDeferredEnvelopeStore(temp.db)
    envelopeStore.put({ invocationId: todo.invocationId, toolName: 'publish', canonicalArgs: { content: 'approved' },
      contentVersions: { document: 1 }, executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId } })
    const dispatchCalls = vi.fn()
    const resume = createDeferredResumeCoordinator({ db: temp.db, todoStore, envelopeStore, maxParallel: 2,
      recheck: async () => ({ allowed: true }), dispatch: async () => { dispatchCalls(); return { dispatched: true } } })
    await resume.requestResume({ requestId: 'crash-request', todoId: todo.todoId, channel: 'wechat', identityKey: todo.identityKey,
      ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule, notificationVersion: 1,
      messageId: 'notice', reasonKey: 'crash-reason' })
    putTaskControlRecord(temp.db, { sessionId, ownerId: todo.ownerId, workflowId: todo.workflowId, taskId: todo.taskId,
      planRevision: 1, expectedRevision: null, data: { status: 'active', steps: [{ stepId: 'publish', instruction: 'Publish' }],
        outstandingInvocations: [{ invocationId: todo.invocationId, todoId: todo.todoId, stepId: todo.stepId }] } })
    const realPort = createDeferredTodoTaskControlSafetyPort({ todoStore, dispatchDeferred: async () => ({ dispatched: false }) })
    const first = createImTaskControlCoordinator({ db: temp.db, safetyPort: { ...realPort,
      invalidateTask: async () => { throw new Error('simulated crash before invalidation') } } })
    await expect(first.cancel({ sessionId, ownerId: todo.ownerId, workflowId: todo.workflowId, taskId: todo.taskId,
      expectedRevision: 1, operationId: 'crash-cancel' })).resolves.toMatchObject({ status: 'reconciliation_required' })
    expect(createDeferredResumeRequestStore(temp.db).get('crash-request')?.state).toBe('pending')
    temp.db.close()

    const db = openDatabase(temp.dbPath)
    const reopenedTodos = createDeferredTodoStore(db)
    const reopenedDispatchCalls = vi.fn()
    const reopenedResume = createDeferredResumeCoordinator({ db, todoStore: reopenedTodos, envelopeStore: createDeferredEnvelopeStore(db), maxParallel: 2,
      recheck: async () => ({ allowed: true }), dispatch: async () => { reopenedDispatchCalls(); return { dispatched: true } } })
    expect(await reopenedResume.dispatchPending(sessionId)).toMatchObject([{ requestId: 'crash-request', status: 'invalidated' }])
    const reopenedPort = createDeferredTodoTaskControlSafetyPort({ todoStore: reopenedTodos, dispatchDeferred: async () => ({ dispatched: false }) })
    const recovered = createImTaskControlCoordinator({ db, safetyPort: reopenedPort })
    await expect(recovered.recoverPendingOperations()).resolves.toEqual([{ operationId: 'crash-cancel', status: 'cancelled' }])
    expect(createDeferredResumeRequestStore(db).get('crash-request')?.state).toBe('invalidated')
    expect(reopenedTodos.get(todo.todoId, { channel: 'wechat', identityKey: todo.identityKey, ownerId: todo.ownerId,
      authorizationEpoch: todo.authorizationEpoch, rule })?.status).toBe('invalidated')
    expect(dispatchCalls).not.toHaveBeenCalled()
    expect(reopenedDispatchCalls).not.toHaveBeenCalled()
    db.close()
    temp.cleanup()
  })
})
