import { describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createDeferredResumeRequestStore } from './deferredResumeRequestStore'
import { createDeferredTodoStore } from './deferredTodoStore'

const base = {
  requestId: 'resume-request-persisted', reasonKey: 'reply-event-1', todoId: 'resume-todo', invocationId: 'resume-invocation',
  sessionId: 'origin-session', channel: 'wechat' as const, identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3,
  rule: { ruleId: 'write', factsHash: 'a'.repeat(64) }, notificationVersion: 1, messageId: 'trusted-message-1'
}

describe('deferred resume request persistence', () => {
  it('persists pending requests across reopen and deduplicates the same reason key', () => {
    const temp = createTempDatabase('deferred-resume-request-')
    createDeferredTodoStore(temp.db).create({ todoId: base.todoId, invocationId: base.invocationId, channel: base.channel,
      identityKey: base.identityKey, ownerId: base.ownerId, authorizationEpoch: base.authorizationEpoch, rule: base.rule,
      workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: base.sessionId,
      createdAt: 1, expiresAt: Date.now() + 60_000 })
    const store = createDeferredResumeRequestStore(temp.db)
    expect(store.create({ ...base, now: 10 })).toMatchObject({ duplicate: false, request: { state: 'pending', createdAt: 10 } })
    expect(store.create({ ...base, now: 11 })).toMatchObject({ duplicate: true, request: { state: 'pending', createdAt: 10 } })
    expect(() => store.create({ ...base, messageId: 'different-message' })).toThrow('DEFERRED_RESUME_REASON_BINDING_CONFLICT')
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    expect(createDeferredResumeRequestStore(reopened).get(base.requestId)).toMatchObject({
      requestId: base.requestId, todoId: base.todoId, messageId: base.messageId, state: 'pending', createdAt: 10
    })
    reopened.close()
    temp.cleanup()
  })

  it('allows only one active resume request to consume a notification version', () => {
    const db = createTempDatabase('deferred-notification-consume-')
    createDeferredTodoStore(db.db).create({ todoId: base.todoId, invocationId: base.invocationId, channel: base.channel,
      identityKey: base.identityKey, ownerId: base.ownerId, authorizationEpoch: base.authorizationEpoch, rule: base.rule,
      workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: base.sessionId,
      createdAt: 1, expiresAt: Date.now() + 60_000 })
    const store = createDeferredResumeRequestStore(db.db)
    store.create({ ...base, now: 10 })
    expect(() => store.create({ ...base, requestId: 'other-request', reasonKey: 'other-reply', messageId: 'other-reply', now: 11 }))
      .toThrow('DEFERRED_NOTIFICATION_VERSION_ALREADY_CONSUMED')
    db.db.close()
    db.cleanup()
  })

  it('lists pending recovery sessions and requests by owning channel only', () => {
    const db = createTempDatabase('deferred-resume-channel-recovery-')
    const todos = createDeferredTodoStore(db.db)
    const store = createDeferredResumeRequestStore(db.db)
    todos.create({ todoId: 'wechat-todo', invocationId: base.invocationId, channel: 'wechat', identityKey: 'i', ownerId: 'o', authorizationEpoch: 3,
      rule: base.rule, workflowId: 'wf', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: base.sessionId,
      createdAt: 1, expiresAt: Date.now() + 60_000 })
    todos.create({ todoId: 'feishu-todo', invocationId: 'feishu-inv', channel: 'feishu', identityKey: 'i', ownerId: 'o', authorizationEpoch: 3,
      rule: base.rule, workflowId: 'wf', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: base.sessionId,
      createdAt: 1, expiresAt: Date.now() + 60_000 })
    store.create({ ...base, todoId: 'wechat-todo', now: 2 })
    store.create({ ...base, requestId: 'feishu-request', reasonKey: 'feishu-reply', todoId: 'feishu-todo', invocationId: 'feishu-inv', channel: 'feishu', now: 3 })
    expect(store.listPendingSessionIds('feishu')).toEqual([base.sessionId])
    expect(store.listPending(base.sessionId, 'feishu').map(({ channel }) => channel)).toEqual(['feishu'])
    expect(store.listPending(base.sessionId, 'wechat').map(({ channel }) => channel)).toEqual(['wechat'])
    db.db.close()
    db.cleanup()
  })

  it('invalidates pending requests below a new authority epoch and fences dispatching requests', () => {
    const db = createTempDatabase('deferred-request-epoch-')
    const todoStore = createDeferredTodoStore(db.db)
    todoStore.create({ todoId: base.todoId, invocationId: base.invocationId, channel: base.channel, identityKey: base.identityKey,
      ownerId: base.ownerId, authorizationEpoch: base.authorizationEpoch, rule: base.rule, workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, originSessionId: base.sessionId, createdAt: 1, expiresAt: Date.now() + 60_000 })
    const store = createDeferredResumeRequestStore(db.db)
    store.create({ ...base, now: 10 })
    expect(store.invalidateOlderAuthorizationEpochs('wechat', 4)).toEqual({ invalidated: 1, dispatching: 0 })
    expect(store.get(base.requestId)?.state).toBe('invalidated')
    db.db.close()
    db.cleanup()
  })
})
