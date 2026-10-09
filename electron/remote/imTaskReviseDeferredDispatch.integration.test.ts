import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { putTaskControlRecord } from '../database/taskControl'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'
import { createDeferredTodoTaskControlSafetyPort } from './deferredTodoTaskControlAdapter'
import { createImTaskControlCoordinator } from './imTaskControlCoordinator'

function setup() {
  const db = createMemoryAppDb()
  const sessionId = createSession(db, { name: 'revise-resume-dispatch-integration' }).id
  const ownerId = 'revise-owner'
  const workflowId = 'revise-workflow'
  const taskId = 'revise-task'
  const rule = { ruleId: 'write', factsHash: 'e'.repeat(64) }
  const todoStore = createDeferredTodoStore(db)
  const intents = createSecurityActionIntentStore(db)
  const envelopeStore = createDeferredEnvelopeStore(db)
  const resume = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, maxParallel: 2,
    recheck: async () => ({ allowed: true }), dispatch: async (_request, _todo, envelope) => {
      executor(envelope.invocationId)
      return { dispatched: true }
    } })
  const executor = vi.fn()
  const taskSteps = [{ stepId: 'stable', instruction: 'Publish exact approved content' }, { stepId: 'replace', instruction: 'Publish old content' }]
  const todos = new Map<string, ReturnType<typeof todoStore.create>['todo']>()
  for (const [todoId, invocationId, step] of [['stable-todo', 'stable-inv', taskSteps[0]!], ['replace-todo', 'replace-inv', taskSteps[1]!] ] as const) {
    const todo = todoStore.create({ todoId, invocationId, channel: 'wechat', identityKey: 'revise-identity', ownerId,
      authorizationEpoch: 6, rule, workflowId, taskId, stepId: step.stepId, planRevision: 1, originSessionId: sessionId,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    todos.set(todoId, todo)
    intents.prepare({ invocationId, envelopeInvocationId: invocationId, sessionId, workflowId, taskId,
      stepId: step.stepId, planRevision: 1 })
    intents.linkTodo(invocationId, todoId)
    intents.commitCheckpoint(invocationId, { checkpointId: `cp-${todoId}`, workflowRevision: 1 })
    envelopeStore.put({ invocationId, toolName: 'publish', canonicalArgs: { content: `approved-${todoId}` },
      contentVersions: { document: 1 }, executionContext: { sessionId, workflowId, taskId, stepId: step.stepId } })
    void resume.requestResume({ requestId: `request-${todoId}`, todoId, channel: 'wechat', identityKey: 'revise-identity', ownerId,
      authorizationEpoch: 6, rule, notificationVersion: 1, messageId: `notice-${todoId}`, reasonKey: `reason-${todoId}` })
  }
  putTaskControlRecord(db, { sessionId, ownerId, workflowId, taskId, planRevision: 1, expectedRevision: null,
    data: { status: 'active', steps: taskSteps,
      outstandingInvocations: [
        { invocationId: 'stable-inv', todoId: 'stable-todo', stepId: 'stable' },
        { invocationId: 'replace-inv', todoId: 'replace-todo', stepId: 'replace' }
      ] } })
  const safetyPort = createDeferredTodoTaskControlSafetyPort({ todoStore, dispatchDeferred: async () => {
    const results = await resume.dispatchPending(sessionId)
    return results.some(({ status }) => status === 'dispatched') ? { dispatched: true } : { dispatched: false }
  } })
  return { db, sessionId, ownerId, workflowId, taskId, rule, todoStore, resume, executor, safetyPort, todos }
}

describe('task.revisePlan and real deferred dispatcher integration', () => {
  it('retains only an explicitly mapped unchanged step and dispatches its original envelope', async () => {
    const f = setup()
    const controls = createImTaskControlCoordinator({ db: f.db, safetyPort: f.safetyPort })
    await expect(controls.revisePlan({ sessionId: f.sessionId, ownerId: f.ownerId, workflowId: f.workflowId, taskId: f.taskId,
      expectedRevision: 1, newRevision: 2,
      newSteps: [{ stepId: 'stable-v2', instruction: 'Publish exact approved content' }, { stepId: 'new', instruction: 'Do new work' }],
      stepMapping: [{ fromStepId: 'stable', toStepId: 'stable-v2' }] })).resolves.toMatchObject({ status: 'revised' })
    expect(f.todoStore.get('stable-todo', { channel: 'wechat', identityKey: 'revise-identity', ownerId: f.ownerId,
      authorizationEpoch: 6, rule: f.rule })?.status).toBe('pending')
    expect(f.todoStore.get('replace-todo', { channel: 'wechat', identityKey: 'revise-identity', ownerId: f.ownerId,
      authorizationEpoch: 6, rule: f.rule })?.status).toBe('invalidated')
    await expect(controls.resumeDeferred({ sessionId: f.sessionId, ownerId: f.ownerId, workflowId: f.workflowId, taskId: f.taskId,
      planRevision: 2, todoId: 'stable-todo' })).resolves.toMatchObject({ status: 'dispatched' })
    expect(f.executor).toHaveBeenCalledTimes(1)
    expect(f.executor).toHaveBeenCalledWith('stable-inv')
    expect(await f.resume.dispatchPending(f.sessionId)).toEqual([])
    f.db.close()
  })

  it('invalidates the old invocation when the mapped step instruction changed', async () => {
    const f = setup()
    const controls = createImTaskControlCoordinator({ db: f.db, safetyPort: f.safetyPort })
    await expect(controls.revisePlan({ sessionId: f.sessionId, ownerId: f.ownerId, workflowId: f.workflowId, taskId: f.taskId,
      expectedRevision: 1, newRevision: 2,
      newSteps: [{ stepId: 'stable-v2', instruction: 'Publish different content' }],
      stepMapping: [{ fromStepId: 'stable', toStepId: 'stable-v2' }] })).resolves.toMatchObject({ status: 'revised' })
    expect(f.todoStore.get('stable-todo', { channel: 'wechat', identityKey: 'revise-identity', ownerId: f.ownerId,
      authorizationEpoch: 6, rule: f.rule })?.status).toBe('invalidated')
    const outcomes = await f.resume.dispatchPending(f.sessionId)
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every(({ status }) => status === 'invalidated')).toBe(true)
    expect(f.executor).not.toHaveBeenCalled()
    f.db.close()
  })
})
