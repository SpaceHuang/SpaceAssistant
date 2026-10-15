import { describe, expect, it, vi } from 'vitest'
import { readFile, readdir, rm } from 'node:fs/promises'
import { SecurityAuditLog } from '../confirmation/securityAuditLog'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createSession } from '../database/operations'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredResumeRequestStore } from '../confirmation/deferredResumeRequestStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredResumeCoordinator } from './deferredResumeCoordinator'
import { createDeferredApprovalCloseCoordinator } from './deferredApprovalCloseCoordinator'
import { createRemoteAuthorizationEpochStore } from './remoteAuthorizationEpochStore'
import { RemoteAuthorizationRegistry } from './remoteAuthorizationRegistry'
import { ConfirmationAuthorizationRegistry, confirmationAuthorizationRegistry } from '../confirmation/confirmationAuthorizationRegistry'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createDeferredImBundleRuntime } from './deferredImBundleRuntime'
import { getDbConnection } from '../database/sqliteStore'
import { restoreImPolicySnapshot } from '../confirmation/imPolicyStore'

function makeRealStores(db: ReturnType<typeof openDatabase>, sessionId: string) {
  const todoStore = createDeferredTodoStore(db)
  const intents = createSecurityActionIntentStore(db)
  const envelopeStore = createDeferredEnvelopeStore(db)
  const requests = createDeferredResumeRequestStore(db)
  const rule = { ruleId: 'write', factsHash: 'f'.repeat(64) }
  const todo = todoStore.create({ todoId: 'close-todo', invocationId: 'close-invocation', channel: 'wechat', identityKey: 'close-identity',
    ownerId: 'close-owner', authorizationEpoch: 4, rule, workflowId: 'close-workflow', taskId: 'close-task', stepId: 'publish',
    planRevision: 2, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
  intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
    workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
  intents.linkTodo(todo.invocationId, todo.todoId)
  intents.commitCheckpoint(todo.invocationId, { checkpointId: 'close-checkpoint', workflowRevision: 1 })
  envelopeStore.put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: { path: 'publish.txt', content: 'approved' },
    contentVersions: { document: 1 }, executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId } })
  const dispatch = vi.fn(async () => ({ dispatched: true }))
  const resume = createDeferredResumeCoordinator({ db, todoStore, envelopeStore, maxParallel: 2,
    recheck: async () => ({ allowed: true }), dispatch })
  return { todoStore, requests, resume, dispatch, todo, rule }
}

describe('real deferred approval close recovery', () => {
  it('wires the production bundle runtime to persist the closure fence, invalidate work, revoke permits, and audit', async () => {
    const temp = createTempDatabase('deferred-close-production-wiring-')
    const sessionId = createSession(temp.db, { name: 'deferred-close-production-wiring' }).id
    const stores = makeRealStores(temp.db, sessionId)
    const scope = { channel: 'wechat' as const, identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, sessionId }
    await stores.resume.requestResume({ requestId: 'production-close-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'notice', reasonKey: 'production-close' })
    const permit = confirmationAuthorizationRegistry.issue({ channel: 'wechat', invocationId: stores.todo.invocationId,
      requestId: 'production-permit', toolUseId: 'production-tool', sessionId, planDigest: 'plan', factsDigest: 'facts', revision: '1' })
    const consumed = confirmationAuthorizationRegistry.consumeForWrite(permit, permit.subject)
    const events: unknown[] = []
    const authorizationRegistry = new RemoteAuthorizationRegistry()
    authorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(temp.db))
    const runtime = createDeferredImBundleRuntime({ db: temp.db, channel: 'wechat', todoStore: stores.todoStore,
      authorizationRegistry,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => authorizationRegistry.getAuthorizationEpoch('wechat'),
      maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch: async () => ({ dispatched: true }), audit: (event) => events.push(event) })

    const closeResult = await runtime.closeCoordinator.close(scope)
    expect(closeResult).toEqual({ status: 'closed' })
    expect(runtime.closeCoordinator.getClosure(scope)?.state).toBe('closed')
    expect(stores.todoStore.get(stores.todo.todoId, { channel: 'wechat', identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId,
      authorizationEpoch: stores.todo.authorizationEpoch, originSessionId: sessionId, rule: stores.rule })?.status).toBe('invalidated')
    expect(stores.requests.get('production-close-request')?.state).toBe('invalidated')
    expect(() => confirmationAuthorizationRegistry.restore(permit, permit.subject, consumed.recovery)).toThrow('MEMORY_WRITE_PERMIT_RECOVERY_INVALID')
    expect(events).toEqual([expect.objectContaining({ event: 'settings.policy-change', reason: 'deferred_approval_close' }),
      expect.objectContaining({ event: 'settings.policy-change', reason: 'deferred_approval_close_complete' })])
    expect(await stores.resume.dispatchPending(sessionId)).toEqual([])
    expect(stores.dispatch).not.toHaveBeenCalled()
    const dispatchOnRecovery = vi.fn(async () => ({ dispatched: true }))
    const recoveryRegistry = new RemoteAuthorizationRegistry()
    recoveryRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(temp.db))
    const interruptedRuntime = createDeferredImBundleRuntime({ db: temp.db, channel: 'wechat', todoStore: stores.todoStore,
      authorizationRegistry: recoveryRegistry,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => recoveryRegistry.getAuthorizationEpoch('wechat'), maxParallel: 1,
      isOwnerAuthorized: () => true, recheckTask: () => true, dispatch: dispatchOnRecovery, audit: vi.fn() })
    await expect(interruptedRuntime.recoverPending()).resolves.toEqual([])
    expect(dispatchOnRecovery).not.toHaveBeenCalled()
    temp.db.close()
    temp.cleanup()
  })

  it('drills rollback with a test-only fake IM transport, temporary DB, and current behavior version', async () => {
    const temp = createTempDatabase('im-security-rollback-drill-')
    const sessionId = createSession(temp.db, { name: 'im-security-rollback-drill' }).id
    const conn = getDbConnection(temp.db)
    const stores = makeRealStores(temp.db, sessionId)
    await expect(stores.resume.requestResume({ requestId: 'drill-resume-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'drill-approved-message', reasonKey: 'rollback-drill' }))
      .resolves.toMatchObject({ status: 'resume_requested' })

    // Fixture only: never registered with production code and never connected to an IM platform.
    const fakeImAdapter = { channelId: 'fake-im', send: vi.fn(async (_message: string) => ({ delivered: true })) }
    stores.dispatch.mockImplementation(async () => {
      await fakeImAdapter.send('deferred reply')
      return { dispatched: true }
    })
    const auditDir = `${temp.dbPath}.audit`
    const audit = new SecurityAuditLog({ logDir: auditDir })
    const permits = new ConfirmationAuthorizationRegistry()
    const permit = permits.issue({ channel: 'wechat', invocationId: stores.todo.invocationId, requestId: 'drill-permit',
      toolUseId: 'drill-tool', sessionId, planDigest: 'drill-plan', factsDigest: 'drill-facts', revision: '1' })
    const consumed = permits.consumeForWrite(permit, permit.subject)
    const scope = { channel: 'wechat' as const, identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, sessionId }
    let blockNewDispatch = false
    let closureSnapshot: { todoStatus: string | undefined; resumeStatus: string | undefined; permitRevoked: boolean } | null = null
    const close = createDeferredApprovalCloseCoordinator({ db: temp.db, port: {
      blockNewDispatch: async () => { blockNewDispatch = true },
      persistClosureFacts: async () => {
        audit.record({ ts: Date.now(), event: 'settings.policy-change', lane: 'wechat', policyDomain: 'im',
          policyBehaviorVersion: 'im-standard-v2', policyRevision: 2, sessionId, before: 'enabled', after: 'disabled',
          reason: 'rollback-drill-close' })
      },
      invalidatePendingTodos: async () => stores.resume.invalidatePendingTodos(scope),
      cancelResumeRequests: async () => stores.resume.cancelPendingResumeRequests(scope),
      revokeConsumedPermits: async () => permits.revokeByChannel('wechat'),
      reconcile: async () => {
        let permitRevoked = false
        try { permits.restore(permit, permit.subject, consumed.recovery) } catch { permitRevoked = true }
        closureSnapshot = {
          todoStatus: stores.todoStore.get(stores.todo.todoId, { channel: 'wechat', identityKey: stores.todo.identityKey,
            ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch, originSessionId: sessionId,
            rule: stores.rule })?.status,
          resumeStatus: stores.requests.get('drill-resume-request')?.state,
          permitRevoked
        }
      },
      rollbackToUser: async () => undefined
    } })

    const closed = await close.close(scope)
    expect(closed.status).toBe('closed')
    expect(closureSnapshot).toMatchObject({ todoStatus: 'invalidated', resumeStatus: 'invalidated', permitRevoked: true })
    expect(blockNewDispatch).toBe(true)
    expect(await stores.resume.dispatchPending(sessionId)).toEqual([])
    expect(stores.dispatch).not.toHaveBeenCalled()
    expect(fakeImAdapter.send).not.toHaveBeenCalled()
    await audit.flush()
    const auditFile = (await readdir(auditDir)).find((name) => name.startsWith('SecurityAudit-'))
    expect(auditFile).toBeTypeOf('string')
    const auditContents = await readFile(`${auditDir}/${auditFile}`, 'utf8')
    expect(auditContents).toContain('rollback-drill-close')
    expect(JSON.parse(auditContents.trim())).toMatchObject({ policyDomain: 'im', policyBehaviorVersion: 'im-standard-v2',
      policyRevision: 2, before: 'enabled', after: 'disabled' })

    const resultStore = createDeferredExecutionResultStore(temp.db)
    resultStore.beginDispatch({ todoId: 'drill-unknown-todo', invocationId: 'drill-unknown-invocation', dispatchKey: 'drill-unknown-dispatch' })
    await expect(resultStore.recover('drill-unknown-dispatch', async () => ({ status: 'unknown' as const })))
      .resolves.toMatchObject({ state: 'outcome_unknown', replayAllowed: false })
    expect(resultStore.beginDispatch({ todoId: 'drill-unknown-todo', invocationId: 'drill-unknown-invocation', dispatchKey: 'drill-unknown-dispatch' }))
      .toMatchObject({ ok: false, reason: 'outcome_unknown' })

    conn.prepare("INSERT INTO policy_behavior_snapshots(domain,policy_behavior_version,revision,snapshot_json,updated_at) VALUES('im','im-standard-v2',2,'{\"selectedPackage\":\"strict\"}',2)").run()
    conn.prepare("INSERT INTO policy_behavior_snapshot_history(history_id,domain,policy_behavior_version,snapshot_json,archived_at) VALUES('im:1','im','im-standard-v2','{\"selectedPackage\":\"standard\"}',1)").run()
    restoreImPolicySnapshot(conn, { historyId: 'im:1', supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'],
      updatedAt: 3, eventId: 'drill-policy-restore' })
    expect(JSON.parse((conn.prepare("SELECT snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get() as { snapshot_json: string }).snapshot_json))
      .toMatchObject({ selectedPackage: 'standard' })
    expect(conn.prepare("SELECT state FROM deferred_todos WHERE todo_id=?").get(stores.todo.todoId)).toEqual({ state: 'invalidated' })
    expect(close.getClosure(scope)?.state).toBe('closed')

    temp.db.close()
    const reopened = openDatabase(temp.dbPath)
    const recovered = createDeferredApprovalCloseCoordinator({ db: reopened, port: {
      blockNewDispatch: async () => undefined, persistClosureFacts: async () => undefined,
      invalidatePendingTodos: async () => ({ invalidatedTodoIds: [], dispatchingTodoIds: [] }),
      cancelResumeRequests: async () => ({ invalidated: 0, dispatching: 0 }), revokeConsumedPermits: async () => undefined,
      reconcile: async () => undefined, rollbackToUser: async () => undefined
    } })
    expect(recovered.getClosure(scope)?.state).toBe('closed')
    reopened.close()
    temp.cleanup()
    await rm(auditDir, { recursive: true, force: true })
  })

  it('invalidates pending todo and resume request, revokes an unfinalized consumed permit, and fences dispatch', async () => {
    const temp = createTempDatabase('deferred-close-real-')
    const sessionId = createSession(temp.db, { name: 'deferred-close-real' }).id
    const stores = makeRealStores(temp.db, sessionId)
    await expect(stores.resume.requestResume({ requestId: 'close-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'notice', reasonKey: 'close-reason' }))
      .resolves.toMatchObject({ status: 'resume_requested' })

    const permits = new ConfirmationAuthorizationRegistry()
    const permit = permits.issue({ channel: 'wechat', invocationId: stores.todo.invocationId, requestId: 'request', toolUseId: 'tool',
      sessionId, planDigest: 'plan', factsDigest: 'facts', revision: '4' })
    const consumed = permits.consumeForWrite(permit, permit.subject)
    const scope = { channel: 'wechat' as const, identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, sessionId }
    const close = createDeferredApprovalCloseCoordinator({ db: temp.db, port: {
      blockNewDispatch: async () => undefined,
      persistClosureFacts: async () => undefined,
      invalidatePendingTodos: async () => stores.resume.invalidatePendingTodos(scope),
      cancelResumeRequests: async () => stores.resume.cancelPendingResumeRequests(scope),
      revokeConsumedPermits: async () => permits.revokeByChannel('wechat'),
      reconcile: async () => {
        expect(stores.todoStore.get(stores.todo.todoId, { channel: 'wechat', identityKey: stores.todo.identityKey,
          ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch, originSessionId: stores.todo.originSessionId,
          rule: stores.rule })?.status).toBe('invalidated')
        expect(stores.resume.getResumeRequest('close-request')?.state).toBe('invalidated')
      },
      rollbackToUser: async () => undefined
    } })
    await expect(close.close(scope)).resolves.toMatchObject({ status: 'closed' })
    expect(stores.dispatch).not.toHaveBeenCalled()
    expect(await stores.resume.dispatchPending(sessionId)).toEqual([])
    expect(() => permits.restore(permit, permit.subject, consumed.recovery)).toThrow('MEMORY_WRITE_PERMIT_RECOVERY_INVALID')
    temp.db.close()
    temp.cleanup()
  })

  it('keeps the durable fence after a crash and reconciles it after reopen before fallback', async () => {
    const temp = createTempDatabase('deferred-close-reopen-')
    const sessionId = createSession(temp.db, { name: 'deferred-close-reopen' }).id
    const stores = makeRealStores(temp.db, sessionId)
    await stores.resume.requestResume({ requestId: 'reopen-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'notice', reasonKey: 'reopen-reason' })
    const scope = { channel: 'wechat' as const, identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, sessionId }
    const failOnce = vi.fn().mockRejectedValueOnce(new Error('crash at reconciliation'))
    const interrupted = createDeferredApprovalCloseCoordinator({ db: temp.db, port: {
      blockNewDispatch: async () => undefined, persistClosureFacts: async () => undefined,
      invalidatePendingTodos: async () => stores.resume.invalidatePendingTodos(scope),
      cancelResumeRequests: async () => stores.resume.cancelPendingResumeRequests(scope),
      revokeConsumedPermits: async () => undefined, reconcile: failOnce, rollbackToUser: async () => undefined
    } })
    await expect(interrupted.close(scope)).resolves.toMatchObject({ status: 'reconciliation_required', failedAt: 'reconcile' })
    expect(interrupted.getClosure(scope)?.state).toBe('reconciliation_required')
    expect(await stores.resume.requestResume({ requestId: 'late-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'notice', reasonKey: 'late-reason' }))
      .toMatchObject({ status: 'invalidated' })
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    const reopenedStores = makeRealStoresForExisting(reopened)
    const portCalls: string[] = []
    const recovered = createDeferredApprovalCloseCoordinator({ db: reopened, port: {
      blockNewDispatch: async () => { portCalls.push('block') }, persistClosureFacts: async () => { portCalls.push('persist') },
      invalidatePendingTodos: async () => { portCalls.push('todos'); return reopenedStores.todoStore.invalidateByScope({ ...scope, originSessionId: sessionId }) },
      cancelResumeRequests: async () => { portCalls.push('requests'); return reopenedStores.requests.invalidateByScope(scope) },
      revokeConsumedPermits: async () => { portCalls.push('permits') },
      reconcile: async () => { portCalls.push('reconcile') }, rollbackToUser: async () => { portCalls.push('fallback') }
    } })
    await expect(recovered.reconcilePending()).resolves.toMatchObject([{ result: { status: 'closed' } }])
    expect(portCalls).toEqual(['block', 'persist', 'todos', 'requests', 'permits', 'reconcile', 'fallback'])
    expect(reopenedStores.requests.get('reopen-request')?.state).toBe('invalidated')
    expect(reopenedStores.resume.getResumeRequest('late-request')).toBeNull()
    expect(recovered.getClosure(scope)?.state).toBe('closed')
    reopened.close()
    temp.cleanup()
  })

  it('uses the shared authority epoch and blocks a pending resume at the real dispatch boundary during close', async () => {
    const temp = createTempDatabase('deferred-close-epoch-race-')
    const sessionId = createSession(temp.db, { name: 'deferred-close-epoch-race' }).id
    const stores = makeRealStores(temp.db, sessionId)
    await stores.resume.requestResume({ requestId: 'epoch-race-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'notice', reasonKey: 'epoch-race-reason' })
    const registry = new RemoteAuthorizationRegistry()
    const epochStore = createRemoteAuthorizationEpochStore(temp.db)
    registry.bindPersistentEpochStore(epochStore)
    const close = createDeferredApprovalCloseCoordinator({ db: temp.db,
      advanceAuthorizationEpoch: (channel, reason) => registry.advanceAuthorizationEpoch(channel, reason), port: {
        blockNewDispatch: async () => undefined, persistClosureFacts: async () => undefined,
        invalidatePendingTodos: async () => stores.resume.invalidatePendingTodos({ channel: 'wechat', identityKey: stores.todo.identityKey,
          ownerId: stores.todo.ownerId, sessionId }),
        cancelResumeRequests: async () => stores.resume.cancelPendingResumeRequests({ channel: 'wechat', identityKey: stores.todo.identityKey,
          ownerId: stores.todo.ownerId, sessionId }),
        revokeConsumedPermits: async () => undefined, reconcile: async () => undefined, rollbackToUser: async () => undefined
      } })
    const scope = { channel: 'wechat' as const, identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, sessionId }
    expect(epochStore.current('wechat')).toBe(1)
    await expect(close.close(scope)).resolves.toMatchObject({ status: 'closed' })
    expect(epochStore.current('wechat')).toBe(2)
    expect(stores.resume.getResumeRequest('epoch-race-request')?.state).toBe('invalidated')
    expect(await stores.resume.dispatchPending(sessionId)).toEqual([])
    expect(stores.dispatch).not.toHaveBeenCalled()
    temp.db.close()
    temp.cleanup()
  })

  it('does not complete close or roll back while the real dispatcher already owns a consumed todo', async () => {
    const temp = createTempDatabase('deferred-close-dispatch-race-')
    const sessionId = createSession(temp.db, { name: 'deferred-close-dispatch-race' }).id
    const stores = makeRealStores(temp.db, sessionId)
    await stores.resume.requestResume({ requestId: 'dispatch-race-request', todoId: stores.todo.todoId, sessionId, channel: 'wechat',
      identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, authorizationEpoch: stores.todo.authorizationEpoch,
      rule: stores.rule, notificationVersion: 1, messageId: 'notice', reasonKey: 'dispatch-race-reason' })
    let releaseDispatch!: (value: { dispatched: boolean }) => void
    stores.dispatch.mockImplementation(() => new Promise((resolve) => { releaseDispatch = resolve }))
    const running = stores.resume.dispatchPending(sessionId)
    await vi.waitFor(() => expect(releaseDispatch).toBeTypeOf('function'))
    const scope = { channel: 'wechat' as const, identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId, sessionId }
    const close = createDeferredApprovalCloseCoordinator({ db: temp.db, port: {
      blockNewDispatch: async () => undefined, persistClosureFacts: async () => undefined,
      invalidatePendingTodos: async () => {
        const result = stores.todoStore.invalidateByScope({ ...scope, originSessionId: sessionId })
        if (result.dispatchingTodoIds.length) throw new Error('DISPATCH_ALREADY_STARTED')
      },
      cancelResumeRequests: async () => {
        const result = stores.requests.invalidateByScope(scope)
        if (result.dispatching) throw new Error('DISPATCH_ALREADY_STARTED')
      },
      revokeConsumedPermits: async () => undefined, reconcile: async () => undefined, rollbackToUser: async () => undefined
    } })
    await expect(close.close(scope)).resolves.toMatchObject({ status: 'reconciliation_required', failedAt: 'cancelResumeRequests' })
    expect(close.getClosure(scope)?.state).toBe('reconciliation_required')
    releaseDispatch({ dispatched: true })
    await expect(running).resolves.toEqual([{ requestId: 'dispatch-race-request', status: 'dispatched' }])
    expect(close.getClosure(scope)?.state).not.toBe('closed')
    temp.db.close()
    temp.cleanup()
  })
})

function makeRealStoresForExisting(db: ReturnType<typeof openDatabase>) {
  const todoStore = createDeferredTodoStore(db)
  const requests = createDeferredResumeRequestStore(db)
  const resume = createDeferredResumeCoordinator({ db, todoStore, envelopeStore: createDeferredEnvelopeStore(db), maxParallel: 2,
    recheck: async () => ({ allowed: true }), dispatch: async () => ({ dispatched: true }) })
  return { todoStore, requests, resume }
}
