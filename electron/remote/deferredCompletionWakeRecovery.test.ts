import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSession } from '../database/operations'
import { attributeAndPersistRemoteMessage } from './remoteTrackAttributionService'
import { appendImInboxMessageWithWakeEvent } from '../database/imInbox'
import { decideDeferredCompletionWakeRecovery, deliverInterruptedDeferredCompletionNotice } from './deferredCompletionWakeRecovery'
import { readDeferredCompletionWake } from './deferredCompletionWake'
import { buildImQueueScope } from '../../src/shared/queueScope'

describe('deferred completion wake recovery', () => {
  it('reconstructs a deferred continuation Track context from the todo and its original attributed inbox message', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'deferred-track-completion' })
      const attribution = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'alice', ownerId: 'alice',
        authorizationEpoch: 1, platformMessageId: 'deferred-track-source', text: '执行并在完成后总结', originSessionId: session.id, now: 1 },
      { classify: vi.fn() })
      if (attribution.kind !== 'attributed') throw new Error('expected Track attribution')
      const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat',
        queueScope: buildImQueueScope('wechat', session.id), channelMessageId: 'deferred-track-source', content: '执行并在完成后总结',
        trackId: attribution.context.trackId, trackEventId: attribution.context.attributionEventId })
      const todo = createDeferredTodoStore(db).create({ todoId: 'deferred-track-todo', invocationId: 'deferred-track-invocation',
        channel: 'wechat', identityKey: 'alice', ownerId: 'alice', authorizationEpoch: 1,
        rule: { ruleId: 'write', factsHash: 'a'.repeat(64) }, workflowId: 'workflow', taskId: 'task', stepId: 'publish',
        planRevision: 1, originSessionId: session.id, trackId: attribution.context.trackId, createdAt: 1, expiresAt: 10_000 }).todo
      const results = createDeferredExecutionResultStore(db)
      results.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey: 'deferred-track-dispatch', now: 2 })
      results.commitResult(todo.todoId, { kind: 'completed', outputRef: 'deferred-result' }, 3)
      createDeferredEnvelopeStore(db).put({ invocationId: todo.invocationId, requestId: 'source-request', turnId: 'source-turn',
        toolCallId: 'source-call', toolName: 'send_message', canonicalArgs: {}, contentVersions: {}, now: 2,
        executionContext: { currentUserMessageId: inbox.messageId, messageId: 'deferred-track-source' } })

      const completion = readDeferredCompletionWake(db, todo.todoId)

      expect(completion?.trackContext).toEqual({ ...attribution.context })
    } finally { db.close() }
  })

  it('runs no recovery when there is no prior completion turn', () => {
    const recover = vi.fn()
    const read = vi.fn(() => undefined)
    expect(decideDeferredCompletionWakeRecovery({ read, recover })).toEqual({ kind: 'start' })
    expect(recover).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('recovers an unfinished turn, then decides from the newly persisted terminal fact', () => {
    let state: { state: string; outcome?: string } | undefined = { state: 'executing' }
    const recover = vi.fn(() => { state = { state: 'terminal', outcome: 'recovered' } })
    const read = vi.fn(() => state)
    expect(decideDeferredCompletionWakeRecovery({ read, recover })).toEqual({
      kind: 'notify-interrupted', outcome: 'recovered'
    })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the wake pending when recovery cannot establish a terminal result', () => {
    const turn = { state: 'executing' }
    const recover = vi.fn()
    expect(decideDeferredCompletionWakeRecovery({ read: () => turn, recover })).toEqual({ kind: 'recovery-pending' })
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('persists an interruption receipt before marking the committed completion delivered', async () => {
    const db = createMemoryAppDb()
    try {
      const results = createDeferredExecutionResultStore(db)
      results.beginDispatch({ todoId: 'todo-1', invocationId: 'invocation-1', dispatchKey: 'dispatch-1', now: 1 })
      results.commitResult('todo-1', { kind: 'completed', outputRef: 'result-1' }, 2)
      const send = vi.fn(async () => undefined)

      await deliverInterruptedDeferredCompletionNotice(db, { todoId: 'todo-1', sessionId: 'session-1', now: 3, channel: 'wechat', identityKey: 'owner', ownerId: 'owner', recipient: 'owner', send })

      expect(send).toHaveBeenCalledWith(expect.stringContaining('原操作结果已保存'))
      expect(results.getByTodo('todo-1')?.state).toBe('delivered')
      expect(results.listCompletionOutbox('todo-1')).toMatchObject([{ state: 'delivered' }])
      expect(getDbConnection(db).prepare("SELECT state,stage FROM im_lifecycle_outbox WHERE event_id='deferred-completion-interrupted:todo-1'").get())
        .toEqual({ state: 'delivered', stage: 'failed' })
    } finally { db.close() }
  })

  it('leaves the completion pending when the interruption receipt cannot be delivered', async () => {
    const db = createMemoryAppDb()
    try {
      const results = createDeferredExecutionResultStore(db)
      results.beginDispatch({ todoId: 'todo-2', invocationId: 'invocation-2', dispatchKey: 'dispatch-2', now: 1 })
      results.commitResult('todo-2', { kind: 'completed', outputRef: 'result-2' }, 2)

      await expect(deliverInterruptedDeferredCompletionNotice(db, { todoId: 'todo-2', sessionId: 'session-2', now: 3, channel: 'wechat', identityKey: 'owner', ownerId: 'owner', recipient: 'owner',
        send: async () => { throw new Error('platform unavailable') } })).rejects.toThrow('platform unavailable')

      expect(results.getByTodo('todo-2')?.state).toBe('completion_outboxed')
      expect(results.listCompletionOutbox('todo-2')).toMatchObject([{ state: 'pending' }])
      expect(getDbConnection(db).prepare("SELECT state FROM im_lifecycle_outbox WHERE event_id='deferred-completion-interrupted:todo-2'").get())
        .toEqual({ state: 'pending' })
    } finally { db.close() }
  })
})
