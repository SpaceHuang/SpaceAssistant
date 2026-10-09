import { describe, expect, it } from 'vitest'
import { createSession } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { commitDeferredTaskCheckpoint, ensureImTurnTaskControl, getTaskControlRecord, putTaskControlRecord } from './taskControl'

describe('trusted IM task control records', () => {
  it('creates a stable one-step task from an authenticated inbound turn and rejects identity reuse', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-turn-task' }).id
    const input = { sessionId, ownerId: 'owner', requestId: 'request-1', userMessageId: 'user-message-1' }
    const first = ensureImTurnTaskControl(db, input)
    const duplicate = ensureImTurnTaskControl(db, input)
    expect(first).toMatchObject({ ok: true, taskBinding: { workflowId: 'im:request-1', taskId: 'turn:request-1', stepId: 'request' } })
    expect(duplicate).toMatchObject({ ok: true, duplicate: true })
    expect(ensureImTurnTaskControl(db, { ...input, userMessageId: 'different-message' })).toMatchObject({ ok: false, error: 'identity_conflict' })
    db.close()
  })

  it('atomically records the deferred invocation and checkpoint against the active task revision', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'deferred-checkpoint' }).id
    putTaskControlRecord(db, { sessionId, ownerId: 'owner', workflowId: 'workflow', taskId: 'task', planRevision: 3,
      expectedRevision: null, data: { status: 'active', steps: [{ stepId: 'publish', instruction: 'Publish' }], outstandingInvocations: [] } })
    const result = commitDeferredTaskCheckpoint(db, { sessionId, ownerId: 'owner', workflowId: 'workflow', taskId: 'task',
      planRevision: 3, expectedRevision: 1, invocationId: 'invocation', todoId: 'todo', stepId: 'publish', now: 10 })
    expect(result).toMatchObject({ ok: true, checkpoint: { checkpointId: 'deferred:invocation', workflowRevision: 2 } })
    expect(getTaskControlRecord(db, { sessionId, ownerId: 'owner', workflowId: 'workflow', taskId: 'task' })?.data.outstandingInvocations)
      .toEqual([{ invocationId: 'invocation', todoId: 'todo', stepId: 'publish' }])
    db.close()
  })

  it('binds workflow, task, session, and plan revision outside untrusted workflow data', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-control-trusted-identity' }).id

    const stored = putTaskControlRecord(db, {
      sessionId,
      ownerId: 'owner-authenticated',
      workflowId: 'workflow-authenticated',
      taskId: 'task-authenticated',
      planRevision: 4,
      expectedRevision: null,
      data: {
        summary: 'User supplied workflow payload',
        workflowId: 'workflow-forged',
        taskId: 'task-forged',
        sessionId: 'session-forged',
        planRevision: 900
      }
    })

    expect(stored).toMatchObject({
      ok: true,
      record: {
        sessionId,
        workflowId: 'workflow-authenticated',
        taskId: 'task-authenticated',
        planRevision: 4,
        revision: 1,
        data: { summary: 'User supplied workflow payload', taskId: 'task-forged' }
      }
    })
    expect(getTaskControlRecord(db, { sessionId, ownerId: 'owner-authenticated', workflowId: 'workflow-authenticated', taskId: 'task-authenticated' }))
      .toMatchObject({ planRevision: 4, revision: 1 })
    expect(getTaskControlRecord(db, { sessionId, ownerId: 'owner-authenticated', workflowId: 'workflow-forged', taskId: 'task-forged' })).toBeNull()
    db.close()
  })

  it('isolates owners and versions and rejects stale expectedRevision without overwriting', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-control-cas' }).id
    const input = {
      sessionId, ownerId: 'owner-a', workflowId: 'workflow-a', taskId: 'task-a', planRevision: 1,
      expectedRevision: null, data: { status: 'active' }
    }
    expect(putTaskControlRecord(db, input)).toMatchObject({ ok: true, record: { revision: 1, version: 1 } })
    expect(putTaskControlRecord(db, { ...input, planRevision: 2, data: { status: 'forged' } }))
      .toMatchObject({ ok: false, error: 'revision_conflict', current: { planRevision: 1, data: { status: 'active' } } })
    expect(getTaskControlRecord(db, { sessionId, ownerId: 'owner-b', workflowId: 'workflow-a', taskId: 'task-a' })).toBeNull()
    expect(putTaskControlRecord(db, { ...input, version: 2, data: { status: 'v2' } }))
      .toMatchObject({ ok: true, record: { version: 2, revision: 1 } })
    db.close()
  })

  it('creates the task control table when upgrading a schema v65 database', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE im_task_control')
    conn.prepare("UPDATE schema_meta SET value='65' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='im_task_control'").get())
      .toEqual({ name: 'im_task_control' })
    db.close()
  })
})
