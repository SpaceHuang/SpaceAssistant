import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runMigrations } from '../database/migrations'
import { createSecurityActionIntentStore } from './securityActionIntentStore'

describe('security action intent checkpoint state machine', () => {
  it('requires prepare, todo link, and checkpoint commit before notify, resume, or dispatch', () => {
    const db = createMemoryAppDb()
    const store = createSecurityActionIntentStore(db)
    const prepared = store.prepare({
      invocationId: 'intent-invocation-1', sessionId: 'origin-1', workflowId: 'workflow-1', taskId: 'task-1',
      stepId: 'step-1', planRevision: 2, envelopeInvocationId: 'intent-invocation-1'
    })
    expect(prepared).toMatchObject({ state: 'prepared' })
    expect(store.markNotified('intent-invocation-1')).toMatchObject({ ok: false, reason: 'checkpoint_not_committed' })
    expect(store.authorizeResume('intent-invocation-1')).toBe(false)
    expect(store.authorizeDispatch('intent-invocation-1')).toBe(false)

    expect(store.linkTodo('intent-invocation-1', 'todo-1')).toMatchObject({ state: 'todo_linked' })
    expect(store.authorizeResume('intent-invocation-1')).toBe(false)
    expect(store.authorizeDispatch('intent-invocation-1')).toBe(false)
    expect(store.commitCheckpoint('intent-invocation-1', { checkpointId: 'checkpoint-1', workflowRevision: 3 }))
      .toMatchObject({ state: 'checkpoint_committed' })
    expect(store.authorizeResume('intent-invocation-1')).toBe(true)
    expect(store.authorizeDispatch('intent-invocation-1')).toBe(true)
    expect(store.markNotified('intent-invocation-1')).toMatchObject({ ok: true, intent: { state: 'notified' } })
    expect(store.get('intent-invocation-1')).toMatchObject({ state: 'notified', todoId: 'todo-1' })
    db.close()
  })

  it.each([
    ['todo-link', (store: ReturnType<typeof createSecurityActionIntentStore>) => store.linkTodo('fault-intent', 'todo-fault')],
    ['checkpoint', (store: ReturnType<typeof createSecurityActionIntentStore>) => store.commitCheckpoint('fault-intent', { checkpointId: 'checkpoint-fault', workflowRevision: 2 })]
  ] as const)('%s failure leaves the action ineligible for notify, resume, or dispatch', (_stage, fail) => {
    const db = createMemoryAppDb()
    const store = createSecurityActionIntentStore(db)
    store.prepare({ invocationId: 'fault-intent', sessionId: 'origin', workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, envelopeInvocationId: 'fault-intent' })
    if (_stage === 'checkpoint') store.linkTodo('fault-intent', 'todo-fault')
    getDbConnection(db).exec(`CREATE TRIGGER inject_${_stage.replace('-', '_')}_failure BEFORE UPDATE ON security_action_intents BEGIN SELECT RAISE(ABORT, 'injected_${_stage}_failure'); END`)

    expect(() => fail(store)).toThrow(`injected_${_stage}_failure`)
    expect(store.markNotified('fault-intent')).toMatchObject({ ok: false, reason: 'checkpoint_not_committed' })
    expect(store.authorizeResume('fault-intent')).toBe(false)
    expect(store.authorizeDispatch('fault-intent')).toBe(false)
    expect(store.get('fault-intent')?.state).toBe(_stage === 'todo-link' ? 'prepared' : 'todo_linked')
    db.close()
  })

  it('persists prepared state across database reopen and migrates schema v70', () => {
    const temp = createTempDatabase('security-action-intent-')
    const store = createSecurityActionIntentStore(temp.db)
    store.prepare({
      invocationId: 'persisted-intent', sessionId: 'origin', workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, envelopeInvocationId: 'persisted-intent', now: 10
    })
    temp.db.close()
    const reopened = openDatabase(temp.dbPath)
    expect(createSecurityActionIntentStore(reopened).get('persisted-intent')).toMatchObject({ state: 'prepared', createdAt: 10 })
    reopened.close()
    temp.cleanup()

    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE security_action_intents')
    conn.prepare("UPDATE schema_meta SET value='71' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '80' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='security_action_intents'").get())
      .toEqual({ name: 'security_action_intents' })
    db.close()
  })
})
