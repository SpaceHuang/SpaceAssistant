import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createSession } from '../database/operations'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredPolicyReevaluation } from './deferredPolicyReevaluation'

function setup() {
  const temp = createTempDatabase('deferred-policy-reevaluation-')
  const db = temp.db
  commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2',
    snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'policy-reevaluation-seed' })
  const todoStore = createDeferredTodoStore(db)
  const sessionId = createSession(db, { name: 'deferred-policy-reevaluation-session' }).id
  const rule = { ruleId: 'old-ask', factsHash: 'a'.repeat(64) }
  const now = Date.now()
  const todo = todoStore.create({ todoId: 'reeval-todo', invocationId: 'reeval-invocation', channel: 'feishu',
    identityKey: 'reeval-chat', ownerId: 'reeval-owner', authorizationEpoch: 4, rule,
    workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: sessionId,
    createdAt: now, expiresAt: now + 60_000, policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1 }).todo
  const intentStore = createSecurityActionIntentStore(db)
  intentStore.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId,
    sessionId: todo.originSessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
  intentStore.linkTodo(todo.invocationId, todo.todoId)
  intentStore.commitCheckpoint(todo.invocationId, { checkpointId: 'reeval-checkpoint', workflowRevision: 2 })
  const envelopeStore = createDeferredEnvelopeStore(db)
  envelopeStore.put({ invocationId: todo.invocationId, requestId: 'reeval-request', turnId: 'reeval-turn', toolCallId: 'reeval-call',
    toolName: 'write_file', canonicalArgs: { path: 'doc.txt', content: 'safe' }, contentVersions: { taskRevision: 1 },
    executionContext: { toolName: 'write_file', toolInput: { path: 'doc.txt', content: 'safe' }, workflowId: todo.workflowId,
      taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision, messageId: 'source-message',
      ruleId: rule.ruleId, factsHash: rule.factsHash, policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1 } })
  const send = vi.fn().mockResolvedValueOnce({ messageId: 'notice-v1' }).mockResolvedValueOnce({ messageId: 'notice-v2' })
  const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore,
    adapter: { send }, allocateShortCode: vi.fn().mockReturnValueOnce('31').mockReturnValueOnce('32'), audit: vi.fn() })
  return { temp, db, todoStore, todo, envelopeStore, notificationDelivery, send, now, rule }
}

async function invalidate(stores: ReturnType<typeof setup>) {
  await stores.notificationDelivery.createAndSend({ todoId: stores.todo.todoId, invocationId: stores.todo.invocationId,
    channel: 'feishu', identityKey: stores.todo.identityKey, ownerId: stores.todo.ownerId,
    authorizationEpoch: stores.todo.authorizationEpoch, rule: stores.rule, safeActionSummary: '修改文档',
    userDelegation: '请审核', untrustedMaterial: '' })
  commitImPolicySnapshot(getDbConnection(stores.db), { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
    snapshot: { selectedPackage: 'custom', ruleOverrides: { 'mcp-tool-ask': 'ask' } }, updatedAt: stores.now + 1,
    eventId: 'policy-reevaluation-change' })
}

function createReevaluation(stores: ReturnType<typeof setup>, decision: 'allow' | 'ask' | 'deny') {
  const dispatch = vi.fn(async () => ({ dispatched: true }))
  const wake = vi.fn()
  const reevaluation = createDeferredPolicyReevaluation({
    db: stores.db, channel: 'feishu', todoStore: stores.todoStore, envelopeStore: stores.envelopeStore,
    notificationDelivery: stores.notificationDelivery, enabled: () => true, authorizationEpoch: () => 4,
    ownerAuthorized: () => true, recheckTask: () => true, reauthorize: async () => ({ decision,
      rule: { ruleId: decision === 'ask' ? 'new-ask' : `new-${decision}`, factsHash: 'b'.repeat(64) },
      reasonSummary: `new-${decision}` }), recheck: async (_request, todo, envelope) => ({
        allowed: todo.policyRevision === 2 && envelope.executionContext.policyRevision === 2
      }), dispatch, wake, audit: vi.fn()
  })
  return { reevaluation, dispatch, wake }
}

describe('deferred policy re-evaluation', () => {
  it('rebinds an allow to current policy and dispatches the original todo once', async () => {
    const stores = setup()
    await invalidate(stores)
    const { reevaluation, dispatch } = createReevaluation(stores, 'allow')
    await expect(reevaluation.processInvalidated()).resolves.toEqual([{ todoId: stores.todo.todoId, outcome: 'allow' }])
    expect(stores.todoStore.listInvalidatedByPolicyChange('feishu')).toEqual([])
    expect(stores.todoStore.get(stores.todo.todoId, { channel: 'feishu', identityKey: stores.todo.identityKey,
      ownerId: stores.todo.ownerId, authorizationEpoch: 4, originSessionId: stores.todo.originSessionId,
      rule: { ruleId: 'new-allow', factsHash: 'b'.repeat(64) } })).toMatchObject({ status: 'consumed', policyRevision: 2 })
    expect(dispatch).toHaveBeenCalledOnce()
    stores.db.close(); stores.temp.cleanup()
  })

  it('replaces an ask notice and binds it to the fresh rule/version', async () => {
    const stores = setup()
    await invalidate(stores)
    const { reevaluation, dispatch } = createReevaluation(stores, 'ask')
    await expect(reevaluation.processInvalidated()).resolves.toEqual([{ todoId: stores.todo.todoId, outcome: 'ask' }])
    expect(dispatch).not.toHaveBeenCalled()
    expect(stores.notificationDelivery.list(stores.todo.todoId)).toMatchObject([
      { state: 'superseded', notificationVersion: 1 }, { state: 'delivered', notificationVersion: 2,
        rule: { ruleId: 'new-ask', factsHash: 'b'.repeat(64) } }
    ])
    expect(stores.notificationDelivery.resolveCurrent({ channel: 'feishu', identityKey: stores.todo.identityKey,
      ownerId: stores.todo.ownerId, authorizationEpoch: 4, shortCode: '31' })).toBeNull()
    expect(stores.notificationDelivery.resolveCurrent({ channel: 'feishu', identityKey: stores.todo.identityKey,
      ownerId: stores.todo.ownerId, authorizationEpoch: 4, shortCode: '32' })).toMatchObject({ notificationVersion: 2 })
    stores.db.close(); stores.temp.cleanup()
  })

  it('records a deny completion and never calls the dispatcher', async () => {
    const stores = setup()
    await invalidate(stores)
    const { reevaluation, dispatch, wake } = createReevaluation(stores, 'deny')
    await expect(reevaluation.processInvalidated()).resolves.toEqual([{ todoId: stores.todo.todoId, outcome: 'deny' }])
    expect(dispatch).not.toHaveBeenCalled()
    expect(wake).toHaveBeenCalledWith(stores.todo.originSessionId)
    expect(getDbConnection(stores.db).prepare('SELECT state,result_json FROM deferred_execution_results WHERE todo_id=?')
      .get(stores.todo.todoId)).toMatchObject({ state: 'completion_outboxed', result_json: expect.stringContaining('new-deny') })
    expect(stores.todoStore.listInvalidatedByPolicyChange('feishu')).toEqual([])
    stores.db.close(); stores.temp.cleanup()
  })

  it('does not dispatch an allow decision when another policy revision commits during reauthorization', async () => {
    const stores = setup()
    await invalidate(stores)
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const retry = vi.fn()
    const reauthorize = vi.fn(async () => {
      commitImPolicySnapshot(getDbConnection(stores.db), { expectedRevision: 2, policyBehaviorVersion: 'im-standard-v2',
        snapshot: { selectedPackage: 'strict' }, updatedAt: stores.now + 2, eventId: 'policy-reevaluation-race' })
      return { decision: 'allow' as const, rule: { ruleId: 'raced-allow', factsHash: 'c'.repeat(64) } }
    })
    const reevaluation = createDeferredPolicyReevaluation({ db: stores.db, channel: 'feishu', todoStore: stores.todoStore,
      envelopeStore: stores.envelopeStore, notificationDelivery: stores.notificationDelivery, enabled: () => true,
      authorizationEpoch: () => 4, ownerAuthorized: () => true, recheckTask: () => true, reauthorize,
      recheck: async () => ({ allowed: true }), dispatch, maxParallel: 1, scheduleRetry: retry,
      wake: vi.fn(), audit: vi.fn() })
    await expect(reevaluation.processInvalidated()).resolves.toEqual([{ todoId: stores.todo.todoId, outcome: 'stale' }])
    expect(dispatch).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledOnce()
    expect(stores.todoStore.listInvalidatedByPolicyChange('feishu')).toHaveLength(1)
    stores.db.close(); stores.temp.cleanup()
  })
})
