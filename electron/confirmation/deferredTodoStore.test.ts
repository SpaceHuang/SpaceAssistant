import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createDeferredTodoStore, DEFAULT_DEFERRED_TODO_TTL_MS } from './deferredTodoStore'

const trustedTodo = {
  todoId: 'todo-store-1',
  channel: 'feishu' as const,
  identityKey: 'identity-1',
  ownerId: 'owner-1',
  authorizationEpoch: 8,
  rule: { ruleId: 'rule-write', factsHash: 'a'.repeat(64) },
  invocationId: 'invocation-1',
  workflowId: 'workflow-1',
  taskId: 'task-1',
  stepId: 'step-1',
  planRevision: 2,
  originSessionId: 'origin-session-1',
  status: 'pending' as const,
  createdAt: 100,
  expiresAt: 200
}

describe('deferred todo authorization binding', () => {
  it('invalidates pending work when its origin session is deleted', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    store.create({ ...trustedTodo, createdAt: Date.now(), expiresAt: Date.now() + 10_000 })
    expect(store.invalidateByOriginSession('origin-session-1')).toEqual({ invalidatedTodoIds: ['todo-store-1'], dispatchingTodoIds: [] })
    expect(store.get('todo-store-1', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rule: trustedTodo.rule })?.status).toBe('invalidated')
    db.close()
  })

  it('reports dispatching session work so the authorization fence stays closed', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    store.create({ ...trustedTodo, createdAt: Date.now(), expiresAt: Date.now() + 10_000 })
    store.claimForDispatch('todo-store-1', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rule: trustedTodo.rule })
    expect(store.invalidateByOriginSession('origin-session-1')).toEqual({ invalidatedTodoIds: [], dispatchingTodoIds: ['todo-store-1'] })
    db.close()
  })

  it('invalidates stale epoch todos on recovery and fences already-dispatching records', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    const now = Date.now()
    store.create({ ...trustedTodo, todoId: 'stale-pending', invocationId: 'stale-pending-inv', createdAt: now, expiresAt: now + 10_000, updatedAt: now })
    store.create({ ...trustedTodo, todoId: 'stale-dispatching', invocationId: 'stale-dispatching-inv', createdAt: now, expiresAt: now + 10_000, updatedAt: now })
    expect(store.claimForDispatch('stale-dispatching', {
      channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rule: trustedTodo.rule
    }, now)).not.toBeNull()
    expect(store.invalidateOlderAuthorizationEpochs('feishu', 9, now + 1)).toEqual({ invalidatedTodoIds: ['stale-pending'], dispatchingTodoIds: ['stale-dispatching'] })
    expect(store.get('stale-pending', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rule: trustedTodo.rule })?.status).toBe('invalidated')
    expect(store.get('stale-dispatching', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rule: trustedTodo.rule })?.status).toBe('dispatching')
    db.close()
  })

  it('fails closed when channel, identity, owner, epoch, or policy binding differs', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    expect(store.create(trustedTodo)).toMatchObject({ ok: true, todo: trustedTodo })
    for (const context of [
      { channel: 'wechat', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8 },
      { channel: 'feishu', identityKey: 'identity-other', ownerId: 'owner-1', authorizationEpoch: 8 },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-other', authorizationEpoch: 8 },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 7 },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rule: { ruleId: 'rule-write', factsHash: 'b'.repeat(64) } }
    ]) {
      expect(store.get('todo-store-1', context as never)).toBeNull()
    }
    expect(store.get('todo-store-1', {
      channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8,
      rule: trustedTodo.rule
    })).toMatchObject({ todoId: 'todo-store-1', invocationId: 'invocation-1' })
    db.close()
  })

  it('requires a durable authorizationEpoch and ignores process-local generation as authority', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    const { authorizationEpoch: _epoch, ...withoutEpoch } = trustedTodo
    expect(() => store.create({ ...withoutEpoch, authorizationGeneration: 99 } as never))
      .toThrow(/AUTHORIZATION_EPOCH/)
    db.close()
  })

  it('returns the same todo for a retried invocation without creating duplicate records', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    const first = store.create(trustedTodo)
    const retry = store.create(trustedTodo)
    expect(retry).toMatchObject({ ok: true, todo: { todoId: first.todo.todoId, invocationId: 'invocation-1' } })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM deferred_todos WHERE invocation_id=?')
      .get('invocation-1')).toEqual({ count: 1 })
    db.close()
  })

  it('keeps pending todos across reopen, expires at the stored deadline, and gates lifecycle transitions', () => {
    const temp = createTempDatabase('deferred-todo-lifecycle-')
    const createdAt = Date.now()
    const store = createDeferredTodoStore(temp.db)
    const created = store.create({
      ...trustedTodo, todoId: 'lifecycle-todo', invocationId: 'lifecycle-invocation',
      createdAt, expiresAt: undefined, status: undefined
    })
    expect(created.todo.expiresAt).toBe(createdAt + DEFAULT_DEFERRED_TODO_TTL_MS)
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const reopenedStore = createDeferredTodoStore(reopened)
    const context = {
      channel: 'feishu' as const, identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8,
      rule: trustedTodo.rule
    }
    expect(reopenedStore.get('lifecycle-todo', context)?.status).toBe('pending')
    expect(reopenedStore.claimForDispatch('lifecycle-todo', context)?.status).toBe('dispatching')
    expect(reopenedStore.markConsumed('lifecycle-todo', context)).toBe(true)
    expect(reopenedStore.markConsumed('lifecycle-todo', context)).toBe(false)

    const expiring = reopenedStore.create({
      ...trustedTodo, todoId: 'expiring-todo', invocationId: 'expiring-invocation',
      createdAt: 20, expiresAt: 30, status: undefined
    })
    expect(reopenedStore.expireDue(30)).toBe(1)
    expect(reopenedStore.get(expiring.todo.todoId, context, 30)).toMatchObject({ status: 'expired', createdAt: 20, expiresAt: 30 })

    const associated = reopenedStore.create({
      ...trustedTodo, todoId: 'associated-todo', invocationId: 'associated-invocation',
      workflowId: 'workflow-associated', taskId: 'task-associated', stepId: 'step-associated',
      createdAt: 40, expiresAt: 100
    })
    expect(reopenedStore.invalidateAssociated({
      originSessionId: 'origin-session-1', workflowId: 'workflow-associated', taskId: 'task-associated',
      throughPlanRevision: 2, now: 50
    })).toEqual({ invalidatedTodoIds: [associated.todo.todoId], dispatchingTodoIds: [] })
    expect(reopenedStore.get(associated.todo.todoId, context)?.status).toBe('invalidated')
    reopened.close()
    temp.cleanup()
  })
})
