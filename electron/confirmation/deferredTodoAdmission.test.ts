import { describe, expect, it, vi } from 'vitest'
import { createDeferredTodoAdmission } from './deferredTodoAdmission'
import { createMemoryAppDb } from '../database/testHelpers'
import { createPersistentDeferredTodoAdmission } from './deferredTodoAdmission'

describe('deferred approval capacity admission', () => {
  it('denies safely with a receipt when capacity is full and does not create or dispatch', async () => {
    const createTodo = vi.fn()
    const dispatch = vi.fn()
    const sendReceipt = vi.fn()
    const admission = createDeferredTodoAdmission({
      capacity: { reserve: async () => ({ ok: false as const, reason: 'identity_limit' as const }), release: vi.fn() },
      todoStore: { create: createTodo },
      dispatch,
      sendReceipt
    })

    await expect(admission.defer({
      reservation: { reservationId: 'capacity-full', invocationId: 'invocation-full', sessionId: 's1', identityKey: 'identity-1', state: 'prepared' },
      todo: { invocationId: 'invocation-full' }, ttlMs: 60_000
    })).resolves.toMatchObject({ kind: 'deny', cause: 'no-answerer' })
    expect(createTodo).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(sendReceipt).toHaveBeenCalledWith(expect.objectContaining({ code: 'deferred-capacity-exhausted' }))
  })

  it('uses the normal approval fallback for TTL zero without reserving, creating, or hanging', async () => {
    const reserve = vi.fn()
    const createTodo = vi.fn()
    const fallback = vi.fn(async () => ({ kind: 'undetermined' as const }))
    const admission = createDeferredTodoAdmission({
      capacity: { reserve, release: vi.fn() }, todoStore: { create: createTodo }, dispatch: vi.fn(),
      sendReceipt: vi.fn(), fallback
    })

    await expect(admission.defer({
      reservation: { reservationId: 'ttl-zero', invocationId: 'invocation-zero', sessionId: 's1', identityKey: 'identity-1', state: 'prepared' },
      todo: { invocationId: 'invocation-zero' }, ttlMs: 0
    })).resolves.toEqual({ kind: 'undetermined' })
    expect(reserve).not.toHaveBeenCalled()
    expect(createTodo).not.toHaveBeenCalled()
  })

  it('connects real capacity, todo creation, and terminal release without exceeding configured limits', async () => {
    const db = createMemoryAppDb()
    const receipts: Array<{ code: string }> = []
    const dispatch = vi.fn()
    const admission = createPersistentDeferredTodoAdmission(db, {
      limits: { sessionLimit: 1, identityLimit: 1 }, dispatch,
      sendReceipt: (receipt) => { receipts.push(receipt) }
    })
    const first = {
      reservation: {
        reservationId: 'capacity-invocation-1', invocationId: 'capacity-invocation-1', sessionId: 'capacity-session',
        identityKey: 'capacity-identity', state: 'prepared' as const, now: 100, expiresAt: 1_000
      },
      todo: {
        todoId: 'capacity-todo-1', invocationId: 'capacity-invocation-1', channel: 'feishu' as const,
        identityKey: 'capacity-identity', ownerId: 'capacity-owner', authorizationEpoch: 1,
        rule: { ruleId: 'write-rule', factsHash: 'f'.repeat(64) }, workflowId: 'capacity-workflow',
        taskId: 'capacity-task', stepId: 'capacity-step', planRevision: 1, originSessionId: 'capacity-session',
        status: 'pending' as const, createdAt: 100, expiresAt: 1_000, updatedAt: 100
      },
      ttlMs: 900
    }
    const created = await admission.defer(first)
    expect(created).toMatchObject({ kind: 'deferred' })
    expect(await admission.defer({
      reservation: { ...first.reservation, reservationId: 'capacity-invocation-2', invocationId: 'capacity-invocation-2' },
      todo: { ...first.todo, todoId: 'capacity-todo-2', invocationId: 'capacity-invocation-2' }, ttlMs: 900
    })).toMatchObject({ kind: 'deny', cause: 'no-answerer' })
    expect(receipts).toEqual([{ code: 'deferred-capacity-exhausted' }])
    expect(admission.capacity.counts({ identityKey: 'capacity-identity', now: 100 }).identity).toBe(1)

    const authorization = {
      channel: 'feishu' as const, identityKey: 'capacity-identity', ownerId: 'capacity-owner', authorizationEpoch: 1,
      rule: first.todo.rule
    }
    expect(admission.todoStore.claimForDispatch(first.todo.todoId, authorization, 200)).not.toBeNull()
    expect(admission.todoStore.markConsumed(first.todo.todoId, authorization, 300)).toBe(true)
    expect(admission.capacity.counts({ identityKey: 'capacity-identity', now: 300 }).identity).toBe(0)

    const secondTodo = { ...first.todo, todoId: 'capacity-todo-3', invocationId: 'capacity-invocation-3',
      workflowId: 'capacity-workflow-2', taskId: 'capacity-task-2', stepId: 'capacity-step-2', createdAt: 400,
      expiresAt: 2_000, updatedAt: 400 }
    await admission.defer({
      reservation: { ...first.reservation, reservationId: secondTodo.invocationId, invocationId: secondTodo.invocationId, now: 400, expiresAt: 2_000 },
      todo: secondTodo, ttlMs: 1_600
    })
    expect(admission.todoStore.invalidateAssociated({
      originSessionId: secondTodo.originSessionId, workflowId: secondTodo.workflowId, taskId: secondTodo.taskId,
      throughPlanRevision: secondTodo.planRevision, now: 500
    }).invalidatedTodoIds).toEqual([secondTodo.todoId])
    expect(admission.capacity.counts({ identityKey: 'capacity-identity', now: 500 }).identity).toBe(0)

    const expiringTodo = { ...secondTodo, todoId: 'capacity-todo-4', invocationId: 'capacity-invocation-4',
      workflowId: 'capacity-workflow-3', taskId: 'capacity-task-3', createdAt: 600, expiresAt: 700, updatedAt: 600 }
    await admission.defer({
      reservation: { ...first.reservation, reservationId: expiringTodo.invocationId, invocationId: expiringTodo.invocationId, now: 600, expiresAt: 700 },
      todo: expiringTodo, ttlMs: 100
    })
    expect(admission.todoStore.expireDue(700)).toBe(1)
    expect(admission.capacity.counts({ identityKey: 'capacity-identity', now: 700 }).identity).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })

  it('keeps concurrent admitted todo creation within both configured limits', async () => {
    const db = createMemoryAppDb()
    const admission = createPersistentDeferredTodoAdmission(db, {
      limits: { sessionLimit: 5, identityLimit: 10 }, dispatch: vi.fn(), sendReceipt: vi.fn()
    })
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const sessionId = index < 8 ? 'shared-session' : `session-${index}`
      const invocationId = `concurrent-invocation-${index}`
      const now = 1_000 + index
      return admission.defer({
        reservation: {
          reservationId: invocationId, invocationId, sessionId, identityKey: 'concurrent-identity',
          state: 'prepared', now, expiresAt: now + 10_000
        },
        todo: {
          todoId: `concurrent-todo-${index}`, invocationId, channel: 'wechat' as const,
          identityKey: 'concurrent-identity', ownerId: 'concurrent-owner', authorizationEpoch: 1,
          rule: { ruleId: 'rule', factsHash: 'c'.repeat(64) }, workflowId: 'concurrent-workflow',
          taskId: `task-${index}`, stepId: 'step-1', planRevision: 1, originSessionId: sessionId,
          status: 'pending' as const, createdAt: now, expiresAt: now + 10_000, updatedAt: now
        },
        ttlMs: 10_000
      })
    }))
    expect(results.filter((result) => (result as { kind: string }).kind === 'deferred')).toHaveLength(10)
    expect(admission.capacity.counts({ identityKey: 'concurrent-identity', now: 1_100 })).toMatchObject({
      identity: 10, sessions: { 'shared-session': 5 }
    })
    db.close()
  })
})
