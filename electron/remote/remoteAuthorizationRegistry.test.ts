import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  RemoteAuthorizationRegistry,
  type PendingCancelByChannel,
  type WriteGrantRevoker
} from './remoteAuthorizationRegistry'
import { PendingRequestRegistry } from './pendingRequestRegistry'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createRemoteAuthorizationEpochStore } from './remoteAuthorizationEpochStore'
import { confirmationAuthorizationRegistry } from '../confirmation/confirmationAuthorizationRegistry'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredResumeRequestStore } from '../confirmation/deferredResumeRequestStore'
import { createSession } from '../database/operations'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'

describe('RemoteAuthorizationRegistry', () => {
  let registry: RemoteAuthorizationRegistry

  beforeEach(() => {
    registry = new RemoteAuthorizationRegistry()
  })

  it('bumps generation monotonically per channel', () => {
    expect(registry.getGeneration('feishu')).toBe(0)
    expect(registry.invalidate('feishu', 'remote_disabled')).toBe(1)
    expect(registry.getGeneration('feishu')).toBe(1)
    expect(registry.getGeneration('wechat')).toBe(0)
    expect(registry.invalidate('feishu', 'allowlist_changed')).toBe(2)
  })

  it('cancels pending and revokes grants synchronously on invalidate', async () => {
    const pending = new PendingRequestRegistry<{
      id: string
      sessionId: string
      expiresAt: number
      channel: 'feishu' | 'wechat'
    }>()
    const wait = pending.register(
      { id: 'p1', sessionId: 's1', expiresAt: Date.now() + 60_000, channel: 'feishu' },
      60_000
    )
    const cancelHandler: PendingCancelByChannel = {
      cancelByChannel: (ch) => pending.cancelByChannel(ch)
    }
    const grantRevoker: WriteGrantRevoker = {
      revokeByChannel: () => 3
    }
    const audits: Array<Record<string, unknown>> = []
    registry.registerPendingCancel(cancelHandler)
    registry.setWriteGrantRevoker(grantRevoker)
    registry.registerAuditAppender((e) => {
      audits.push(e)
    })

    const gen = registry.invalidate('feishu', 'owner_cleared')
    expect(gen).toBe(1)
    await expect(wait).resolves.toBe('cancelled')
    expect(pending.countPending()).toBe(0)
    expect(audits[0]).toMatchObject({
      type: 'authorization_revoked',
      channel: 'feishu',
      reason: 'owner_cleared',
      authorizationGeneration: 1,
      cancelledPending: 1,
      revokedGrants: 3
    })
  })

  it('clears lane session-scope decision cache on invalidate (B3)', () => {
    const cleared: string[] = []
    registry.registerCacheClearer({
      clearByChannel: (ch) => {
        cleared.push(ch)
        return ch === 'wechat' ? 2 : 0
      }
    })
    const audits: Array<Record<string, unknown>> = []
    registry.registerAuditAppender((e) => {
      audits.push(e)
    })
    registry.invalidate('wechat', 'logout')
    expect(cleared).toEqual(['wechat'])
    expect(audits[0]).toMatchObject({ clearedCacheEntries: 2 })
  })

  it('approve after invalidate cannot use old generation semantics', () => {
    const pending = new PendingRequestRegistry<{
      id: string
      sessionId: string
      expiresAt: number
      channel: 'feishu' | 'wechat'
      authorizationGeneration: number
    }>()
    registry.registerPendingCancel({
      cancelByChannel: (ch) => pending.cancelByChannel(ch)
    })
    const wait = pending.register(
      {
        id: 'old',
        sessionId: 's',
        expiresAt: Date.now() + 60_000,
        channel: 'wechat',
        authorizationGeneration: registry.getGeneration('wechat')
      },
      60_000
    )
    registry.invalidate('wechat', 'remote_disabled')
    // After invalidate the waiter is already resolved as n; resolve(y) is a no-op
    expect(pending.resolve('old', 'y')).toBe(false)
    return expect(wait).resolves.toBe('cancelled')
  })

  it('uses the durable epoch before completing registered todo invalidators', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(store)
    const seen: Array<[string, number]> = []
    registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: (channel, epoch) => seen.push([channel, epoch]) })
    expect(registry.getAuthorizationEpoch('feishu')).toBe(1)
    registry.invalidate('feishu', 'owner_cleared')
    expect(registry.getAuthorizationEpoch('feishu')).toBe(2)
    expect(seen).toEqual([['feishu', 2]])
    expect(store.pendingRevocations()).toEqual([])
    db.close()
  })

  it('keeps the durable revoke pending if a cascade fails and recovers before readiness', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(store)
    const removeFailingInvalidator = registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: () => { throw new Error('cascade failed') } })
    expect(() => registry.invalidate('wechat', 'logout')).toThrow('cascade failed')
    expect(() => registry.getAuthorizationEpoch('wechat')).toThrow(/RECOVERY_REQUIRED|DISPATCH_FENCED/)
    removeFailingInvalidator()
    registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: () => undefined })
    expect(() => registry.recoverPendingRevocations()).not.toThrow()
    expect(registry.getAuthorizationEpoch('wechat')).toBe(2)
    db.close()
  })

  it('fences getGeneration immediately when an in-process persistent cascade fails', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(store)
    const remove = registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: () => { throw new Error('cascade unavailable') } })
    expect(() => registry.invalidate('feishu', 'owner_cleared')).toThrow('cascade unavailable')
    expect(() => registry.getGeneration('feishu')).toThrow(/DISPATCH_FENCED|RECOVERY_REQUIRED/)
    remove()
    registry.recoverPendingRevocations()
    expect(registry.getGeneration('feishu')).toBe(2)
    db.close()
  })

  it('deduplicates cascade registrations and fans revocation out to resume requests and unissued permits', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(store)
    const resumeRequests = vi.fn()
    const unissuedPermits = vi.fn()
    const cascade = {
      invalidateByAuthorizationEpoch: vi.fn(),
      invalidateResumeRequests: resumeRequests,
      revokeUnissuedDispatchPermits: unissuedPermits
    }
    const disposeFirst = registry.registerDeferredTodoInvalidator(cascade as never)
    registry.registerDeferredTodoInvalidator(cascade as never)
    registry.invalidate('feishu', 'remote_disabled')
    expect(cascade.invalidateByAuthorizationEpoch).toHaveBeenCalledOnce()
    expect(resumeRequests).toHaveBeenCalledWith('feishu', 2)
    expect(unissuedPermits).toHaveBeenCalledWith('feishu', 2)
    disposeFirst()
    db.close()
  })

  it('unregisters replaced channel cascades and revokes shared channel permits', () => {
    const db = createMemoryAppDb()
    registry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))
    const permit = confirmationAuthorizationRegistry.issue({
      channel: 'feishu', invocationId: 'inv', requestId: 'req', toolUseId: 'tool', sessionId: 'session',
      planDigest: 'plan', factsDigest: 'facts', revision: 'r1'
    })
    const first = vi.fn()
    const second = vi.fn()
    const dispose = registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: first }, 'feishu-test')
    registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: second }, 'feishu-test')
    dispose()
    registry.invalidate('feishu', 'owner_cleared')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(() => confirmationAuthorizationRegistry.consume(permit, permit.subject)).toThrow('MEMORY_WRITE_PERMIT_INVALID')
    db.close()
  })

  it('invalidates only todos bound to the deleted origin session', () => {
    const db = createMemoryAppDb()
    registry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))
    const invalidateSession = vi.fn()
    const invalidateChannel = vi.fn()
    const cancel = vi.fn()
    const clearCache = vi.fn()
    registry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: invalidateChannel,
      invalidateByOriginSession: invalidateSession
    }, 'session-todos')
    registry.registerPendingCancel({ cancelByChannel: cancel }, 'session-pending')
    registry.registerCacheClearer({ clearByChannel: clearCache }, 'session-cache')
    registry.invalidateSession('feishu', 'session-id')
    expect(invalidateSession).toHaveBeenCalledWith('session-id', 'feishu', 2)
    expect(invalidateChannel).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith('feishu')
    expect(clearCache).toHaveBeenCalledWith('feishu')
    db.close()
  })

  it('keeps a closed authorization epoch across reopen and re-enable without reviving old todos', () => {
    const db = createMemoryAppDb()
    const firstStore = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(firstStore)
    const staleTodoInvalidator = vi.fn()
    registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: staleTodoInvalidator }, 'reopen-test')
    registry.invalidate('feishu', 'remote_disabled')
    registry.invalidate('feishu', 'remote_enabled')
    expect(firstStore.current('feishu')).toBe(3)
    expect(staleTodoInvalidator).toHaveBeenLastCalledWith('feishu', 3)
    db.close()
  })

  it('replays session scoped invalidation after reopen without broad channel invalidation', () => {
    const db = createMemoryAppDb()
    const firstStore = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(firstStore)
    const scoped = vi.fn()
    const broad = vi.fn()
    registry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: broad, invalidateByOriginSession: scoped }, 'scope-recovery')
    firstStore.advance('wechat', 'session_deleted', 20, 'origin-session')
    const reopenedRegistry = new RemoteAuthorizationRegistry()
    reopenedRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))
    reopenedRegistry.registerDeferredTodoInvalidator({ invalidateByAuthorizationEpoch: broad, invalidateByOriginSession: scoped }, 'scope-recovery')
    reopenedRegistry.recoverPendingRevocations()
    expect(scoped).toHaveBeenCalledWith('origin-session', 'wechat', 2)
    expect(broad).not.toHaveBeenCalled()
    db.close()
  })

  it('does not claim or consume an old todo when durable revocation wins the race', () => {
    const db = createMemoryAppDb()
    const epochStore = createRemoteAuthorizationEpochStore(db)
    const todos = createDeferredTodoStore(db)
    const context = {
      channel: 'feishu' as const, identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1,
      rule: { ruleId: 'write', factsHash: 'f'.repeat(64) }
    }
    todos.create({ ...context, invocationId: 'race-inv', workflowId: 'wf', taskId: 'task', stepId: 'step', planRevision: 1,
      originSessionId: 'origin', createdAt: 1, expiresAt: Date.now() + 60_000, todoId: 'race-todo' })
    registry.bindPersistentEpochStore(epochStore)
    registry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: (channel, epoch) => { todos.invalidateOlderAuthorizationEpochs(channel, epoch) }
    }, 'race-todos')
    registry.invalidate('feishu', 'allowlist_changed')
    expect(todos.claimForDispatch('race-todo', context)).toBeNull()
    expect(todos.markConsumed('race-todo', context)).toBe(false)
    expect(epochStore.current('feishu')).toBe(2)
    db.close()
  })

  it('reconciles an older pending session tombstone before completing a newer deletion', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    registry.bindPersistentEpochStore(store)
    store.advance('wechat', 'session_deleted', 10, 'older-session')
    const invalidatedSessions: string[] = []
    registry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: () => undefined,
      invalidateByOriginSession: (sessionId) => { invalidatedSessions.push(sessionId) }
    }, 'session-recovery-order')
    registry.invalidateSession('wechat', 'newer-session')
    expect(invalidatedSessions).toEqual(['older-session', 'newer-session'])
    expect(store.pendingRevocations()).toEqual([])
    db.close()
  })

  it('reopens SQLite and invalidates only the journaled session before dispatch resumes', () => {
    const temp = createTempDatabase('remote-auth-session-recovery-')
    const firstTodos = createDeferredTodoStore(temp.db)
    const rule = { ruleId: 'write', factsHash: 'e'.repeat(64) }
    for (const [todoId, originSessionId] of [['stale-session-todo', 'deleted-session'], ['other-session-todo', 'keep-session']] as const) {
      firstTodos.create({ todoId, channel: 'feishu', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1, rule,
        invocationId: `${todoId}-inv`, workflowId: 'wf', taskId: 'task', stepId: 'step', planRevision: 1,
        originSessionId, createdAt: 1, expiresAt: Date.now() + 60_000 })
    }
    createRemoteAuthorizationEpochStore(temp.db).advance('feishu', 'session_deleted', 10, 'deleted-session')
    temp.db.close()

    const reopenedDb = openDatabase(temp.dbPath)
    const reopenedTodos = createDeferredTodoStore(reopenedDb)
    const reopenedRegistry = new RemoteAuthorizationRegistry()
    reopenedRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(reopenedDb))
    reopenedRegistry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: (channel, epoch) => { reopenedTodos.invalidateOlderAuthorizationEpochs(channel, epoch) },
      invalidateByOriginSession: (sessionId) => { reopenedTodos.invalidateByOriginSession(sessionId) }
    }, 'reopened-real-todos')
    reopenedRegistry.recoverPendingRevocations()
    const context = { channel: 'feishu' as const, identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1, rule }
    expect(reopenedTodos.claimForDispatch('stale-session-todo', context)).toBeNull()
    expect(reopenedTodos.get('other-session-todo', context)?.status).toBe('pending')
    expect(reopenedRegistry.getAuthorizationEpoch('feishu')).toBe(2)
    reopenedDb.close()
    temp.cleanup()
  })

  it('reopens after epoch advance but before cascade and invalidates both real todo and pending resume request', () => {
    const temp = createTempDatabase('remote-auth-revoke-cascade-reopen-')
    const sessionId = createSession(temp.db, { name: 'revoke-cascade-reopen' }).id
    const todoStore = createDeferredTodoStore(temp.db)
    const rule = { ruleId: 'write', factsHash: 'd'.repeat(64) }
    const todo = todoStore.create({ todoId: 'cascade-todo', invocationId: 'cascade-invocation', channel: 'wechat', identityKey: 'identity',
      ownerId: 'owner', authorizationEpoch: 1, rule, workflowId: 'wf', taskId: 'task', stepId: 'step', planRevision: 1,
      originSessionId: sessionId, createdAt: 1, expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(temp.db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'cascade-checkpoint', workflowRevision: 1 })
    const resume = createDeferredResumeCoordinator({ db: temp.db, todoStore, envelopeStore: createDeferredEnvelopeStore(temp.db), maxParallel: 1,
      recheck: async () => ({ allowed: true }), dispatch: async () => ({ dispatched: true }) })
    resume.requestResume({ requestId: 'cascade-request', todoId: todo.todoId, channel: 'wechat', identityKey: 'identity', ownerId: 'owner',
      authorizationEpoch: 1, rule, notificationVersion: 1, messageId: 'trusted', reasonKey: 'cascade-reason' })
    createRemoteAuthorizationEpochStore(temp.db).advance('wechat', 'remote_disabled')
    temp.db.close()

    const reopenedDb = openDatabase(temp.dbPath)
    const reopenedTodos = createDeferredTodoStore(reopenedDb)
    const reopenedRequests = createDeferredResumeRequestStore(reopenedDb)
    const reopenedRegistry = new RemoteAuthorizationRegistry()
    reopenedRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(reopenedDb))
    reopenedRegistry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: (channel, epoch) => {
        const result = reopenedTodos.invalidateOlderAuthorizationEpochs(channel, epoch)
        if (result.dispatchingTodoIds.length) throw new Error('DISPATCHING_TODO_REQUIRES_RECONCILIATION')
      },
      invalidateResumeRequests: (channel, epoch) => {
        const result = reopenedRequests.invalidateOlderAuthorizationEpochs(channel, epoch)
        if (result.dispatching) throw new Error('DISPATCHING_REQUEST_REQUIRES_RECONCILIATION')
      }
    }, 'reopened-real-resume-cascade')
    expect(() => reopenedRegistry.getAuthorizationEpoch('wechat')).toThrow(/RECOVERY_REQUIRED|DISPATCH_FENCED/)
    reopenedRegistry.recoverPendingRevocations()
    expect(reopenedTodos.get(todo.todoId, { channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1, rule })?.status).toBe('invalidated')
    expect(reopenedRequests.get('cascade-request')?.state).toBe('invalidated')
    expect(reopenedRegistry.getAuthorizationEpoch('wechat')).toBe(2)
    reopenedDb.close()
    temp.cleanup()
  })

  it('keeps the resume dispatch fence closed when session invalidation finds an executing todo', () => {
    const db = createMemoryAppDb()
    const epochStore = createRemoteAuthorizationEpochStore(db)
    const todos = createDeferredTodoStore(db)
    const context = { channel: 'wechat' as const, identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1,
      rule: { ruleId: 'rule', factsHash: 'a'.repeat(64) } }
    todos.create({ ...context, todoId: 'dispatching-session-todo', invocationId: 'dispatching-session-inv', workflowId: 'wf',
      taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: 'deleted-session', createdAt: 1, expiresAt: Date.now() + 60_000 })
    expect(todos.claimForDispatch('dispatching-session-todo', context)).not.toBeNull()
    registry.bindPersistentEpochStore(epochStore)
    registry.registerDeferredTodoInvalidator({
      invalidateByAuthorizationEpoch: (channel, epoch) => { todos.invalidateOlderAuthorizationEpochs(channel, epoch) },
      invalidateByOriginSession: (sessionId) => {
        const result = todos.invalidateByOriginSession(sessionId)
        if (result.dispatchingTodoIds.length) throw new Error('DISPATCH_ALREADY_STARTED')
      }
    }, 'dispatch-race-todos')
    expect(() => registry.invalidateSession('wechat', 'deleted-session')).toThrow('DISPATCH_ALREADY_STARTED')
    expect(() => registry.getGeneration('wechat')).toThrow(/FENCED|RECOVERY_REQUIRED/)
    expect(todos.markConsumed('dispatching-session-todo', context)).toBe(true)
    expect(epochStore.pendingRevocations()).toHaveLength(1)
    db.close()
  })
})
