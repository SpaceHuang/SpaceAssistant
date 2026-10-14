import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMemoryAppDb } from '../database/testHelpers'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'
import { appendMessage, createSession } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { serializeQueueScope, buildImQueueScope } from '../../src/shared/queueScope'
import { ensureImTurnTaskControl } from '../database/taskControl'
import { createDeferredTodoCapacityController } from '../confirmation/deferredTodoCapacity'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from './deferredApprovalNotificationDelivery'
import { createImDeferredApprovalProducer, createImDeferredConfirmationAdapter, resolveImTaskDigest } from './imDeferredApprovalProducer'
import { createDeferredImBundleRuntime } from './deferredImBundleRuntime'
import { AgentChannel } from '../confirmation/agentChannel'
import type { RemoteContext } from '../tools/types'
import { assembleInvocation } from '../testSupport/invocationAssembler'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { evaluateToolCallGate } from '../confirmation/toolCallGate'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { TypedToolRegistry, definePlannedTool } from '../tools/plannedToolRegistry'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { setRemoteAsyncApprovalTestModeEnabled } from '../confirmation/remoteAsyncApprovalTestMode'

function seedImPolicy(db: ReturnType<typeof createMemoryAppDb>): void {
  commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'producer-policy-seed' })
}

describe('production IM deferred approval producer', () => {
  afterEach(() => { setRemoteAsyncApprovalTestModeEnabled(false, false) })

  it('reads the authenticated user message from the IM queue scope when resolving task delegation', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-task-digest' }).id
    const userMessageId = 'wechat-scoped-user-message'
    appendMessage(db, { id: userMessageId, sessionId, role: 'user', content: '覆盖 b.txt 为 test', timestamp: Date.now(), status: 'sent' })
    getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
      .run(serializeQueueScope(buildImQueueScope('wechat', sessionId)), userMessageId)

    const storage = createSqliteSessionStorage(db)
    expect(storage.queries.readMessages({ sessionId })).toEqual([])
    expect(resolveImTaskDigest(storage, { source: 'wechat', originSessionId: sessionId, currentUserMessageId: userMessageId } as RemoteContext))
      .toBe('覆盖 b.txt 为 test')
    db.close()
  })

  it('creates a WeChat approval todo when the authenticated user message is stored in the IM queue scope', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'im-task-digest-admission' }).id
    const requestId = 'wechat-task-digest-request'
    const userMessageId = 'wechat-task-digest-user'
    appendMessage(db, { id: userMessageId, sessionId, role: 'user', content: '覆盖 b.txt 为 test', timestamp: Date.now(), status: 'sent' })
    getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
      .run(serializeQueueScope(buildImQueueScope('wechat', sessionId)), userMessageId)
    const storage = createSqliteSessionStorage(db)
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'wechat-owner', requestId, userMessageId })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore,
      adapter: { send: async () => ({ messageId: 'wechat-task-digest-notice' }) }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'wechat', todoStore, capacity, intentStore,
      envelopeStore: createDeferredEnvelopeStore(db), notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 5, resolveTaskDigest: (context) => resolveImTaskDigest(storage, context) })
    const remoteContext: RemoteContext = { source: 'wechat', messageId: 'platform-message', userId: 'wechat-owner', authOwner: 'wechat-owner',
      originSessionId: sessionId, requestId, turnId: 'wechat-task-digest-turn', currentUserMessageId: userMessageId,
      taskBinding: binding.taskBinding, providerRouteId: 'wechat-route', model: 'model', workDirProfileId: 'profile' }
    const call = { invocationId: 'wechat-task-digest-turn', toolCallId: 'wechat-task-digest-call', toolName: 'write_file',
      input: { path: 'b.txt', content: 'test' } }
    const context = { facts: { actionClass: 'write', baseRiskLevel: 'high', summary: { text: '覆盖 b.txt' },
      signals: [{ kind: 'path-target', path: '/workspace/b.txt', zone: 'workdir-normal' }] }, decision: { riskLevel: 'high' as const,
      memoryTiers: [], timeoutMs: null, answerer: 'user' as const, disposition: 'human-required' as const } }

    const result = await producer.defer(call, { kind: 'denied', answerer: 'user', cause: 'human-required' },
      { call, modelTurn: 1, confirmationId: call.toolCallId, answerer: 'user', reasonCode: 'im-write-ask', context }, context,
      { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' }, remoteContext)

    expect(result).toMatchObject({ kind: 'deferred', invocationId: call.invocationId })
    const todoId = (result as { todoId: string }).todoId
    const factsHash = (getDbConnection(db).prepare('SELECT facts_hash FROM deferred_todos WHERE todo_id=?').get(todoId) as { facts_hash: string }).facts_hash
    expect(todoStore.get(todoId, { channel: 'wechat', identityKey: 'wechat-owner', ownerId: 'wechat-owner',
      authorizationEpoch: 5, originSessionId: sessionId, rule: { ruleId: 'im-write-ask', factsHash } }))
      .toMatchObject({ status: 'pending', taskId: binding.taskBinding.taskId })
    expect(notificationDelivery.list(todoId)).toMatchObject([{ state: 'delivered' }])
    expect(notificationDelivery.list(todoId)[0]?.dto.sections).toContainEqual(expect.objectContaining({
      kind: 'user-delegation', text: '覆盖 b.txt 为 test'
    }))
    db.close()
  })

  it('allows a standard-package clean read through the assembled policy and RegisteredTools executor exactly once', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'standard-package-read' }).id
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-standard-read-')
    const { agentSdk } = assembleInvocation({ requestId: 'standard-read-request', turnId: 'standard-read-turn', sessionId, providerRouteId: 'standard-read-route',
      lane: 'feishu', model: 'model', locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      appDb: db, workDir, userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      remoteContext: { source: 'feishu', messageId: 'standard-read-origin', confirmPolicy: 'im_confirm', chatId: 'standard-read-chat',
        userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'standard-read-request', turnId: 'standard-read-turn' } as never })
    const executor = vi.fn(async () => ({ success: true, data: 'read once' }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'read_file', actionClass: 'read', parseInput: (raw) => raw as { path: string },
      plan: async (input) => input, execute: executor }))
    const composed = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['read_file']), hostHistory: new MemoryHistory() })
    const call = { invocationId: 'standard-read-request', toolCallId: 'standard-read-call', toolName: 'read_file', input: { path: 'notes.md' } }
    try {
      await expect(composed.executeDeferred(call, 'test-standard-read')).resolves.toMatchObject({ output: { success: true, data: 'read once' }, isError: false })
      expect(executor).toHaveBeenCalledOnce()
      expect(executor.mock.calls[0]?.[0]).toEqual({ path: 'notes.md' })
      expect(executor.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal), runtimeContext: {
        remoteContext: { source: 'feishu', authOwner: 'owner', chatId: 'standard-read-chat' },
        readExecutionPermit: { decisionRuleId: 'default-read-outbound-allow', toolUseId: 'standard-read-call' }
      } })
    } finally {
      await composed.dispose()
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('terminates malformed tool input during Hosted preparation without todo admission or execution', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'malformed-tool-input' }).id
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-malformed-tool-input-')
    const { agentSdk } = assembleInvocation({ requestId: 'malformed-input-request', turnId: 'malformed-input-turn', sessionId,
      providerRouteId: 'malformed-input-route', lane: 'feishu', model: 'model', locale: 'en-US', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), remoteContext: { source: 'feishu', messageId: 'malformed-origin',
        confirmPolicy: 'im_confirm', chatId: 'malformed-chat', userId: 'owner', authOwner: 'owner' } as never })
    const executor = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: () => { throw new Error('INVALID_WRITE_INPUT') },
      plan: async (input) => input, execute: executor }))
    const hosted = agentSdk.createHostedTurnRuntime({ registry, authorizedToolNames: new Set(['write_file']), hostHistory: new MemoryHistory() })
    try {
      await expect(hosted.executeDeferred({ invocationId: 'malformed-input-request', toolCallId: 'malformed-input-call',
        toolName: 'write_file', input: { path: '../outside', content: 42 } }, 'malformed-input-resume'))
        .rejects.toMatchObject({ name: 'DeferredToolPreDispatchError', cause: expect.objectContaining({ message: 'INVALID_WRITE_INPUT' }) })
      expect(executor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally {
      await hosted.dispose()
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('hard-denies a recursive approval-agent confirmation through the assembled gate before todo admission', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'approval-agent-recursion-guard' }).id
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-recursion-guard-')
    const { agentSdk } = assembleInvocation({ requestId: 'recursion-guard-request', turnId: 'recursion-guard-turn', sessionId,
      lane: 'feishu', model: 'model', locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      workDir, userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(),
      internalConfirmExemption: 'approval-agent', remoteContext: { source: 'feishu', messageId: 'recursion-origin',
        confirmPolicy: 'im_confirm', chatId: 'recursion-chat', userId: 'owner', authOwner: 'owner' } as never })
    const executor = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'read_file', actionClass: 'read', parseInput: (raw) => raw as { path: string },
      plan: async (input) => input, execute: executor }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const call = { invocationId: 'recursion-guard-request', toolCallId: 'recursive-read', toolName: 'read_file', input: { path: '/etc/hosts' } }
    const capabilities = new CapabilityRegistry()
    capabilities.define(call.invocationId, ['read_file'])
    const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    try {
      const binding = await registered.prepareTool(call, { kind: 'initial' })
      const resolved = await agentSdk.resolveGateArgs(binding, call)
      const gateResult = await evaluateToolCallGate(resolved)
      expect(gateResult.decision).toMatchObject({ type: 'deny', ruleId: 'recursion-guard' })
      await expect(gate.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
      expect(executor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally {
      registered.discardPreparedTool(call)
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('hard-denies the critical Wiki raw write through the assembled gate without creating a human todo', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'critical-wiki-raw-deny' }).id
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-critical-wiki-deny-')
    const { agentSdk } = assembleInvocation({ requestId: 'critical-wiki-request', turnId: 'critical-wiki-turn', sessionId,
      lane: 'feishu', model: 'model', locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true }, workDir, userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), remoteContext: { source: 'feishu', messageId: 'critical-wiki-origin',
        confirmPolicy: 'im_confirm', chatId: 'critical-wiki-chat', userId: 'owner', authOwner: 'owner' } as never })
    const executor = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => input, execute: executor }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const call = { invocationId: 'critical-wiki-request', toolCallId: 'critical-wiki-call', toolName: 'write_file',
      input: { path: 'llm-wiki/raw/source.md', content: 'overwrite' } }
    const capabilities = new CapabilityRegistry()
    capabilities.define(call.invocationId, ['write_file'])
    const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    try {
      const binding = await registered.prepareTool(call, { kind: 'initial' })
      const args = await agentSdk.resolveGateArgs(binding, call)
      const decision = await evaluateToolCallGate(args)
      expect(decision).toMatchObject({ decision: { type: 'deny', ruleId: 'wiki-raw-write-deny' }, diagnostics: { denyClass: 'forbidden' },
        facts: { signals: expect.arrayContaining([{ kind: 'wiki-raw-target' }]) } })
      await expect(gate.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
      expect(executor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally {
      registered.discardPreparedTool(call)
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('persists a locked human-required IM invocation without an Agent approval attempt', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'human-required-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-human', userMessageId: 'user-human' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore,
      adapter: { send: async () => ({ messageId: 'human-notice' }) }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore,
      envelopeStore, notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 6, resolveTaskDigest: () => 'Create the requested report.' })
    const remoteContext: RemoteContext = { source: 'feishu', messageId: 'platform-human', confirmPolicy: 'im_confirm', chatId: 'chat-human',
      userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'request-human', turnId: 'turn-human',
      currentUserMessageId: 'user-human', taskBinding: binding.taskBinding, providerRouteId: 'route-human', model: 'model-1', workDirProfileId: 'profile-1' }
    const call = { invocationId: 'turn-human', toolCallId: 'call-human', toolName: 'write_file',
      input: { path: 'report.md', content: 'exact approved content' } }
    const context = { facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'high', signals: [{ kind: 'path-target', path: '/workspace/report.md', zone: 'workdir-normal' }],
      summary: { text: 'Write report.md' } }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null,
      answerer: 'user' as const, disposition: 'human-required' as const }, evidenceReferences: ['host-fact:workspace-file-version-7'] }
    const deferred = await producer.defer(call, { kind: 'denied', answerer: 'user', cause: 'human-required' },
      { call, modelTurn: 1, confirmationId: 'call-human', answerer: 'user', reasonCode: 'locked-confirm-every-time', context },
      context, { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' }, remoteContext)

    expect(deferred).toMatchObject({ kind: 'deferred', invocationId: call.invocationId })
    const storedFactsHash = (getDbConnection(db).prepare('SELECT facts_hash FROM deferred_todos WHERE todo_id=?').get(deferred!.todoId) as { facts_hash: string }).facts_hash
    expect(todoStore.get(deferred!.todoId, { channel: 'feishu', identityKey: 'chat-human', ownerId: 'owner', authorizationEpoch: 6,
      originSessionId: sessionId, rule: { ruleId: 'locked-confirm-every-time', factsHash: storedFactsHash } })).toMatchObject({
        status: 'pending', invocationId: call.invocationId, originSessionId: sessionId
      })
    expect(envelopeStore.get(call.invocationId)).toMatchObject({
      canonicalArgs: call.input,
      contentVersions: { authorizationEpoch: 6, taskRevision: binding.taskBinding.revision, planRevision: binding.taskBinding.planRevision },
      executionContext: {
        channel: 'feishu', sessionId, ownerId: 'owner', identityKey: 'chat-human', authorizationEpoch: 6,
        workflowId: binding.taskBinding.workflowId, taskId: binding.taskBinding.taskId, stepId: binding.taskBinding.stepId,
        policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1,
        ruleId: 'locked-confirm-every-time', factsHash: storedFactsHash,
        evidenceReferences: ['host-fact:workspace-file-version-7'],
        toolInput: call.input, toolCallId: call.toolCallId, invocationId: call.invocationId,
        currentUserMessageId: 'user-human', taskRevision: binding.taskBinding.revision
      }
    })
    expect(notificationDelivery.list(deferred!.todoId)).toMatchObject([{ state: 'delivered', trustedMessageId: 'human-notice' }])
    expect(intentStore.get(call.invocationId)).toMatchObject({ checkpointId: `deferred:${call.invocationId}` })
    db.close()
  })

  it.each([
    { label: 'undetermined', cause: 'agent-undetermined', timeoutMs: null,
      invokeApproval: async () => ({ ok: true, verdict: { kind: 'undetermined', reason: { summary: 'not enough evidence' } } }) },
    { label: 'timeout', cause: 'timeout', timeoutMs: 10,
      invokeApproval: () => new Promise<never>(() => undefined) },
    { label: 'unavailable', cause: 'unavailable', timeoutMs: null,
      invokeApproval: async () => ({ ok: false, cause: 'unavailable' }) }
  ] as const)('persists the exact invocation and safe todo for Agent $label', async (scenario) => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'origin-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-1', userMessageId: 'user-message-1' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const sendNotification = vi.fn(async () => ({ messageId: 'notice-1' }))
    const notificationDelivery = createDeferredApprovalNotificationDelivery({
      db, todoStore, intentStore, adapter: { send: sendNotification }, audit: vi.fn()
    })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 4,
      resolveTaskDigest: () => 'Write the approved project summary.' })
    const remoteContext: RemoteContext = {
      source: 'feishu', messageId: 'platform-message-1', confirmPolicy: 'im_confirm', chatId: 'chat-1', userId: 'owner',
      authOwner: 'owner', originSessionId: sessionId, requestId: 'request-1', turnId: 'turn-1', currentUserMessageId: 'user-message-1',
      taskBinding: binding.taskBinding, providerRouteId: 'anthropic:route-1', model: 'model-1', workDirProfileId: 'profile-1'
    }
    const confirmation = { call: { invocationId: 'turn-1', toolCallId: 'call-1', toolName: 'write_file', input: { path: 'summary.md', content: 'approved' } },
      modelTurn: 1, confirmationId: 'call-1', answerer: 'agent' as const, reasonCode: 'write-rule',
      context: { facts: { actionClass: 'write', baseRiskLevel: 'high', signals: [{ kind: 'path-target', path: '/workspace/summary.md', zone: 'workdir-normal' }], summary: { text: 'Write summary.md' } }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } } }
    const agent = new AgentChannel({ lane: 'feishu', requestId: 'request-1', sessionId, toolName: 'write_file', policy: { kind: 'agent' },
      invokeApproval: scenario.invokeApproval as never })
    const primaryOutcome = await agent.request({ facts: confirmation.context.facts as never, riskLevel: 'high', memoryTiers: [], timeoutMs: scenario.timeoutMs })
    expect(primaryOutcome).toMatchObject({ kind: 'rejected', cause: scenario.cause, answererKind: 'agent' })
    const deferred = await producer.defer(confirmation.call, { kind: 'denied', answerer: 'agent', cause: scenario.cause }, confirmation,
      confirmation.context, primaryOutcome, remoteContext)

    expect(deferred).toMatchObject({ kind: 'deferred', invocationId: 'turn-1', cause: scenario.cause, executionState: 'not-executed',
      checkpointRef: { checkpointId: 'deferred:turn-1' } })
    const factsHash = (getDbConnection(db).prepare('SELECT facts_hash FROM deferred_todos WHERE todo_id=?').get(deferred!.todoId) as { facts_hash: string }).facts_hash
    const todo = todoStore.get(deferred!.todoId, { channel: 'feishu', identityKey: 'chat-1', ownerId: 'owner', authorizationEpoch: 4,
      originSessionId: sessionId, rule: { ruleId: 'write-rule', factsHash } })
    expect(todo).toMatchObject({ status: 'pending', originSessionId: sessionId, taskId: binding.taskBinding.taskId, stepId: 'request' })
    expect(envelopeStore.get('turn-1')).toMatchObject({ requestId: 'request-1', turnId: 'turn-1', toolCallId: 'call-1', canonicalArgs: confirmation.call.input,
      executionContext: { policyBehaviorVersion: 'im-standard-v2', policyRevision: 1, policyEpoch: 1, ruleId: 'write-rule', factsHash } })
    expect(intentStore.authorizeResume('turn-1')).toBe(true)
    expect(notificationDelivery.list(deferred!.todoId)).toMatchObject([{ state: 'delivered', trustedMessageId: 'notice-1' }])
    expect(notificationDelivery.list(deferred!.todoId)[0]?.dto.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'target-summary', text: '工作区内目标' }),
      expect.objectContaining({ kind: 'impact-summary', text: 'write, high impact' }),
      expect.objectContaining({ kind: 'reason-summary', text: 'write-rule' })
    ]))
    const repeated = await producer.defer(confirmation.call, { kind: 'denied', answerer: 'agent', cause: scenario.cause }, confirmation,
      confirmation.context, primaryOutcome, remoteContext)
    expect(repeated).toMatchObject({ kind: 'deferred', todoId: deferred!.todoId })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM deferred_todos WHERE invocation_id=?').get('turn-1'))
      .toEqual({ count: 1 })
    expect(notificationDelivery.list(deferred!.todoId)).toHaveLength(1)
    expect(sendNotification).toHaveBeenCalledOnce()
    const similarCall = { ...confirmation.call, invocationId: 'turn-1-similar', toolCallId: 'call-similar',
      input: { path: 'summary.md', content: 'different content' } }
    const similarConfirmation = { ...confirmation, call: similarCall, confirmationId: similarCall.toolCallId }
    const similarContext = { ...remoteContext, requestId: 'request-similar', turnId: 'turn-1-similar',
      messageId: 'platform-message-similar' }
    const similar = await producer.defer(similarCall, { kind: 'denied', answerer: 'agent', cause: scenario.cause },
      similarConfirmation, confirmation.context, primaryOutcome, similarContext)
    expect(similar).toMatchObject({ kind: 'denied', cause: 'pending-existing', answerer: 'user' })
    expect((similar as { userMessage?: string }).userMessage).toContain('通知短码：01')
    expect((similar as { userMessage?: string }).userMessage).toContain('本次请求未执行')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM deferred_todos WHERE owner_id=?').get('owner')).toEqual({ count: 1 })
    expect(sendNotification).toHaveBeenCalledOnce()
    db.close()
  })

  it('does not tell the user to process a notification whose delivery is unconfirmed', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'unconfirmed-notification-copy' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'copy-request-1', userMessageId: 'copy-user-1' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore,
      adapter: { send: vi.fn().mockRejectedValue(new Error('transport failed')) }, allocateShortCode: () => '07', audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'wechat', todoStore, capacity, intentStore, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 4, resolveTaskDigest: () => 'Update summary.md.' })
    const call = { invocationId: 'copy-turn-1', toolCallId: 'copy-call-1', toolName: 'write_file',
      input: { path: 'summary.md', content: 'first request' } }
    const confirmation = { call, modelTurn: 1, confirmationId: call.toolCallId, answerer: 'agent' as const,
      reasonCode: 'write-rule', context: { facts: { actionClass: 'write', baseRiskLevel: 'high',
        signals: [{ kind: 'path-target', path: '/workspace/summary.md', zone: 'workdir-normal' }], summary: { text: 'Update summary.md' } },
        decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null, disposition: 'human-required' as const } } }
    const remoteContext: RemoteContext = { source: 'wechat', messageId: 'copy-platform-1', userId: 'owner', authOwner: 'owner',
      originSessionId: sessionId, requestId: 'copy-request-1', turnId: 'copy-turn-1', currentUserMessageId: 'copy-user-1',
      taskBinding: binding.taskBinding, providerRouteId: 'wechat-route', model: 'model', workDirProfileId: 'profile' }
    const primaryOutcome = { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' } as const
    const deferred = await producer.defer(call, { kind: 'denied', answerer: 'user', cause: 'human-required' }, confirmation,
      confirmation.context, primaryOutcome, remoteContext)
    expect(deferred).toMatchObject({ kind: 'deferred' })

    const nextCall = { ...call, invocationId: 'copy-turn-2', toolCallId: 'copy-call-2', input: { path: 'summary.md', content: 'second request' } }
    const blocked = await producer.defer(nextCall, { kind: 'denied', answerer: 'user', cause: 'human-required' },
      { ...confirmation, call: nextCall, confirmationId: nextCall.toolCallId }, confirmation.context, primaryOutcome,
      { ...remoteContext, requestId: 'copy-request-2', turnId: 'copy-turn-2', messageId: 'copy-platform-2' })
    expect(blocked).toMatchObject({ kind: 'denied', cause: 'pending-existing', answerer: 'user' })
    const userMessage = (blocked as { userMessage?: string }).userMessage ?? ''
    expect(userMessage).toContain('无法确认原审批通知是否已送达')
    expect(userMessage).toContain('本次请求未执行')
    expect(userMessage).not.toContain('请先处理原审批通知')
    expect(userMessage).not.toContain('通知短码：07')
    expect(notificationDelivery.list(deferred!.todoId)).toMatchObject([{ state: 'undelivered', shortCode: '07' }])
    db.close()
  })

  it('fails closed without the exact authenticated task binding or user delegation', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const producer = createImDeferredApprovalProducer({ db, channel: 'wechat', todoStore, capacity, intentStore,
      envelopeStore: createDeferredEnvelopeStore(db),
      notificationDelivery: { createAndSend: vi.fn() } as never, isEnabled: () => true, getAuthorizationEpoch: () => 1,
      resolveTaskDigest: () => undefined })
    const context = { facts: { actionClass: 'write' }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } }
    await expect(producer.defer({ invocationId: 'i', toolCallId: 'c', toolName: 'write_file', input: {} },
      { kind: 'denied', answerer: 'agent', cause: 'agent-deny' }, { call: {} as never, modelTurn: 1, confirmationId: 'c', answerer: 'agent', reasonCode: 'rule', context },
      context, { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }, { source: 'wechat', authOwner: 'owner' } as RemoteContext))
      .resolves.toBeUndefined()
    expect(todoStore).toBeDefined()
    db.close()
  })

  it('does not silently fall back to a synchronous prompt when enabled human-required deferral lacks authenticated context', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const onFallback = vi.fn()
    const producer = createImDeferredApprovalProducer({ db, channel: 'wechat', todoStore, capacity,
      intentStore: createSecurityActionIntentStore(db), envelopeStore: createDeferredEnvelopeStore(db),
      notificationDelivery: { createAndSend: vi.fn() } as never, isEnabled: () => true,
      getAuthorizationEpoch: () => 1, resolveTaskDigest: () => undefined, onFallback })
    const context = { facts: { actionClass: 'write' }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null,
      answerer: 'user' as const, disposition: 'human-required' as const } }
    await expect(producer.defer({ invocationId: 'missing-material-invocation', toolCallId: 'call', toolName: 'write_file', input: {} },
      { kind: 'denied', answerer: 'user', cause: 'human-required' },
      { call: {} as never, modelTurn: 1, confirmationId: 'call', answerer: 'user', reasonCode: 'im-write-ask', context },
      context, { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' }, { source: 'wechat', authOwner: 'owner' } as RemoteContext))
      .resolves.toMatchObject({ kind: 'unavailable', cause: 'unavailable', userMessage: expect.any(String) })
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining('required-context-missing:'))
    expect(onFallback.mock.calls[0]?.[0]).toContain('taskBinding')
    expect(onFallback.mock.calls[0]?.[0]).toContain('taskDigest')
    expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    db.close()
  })

  it('reports a disabled WeChat runtime instead of falling back when async approval test mode is switched on', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    setRemoteAsyncApprovalTestModeEnabled(true, false)
    const capacity = createDeferredTodoCapacityController(db)
    const onFallback = vi.fn()
    const producer = createImDeferredApprovalProducer({ db, channel: 'wechat', todoStore: createDeferredTodoStore(db, { capacity }), capacity,
      intentStore: createSecurityActionIntentStore(db), envelopeStore: createDeferredEnvelopeStore(db),
      notificationDelivery: { createAndSend: vi.fn() } as never, isEnabled: () => false,
      getAuthorizationEpoch: () => 1, resolveTaskDigest: () => 'Create the requested file.', onFallback })
    const context = { facts: { actionClass: 'write' }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null,
      answerer: 'user' as const, disposition: 'human-required' as const } }
    await expect(producer.defer({ invocationId: 'runtime-disabled-invocation', toolCallId: 'call', toolName: 'write_file', input: {} },
      { kind: 'denied', answerer: 'user', cause: 'human-required' },
      { call: {} as never, modelTurn: 1, confirmationId: 'call', answerer: 'user', reasonCode: 'im-write-ask', context },
      context, { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' }, { source: 'wechat', authOwner: 'owner' } as RemoteContext))
      .resolves.toMatchObject({ kind: 'unavailable', cause: 'unavailable' })
    expect(onFallback).toHaveBeenCalledWith('runtime-disabled')
    expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    db.close()
  })

  it('keeps an explicit Agent deny terminal even with a valid delegated IM task binding', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'agent-deny-terminal' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'agent-deny-request', userMessageId: 'agent-deny-user' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const createAndSend = vi.fn()
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore,
      envelopeStore: createDeferredEnvelopeStore(db), notificationDelivery: { createAndSend } as never,
      isEnabled: () => true, getAuthorizationEpoch: () => 4, resolveTaskDigest: () => 'Write the requested note.' })
    const context: RemoteContext = { source: 'feishu', messageId: 'agent-deny-origin', confirmPolicy: 'im_confirm', chatId: 'agent-deny-chat',
      userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'agent-deny-request', turnId: 'agent-deny-turn',
      currentUserMessageId: 'agent-deny-user', taskBinding: binding.taskBinding, providerRouteId: 'route', model: 'model', workDirProfileId: 'profile' }
    const call = { invocationId: 'agent-deny-turn', toolCallId: 'agent-deny-call', toolName: 'write_file', input: { path: 'note.md', content: 'draft' } }
    const facts = { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'Write note.md' } }
    const confirmation = { call, modelTurn: 1, confirmationId: call.toolCallId, answerer: 'agent' as const, reasonCode: 'im-auto-evaluator',
      context: { facts, decision: { riskLevel: 'medium' as const, memoryTiers: [], timeoutMs: 1000, answerer: 'agent' as const,
        disposition: 'auto-eligible' as const } } }

    await expect(producer.defer(call, { kind: 'denied', answerer: 'agent', cause: 'agent-deny' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'agent-deny', answererKind: 'agent' }, context)).resolves.toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    expect(createAndSend).not.toHaveBeenCalled()
    expect(intentStore.get(call.invocationId)).toBeNull()
    db.close()
  })

  it('preserves an admitted todo after notification failure and retries it on the next authenticated inbound', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'undelivered-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-undelivered', userMessageId: 'user-message' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const send = vi.fn().mockRejectedValueOnce(new Error('temporary channel outage')).mockResolvedValueOnce({ messageId: 'notice-after-retry' })
    const delivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore, adapter: { send }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore,
      envelopeStore: createDeferredEnvelopeStore(db), notificationDelivery: delivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 2, resolveTaskDigest: () => 'Publish the report.' })
    const context: RemoteContext = { source: 'feishu', messageId: 'origin', confirmPolicy: 'im_confirm', chatId: 'chat', userId: 'owner',
      authOwner: 'owner', originSessionId: sessionId, requestId: 'request-undelivered', turnId: 'turn-undelivered', currentUserMessageId: 'user-message',
      taskBinding: binding.taskBinding, providerRouteId: 'route', model: 'model', workDirProfileId: 'profile' }
    const confirmation = { call: { invocationId: 'turn-undelivered', toolCallId: 'call', toolName: 'write_file', input: { path: 'report.md' } },
      modelTurn: 1, confirmationId: 'call', answerer: 'agent' as const, reasonCode: 'write-rule',
      context: { facts: { actionClass: 'write' }, decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null } } }
    const deferred = await producer.defer(confirmation.call, { kind: 'denied', answerer: 'agent', cause: 'agent-undetermined' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'agent-undetermined', answererKind: 'agent' }, context)
    expect(deferred).toMatchObject({ kind: 'deferred', invocationId: 'turn-undelivered' })
    expect(getDbConnection(db).prepare('SELECT state FROM deferred_todos WHERE invocation_id=?').get('turn-undelivered')).toEqual({ state: 'pending' })
    expect(capacity.counts({ identityKey: 'chat' }).identity).toBe(1)
    expect(delivery.list(deferred!.todoId)).toMatchObject([{ state: 'undelivered', trustedMessageId: null }])

    await expect(delivery.retryForAuthenticatedInbound({ channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 2 }))
      .resolves.toMatchObject([{ todoId: deferred!.todoId, state: 'delivered', messageId: 'notice-after-retry' }])
    expect(delivery.resolveCurrent({ channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 2,
      shortCode: delivery.list(deferred!.todoId)[1]!.shortCode })).toMatchObject({ trustedMessageId: 'notice-after-retry' })
    db.close()
  })

  it.each([
    { label: 'sensitive script path', language: 'python', code: 'open("/etc/hosts", "r").read()', ruleId: 'script-system-dir-confirm', mode: 'release-gate' as const },
    { label: 'dynamic execution', language: 'python', code: 'exec("print(1)")', ruleId: 'script-path-unknown-confirm', mode: 'release-gate' as const },
    { label: 'sensitive script path', language: 'python', code: 'open("/etc/hosts", "r").read()', ruleId: 'script-system-dir-confirm', mode: 'development-test' as const },
    { label: 'dynamic execution', language: 'python', code: 'exec("print(1)")', ruleId: 'script-path-unknown-confirm', mode: 'development-test' as const }
  ])('closes the real assembler → human-required producer → trusted reply → fenced dispatcher path for $label ($mode)', async ({ label, language, code, ruleId, mode }) => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    if (mode === 'development-test') setRemoteAsyncApprovalTestModeEnabled(true, false)
    const sessionId = createSession(db, { name: 'e2e-session' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-e2e', userMessageId: 'user-e2e' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intents = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'trusted-e2e' }) }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore: intents, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 3, resolveTaskDigest: () => 'Create the report.' })
    const context: RemoteContext = { source: 'feishu', messageId: 'origin', confirmPolicy: 'im_confirm', chatId: 'chat-e2e', userId: 'owner',
      authOwner: 'owner', originSessionId: sessionId, requestId: 'request-e2e', turnId: 'turn-e2e', currentUserMessageId: 'user-e2e',
      taskBinding: binding.taskBinding, providerRouteId: 'route-e2e', model: 'model', workDirProfileId: 'profile' }
    const { agentSdk } = assembleInvocation({ requestId: 'request-e2e', turnId: 'turn-e2e', sessionId, lane: 'feishu',
      model: 'model', providerRouteId: 'route-e2e', locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db,
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), remoteContext: context })
    const call = { invocationId: 'turn-e2e', toolCallId: 'call-e2e', toolName: 'run_script', input: { language, code } }
    const permitBinding = { requestId: call.invocationId, turnId: call.invocationId, invocationId: call.invocationId,
      toolCallId: call.toolCallId, capabilityId: call.toolName, inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts',
      authorizationVersion: 'auth', phase: 'initial-compat' as const }
    const gate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(permitBinding, call))
    expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId, answerer: 'user', disposition: 'human-required' })
    if (label === 'dynamic execution') {
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution' }))
    } else {
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', zone: 'system-dir' }))
    }
    const confirmationContext = { facts: gate.facts, decision: { riskLevel: gate.decision.type === 'require-confirm' ? gate.decision.riskLevel : 'high',
      memoryTiers: gate.decision.type === 'require-confirm' ? gate.decision.memoryTiers : [],
      timeoutMs: gate.decision.type === 'require-confirm' ? gate.decision.timeoutMs : null,
      answerer: 'user' as const, disposition: 'human-required' as const }, lane: 'feishu' }
    const channelRequest = vi.fn()
    const agentChannelFactory = vi.fn()
    const confirmationPort = agentSdk.createConfirmationPort({ evaluate: vi.fn(), markConfirmed: vi.fn() } as never, {
      cancel: vi.fn(), agentChannelFactory: agentChannelFactory as never,
      createChannel: () => ({ request: channelRequest, cancel: vi.fn() }) as never,
      ...createImDeferredConfirmationAdapter(producer, context)
    })
    const deferred = await confirmationPort({ call, modelTurn: 1, confirmationId: call.toolCallId, answerer: 'user',
      reasonCode: gate.decision.type === 'require-confirm' ? gate.decision.ruleId : 'unexpected', context: confirmationContext })
    expect(deferred).toMatchObject({ kind: 'deferred' })
    const storedPolicyVersion = (getDbConnection(db).prepare('SELECT policy_behavior_version FROM deferred_todos WHERE todo_id=?')
      .get(deferred!.todoId) as { policy_behavior_version: string }).policy_behavior_version
    expect(storedPolicyVersion).toMatch(mode === 'development-test' ? /^im-standard-v2:dev-test:/ : /^im-standard-v2$/)
    expect(channelRequest).not.toHaveBeenCalled()
    expect(agentChannelFactory).not.toHaveBeenCalled()
    expect(envelopeStore.get(call.invocationId)).toMatchObject({ canonicalArgs: call.input,
      executionContext: { ruleId, toolName: 'run_script', toolInput: call.input } })
    const dispatch = vi.fn(async ({ todo, envelope }: { todo: { invocationId: string }; envelope: { requestId: string; canonicalArgs: unknown } }) => {
      expect(todo.invocationId).toBe('turn-e2e')
      expect(envelope.requestId).toBe('request-e2e')
      expect(envelope.canonicalArgs).toEqual(call.input)
      return { dispatched: true }
    })
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 3, maxParallel: 1, isOwnerAuthorized: () => true,
      recheckTask: (todo, envelope) => {
        const row = getDbConnection(db).prepare('SELECT data_json FROM im_task_control WHERE session_id=? AND workflow_id=? AND task_id=?').get(todo.originSessionId, todo.workflowId, todo.taskId) as { data_json: string }
        const taskData = JSON.parse(row.data_json) as { outstandingInvocations: Array<{ invocationId: string; todoId: string; stepId: string }> }
        return envelope.executionContext.workflowId === todo.workflowId && taskData.outstandingInvocations.some((entry) => entry.invocationId === todo.invocationId && entry.todoId === todo.todoId)
      }, dispatch, audit: vi.fn() })
    expect(dispatch).not.toHaveBeenCalled()
    const notification = notificationDelivery.list(deferred!.todoId)[0]!
    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'chat-e2e', ownerId: 'owner', messageId: 'reply-e2e',
      replyToMessageId: notification.trustedMessageId!, text: `批准 ${notification.shortCode}` })).resolves.toMatchObject({ status: 'resume_requested', sessionId, dispatch: [{ status: 'dispatched' }] })
    expect(dispatch).toHaveBeenCalledOnce()
    db.close()
  })

  it('replaces an Agent-approved create candidate with a real human todo when recheck finds an existing target', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'agent-candidate-recheck-session' }).id
    const task = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-agent-recheck', userMessageId: 'user-agent-recheck' })
    if (!task.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intents = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'agent-recheck-notice' }) }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore: intents, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 5, resolveTaskDigest: () => 'Create a project note.' })
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-agent-recheck-')
    const target = `${workDir}/new.md`
    const remoteContext: RemoteContext = { source: 'feishu', messageId: 'platform-agent-recheck', confirmPolicy: 'im_confirm',
      chatId: 'chat-agent-recheck', userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'request-agent-recheck',
      turnId: 'turn-agent-recheck', currentUserMessageId: 'user-agent-recheck', taskBinding: task.taskBinding,
      providerRouteId: 'route-agent-recheck', model: 'model', workDirProfileId: 'profile-agent-recheck' }
    const { agentSdk } = assembleInvocation({ requestId: remoteContext.requestId!, turnId: remoteContext.turnId!, sessionId,
      lane: 'feishu', model: 'model', providerRouteId: 'route-agent-recheck', locale: 'en-US', messages: [],
      toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: '/tmp', getApiKey: async () => 'key',
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), remoteContext })
    const executor = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => input, execute: executor }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const agentReview = vi.fn(async () => {
      await fs.writeFile(target, 'changed during Agent review')
      return { ok: true as const, verdict: { kind: 'approve' as const, reason: { summary: 'ordinary new-file write approved' } } }
    })
    const humanChannelRequest = vi.fn()
    const confirmation = agentSdk.createConfirmationPort(policy, {
      cancel: vi.fn(), createChannel: (requestedCall, requested) => requested.answerer === 'agent'
        ? new AgentChannel({ lane: 'feishu', requestId: remoteContext.requestId!, sessionId, toolName: requestedCall.toolName,
            policy: { kind: 'agent' }, invokeApproval: agentReview })
        : ({ request: humanChannelRequest, cancel: vi.fn() }) as never,
      ...createImDeferredConfirmationAdapter(producer, remoteContext)
    })
    const call = { invocationId: remoteContext.turnId!, toolCallId: 'candidate-write', toolName: 'write_file',
      input: { path: 'new.md', content: 'reviewed content' } }
    const capabilities = new CapabilityRegistry()
    capabilities.define(call.invocationId, ['write_file', 'run_shell'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    try {
      const initialBinding = await registered.prepareTool(call, { kind: 'initial' })
      const diagnosticGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(initialBinding, call))
      expect(diagnosticGate).toMatchObject({ decision: { ruleId: 'im-low-risk-create', answerer: 'agent' }, facts: { signals: expect.arrayContaining([{ kind: 'write-target-new' }]) } })
      const initialDecision = await safetyGate.evaluate(initialBinding)
      expect(initialDecision).toMatchObject({ kind: 'ask', answerer: 'agent', reasonCode: 'im-low-risk-create' })
      if (initialDecision.kind !== 'ask') throw new Error('EXPECTED_AGENT_CANDIDATE')
      const agentOutcome = await confirmation({ call, confirmationId: initialDecision.confirmationId, answerer: initialDecision.answerer,
        reasonCode: initialDecision.reasonCode, context: initialDecision.context })
      expect(agentOutcome).toMatchObject({ kind: 'approved', answerer: 'agent' })
      if (agentOutcome.kind !== 'approved') throw new Error('EXPECTED_AGENT_APPROVAL')

      const recheckBinding = await registered.prepareTool(call, { kind: 'recheck', confirmation: { receipt: agentOutcome.receipt } })
      const humanDecision = await safetyGate.evaluate(recheckBinding)
      expect(humanDecision).toMatchObject({ kind: 'ask', answerer: 'user', reasonCode: 'im-write-ask',
        context: { decision: { disposition: 'human-required' } } })
      if (humanDecision.kind !== 'ask') throw new Error('EXPECTED_FRESH_HUMAN_REQUIRED_DECISION')
      const deferred = await confirmation({ call, confirmationId: humanDecision.confirmationId, answerer: humanDecision.answerer,
        reasonCode: humanDecision.reasonCode, context: humanDecision.context })
      expect(deferred).toMatchObject({ kind: 'deferred', invocationId: call.invocationId, cause: 'human-required', executionState: 'not-executed' })
      if (deferred.kind !== 'deferred') throw new Error('EXPECTED_PERSISTED_HUMAN_TODO')

      const envelope = envelopeStore.get(call.invocationId)
      expect(envelope).toMatchObject({ canonicalArgs: call.input,
        executionContext: { ruleId: 'im-write-ask', toolInput: call.input, taskId: task.taskBinding.taskId } })
      const factsHash = (getDbConnection(db).prepare('SELECT facts_hash FROM deferred_todos WHERE todo_id=?').get(deferred.todoId) as { facts_hash: string }).facts_hash
      expect(todoStore.get(deferred.todoId, { channel: 'feishu', identityKey: 'chat-agent-recheck', ownerId: 'owner', authorizationEpoch: 5,
        originSessionId: sessionId, rule: { ruleId: 'im-write-ask', factsHash } })).toMatchObject({ status: 'pending', originSessionId: sessionId, invocationId: call.invocationId })
      expect(notificationDelivery.list(deferred.todoId)).toMatchObject([{ state: 'delivered', trustedMessageId: 'agent-recheck-notice' }])
      expect(agentReview).toHaveBeenCalledOnce()
      expect(humanChannelRequest).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()

      const dispatch = vi.fn(async ({ todo, envelope: dispatchedEnvelope }: { todo: { invocationId: string }; envelope: { requestId: string; canonicalArgs: unknown } }) => {
        expect(todo.invocationId).toBe(call.invocationId)
        expect(dispatchedEnvelope.requestId).toBe(remoteContext.requestId)
        expect(dispatchedEnvelope.canonicalArgs).toEqual(call.input)
        return { dispatched: true }
      })
      const bundle = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
        getAuthorizationEpoch: () => 5, maxParallel: 1, isOwnerAuthorized: () => true,
        recheckTask: (todo, currentEnvelope) => currentEnvelope.executionContext.workflowId === todo.workflowId &&
          currentEnvelope.executionContext.taskId === todo.taskId && currentEnvelope.executionContext.toolInput !== undefined,
        dispatch, audit: vi.fn() })
      expect(dispatch).not.toHaveBeenCalled()
      const notification = notificationDelivery.list(deferred.todoId)[0]!
      await expect(bundle.handleReply({ channel: 'feishu', identityKey: 'chat-agent-recheck', ownerId: 'owner', messageId: 'reply-agent-recheck',
        replyToMessageId: notification.trustedMessageId!, text: `批准 ${notification.shortCode}` }))
        .resolves.toMatchObject({ status: 'resume_requested', dispatch: [{ status: 'dispatched' }] })
      expect(dispatch).toHaveBeenCalledOnce()
      expect(executor).not.toHaveBeenCalled()
    } finally {
      registered.discardPreparedTool(call)
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('replaces a clean certified script Agent candidate with a human todo when recheck finds its target symlinked to a system file', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'script-candidate-recheck-session' }).id
    const task = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'request-script-recheck', userMessageId: 'user-script-recheck' })
    if (!task.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intents = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'script-recheck-notice' }) }, audit: vi.fn() })
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore: intents, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 8, resolveTaskDigest: () => 'Run the verified report script.' })
    const context: RemoteContext = { source: 'feishu', messageId: 'script-recheck-origin', confirmPolicy: 'im_confirm', chatId: 'script-recheck-chat',
      userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'request-script-recheck', turnId: 'turn-script-recheck',
      currentUserMessageId: 'user-script-recheck', taskBinding: task.taskBinding, providerRouteId: 'route-script-recheck', model: 'model', workDirProfileId: 'profile' }
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-script-recheck-')
    const { agentSdk } = assembleInvocation({ requestId: context.requestId!, turnId: context.turnId!, sessionId, lane: 'feishu',
      model: 'model', providerRouteId: context.providerRouteId!, locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG,
      appDb: db, workDir, userDataDir: '/tmp', getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn(), remoteContext: context })
    const executor = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'run_script', actionClass: 'execute', parseInput: (raw) => raw as { language: string; code: string },
      plan: async (input) => input, execute: executor }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name)
    const agentReview = vi.fn(async () => {
      await fs.symlink('/etc/hosts', `${workDir}/report.txt`)
      return { ok: true as const, verdict: { kind: 'approve' as const, reason: { summary: 'certified clean script approved' } } }
    })
    const humanChannelRequest = vi.fn()
    const confirmation = agentSdk.createConfirmationPort(policy, {
      cancel: vi.fn(), createChannel: (requestedCall, requested) => requested.answerer === 'agent'
        ? new AgentChannel({ lane: 'feishu', requestId: context.requestId!, sessionId, toolName: requestedCall.toolName,
            policy: { kind: 'agent' }, invokeApproval: agentReview })
        : ({ request: humanChannelRequest, cancel: vi.fn() }) as never,
      ...createImDeferredConfirmationAdapter(producer, context)
    })
    const call = { invocationId: context.turnId!, toolCallId: 'script-candidate', toolName: 'run_script',
      input: { language: 'python', code: 'open("report.txt", "r").read()' } }
    const capabilities = new CapabilityRegistry()
    capabilities.define(call.invocationId, ['run_script'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    try {
      const initialBinding = await registered.prepareTool(call, { kind: 'initial' })
      const initialGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(initialBinding, call))
      expect(initialGate).toMatchObject({ decision: { ruleId: 'script-clean-certified-remote', answerer: 'agent' } })
      expect(initialGate.facts.signals).not.toContainEqual({ kind: 'script-uncertified' })
      const initialDecision = await safetyGate.evaluate(initialBinding)
      expect(initialDecision).toMatchObject({ kind: 'ask', answerer: 'agent', reasonCode: 'script-clean-certified-remote' })
      if (initialDecision.kind !== 'ask') throw new Error('EXPECTED_CERTIFIED_SCRIPT_AGENT_CANDIDATE')
      await expect(confirmation({ call, confirmationId: initialDecision.confirmationId, answerer: initialDecision.answerer,
        reasonCode: initialDecision.reasonCode, context: initialDecision.context })).resolves.toMatchObject({ kind: 'approved', answerer: 'agent' })

      const recheckBinding = await registered.prepareTool(call, { kind: 'recheck', confirmation: { receipt: 'script-agent-receipt' } })
      const recheckGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(recheckBinding, call))
      expect(recheckGate).toMatchObject({ decision: { type: 'require-confirm', ruleId: 'script-system-dir-confirm', answerer: 'user' },
        facts: { signals: expect.arrayContaining([expect.objectContaining({ kind: 'path-target', zone: 'system-dir' })]) } })
      const humanDecision = await safetyGate.evaluate(recheckBinding)
      expect(humanDecision).toMatchObject({ kind: 'ask', answerer: 'user', reasonCode: 'script-system-dir-confirm',
        context: { decision: { disposition: 'human-required' } } })
      if (humanDecision.kind !== 'ask') throw new Error('EXPECTED_DYNAMIC_SCRIPT_HUMAN_REQUIRED')
      const deferred = await confirmation({ call, confirmationId: humanDecision.confirmationId, answerer: humanDecision.answerer,
        reasonCode: humanDecision.reasonCode, context: humanDecision.context })
      expect(deferred).toMatchObject({ kind: 'deferred', cause: 'human-required', executionState: 'not-executed' })
      if (deferred.kind !== 'deferred') throw new Error('EXPECTED_PERSISTED_SCRIPT_HUMAN_TODO')
      expect(envelopeStore.get(call.invocationId)).toMatchObject({ canonicalArgs: call.input,
        executionContext: { ruleId: 'script-system-dir-confirm', toolName: 'run_script', toolInput: call.input } })
      expect(notificationDelivery.list(deferred.todoId)).toMatchObject([{ state: 'delivered', trustedMessageId: 'script-recheck-notice' }])
      expect(agentReview).toHaveBeenCalledOnce()
      expect(humanChannelRequest).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()

      const dispatch = vi.fn(async ({ todo, envelope }: { todo: { invocationId: string }; envelope: { requestId: string; canonicalArgs: unknown } }) => {
        expect(todo.invocationId).toBe(call.invocationId)
        expect(envelope.requestId).toBe(context.requestId)
        expect(envelope.canonicalArgs).toEqual(call.input)
        return { dispatched: true }
      })
      const bundle = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
        getAuthorizationEpoch: () => 8, maxParallel: 1, isOwnerAuthorized: () => true,
        recheckTask: (todo, envelope) => envelope.executionContext.workflowId === todo.workflowId && envelope.executionContext.taskId === todo.taskId,
        dispatch, audit: vi.fn() })
      const notification = notificationDelivery.list(deferred.todoId)[0]!
      await expect(bundle.handleReply({ channel: 'feishu', identityKey: 'script-recheck-chat', ownerId: 'owner', messageId: 'script-recheck-reply',
        replyToMessageId: notification.trustedMessageId!, text: `批准 ${notification.shortCode}` }))
        .resolves.toMatchObject({ status: 'resume_requested', dispatch: [{ status: 'dispatched' }] })
      expect(dispatch).toHaveBeenCalledOnce()
      expect(executor).not.toHaveBeenCalled()
    } finally {
      registered.discardPreparedTool(call)
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('hard-denies an outside write and a known-but-unauthorized capability before confirmation or todo admission', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'hard-deny-pre-admission' }).id
    const workDir = await fs.mkdtemp('/private/var/folders/ty/_cyp42ys5m19qj_4_qhvst4m0000gn/T/im-hard-deny-')
    const { agentSdk } = assembleInvocation({ requestId: 'hard-deny-pre-admission', sessionId, lane: 'feishu',
      remoteContext: { source: 'feishu', messageId: 'hard-deny-origin', chatId: 'hard-deny-chat', userId: 'owner' } as never,
      model: 'model', locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: '/tmp',
      feishuConfig: { remoteDenyOutbound: false, larkCliWriteRequiresConfirm: true } as never,
      getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
    const executor = vi.fn(async () => ({ success: true }))
    const shellExecutor = vi.fn(async () => ({ success: true }))
    const larkExecutor = vi.fn(async () => ({ success: true }))
    const registry = new TypedToolRegistry()
    registry.register(definePlannedTool({ name: 'write_file', actionClass: 'write', parseInput: (raw) => raw as { path: string; content: string },
      plan: async (input) => input, execute: executor }))
    registry.register(definePlannedTool({ name: 'run_shell', actionClass: 'execute', parseInput: (raw) => raw as { command: string },
      plan: async (input) => input, execute: shellExecutor }))
    registry.register(definePlannedTool({ name: 'run_lark_cli', actionClass: 'execute', parseInput: (raw) => raw as { args: string[] },
      plan: async (input) => input, execute: larkExecutor }))
    const registered = agentSdk.createRegisteredTools({ registry })
    const policy = agentSdk.createSafetyPolicy(registered, (name) => name, { resolveGateArgs: async (binding, toolCall) => ({
      ...await agentSdk.resolveGateArgs(binding, toolCall),
      feishuConfig: { ...DEFAULT_TOOLS_CONFIG } as never
    }) })
    const call = { invocationId: 'hard-deny-pre-admission', toolCallId: 'outside-write', toolName: 'write_file',
      input: { path: '/etc/spaceassistant-im-policy-denied.txt', content: 'must not be written' } }
    const capabilities = new CapabilityRegistry()
    capabilities.define(call.invocationId, ['write_file', 'run_shell', 'run_lark_cli'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy })
    try {
      const binding = await registered.prepareTool(call, { kind: 'initial' })
      const outsideGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(binding, call))
      expect(outsideGate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-write-deny' })
      expect(outsideGate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', zone: 'system-dir' }))
      await expect(safetyGate.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
      expect(executor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })

      const shellCall = { invocationId: call.invocationId, toolCallId: 'remote-shell', toolName: 'run_shell', input: { command: 'make deploy' } }
      const shellBinding = await registered.prepareTool(shellCall, { kind: 'initial' })
      const shellGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(shellBinding, shellCall))
      expect(shellGate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-shell-disabled' })
      await expect(safetyGate.evaluate(shellBinding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
      expect(shellExecutor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })

      const highImpactCall = { invocationId: call.invocationId, toolCallId: 'lark-high-impact', toolName: 'run_lark_cli',
        input: { args: ['doc', 'delete', '--token', 'secret'] } }
      const highImpactBinding = await registered.prepareTool(highImpactCall, { kind: 'initial' })
      const highImpactGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(highImpactBinding, highImpactCall))
      expect(highImpactGate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'lark-high-impact-ask', answerer: 'user' })
      const highImpactDecision = await safetyGate.evaluate(highImpactBinding)
      expect(highImpactDecision).toMatchObject({ kind: 'ask', answerer: 'user', reasonCode: 'lark-high-impact-ask' })
      expect(larkExecutor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })

      commitImPolicySnapshot(getDbConnection(db), { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
        snapshot: { selectedPackage: 'standard', denyOutbound: true }, updatedAt: 2, eventId: 'hard-deny-outbound-policy' })
      const deniedAssembler = assembleInvocation({ requestId: 'hard-deny-outbound', sessionId, lane: 'feishu',
        remoteContext: { source: 'feishu', messageId: 'hard-deny-origin', chatId: 'hard-deny-chat', userId: 'owner' } as never,
        model: 'model', locale: 'en-US', messages: [], toolsConfig: DEFAULT_TOOLS_CONFIG, appDb: db, workDir, userDataDir: '/tmp',
        feishuConfig: { remoteDenyOutbound: true, larkCliWriteRequiresConfirm: true } as never,
        getApiKey: async () => 'key', emitFactEvent: vi.fn(), emitSessionEvent: vi.fn() })
      const deniedCall = { invocationId: 'lark-policy-denied', toolCallId: 'lark-policy-denied', toolName: 'run_lark_cli',
        input: { args: ['doc', 'delete', '--token', 'secret'] } }
      const deniedBinding = await registered.prepareTool(deniedCall, { kind: 'initial' })
      const deniedArgs = await deniedAssembler.agentSdk.resolveGateArgs(deniedBinding, deniedCall)
      const deniedGate = await evaluateToolCallGate(deniedArgs)
      expect(deniedGate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-deny-lark-write-outbound' })
      const deniedCapabilities = new CapabilityRegistry()
      deniedCapabilities.define(deniedCall.invocationId, ['run_lark_cli'])
      const deniedPolicy = deniedAssembler.agentSdk.createSafetyPolicy(registered, (name) => name)
      const deniedSafetyGate = new SafetyGate({ capabilities: deniedCapabilities, permitStore: new InMemorySafetyPermitStore(), policy: deniedPolicy })
      await expect(deniedSafetyGate.evaluate(deniedBinding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
      expect(larkExecutor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })

      commitImPolicySnapshot(getDbConnection(db), { expectedRevision: 2, policyBehaviorVersion: 'im-standard-v2',
        snapshot: { selectedPackage: 'standard', denyOutbound: false }, updatedAt: 3, eventId: 'hard-deny-outbound-policy-reset' })
      const harmlessCall = { invocationId: call.invocationId, toolCallId: 'lark-harmless', toolName: 'run_lark_cli',
        input: { args: ['api', 'invoke'] } }
      const harmlessBinding = await registered.prepareTool(harmlessCall, { kind: 'initial' })
      const harmlessGate = await evaluateToolCallGate(await agentSdk.resolveGateArgs(harmlessBinding, harmlessCall))
      expect(harmlessGate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'lark-unknown-ask', answerer: 'user' })
      const harmlessDecision = await safetyGate.evaluate(harmlessBinding)
      expect(harmlessDecision).toMatchObject({ kind: 'ask', answerer: 'user', reasonCode: 'lark-unknown-ask' })
      expect(larkExecutor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })

      capabilities.define(call.invocationId, ['write_file'], [])
      await expect(safetyGate.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'UNAUTHORIZED_CAPABILITY' })
      expect(executor).not.toHaveBeenCalled()
      expect(shellExecutor).not.toHaveBeenCalled()
      expect(larkExecutor).not.toHaveBeenCalled()
      expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_todos').get()).toEqual({ count: 0 })
    } finally {
      registered.discardPreparedTool(call)
      db.close()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('invalidates an admitted human-approved invocation when the IM policy version changes before dispatch', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'human-policy-recheck' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'human-policy-request', userMessageId: 'human-policy-user' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intents = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'human-policy-notice' }) }, audit: vi.fn() })
    const context: RemoteContext = { source: 'feishu', messageId: 'human-policy-origin', confirmPolicy: 'im_confirm', chatId: 'human-policy-chat',
      userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'human-policy-request', turnId: 'human-policy-turn',
      currentUserMessageId: 'human-policy-user', taskBinding: binding.taskBinding, providerRouteId: 'route', model: 'model', workDirProfileId: 'profile' }
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore: intents, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 5, resolveTaskDigest: () => 'Write an approved file.' })
    const call = { invocationId: 'human-policy-turn', toolCallId: 'human-policy-call', toolName: 'write_file', input: { path: 'approved.md', content: 'approved' } }
    const confirmation = { call, modelTurn: 1, confirmationId: call.toolCallId, answerer: 'user' as const, reasonCode: 'im-write-ask',
      context: { facts: { actionClass: 'write', baseRiskLevel: 'high', signals: [], summary: { text: 'Write approved.md' } },
        decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null, answerer: 'user' as const, disposition: 'human-required' as const } } }
    const deferred = await producer.defer(call, { kind: 'denied', answerer: 'user', cause: 'human-required' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' }, context)
    expect(deferred).toMatchObject({ kind: 'deferred', cause: 'human-required' })
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 5, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true, dispatch, audit: vi.fn() })
    const notification = notificationDelivery.list(deferred!.todoId)[0]!
    commitImPolicySnapshot(getDbConnection(db), { expectedRevision: 1, policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'strict' }, updatedAt: 2, eventId: 'human-policy-revoked-after-admission' })
    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'human-policy-chat', ownerId: 'owner', messageId: 'human-policy-reply',
      replyToMessageId: notification.trustedMessageId!, text: `批准 ${notification.shortCode}` }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT state FROM deferred_todos WHERE todo_id=?').get(deferred!.todoId)).toMatchObject({ state: 'invalidated' })
    db.close()
  })

  it('rejects a trusted approval reply when the persisted canonical arguments drift from the approved envelope', async () => {
    const db = createMemoryAppDb()
    seedImPolicy(db)
    const sessionId = createSession(db, { name: 'human-args-drift' }).id
    const binding = ensureImTurnTaskControl(db, { sessionId, ownerId: 'owner', requestId: 'args-drift-request', userMessageId: 'args-drift-user' })
    if (!binding.ok) throw new Error('task binding unavailable')
    const capacity = createDeferredTodoCapacityController(db)
    const todoStore = createDeferredTodoStore(db, { capacity })
    const intentStore = createSecurityActionIntentStore(db)
    const envelopeStore = createDeferredEnvelopeStore(db)
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore,
      adapter: { send: async () => ({ messageId: 'args-drift-notice' }) }, audit: vi.fn() })
    const context: RemoteContext = { source: 'feishu', messageId: 'args-drift-origin', confirmPolicy: 'im_confirm', chatId: 'args-drift-chat',
      userId: 'owner', authOwner: 'owner', originSessionId: sessionId, requestId: 'args-drift-request', turnId: 'args-drift-turn',
      currentUserMessageId: 'args-drift-user', taskBinding: binding.taskBinding, providerRouteId: 'route', model: 'model', workDirProfileId: 'profile' }
    const producer = createImDeferredApprovalProducer({ db, channel: 'feishu', todoStore, capacity, intentStore, envelopeStore,
      notificationDelivery, isEnabled: () => true, getAuthorizationEpoch: () => 5, resolveTaskDigest: () => 'Write the approved file.' })
    const call = { invocationId: 'args-drift-turn', toolCallId: 'args-drift-call', toolName: 'write_file', input: { path: 'approved.md', content: 'approved' } }
    const confirmation = { call, modelTurn: 1, confirmationId: call.toolCallId, answerer: 'user' as const, reasonCode: 'im-write-ask',
      context: { facts: { toolName: 'write_file', actionClass: 'write', signals: [{ kind: 'path-target', path: '/workspace/approved.md' }] },
        decision: { riskLevel: 'high' as const, memoryTiers: [], timeoutMs: null, answerer: 'user' as const, disposition: 'human-required' as const } } }
    const deferred = await producer.defer(call, { kind: 'denied', answerer: 'user', cause: 'human-required' }, confirmation,
      confirmation.context, { kind: 'rejected', cause: 'no-answerer', answererKind: 'user' }, context)
    if (deferred?.kind !== 'deferred') throw new Error('EXPECTED_PERSISTED_HUMAN_TODO')
    const notification = notificationDelivery.list(deferred.todoId)[0]!
    const envelope = envelopeStore.get(call.invocationId)!
    const changedEnvelope = { ...envelope, canonicalArgs: { path: '/etc/hosts', content: 'approved' } }
    getDbConnection(db).prepare('UPDATE deferred_call_envelopes SET envelope_json=? WHERE invocation_id=?')
      .run(JSON.stringify(changedEnvelope), call.invocationId)
    const dispatch = vi.fn(async () => ({ dispatched: true }))
    const runtime = createDeferredImBundleRuntime({ db, channel: 'feishu', todoStore, notificationDelivery, isEnabled: () => true,
      getAuthorizationEpoch: () => 5, maxParallel: 1, isOwnerAuthorized: () => true, recheckTask: () => true, dispatch, audit: vi.fn() })

    await expect(runtime.handleReply({ channel: 'feishu', identityKey: 'args-drift-chat', ownerId: 'owner', messageId: 'args-drift-reply',
      replyToMessageId: notification.trustedMessageId!, text: `批准 ${notification.shortCode}` }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(envelope.canonicalArgs).toEqual(call.input)
    expect(dispatch).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT state FROM deferred_todos WHERE todo_id=?').get(deferred.todoId)).toMatchObject({ state: 'invalidated' })
    db.close()
  })
})
