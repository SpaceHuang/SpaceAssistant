import { describe, expect, it } from 'vitest'
import { createSession } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { putTaskControlRecord } from '../database/taskControl'
import { createImTaskControlCoordinator, type ImTaskSafetyPort } from './imTaskControlCoordinator'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredTodoTaskControlSafetyPort } from './deferredTodoTaskControlAdapter'
import { getDbConnection } from '../database/sqliteStore'

describe('IM task control coordinator', () => {
  it('blocks a rebuilt deferred todo that is not bound to the original outstanding step invocation', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-control-rebuilt-deferred' }).id
    putTaskControlRecord(db, { sessionId, ownerId: 'owner-binding', workflowId: 'workflow-binding', taskId: 'task-binding',
      planRevision: 1, expectedRevision: null, data: { status: 'active', steps: [{ stepId: 'publish', instruction: 'Publish' }],
        outstandingInvocations: [{ invocationId: 'original-invocation', stepId: 'publish', todoId: 'original-todo' }] } })
    const dispatched: string[] = []
    const coordinator = createImTaskControlCoordinator({ db, safetyPort: {
      invalidateTask: async () => ({ invalidated: [] }),
      dispatchDeferred: async ({ todoId }) => { dispatched.push(todoId); return { dispatched: true } }
    } })

    expect(await coordinator.resumeDeferred({ sessionId, ownerId: 'owner-binding', workflowId: 'workflow-binding', taskId: 'task-binding',
      planRevision: 1, todoId: 'rebuilt-todo' })).toMatchObject({ status: 'invalidated' })
    expect(dispatched).toEqual([])
    db.close()
  })

  it('invalidates associated deferred work before dispatch and blocks a later resume', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-cancel-before-dispatch' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'owner-1', workflowId: 'workflow-1', taskId: 'task-1',
      planRevision: 2, expectedRevision: null,
      data: { status: 'active', outstandingInvocations: ['invocation-1'] }
    })
    const calls: string[] = []
    const safetyPort: ImTaskSafetyPort = {
      invalidateTask: async (request) => { calls.push(`invalidate:${request.planRevision}`); return { invalidated: ['todo-1'] } },
      dispatchDeferred: async (request) => { calls.push(`dispatch:${request.todoId}`); return { dispatched: true } }
    }
    const coordinator = createImTaskControlCoordinator({ db, safetyPort })

    expect(await coordinator.cancel({
      sessionId, ownerId: 'owner-1', workflowId: 'workflow-1', taskId: 'task-1', expectedRevision: 1
    })).toMatchObject({ status: 'cancelled' })
    expect(await coordinator.resumeDeferred({
      sessionId, ownerId: 'owner-1', workflowId: 'workflow-1', taskId: 'task-1',
      planRevision: 2, todoId: 'todo-1'
    })).toMatchObject({ status: 'invalidated' })
    expect(calls).toEqual(['invalidate:2'])
    db.close()
  })

  it('reports an action already started when dispatch wins the cancel race', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-cancel-dispatch-race' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'owner-race', workflowId: 'workflow-race', taskId: 'task-race',
      planRevision: 1, expectedRevision: null, data: { status: 'active', steps: [{ stepId: 'step-race', instruction: 'Dispatch' }],
        outstandingInvocations: [{ invocationId: 'inv-race', stepId: 'step-race', todoId: 'todo-race' }] }
    })
    let markDispatchStarted!: () => void
    let finishDispatch!: () => void
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve })
    const dispatchGate = new Promise<void>((resolve) => { finishDispatch = resolve })
    const safetyPort: ImTaskSafetyPort = {
      invalidateTask: async () => ({ invalidated: [] }),
      dispatchDeferred: async () => {
        markDispatchStarted()
        await dispatchGate
        return { dispatched: true }
      }
    }
    const coordinator = createImTaskControlCoordinator({ db, safetyPort })
    const dispatch = coordinator.resumeDeferred({
      sessionId, ownerId: 'owner-race', workflowId: 'workflow-race', taskId: 'task-race',
      planRevision: 1, todoId: 'todo-race'
    })
    await dispatchStarted
    expect(await coordinator.cancel({
      sessionId, ownerId: 'owner-race', workflowId: 'workflow-race', taskId: 'task-race', expectedRevision: 1
    })).toMatchObject({ status: 'action_started' })
    finishDispatch()
    await dispatch
    db.close()
  })

  it('invalidates replaced and removed step todos while preserving only explicitly mapped unchanged work', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-revise-plan-mapping' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'owner-revise', workflowId: 'workflow-revise', taskId: 'task-revise',
      planRevision: 3, expectedRevision: null,
      data: {
        status: 'active',
        steps: [
          { stepId: 'scope', instruction: 'Confirm scope' },
          { stepId: 'research', instruction: 'Research options' },
          { stepId: 'budget', instruction: 'Estimate budget' }
        ],
        outstandingInvocations: [
          { invocationId: 'invoke-scope', stepId: 'scope', todoId: 'todo-scope' },
          { invocationId: 'invoke-research', stepId: 'research', todoId: 'todo-research' },
          { invocationId: 'invoke-budget', stepId: 'budget', todoId: 'todo-budget' }
        ]
      }
    })
    const invalidations: number[] = []
    const coordinator = createImTaskControlCoordinator({
      db,
      safetyPort: {
        invalidateTask: async (request) => {
          invalidations.push(request.planRevision)
          return { invalidated: request.invocationIds }
        },
        dispatchDeferred: async () => ({ dispatched: true })
      }
    })

    expect(await coordinator.revisePlan({
      sessionId, ownerId: 'owner-revise', workflowId: 'workflow-revise', taskId: 'task-revise',
      expectedRevision: 1, newRevision: 4,
      newSteps: [
        { stepId: 'scope-v2', instruction: 'Confirm scope' },
        { stepId: 'research-v2', instruction: 'Research alternatives' },
        { stepId: 'summary', instruction: 'Summarize findings' }
      ],
      stepMapping: [
        { fromStepId: 'scope', toStepId: 'scope-v2' },
        { fromStepId: 'research', toStepId: 'research-v2' }
      ]
    })).toMatchObject({ status: 'revised', retainedStepIds: ['scope-v2'] })
    expect(invalidations).toEqual([3])
    db.close()
  })

  it('retries an incomplete invalidation idempotently and keeps related resume fail closed', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-cancel-invalidation-retry' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'owner-retry', workflowId: 'workflow-retry', taskId: 'task-retry',
      planRevision: 1, expectedRevision: null, data: { status: 'active' }
    })
    let attempts = 0
    const safetyPort: ImTaskSafetyPort = {
      invalidateTask: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('TEMPORARY_SAFETY_PORT_FAILURE')
        return { invalidated: ['todo-retry'] }
      },
      dispatchDeferred: async () => ({ dispatched: true })
    }
    const coordinator = createImTaskControlCoordinator({ db, safetyPort })
    const request = {
      sessionId, ownerId: 'owner-retry', workflowId: 'workflow-retry', taskId: 'task-retry',
      expectedRevision: 1, operationId: 'cancel-operation-retry'
    }

    expect(await coordinator.cancel(request)).toMatchObject({ status: 'reconciliation_required' })
    expect(await coordinator.resumeDeferred({
      sessionId, ownerId: 'owner-retry', workflowId: 'workflow-retry', taskId: 'task-retry',
      planRevision: 1, todoId: 'todo-retry'
    })).toMatchObject({ status: 'blocked' })
    expect(await coordinator.retryOperation('cancel-operation-retry')).toMatchObject({ status: 'cancelled' })
    expect(attempts).toBe(2)
    expect(await coordinator.retryOperation('cancel-operation-retry')).toMatchObject({ status: 'cancelled' })
    expect(attempts).toBe(2)
    db.close()
  })

  it('recovers persisted task-control operations through the real todo store adapter', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-control-todo-recovery' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'owner-outbox', workflowId: 'workflow-outbox', taskId: 'task-outbox',
      planRevision: 1, expectedRevision: null,
      data: { status: 'active', outstandingInvocations: [{ invocationId: 'outbox-invocation', stepId: 'step', todoId: 'outbox-todo' }] }
    })
    const todos = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'f'.repeat(64) }
    todos.create({ todoId: 'outbox-todo', invocationId: 'outbox-invocation', channel: 'feishu', identityKey: 'identity', ownerId: 'owner-outbox',
      authorizationEpoch: 1, rule, workflowId: 'workflow-outbox', taskId: 'task-outbox', stepId: 'step', planRevision: 1,
      originSessionId: sessionId, createdAt: 1, expiresAt: Date.now() + 60_000 })
    let failFirst = true
    const realInvalidator = createDeferredTodoTaskControlSafetyPort({ todoStore: todos, dispatchDeferred: async () => ({ dispatched: false }) })
    const coordinator = createImTaskControlCoordinator({ db, safetyPort: {
      ...realInvalidator,
      invalidateTask: async (request) => {
        if (failFirst) { failFirst = false; throw new Error('injected crash after operation commit') }
        return realInvalidator.invalidateTask(request)
      }
    } })
    const request = { sessionId, ownerId: 'owner-outbox', workflowId: 'workflow-outbox', taskId: 'task-outbox', expectedRevision: 1, operationId: 'outbox-cancel' }
    expect(await coordinator.cancel(request)).toMatchObject({ status: 'reconciliation_required' })
    expect(todos.get('outbox-todo', { channel: 'feishu', identityKey: 'identity', ownerId: 'owner-outbox', authorizationEpoch: 1, rule })?.status).toBe('pending')
    expect(await coordinator.recoverPendingOperations()).toEqual([{ operationId: 'outbox-cancel', status: 'cancelled' }])
    expect(todos.get('outbox-todo', { channel: 'feishu', identityKey: 'identity', ownerId: 'owner-outbox', authorizationEpoch: 1, rule })?.status).toBe('invalidated')
    expect(getDbConnection(db).prepare('SELECT state FROM im_task_control_operations WHERE operation_id=?').get('outbox-cancel')).toEqual({ state: 'applied' })
    expect(await coordinator.recoverPendingOperations()).toEqual([])
    db.close()
  })

  it('replays revise after the plan commit but before operation completion without duplicating the revision', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-control-revise-recovery' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'owner-revise-crash', workflowId: 'workflow-revise-crash', taskId: 'task-revise-crash',
      planRevision: 1, expectedRevision: null,
      data: { status: 'active', steps: [{ stepId: 'old', instruction: 'same' }], outstandingInvocations: [{ invocationId: 'revise-inv', stepId: 'old' }] }
    })
    const todos = createDeferredTodoStore(db)
    const realPort = createDeferredTodoTaskControlSafetyPort({ todoStore: todos, dispatchDeferred: async () => ({ dispatched: false }) })
    const coordinator = createImTaskControlCoordinator({ db, safetyPort: realPort })
    getDbConnection(db).exec(`CREATE TRIGGER fail_task_operation_applied BEFORE UPDATE OF state ON im_task_control_operations
      WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'injected operation completion crash'); END`)
    await expect(coordinator.revisePlan({
      sessionId, ownerId: 'owner-revise-crash', workflowId: 'workflow-revise-crash', taskId: 'task-revise-crash',
      expectedRevision: 1, newRevision: 2, newSteps: [{ stepId: 'new', instruction: 'same' }],
      stepMapping: [{ fromStepId: 'old', toStepId: 'new' }], operationId: 'revise-recovery-op'
    })).rejects.toThrow('injected operation completion crash')
    getDbConnection(db).exec('DROP TRIGGER fail_task_operation_applied')
    expect(await coordinator.recoverPendingOperations()).toEqual([{ operationId: 'revise-recovery-op', status: 'revised' }])
    expect(getDbConnection(db).prepare(`SELECT revision,plan_revision FROM im_task_control WHERE session_id=? AND task_id=?`)
      .get(sessionId, 'task-revise-crash')).toEqual({ revision: 2, plan_revision: 2 })
    db.close()
  })

  it('reopens after cancel requested commit and completes real todo invalidation before dispatch is allowed', async () => {
    const temp = createTempDatabase('task-control-crash-before-todo-cascade-')
    const sessionId = createSession(temp.db, { name: 'task-control-process-crash' }).id
    putTaskControlRecord(temp.db, {
      sessionId, ownerId: 'owner-reopen', workflowId: 'workflow-reopen', taskId: 'task-reopen',
      planRevision: 1, expectedRevision: null,
      data: { status: 'active', outstandingInvocations: [{ invocationId: 'reopen-inv', stepId: 'step', todoId: 'reopen-todo' }] }
    })
    const firstTodos = createDeferredTodoStore(temp.db)
    const rule = { ruleId: 'write', factsHash: '9'.repeat(64) }
    firstTodos.create({ todoId: 'reopen-todo', invocationId: 'reopen-inv', channel: 'feishu', identityKey: 'identity', ownerId: 'owner-reopen',
      authorizationEpoch: 1, rule, workflowId: 'workflow-reopen', taskId: 'task-reopen', stepId: 'step', planRevision: 1,
      originSessionId: sessionId, createdAt: 1, expiresAt: Date.now() + 60_000 })
    let crashBeforeCascade = true
    const firstPort = createDeferredTodoTaskControlSafetyPort({ todoStore: firstTodos, dispatchDeferred: async () => ({ dispatched: false }) })
    const firstCoordinator = createImTaskControlCoordinator({ db: temp.db, safetyPort: {
      ...firstPort,
      invalidateTask: async () => {
        if (crashBeforeCascade) { crashBeforeCascade = false; throw new Error('process stopped before todo invalidation') }
        return firstPort.invalidateTask({ operationId: 'cancel-reopen', sessionId, ownerId: 'owner-reopen', workflowId: 'workflow-reopen', taskId: 'task-reopen', planRevision: 1, invocationIds: ['reopen-inv'] })
      }
    } })
    expect(await firstCoordinator.cancel({ sessionId, ownerId: 'owner-reopen', workflowId: 'workflow-reopen', taskId: 'task-reopen', expectedRevision: 1, operationId: 'cancel-reopen' }))
      .toMatchObject({ status: 'reconciliation_required' })
    expect(firstTodos.get('reopen-todo', { channel: 'feishu', identityKey: 'identity', ownerId: 'owner-reopen', authorizationEpoch: 1, rule })?.status).toBe('pending')
    expect(firstTodos.claimForDispatch('reopen-todo', { channel: 'feishu', identityKey: 'identity', ownerId: 'owner-reopen', authorizationEpoch: 1, rule })).toBeNull()
    temp.db.close()

    const reopenedDb = openDatabase(temp.dbPath)
    const reopenedTodos = createDeferredTodoStore(reopenedDb)
    const reopenedPort = createDeferredTodoTaskControlSafetyPort({ todoStore: reopenedTodos, dispatchDeferred: async () => ({ dispatched: false }) })
    const reopenedCoordinator = createImTaskControlCoordinator({ db: reopenedDb, safetyPort: reopenedPort })
    const context = { channel: 'feishu' as const, identityKey: 'identity', ownerId: 'owner-reopen', authorizationEpoch: 1, rule }
    expect(reopenedTodos.get('reopen-todo', context)?.status).toBe('pending')
    const recovering = reopenedCoordinator.recoverPendingOperations()
    expect(reopenedTodos.claimForDispatch('reopen-todo', context)).toBeNull()
    await expect(recovering).resolves.toEqual([{ operationId: 'cancel-reopen', status: 'cancelled' }])
    expect(reopenedTodos.get('reopen-todo', context)?.status).toBe('invalidated')
    reopenedDb.close()
    temp.cleanup()
  })

  it('reopens after revise requested commit and invalidates only removed-step todos', async () => {
    const temp = createTempDatabase('task-control-revise-crash-before-todo-cascade-')
    const sessionId = createSession(temp.db, { name: 'task-control-revise-process-crash' }).id
    putTaskControlRecord(temp.db, {
      sessionId, ownerId: 'owner-revise-reopen', workflowId: 'workflow-revise-reopen', taskId: 'task-revise-reopen',
      planRevision: 1, expectedRevision: null,
      data: { status: 'active', steps: [{ stepId: 'scope', instruction: 'same' }, { stepId: 'removed', instruction: 'old' }],
        outstandingInvocations: [{ invocationId: 'keep-inv', stepId: 'scope', todoId: 'keep-todo' }, { invocationId: 'remove-inv', stepId: 'removed', todoId: 'remove-todo' }] }
    })
    const firstTodos = createDeferredTodoStore(temp.db)
    const rule = { ruleId: 'write', factsHash: '8'.repeat(64) }
    for (const [todoId, invocationId, stepId] of [['keep-todo', 'keep-inv', 'scope'], ['remove-todo', 'remove-inv', 'removed']] as const) {
      firstTodos.create({ todoId, invocationId, channel: 'wechat', identityKey: 'identity', ownerId: 'owner-revise-reopen', authorizationEpoch: 1, rule,
        workflowId: 'workflow-revise-reopen', taskId: 'task-revise-reopen', stepId, planRevision: 1,
        originSessionId: sessionId, createdAt: 1, expiresAt: Date.now() + 60_000 })
    }
    const firstPort = createDeferredTodoTaskControlSafetyPort({ todoStore: firstTodos, dispatchDeferred: async () => ({ dispatched: false }) })
    const firstCoordinator = createImTaskControlCoordinator({ db: temp.db, safetyPort: {
      ...firstPort,
      invalidateTask: async () => { throw new Error('process stopped before revise todo invalidation') }
    } })
    const request = { sessionId, ownerId: 'owner-revise-reopen', workflowId: 'workflow-revise-reopen', taskId: 'task-revise-reopen',
      expectedRevision: 1, newRevision: 2, newSteps: [{ stepId: 'scope-v2', instruction: 'same' }, { stepId: 'new', instruction: 'new' }],
      stepMapping: [{ fromStepId: 'scope', toStepId: 'scope-v2' }], operationId: 'revise-reopen' }
    expect(await firstCoordinator.revisePlan(request)).toMatchObject({ status: 'reconciliation_required' })
    const pendingContext = { channel: 'wechat' as const, identityKey: 'identity', ownerId: 'owner-revise-reopen', authorizationEpoch: 1, rule }
    expect(firstTodos.claimForDispatch('keep-todo', pendingContext)).toBeNull()
    expect(firstTodos.claimForDispatch('remove-todo', pendingContext)).toBeNull()
    temp.db.close()

    const reopenedDb = openDatabase(temp.dbPath)
    const reopenedTodos = createDeferredTodoStore(reopenedDb)
    const reopenedPort = createDeferredTodoTaskControlSafetyPort({ todoStore: reopenedTodos, dispatchDeferred: async () => ({ dispatched: false }) })
    const reopenedCoordinator = createImTaskControlCoordinator({ db: reopenedDb, safetyPort: reopenedPort })
    expect(await reopenedCoordinator.recoverPendingOperations()).toEqual([{ operationId: 'revise-reopen', status: 'revised' }])
    const keepContext = { channel: 'wechat' as const, identityKey: 'identity', ownerId: 'owner-revise-reopen', authorizationEpoch: 1, rule }
    expect(reopenedTodos.get('remove-todo', keepContext)?.status).toBe('invalidated')
    expect(reopenedTodos.get('keep-todo', keepContext)?.status).toBe('pending')
    expect(getDbConnection(reopenedDb).prepare('SELECT revision,plan_revision FROM im_task_control WHERE session_id=? AND task_id=?')
      .get(sessionId, 'task-revise-reopen')).toEqual({ revision: 2, plan_revision: 2 })
    reopenedDb.close()
    temp.cleanup()
  })
})
