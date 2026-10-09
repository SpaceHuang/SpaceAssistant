import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredTodoTaskControlSafetyPort } from './deferredTodoTaskControlAdapter'

describe('deferred todo task-control invalidation adapter', () => {
  it('invalidates requested invocation ids in the real store and preserves unrelated work', async () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'c'.repeat(64) }
    for (const [todoId, invocationId] of [['cancel-todo', 'cancel-inv'], ['keep-todo', 'keep-inv']] as const) {
      store.create({ todoId, invocationId, channel: 'feishu', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1,
        rule, workflowId: 'workflow', taskId: 'task', stepId: todoId, planRevision: 1,
        originSessionId: 'session', createdAt: 1, expiresAt: Date.now() + 60_000 })
    }
    const adapter = createDeferredTodoTaskControlSafetyPort({ todoStore: store, dispatchDeferred: async () => ({ dispatched: false }) })
    await expect(adapter.invalidateTask({ operationId: 'cancel-op', sessionId: 'session', ownerId: 'owner', workflowId: 'workflow', taskId: 'task', planRevision: 1, invocationIds: ['cancel-inv'] }))
      .resolves.toEqual({ invalidated: ['cancel-inv'] })
    const context = { channel: 'feishu' as const, identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1, rule }
    expect(store.get('cancel-todo', context)?.status).toBe('invalidated')
    expect(store.get('keep-todo', context)?.status).toBe('pending')
    db.close()
  })

  it('refuses to complete cancellation when a matching todo has already entered dispatching', async () => {
    const db = createMemoryAppDb()
    const store = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'd'.repeat(64) }
    store.create({ todoId: 'started-todo', invocationId: 'started-inv', channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1,
      rule, workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1,
      originSessionId: 'session', createdAt: 1, expiresAt: Date.now() + 60_000 })
    store.claimForDispatch('started-todo', { channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1, rule })
    const adapter = createDeferredTodoTaskControlSafetyPort({ todoStore: store, dispatchDeferred: async () => ({ dispatched: false }) })
    await expect(adapter.invalidateTask({ operationId: 'cancel-op', sessionId: 'session', ownerId: 'owner', workflowId: 'workflow', taskId: 'task', planRevision: 1, invocationIds: ['started-inv'] }))
      .rejects.toThrow('DEFERRED_TODO_DISPATCH_ALREADY_STARTED')
    db.close()
  })
})
