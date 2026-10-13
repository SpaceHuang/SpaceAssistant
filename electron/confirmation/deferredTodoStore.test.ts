import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createDeferredTodoStore, DEFAULT_DEFERRED_TODO_TTL_MS } from './deferredTodoStore'
import { applyRemoteTrackLifecycleEvent, createRemoteTrack } from '../database/remoteTrackStore'
import { commitImPolicySnapshot } from './imPolicyStore'
import { getRemoteAsyncApprovalTestRunId, setRemoteAsyncApprovalTestModeEnabled } from './remoteAsyncApprovalTestMode'

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
  it('persists a process-local async approval test fence only for the active development run', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'test-run-policy-seed' })
    try {
      setRemoteAsyncApprovalTestModeEnabled(true, false)
      const runId = getRemoteAsyncApprovalTestRunId()!
      const store = createDeferredTodoStore(db)
      const current = store.create({ ...trustedTodo, todoId: 'test-run-current', invocationId: 'test-run-current-inv',
        policyBehaviorVersion: `im-standard-v2:dev-test:${runId}` }).todo
      expect(current.policyBehaviorVersion).toBe(`im-standard-v2:dev-test:${runId}`)

      setRemoteAsyncApprovalTestModeEnabled(false, false)
      setRemoteAsyncApprovalTestModeEnabled(true, false)
      expect(() => store.create({ ...trustedTodo, todoId: 'test-run-stale', invocationId: 'test-run-stale-inv',
        policyBehaviorVersion: `im-standard-v2:dev-test:${runId}` })).toThrow('DEFERRED_TEST_POLICY_FENCE_INVALID')
    } finally {
      setRemoteAsyncApprovalTestModeEnabled(false, false)
      db.close()
    }
  })

  it('persists the shared IM policy version, revision, and epoch captured at todo creation', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'todo-policy-seed' })
    const todo = createDeferredTodoStore(db).create({ ...trustedTodo, invocationId: 'policy-bound-invocation' }).todo
    expect(todo).toMatchObject({ policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1 })
    expect(conn.prepare('SELECT policy_behavior_version,policy_revision,policy_epoch FROM deferred_todos WHERE todo_id=?').get(todo.todoId))
      .toEqual({ policy_behavior_version: 'im-standard-v2', policy_revision: 1, policy_epoch: 1 })
    db.close()
  })

  it('persists the Track association on the todo source row and keeps the child projection in sync', () => {
    const db = createMemoryAppDb()
    createRemoteTrack(db, { trackId: 'todo-track', eventId: 'todo-track-root', idempotencyKey: 'todo-track-inbound', channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rootMessageId: 'root-message', occurredAt: 1 })
    applyRemoteTrackLifecycleEvent(db, { trackId: 'todo-track', eventId: 'todo-track-started', idempotencyKey: 'todo-track-started', occurredAt: 2, event: { type: 'execution-started' } })
    const store = createDeferredTodoStore(db)
    const result = store.create({ ...trustedTodo, todoId: 'tracked-todo', invocationId: 'tracked-invocation', trackId: 'todo-track' })
    expect(result.todo).toMatchObject({ trackId: 'todo-track' })
    expect(getDbConnection(db).prepare('SELECT track_id FROM deferred_todos WHERE todo_id=?').get('tracked-todo'))
      .toEqual({ track_id: 'todo-track' })
    expect(getDbConnection(db).prepare("SELECT state FROM remote_track_children WHERE track_id='todo-track' AND child_kind='async-todo' AND child_id='tracked-todo'").get())
      .toEqual({ state: 'pending' })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('todo-track')).toEqual({ state: 'waiting-async-approval' })
    const claimed = store.claimForDispatch('tracked-todo', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1',
      authorizationEpoch: 8, originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule }, 110)
    expect(claimed?.status).toBe('dispatching')
    expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('todo-track')).toEqual({ state: 'resuming' })
    db.close()
  })

  it('records a closed Track-link failure fact when todo child association cannot be written', () => {
    const db = createMemoryAppDb()
    createRemoteTrack(db, { trackId: 'todo-link-failed-track', eventId: 'todo-link-failed-root', idempotencyKey: 'todo-link-failed-inbound',
      channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, rootMessageId: 'todo-link-platform-message', occurredAt: 1 })
    getDbConnection(db).exec(`CREATE TRIGGER fail_remote_track_child_insert BEFORE INSERT ON remote_track_children
      BEGIN SELECT RAISE(ABORT,'injected child link failure'); END`)
    const store = createDeferredTodoStore(db)
    expect(() => store.create({ ...trustedTodo, todoId: 'link-failed-todo', invocationId: 'link-failed-invocation', trackId: 'todo-link-failed-track' }))
      .toThrow('injected child link failure')
    expect(getDbConnection(db).prepare(`SELECT event_kind,reason_code FROM remote_track_runtime_diagnostics
      WHERE platform_message_id='todo-link-platform-message'`).get())
      .toEqual({ event_kind: 'track-association-write-failed', reason_code: 'turn-association-write-failed' })
    db.close()
  })

  it('invalidates pending work when its origin session is deleted', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    store.create({ ...trustedTodo, createdAt: Date.now(), expiresAt: Date.now() + 10_000 })
    expect(store.invalidateByOriginSession('origin-session-1')).toEqual({ invalidatedTodoIds: ['todo-store-1'], dispatchingTodoIds: [] })
    expect(store.get('todo-store-1', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule })?.status).toBe('invalidated')
    db.close()
  })

  it('reports dispatching session work so the authorization fence stays closed', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    store.create({ ...trustedTodo, createdAt: Date.now(), expiresAt: Date.now() + 10_000 })
    store.claimForDispatch('todo-store-1', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule })
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
      channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule
    }, now)).not.toBeNull()
    expect(store.invalidateOlderAuthorizationEpochs('feishu', 9, now + 1)).toEqual({ invalidatedTodoIds: ['stale-pending'], dispatchingTodoIds: ['stale-dispatching'] })
    expect(store.get('stale-pending', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule })?.status).toBe('invalidated')
    expect(store.get('stale-dispatching', { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule })?.status).toBe('dispatching')
    db.close()
  })

  it('fails closed when channel, identity, owner, epoch, or policy binding differs', () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    expect(store.create(trustedTodo)).toMatchObject({ ok: true, todo: trustedTodo })
    for (const context of [
      { channel: 'wechat', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: 'origin-session-1', rule: trustedTodo.rule },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: 'other-session', rule: trustedTodo.rule },
      { channel: 'feishu', identityKey: 'identity-other', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: 'origin-session-1', rule: trustedTodo.rule },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-other', authorizationEpoch: 8, originSessionId: 'origin-session-1', rule: trustedTodo.rule },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 7, originSessionId: 'origin-session-1', rule: trustedTodo.rule },
      { channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: 'origin-session-1', rule: { ruleId: 'rule-write', factsHash: 'b'.repeat(64) } }
    ]) {
      expect(store.get('todo-store-1', context as never)).toBeNull()
    }
    expect(store.get('todo-store-1', {
      channel: 'feishu', identityKey: 'identity-1', ownerId: 'owner-1', authorizationEpoch: 8, originSessionId: 'origin-session-1',
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
    const retry = store.create({ ...trustedTodo, createdAt: trustedTodo.createdAt + 50_000, expiresAt: trustedTodo.expiresAt + 50_000 })
    expect(retry).toMatchObject({ ok: true, todo: { todoId: first.todo.todoId, invocationId: 'invocation-1' } })
    expect(retry.ok && retry.todo.createdAt).toBe(first.todo.createdAt)
    expect(retry.ok && retry.todo.expiresAt).toBe(first.todo.expiresAt)
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
      originSessionId: trustedTodo.originSessionId, rule: trustedTodo.rule
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
