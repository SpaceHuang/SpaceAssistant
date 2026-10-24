import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { createMemoryAppDb } from '../database/testHelpers'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'
import { getDbConnection } from '../database/sqliteStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createDeferredImBundleRuntime } from './deferredImBundleRuntime'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createSession } from '../database/operations'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { appendWakeEvent, claimWakeEvents, listWakeEvents } from '../database/wakeEvents'
import { createWakeEventDispatcher } from './wakeEventDispatcher'
import { putTaskControlRecord } from '../database/taskControl'
import { registerPolicyIpc } from '../ipc/policyIpc'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { executeDeferredImTool } from './imDeferredToolExecutor'

describe('deferred IM bundle runtime', () => {
  it.each([
    { channel: 'feishu' as const, policyAction: 'allow' as const, lateAction: undefined, expectedDecision: 'allow', expectedExecutions: 1 },
    { channel: 'feishu' as const, policyAction: 'allow' as const, lateAction: 'deny' as const, expectedDecision: 'allow', expectedExecutions: 0 },
    { channel: 'feishu' as const, policyAction: 'ask' as const, lateAction: undefined, expectedDecision: 'ask', expectedExecutions: 0 },
    { channel: 'feishu' as const, policyAction: 'deny' as const, lateAction: undefined, expectedDecision: 'deny', expectedExecutions: 0 },
    { channel: 'wechat' as const, policyAction: 'allow' as const, lateAction: undefined, expectedDecision: 'allow', expectedExecutions: 1 },
    { channel: 'wechat' as const, policyAction: 'allow' as const, lateAction: 'deny' as const, expectedDecision: 'allow', expectedExecutions: 0 },
    { channel: 'wechat' as const, policyAction: 'ask' as const, lateAction: undefined, expectedDecision: 'ask', expectedExecutions: 0 },
    { channel: 'wechat' as const, policyAction: 'deny' as const, lateAction: undefined, expectedDecision: 'deny', expectedExecutions: 0 }
  ])('re-evaluates persisted $channel envelope through the real gate ($policyAction; late=$lateAction)', async ({ channel, policyAction, lateAction, expectedDecision, expectedExecutions }) => {
    const db = createMemoryAppDb()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deferred-policy-caller-'))
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deferred-policy-caller-userdata-'))
    const sessionStorage = createSqliteSessionStorage(db)
    const sessionId = createSession(db, { name: 'deferred-policy-caller' }).id
    let disposePolicySubscription = () => undefined
    const runtimeProvider = createDesktopAgentRuntime()
    const providerStream = vi.fn(async function* () { yield { type: 'finish' as const, reason: 'stop' as const } })
    runtimeProvider.modelProviders.register({ routeId: 'deferred-policy-caller-model', protocol: 'anthropic-messages',
      dialect: 'test', adapterVersion: '1', modelId: 'model' }, { providerId: 'deferred-policy-caller-provider', stream: providerStream })
    setDefaultAgentRuntime(runtimeProvider)
    const calls: unknown[] = []
    const gateDecisions: unknown[] = []
    const executorErrors: unknown[] = []
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, plan: async (input) => input,
      execute: async (args) => { calls.push(args); return { success: true, path: args.path } } }))
    const now = Date.now()
    try {
      commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2',
        snapshot: { selectedPackage: 'custom' }, updatedAt: now, eventId: 'deferred-policy-caller-seed' })
      const todoStore = createDeferredTodoStore(db)
      const oldRule = { ruleId: 'old-im-write-ask', factsHash: 'a'.repeat(64) }
      const todo = todoStore.create({ todoId: 'deferred-policy-caller-todo', invocationId: 'deferred-policy-caller-invocation',
        channel, identityKey: 'caller-chat', ownerId: 'caller-owner', authorizationEpoch: 7, rule: oldRule,
        workflowId: 'caller-workflow', taskId: 'caller-task', stepId: 'caller-step', planRevision: 1,
        originSessionId: sessionId, createdAt: now, expiresAt: now + 60_000 }).todo
      const intentStore = createSecurityActionIntentStore(db)
      intentStore.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
        workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
      intentStore.linkTodo(todo.invocationId, todo.todoId)
      intentStore.commitCheckpoint(todo.invocationId, { checkpointId: 'deferred-policy-caller-checkpoint', workflowRevision: 1 })
      const envelopeStore = createDeferredEnvelopeStore(db)
      const canonicalArgs = { path: 'created-by-policy-recheck.txt', content: 'original parked operation' }
      envelopeStore.put({ invocationId: todo.invocationId, requestId: 'deferred-policy-caller-request', turnId: 'deferred-policy-caller-turn',
        toolCallId: 'deferred-policy-caller-call', toolName: 'write_file', canonicalArgs, contentVersions: {},
        executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId,
          planRevision: 1, channel, identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 7,
          invocationId: todo.invocationId, toolName: 'write_file', toolInput: structuredClone(canonicalArgs),
          requestId: 'deferred-policy-caller-request', turnId: 'deferred-policy-caller-turn', toolCallId: 'deferred-policy-caller-call',
          providerRouteId: 'deferred-policy-caller-model', messageId: 'original-inbound-message', model: 'model',
          workDirProfileId: 'caller-profile', policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: todo.policyEpoch,
          ruleId: oldRule.ruleId, factsHash: oldRule.factsHash, confirmationReceipt: 'stale-original-receipt' } })
      const send = vi.fn().mockResolvedValue({ messageId: 'caller-notification' })
      const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore,
        adapter: { send }, allocateShortCode: vi.fn().mockReturnValueOnce('71').mockReturnValueOnce('72'), audit: vi.fn() })
      await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId, channel,
        identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 7, rule: oldRule,
        safeActionSummary: '创建文件', userDelegation: '原始待处理调用', untrustedMaterial: '' })

      const runGate = (envelope: ReturnType<typeof envelopeStore.get>, policyOnly: boolean) => {
        if (!envelope) throw new Error('DEFERRED_POLICY_CALLER_ENVELOPE_MISSING')
        const context = envelope.executionContext
        return executeDeferredImTool({ db, sessionStorage, sessionId, requestId: envelope.requestId, turnId: envelope.turnId,
          invocationId: envelope.invocationId, toolCallId: envelope.toolCallId, toolName: envelope.toolName,
          input: envelope.canonicalArgs, ...(policyOnly ? { policyOnly: true } : { confirmationReceipt: context.confirmationReceipt as string }),
          lane: channel, remoteContext: { source: channel, messageId: context.messageId as string,
            chatId: todo.identityKey, userId: todo.ownerId, authOwner: todo.ownerId, originSessionId: sessionId,
            workDirProfileId: 'caller-profile' }, model: 'model', providerRouteId: 'deferred-policy-caller-model',
          toolsConfig: DEFAULT_TOOLS_CONFIG, workDir, userDataDir, getApiKey: async () => null, getBaseUrl: () => 'https://unused.invalid',
          workDirManager: { listProfiles: () => [], getActiveProfileId: () => 'caller-profile', getActiveWorkDir: () => workDir,
            checkDirectoryWritable: () => ({ ok: true }) } as never, registry })
      }
      const handlers = new Map<string, (...args: unknown[]) => unknown>()
      const dispatch = vi.fn(async ({ envelope }) => {
        if (lateAction) await handlers.get('policy:write')!({}, { lane: channel, expectedRevision: 2,
          change: { kind: 'rule-override', ruleId: 'im-low-risk-create', action: lateAction } })
        try {
          const result = await runGate(envelope, false)
          return { dispatched: true, result }
        } catch (error) {
          executorErrors.push(error instanceof Error && 'cause' in error ? error.cause : error)
          return { dispatched: false, failureReason: '真实 executor 未进入' }
        }
      })
      const bundle = createDeferredImBundleRuntime({ db, channel, todoStore, notificationDelivery,
        isEnabled: () => true, getAuthorizationEpoch: () => 7, maxParallel: 1, isOwnerAuthorized: () => true,
        recheckTask: () => true, reauthorizePolicy: async (_todo, envelope) => {
          const result = await runGate(envelope, true) as { decision?: { kind?: string }; policy?: { ruleId: string; factsHash: string } }
          if (!result.decision || !result.policy) throw new Error('DEFERRED_POLICY_CALLER_GATE_RESULT_MISSING')
          gateDecisions.push({ decision: result.decision, policy: result.policy })
          return { decision: result.decision.kind as 'allow' | 'ask' | 'deny', rule: result.policy }
        }, dispatch, audit: vi.fn() })
      disposePolicySubscription = bundle.disposePolicyChangeSubscription

      registerPolicyIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, db)
      await handlers.get('policy:write')!({}, { lane: channel, expectedRevision: 1,
        change: { kind: 'rule-override', ruleId: 'im-low-risk-create', action: policyAction } })
      await vi.waitFor(() => expect(gateDecisions).toHaveLength(1))
      expect(gateDecisions).toMatchObject([{ decision: { kind: expectedDecision } }])
      if (expectedDecision === 'allow') await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      if (expectedExecutions === 1) await vi.waitFor(() => expect(calls).toHaveLength(1))
      if (expectedDecision === 'allow' && lateAction) await vi.waitFor(() => expect(executorErrors).toHaveLength(1))
      if (expectedDecision === 'ask') await vi.waitFor(() => expect(notificationDelivery.list(todo.todoId)).toHaveLength(2))
      if (expectedDecision === 'deny') await vi.waitFor(() => expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)?.state).toBe('completion_outboxed'))

      expect(executorErrors).toHaveLength(expectedDecision === 'allow' && lateAction ? 1 : 0)
      expect(calls).toHaveLength(expectedExecutions)
      if (expectedExecutions === 1) expect(calls).toEqual([canonicalArgs])
      if (expectedDecision !== 'allow') expect(dispatch).not.toHaveBeenCalled()
      expect(providerStream).not.toHaveBeenCalled()
      if (expectedDecision === 'allow') {
        expect(dispatch.mock.calls[0]?.[0].envelope).toMatchObject({ invocationId: todo.invocationId, canonicalArgs })
        expect(todoStore.get(todo.todoId, { channel, identityKey: todo.identityKey, ownerId: todo.ownerId,
          authorizationEpoch: 7, originSessionId: sessionId, rule: dispatch.mock.calls[0]?.[0].todo.rule }))
          .toMatchObject({ status: 'consumed', policyRevision: 2 })
      }
      if (expectedDecision === 'ask') expect(notificationDelivery.list(todo.todoId)).toMatchObject([
        { state: 'superseded', notificationVersion: 1 }, { state: 'delivered', notificationVersion: 2,
          rule: { ruleId: 'im-low-risk-create' } }
      ])
    } finally {
      disposePolicySubscription()
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it.each([
    { decision: 'allow' as const, expected: 'allow', dispatches: 1 },
    { decision: 'ask' as const, expected: 'ask', dispatches: 0 },
    { decision: 'deny' as const, expected: 'deny', dispatches: 0 }
  ])('automatically re-evaluates an invalidated Feishu todo after policy commit: $decision', async ({ decision, expected, dispatches }) => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1,
      eventId: `bundle-reeval-seed-${decision}` })
    const sessionId = createSession(db, { name: `bundle-reeval-${decision}` }).id
    const todoStore = createDeferredTodoStore(db)
    const oldRule = { ruleId: 'old-ask', factsHash: 'a'.repeat(64) }
    const todo = todoStore.create({ todoId: `bundle-reeval-${decision}-todo`, invocationId: `bundle-reeval-${decision}-invocation`, channel: 'feishu',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule: oldRule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1 }).todo
    const intentStore = createSecurityActionIntentStore(db)
    intentStore.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intentStore.linkTodo(todo.invocationId, todo.todoId)
    intentStore.commitCheckpoint(todo.invocationId, { checkpointId: `bundle-reeval-${decision}-checkpoint`, workflowRevision: 1 })
    putTaskControlRecord(db, { sessionId, ownerId: todo.ownerId, workflowId: todo.workflowId, taskId: todo.taskId,
      planRevision: todo.planRevision, expectedRevision: null, data: { steps: [{ stepId: todo.stepId }],
        outstandingInvocations: [{ invocationId: todo.invocationId, todoId: todo.todoId, stepId: todo.stepId }] } })
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, requestId: todo.invocationId, turnId: 'turn', toolCallId: 'tool', toolName: 'write_file',
      canonicalArgs: { path: 'a.txt', content: 'safe' }, contentVersions: {}, executionContext: { sessionId, workflowId: todo.workflowId,
        taskId: todo.taskId, stepId: todo.stepId, planRevision: 1, channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
        authorizationEpoch: 3, invocationId: todo.invocationId, toolName: 'write_file', toolInput: { path: 'a.txt', content: 'safe' },
        requestId: todo.invocationId, turnId: 'turn', toolCallId: 'tool', providerRouteId: 'provider', messageId: 'message', model: 'test',
        workDirProfileId: 'profile', policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1,
        ruleId: oldRule.ruleId, factsHash: oldRule.factsHash, confirmationReceipt: 'old-receipt' } })
    const send = vi.fn().mockResolvedValue({ messageId: 'approval-message' })
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore, adapter: { send },
      allocateShortCode: vi.fn().mockReturnValueOnce('41').mockReturnValueOnce('42'), audit: vi.fn() })
    await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId, channel: 'feishu',
      identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 3, rule: oldRule, safeActionSummary: '修改文件',
      userDelegation: '请审核', untrustedMaterial: '' })
    const dispatch = vi.fn(async () => ({ dispatched: true, result: { ok: true } }))
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      scheduleRetry: vi.fn(),
      reauthorizePolicy: async () => ({ decision, rule: { ruleId: `new-${decision}`, factsHash: 'b'.repeat(64) } }),
      dispatch, audit: vi.fn() })

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerPolicyIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, db)
    await handlers.get('policy:write')!({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'package', package: 'custom' } })
    await vi.waitFor(() => {
      if (decision === 'ask') expect(notificationDelivery.list(todo.todoId)).toHaveLength(2)
      else expect(todoStore.listInvalidatedByPolicyChange('feishu')).toHaveLength(0)
    })
    expect(dispatch).toHaveBeenCalledTimes(dispatches)
    if (decision === 'allow') expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId,
      authorizationEpoch: 3, originSessionId: sessionId, rule: { ruleId: 'new-allow', factsHash: 'b'.repeat(64) } }))
      .toMatchObject({ status: 'consumed', policyRevision: 2 })
    if (decision === 'ask') expect(notificationDelivery.list(todo.todoId)).toMatchObject([
      { state: 'superseded', notificationVersion: 1 }, { state: 'delivered', notificationVersion: 2, rule: { ruleId: 'new-ask' } }
    ])
    if (decision === 'deny') expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toMatchObject({
      state: 'completion_outboxed', result: { kind: 'failed' }
    })
    runtime.disposePolicyChangeSubscription()
    db.close()
  })

  it('composes durable ingress with the production epoch/task dispatch fence', async () => {
    const db = createMemoryAppDb()
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'bundle-policy-seed-1' })
    const todoStore = createDeferredTodoStore(db)
    const notificationDelivery = { resolveCurrent: vi.fn(() => null) } as never
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const runtime = createDeferredImBundleRuntime({
      db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 2, isOwnerAuthorized: () => true,
      recheckTask: () => true, dispatch, audit: vi.fn()
    })
    expect(runtime.resume).toBeDefined()
    expect(runtime.ingress).toBeDefined()
    expect(dispatch).not.toHaveBeenCalled()
    db.close()
  })

  it('persists the executed tool result, completion outbox, and a safety recovery wake', async () => {
    const db = createMemoryAppDb()
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'bundle-policy-seed-2' })
    const sessionId = createSession(db, { name: 'bundle-completion' }).id
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'e'.repeat(64) }
    const todo = todoStore.create({ todoId: 'bundle-result-todo', invocationId: 'bundle-result-invocation', channel: 'feishu',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'bundle-checkpoint', workflowRevision: 1 })
    const envelopes = createDeferredEnvelopeStore(db)
    envelopes.put({ invocationId: todo.invocationId, requestId: 'original-request', turnId: 'turn', toolCallId: 'tool',
      toolName: 'write_file', canonicalArgs: {}, contentVersions: {},
      executionContext: { sessionId, workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId,
        planRevision: 1, channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: 3,
        invocationId: todo.invocationId, toolName: 'write_file', toolInput: {}, requestId: 'original-request', turnId: 'turn',
        toolCallId: 'tool', providerRouteId: 'provider', policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1,
        ruleId: rule.ruleId, factsHash: rule.factsHash } })
    const dispatch = vi.fn(async () => ({ dispatched: true, result: { ok: false, error: 'provider rejected the write' } }))
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn(), onCompletionWake: vi.fn() })
    await runtime.resume.requestResume({ requestId: 'bundle-approval', todoId: todo.todoId, sessionId, channel: 'feishu', identityKey: todo.identityKey,
      ownerId: todo.ownerId, authorizationEpoch: 3, rule, notificationVersion: 1, messageId: 'trusted', reasonKey: 'reply' })
    await expect(runtime.resume.dispatchPending(sessionId)).resolves.toEqual([{ requestId: 'bundle-approval', status: 'dispatched' }])

    expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toMatchObject({ state: 'completion_outboxed',
      result: { kind: 'failed', outputRef: `deferred-result:${todo.invocationId}`, value: { ok: false, error: 'provider rejected the write' } } })
    expect(createDeferredExecutionResultStore(db).listCompletionOutbox(todo.todoId)).toHaveLength(1)
    expect(listWakeEvents(db, sessionId)).toMatchObject([{ type: 'safety-recovery', payloadRef: { kind: 'safety-approval', approvalId: todo.todoId } }])
    const recoveredWake = vi.fn()
    const restarted = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn(), onCompletionWake: recoveredWake })
    await restarted.recoverPending()
    expect(recoveredWake).toHaveBeenCalledWith(sessionId)
    db.close()
  })

  it('keeps an unknown executor outcome consumed and never replays it during recovery', async () => {
    const db = createMemoryAppDb()
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1,
      eventId: 'bundle-policy-unknown' })
    const sessionId = createSession(db, { name: 'bundle-unknown-outcome' }).id
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'c'.repeat(64) }
    const todo = todoStore.create({ todoId: 'unknown-outcome-todo', invocationId: 'unknown-outcome-invocation', channel: 'feishu',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'unknown-checkpoint', workflowRevision: 1 })
    putTaskControlRecord(db, { sessionId, ownerId: todo.ownerId, workflowId: todo.workflowId, taskId: todo.taskId,
      planRevision: todo.planRevision, expectedRevision: null, data: { steps: [{ stepId: todo.stepId }],
        outstandingInvocations: [{ invocationId: todo.invocationId, todoId: todo.todoId, stepId: todo.stepId }] } })
    createDeferredEnvelopeStore(db).put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: {}, contentVersions: {},
      executionContext: { channel: 'feishu', sessionId, ownerId: todo.ownerId, identityKey: todo.identityKey, authorizationEpoch: 3,
        invocationId: todo.invocationId, toolName: 'write_file', toolInput: {}, requestId: todo.invocationId, turnId: todo.invocationId,
        toolCallId: todo.invocationId, providerRouteId: 'unknown-provider', workflowId: todo.workflowId, taskId: todo.taskId,
        stepId: todo.stepId, planRevision: todo.planRevision, policyBehaviorVersion: todo.policyBehaviorVersion,
        policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch, ruleId: rule.ruleId, factsHash: rule.factsHash } })
    const dispatch = vi.fn(async () => { throw new Error('executor entered, outcome not reported') })
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn() })
    await runtime.resume.requestResume({ requestId: 'unknown-request', todoId: todo.todoId, sessionId, channel: 'feishu', identityKey: todo.identityKey,
      ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule, notificationVersion: 1, messageId: 'trusted', reasonKey: 'reply' })
    await expect(runtime.resume.dispatchPending(sessionId)).resolves.toEqual([{ requestId: 'unknown-request', status: 'outcome_unknown' }])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toMatchObject({ state: 'outcome_unknown' })

    const restarted = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn() })
    await expect(restarted.recoverPending()).resolves.toEqual([])
    await expect(restarted.resume.dispatchPending(sessionId)).resolves.toEqual([])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(restarted.resume.getResumeRequest('unknown-request')?.state).toBe('outcome_unknown')
    db.close()
  })

  it('records a pre-dispatch rejection as a failed result and wakes the user instead of marking outcome unknown', async () => {
    const db = createMemoryAppDb()
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1,
      eventId: 'bundle-policy-not-dispatched' })
    const sessionId = createSession(db, { name: 'bundle-not-dispatched' }).id
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'f'.repeat(64) }
    const todo = todoStore.create({ todoId: 'not-dispatched-todo', invocationId: 'not-dispatched-invocation', channel: 'feishu',
      identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
      planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'not-dispatched-checkpoint', workflowRevision: 1 })
    putTaskControlRecord(db, { sessionId, ownerId: todo.ownerId, workflowId: todo.workflowId, taskId: todo.taskId,
      planRevision: todo.planRevision, expectedRevision: null, data: { steps: [{ stepId: todo.stepId }],
        outstandingInvocations: [{ invocationId: todo.invocationId, todoId: todo.todoId, stepId: todo.stepId }] } })
    createDeferredEnvelopeStore(db).put({ invocationId: todo.invocationId, toolName: 'write_file', canonicalArgs: {}, contentVersions: {},
      executionContext: { channel: 'feishu', sessionId, ownerId: todo.ownerId, identityKey: todo.identityKey, authorizationEpoch: 3,
        invocationId: todo.invocationId, toolName: 'write_file', toolInput: {}, requestId: todo.invocationId, turnId: todo.invocationId,
        toolCallId: todo.invocationId, providerRouteId: 'known-provider', workflowId: todo.workflowId, taskId: todo.taskId,
        stepId: todo.stepId, planRevision: todo.planRevision, policyBehaviorVersion: todo.policyBehaviorVersion,
        policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch, ruleId: rule.ruleId, factsHash: rule.factsHash } })
    const dispatch = vi.fn(async () => ({ dispatched: false, failureReason: 'approved work directory is unavailable' }))
    const onCompletionWake = vi.fn()
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
      notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true,
      dispatch, audit: vi.fn(), onCompletionWake })
    await runtime.resume.requestResume({ requestId: 'not-dispatched-request', todoId: todo.todoId, sessionId, channel: 'feishu',
      identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule,
      notificationVersion: 1, messageId: 'trusted', reasonKey: 'reply' })
    await expect(runtime.resume.dispatchPending(sessionId)).resolves.toEqual([{ requestId: 'not-dispatched-request', status: 'dispatched' }])
    expect(createDeferredExecutionResultStore(db).getByTodo(todo.todoId)).toMatchObject({
      state: 'completion_outboxed', result: { kind: 'failed', value: { success: false, error: 'approved work directory is unavailable' } }
    })
    expect(createDeferredExecutionResultStore(db).listCompletionOutbox(todo.todoId)).toHaveLength(1)
    expect(onCompletionWake).toHaveBeenCalledWith(sessionId)
    expect(runtime.resume.getResumeRequest('not-dispatched-request')?.state).toBe('completed')
    db.close()
  })

  it('retries a claimed completion wake automatically when its lease expires after restart', async () => {
    vi.useFakeTimers()
    try {
      const db = createMemoryAppDb()
      commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'bundle-policy-seed-3' })
      const sessionId = createSession(db, { name: 'bundle-claimed-recovery' }).id
      const todoStore = createDeferredTodoStore(db)
      const rule = { ruleId: 'write', factsHash: '9'.repeat(64) }
      const todo = todoStore.create({ todoId: 'claimed-recovery-todo', invocationId: 'claimed-recovery-invocation', channel: 'feishu',
        identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 3, rule, workflowId: 'workflow', taskId: 'task', stepId: 'step',
        planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
      const intents = createSecurityActionIntentStore(db)
      intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
        workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
      intents.linkTodo(todo.invocationId, todo.todoId)
      intents.commitCheckpoint(todo.invocationId, { checkpointId: 'claimed-checkpoint', workflowRevision: 1 })
      const envelopes = createDeferredEnvelopeStore(db)
      envelopes.put({ invocationId: todo.invocationId, requestId: 'claimed-source-request', turnId: 'claimed-source-turn', toolCallId: 'claimed-tool',
        toolName: 'write_file', canonicalArgs: {}, contentVersions: {}, executionContext: { sessionId } })
      const dispatch = vi.fn(async () => ({ dispatched: true, result: { ok: true } }))
      const onCompletionWake = vi.fn()
      const dispatcher = createWakeEventDispatcher({ db, maxParallel: 1, scheduleRetry: (delay, callback) => setTimeout(callback, delay), launchLoop: async ({ events }) => {
        expect(events).toHaveLength(1)
        onCompletionWake(sessionId)
      } })
      const firstRuntime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
        notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true, getAuthorizationEpoch: () => 3,
        maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true, dispatch, audit: vi.fn(), onCompletionWake })
      await firstRuntime.resume.requestResume({ requestId: 'claimed-approval', todoId: todo.todoId, sessionId, channel: 'feishu', identityKey: todo.identityKey,
        ownerId: todo.ownerId, authorizationEpoch: 3, rule, notificationVersion: 1, messageId: 'trusted', reasonKey: 'reply' })
      await firstRuntime.resume.dispatchPending(sessionId)
      // commitResult already persists the durable completion wake. Re-append would
      // create a second recovery event and test duplicate work rather than restart recovery.
      createDeferredExecutionResultStore(db).beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey: 'claimed-dispatch' })
      createDeferredExecutionResultStore(db).commitResult(todo.todoId, { kind: 'completed', outputRef: `deferred-result:${todo.invocationId}`, value: { ok: true } })
      claimWakeEvents(db, { sessionId, runId: 'dead-run', ownerId: 'dead-owner', now: Date.now() })
      expect(listWakeEvents(db, sessionId)[0]).toMatchObject({ status: 'claimed' })

      let restartedDispatcher = dispatcher
      const restarted = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore,
        notificationDelivery: { resolveCurrent: vi.fn(() => null) } as never, isEnabled: () => true, getAuthorizationEpoch: () => 3,
        maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true, dispatch, audit: vi.fn(), onCompletionWake,
        recoverCompletionWake: (session) => restartedDispatcher.dispatchSession(session),
        scheduleRetry: (delay, callback) => { setTimeout(callback, delay) } })
      await restarted.recoverPending()
      restartedDispatcher = createWakeEventDispatcher({ db, maxParallel: 1, clock: { now: () => Date.now() },
        launchLoop: async ({ events }) => { onCompletionWake(sessionId) } })
      // The first completion invokes the live wake callback. From this point the
      // assertion tracks only the restarted runtime's retry after the lease expires.
      onCompletionWake.mockClear()
      expect(onCompletionWake).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(30_001)
      await vi.advanceTimersByTimeAsync(1)

      expect(onCompletionWake).toHaveBeenCalledTimes(1)
      expect(onCompletionWake).toHaveBeenCalledWith(sessionId)
      expect(listWakeEvents(db, sessionId)[0]?.status).toBe('acked')
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
