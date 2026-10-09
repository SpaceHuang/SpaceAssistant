import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runMigrations } from '../database/migrations'
import { createDeferredExecutionResultStore } from './deferredExecutionResultStore'
import { listWakeEvents } from '../database/wakeEvents'
import { createDeferredTodoStore } from './deferredTodoStore'
import { createSession } from '../database/operations'

describe('deferred execution result recovery', () => {
  it('emits a safe causal result audit only after the execution result is committed', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'audited-result-session' }).id
    const todo = createDeferredTodoStore(db).create({ todoId: 'audited-result-todo', invocationId: 'audited-result-invocation',
      channel: 'wechat', identityKey: 'audit-identity', ownerId: 'audit-owner', authorizationEpoch: 3,
      rule: { ruleId: 'write', factsHash: 'd'.repeat(64) }, workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1,
      originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const audit = vi.fn()
    const store = createDeferredExecutionResultStore(db, { audit })
    store.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey: 'audited-result-dispatch' })
    expect(audit).not.toHaveBeenCalled()
    store.commitResult(todo.todoId, { kind: 'completed', outputRef: 'safe-output-ref' })
    expect(listWakeEvents(db, sessionId)).toMatchObject([{ type: 'safety-recovery', reasonKey: 'deferred-completion:audited-result-dispatch' }])
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'deferred-approval.result', actor: 'agent',
      todoId: todo.todoId, invocationId: todo.invocationId, executionState: 'completed' }))
    expect(JSON.stringify(audit.mock.calls)).not.toContain('safe-output-ref')
    db.close()
  })

  it('reconciles a dispatched invocation by its stable key and emits one completion outbox record', async () => {
    const db = createMemoryAppDb()
    const store = createDeferredExecutionResultStore(db)
    store.beginDispatch({ todoId: 'todo-result-1', invocationId: 'invocation-result-1', dispatchKey: 'dispatch-key-1' })

    const queryResult = async (dispatchKey: string) => ({
      status: 'found' as const, dispatchKey, result: { kind: 'completed', outputRef: 'result-ref-1' }
    })
    expect(await store.recover('dispatch-key-1', queryResult)).toMatchObject({ state: 'completion_outboxed' })
    expect(await store.recover('dispatch-key-1', queryResult)).toMatchObject({ state: 'completion_outboxed', duplicate: true })
    expect(store.getByTodo('todo-result-1')).toMatchObject({
      invocationId: 'invocation-result-1', state: 'completion_outboxed', result: { outputRef: 'result-ref-1' }
    })
    expect(store.listCompletionOutbox('todo-result-1')).toHaveLength(1)
    db.close()
  })

  it('marks an unknowable side effect outcome and prevents automatic replay', async () => {
    const db = createMemoryAppDb()
    const store = createDeferredExecutionResultStore(db)
    store.beginDispatch({ todoId: 'todo-unknown-1', invocationId: 'invocation-unknown-1', dispatchKey: 'dispatch-unknown-1' })
    expect(await store.recover('dispatch-unknown-1', async () => ({ status: 'unknown' as const })))
      .toMatchObject({ state: 'outcome_unknown', replayAllowed: false })
    expect(store.beginDispatch({ todoId: 'todo-unknown-1', invocationId: 'invocation-unknown-1', dispatchKey: 'dispatch-unknown-1' }))
      .toMatchObject({ ok: false, reason: 'outcome_unknown' })
    expect(store.beginDispatch({ todoId: 'todo-unknown-1', invocationId: 'invocation-unknown-1', dispatchKey: 'dispatch-unknown-1' }))
      .toMatchObject({ ok: false })
    expect(store.listCompletionOutbox('todo-unknown-1')).toHaveLength(0)
    db.close()
  })

  it('keeps a unique pending completion event after result commit until delivery', async () => {
    const db = createMemoryAppDb()
    const store = createDeferredExecutionResultStore(db)
    store.beginDispatch({ todoId: 'todo-outbox-1', invocationId: 'invocation-outbox-1', dispatchKey: 'dispatch-outbox-1' })
    store.commitResult('todo-outbox-1', { kind: 'completed', outputRef: 'safe-ref' })
    expect(store.getByTodo('todo-outbox-1')).toMatchObject({ state: 'completion_outboxed' })
    expect(store.listCompletionOutbox('todo-outbox-1')).toMatchObject([{ state: 'pending', result: { outputRef: 'safe-ref' } }])
    expect(store.markCompletionDelivered('todo-outbox-1')).toBe(true)
    expect(store.markCompletionDelivered('todo-outbox-1')).toBe(true)
    expect(store.listCompletionOutbox('todo-outbox-1')).toMatchObject([{ state: 'delivered', result: { outputRef: 'safe-ref' } }])
    db.close()
  })

  it('restores result and completion outbox after reopen and migrates schema v72', () => {
    const temp = createTempDatabase('deferred-execution-result-')
    const store = createDeferredExecutionResultStore(temp.db)
    store.beginDispatch({ todoId: 'todo-reopen', invocationId: 'invocation-reopen', dispatchKey: 'dispatch-reopen', now: 10 })
    store.commitResult('todo-reopen', { kind: 'completed', outputRef: 'durable-ref' }, 20)
    temp.db.close()
    const reopened = openDatabase(temp.dbPath)
    expect(createDeferredExecutionResultStore(reopened).getByTodo('todo-reopen')).toMatchObject({ state: 'completion_outboxed' })
    expect(createDeferredExecutionResultStore(reopened).listCompletionOutbox('todo-reopen')).toMatchObject([
      { state: 'pending', result: { outputRef: 'durable-ref' } }
    ])
    reopened.close()
    temp.cleanup()

    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE deferred_completion_outbox; DROP TABLE deferred_execution_results')
    conn.prepare("UPDATE schema_meta SET value='72' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_execution_results'").get())
      .toEqual({ name: 'deferred_execution_results' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_completion_outbox'").get())
      .toEqual({ name: 'deferred_completion_outbox' })
    db.close()
  })
})
