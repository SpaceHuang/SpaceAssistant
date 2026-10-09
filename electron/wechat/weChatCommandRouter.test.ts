import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { AppDatabase } from '../database'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { WeChatCommandRouter, dispatchWeChatSdkInbound } from './weChatCommandRouter'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import { WeChatProcessedStore } from './weChatProcessedStore'
import { WeChatAuditLogger } from './weChatAuditLogger'
import { WeChatImChannel } from './weChatImChannel'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import { openDatabase, createSession, getConfigValue, setConfigValue, getPersistedTurn, getSession, getTurnByRequestId, appendMessage as mockedAppendMessage } from '../database'
import { appendMessage as appendMessageOperation } from '../database/operations'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { TurnRuntime } from '../turnRuntime'
import {
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession,
  releaseRemoteSession
} from '../remote/remoteAgentRegistry'
import { REMOTE_SESSION_BUSY_MESSAGE } from '../remote/remoteSessionGuardMessages'
import { listQueuedUserMessages } from '../database/operations'
import { listWakeEvents } from '../database/wakeEvents'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { getDbConnection } from '../database/sqliteStore'
import { appendImInboxMessageWithWakeEvent, listImInboxMessages } from '../database/imInbox'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from '../remote/deferredApprovalNotificationDelivery'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext } from '../database/acceptedTurnStorage'

vi.mock('../secureApiKey', () => ({ isSecretStorageAvailable: vi.fn(() => true), encryptSecret: (value: string) => `enc:${value}`, decryptSecret: (value: string) => value.replace(/^enc:/, '') }))

const mockRunAgent = vi.fn()
const mockResolveSession = vi.fn()
const mockConsumeForRequest = vi.fn()

const testTurnRuntime = {
  bindRequest: vi.fn(),
  unbindRequest: vi.fn(),
  prepare: vi.fn((intent: { requestId: string; sessionId: string }) => ({
    turnId: 'turn-test',
    requestId: intent.requestId,
    sessionId: intent.sessionId,
    userMessage: { id: 'user-test' },
    assistantMessage: { id: 'assistant-test' },
    version: 0,
    startToken: 'token-test'
  })),
  executeWithSource: vi.fn(async (_turnId: string, _token: string, source: (a: unknown, b: string) => Promise<unknown>) => source({}, 'token-test')),
  consumeForRequest: mockConsumeForRequest
} as unknown as TurnRuntime

vi.mock('./weChatRemoteAgent', () => ({
  runWeChatRemoteAgent: (...args: unknown[]) => mockRunAgent(...args)
}))

vi.mock('./weChatSessionResolver', () => ({
  resolveWeChatSession: (...args: unknown[]) => mockResolveSession(...args)
}))

vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>()
  return {
    ...actual,
    appendMessage: vi.fn(),
    updateMessageContent: vi.fn()
  }
})

const TEST_MODEL_NAME = 'm1'
const TEST_SERVICE_ID = 'svc-test'

/**
 * 可信 turn 快照会真的解析「会话模型 → 活跃服务 → Key」。不 seed 一份可用配置，
 * router 会在 prepare 阶段被模型解析 fail-fast 拦下，这些用例就测不到编排本身了。
 */
function seedLlmConfig(db: ReturnType<typeof openDatabase>, modelName = TEST_MODEL_NAME): void {
  setConfigValue(db, 'config.defaultModel', modelName)
  setConfigValue(
    db,
    'config.models',
    JSON.stringify([
      {
        id: modelName,
        name: modelName,
        maximumContext: 200000,
        maxTokens: 64000,
        isDefault: true,
        isFast: false,
        isVision: false,
        enabled: true
      }
    ])
  )
  setConfigValue(
    db,
    'config.llmServices',
    JSON.stringify([
      {
        id: TEST_SERVICE_ID,
        name: 'Test Service',
        baseUrl: 'https://api.example.com',
        supportedModelIds: [modelName],
        createdAt: '1',
        updatedAt: '1'
      }
    ])
  )
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([TEST_SERVICE_ID]))
  setConfigValue(db, 'config.preferredLanguageModelId', modelName)
  setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [TEST_SERVICE_ID]: 'enc:sk-test' }))
}

describe('WeChatCommandRouter', () => {
  let tmpDir: string
  let processed: WeChatProcessedStore
  let audit: WeChatAuditLogger
  let reply: ReturnType<typeof vi.fn>
  let router: WeChatCommandRouter
  let db: ReturnType<typeof openDatabase>
  let sessionId: string
  let closeDb: () => void

  function makeRouter(wakeDispatcher?: { dispatchSession: (sessionId: string) => Promise<void> }, handleDeferredApprovalReply?: (input: { message: import('../../src/shared/wechatTypes').WeChatInboundMessage; text: string }) => Promise<void>, approvalGate?: boolean, retryDeferredApprovalNotifications?: (scope: { identityKey: string; ownerId: string }) => Promise<unknown>): WeChatCommandRouter {
    const mockWorkDirManager = {
      listProfiles: () => [],
      getActiveProfileId: () => 'p1',
      getActiveWorkDir: () => tmpDir,
      checkDirectoryWritable: () => ({ ok: true })
    }
    return new WeChatCommandRouter({
      db,
      sessionStorage: createSqliteSessionStorage(db),
      turnRuntime: testTurnRuntime,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      imChannel: new WeChatImChannel(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['wx-user@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: mockWorkDirManager as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never,
      getModel: () => 'm1',
      getToolsConfig: () => ({ deniedTools: [] }) as never,
      wakeEventDispatcher: wakeDispatcher,
      handleDeferredApprovalReply,
      retryDeferredApprovalNotifications,
      isRemoteAsyncApprovalEnabled: () => approvalGate ?? true
    } as never)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    resetRunningRemoteAgentRegistryForTests()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-router-'))
    processed = new WeChatProcessedStore(tmpDir)
    audit = new WeChatAuditLogger(tmpDir)
    reply = vi.fn(async () => undefined)
    mockRunAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const dbPath = path.join(tmpDir, 'test.db')
    db = openDatabase(dbPath)
    seedLlmConfig(db)
    closeDb = () => db.close()
    const session = createSession(db, { name: 'WeChat Session' })
    sessionId = session.id
    mockResolveSession.mockResolvedValue({ sessionId, isNew: true })

    router = makeRouter()
  })

  afterEach(() => {
    mockedAppendMessage.mockReset()
    resetRunningRemoteAgentRegistryForTests()
    closeDb?.()
    if (tmpDir && fsSync.existsSync(tmpDir)) {
      fsSync.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('processes accepted text inbound', async () => {
    const raw = makeIncomingMessage({ text: 'list files' })
    await router.handleSdkInbound(raw)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(mockRunAgent).toHaveBeenCalledWith(expect.objectContaining({
      acceptedTurn: expect.objectContaining({ turnId: 'turn-test', lane: 'wechat', currentUserMessageId: 'user-test' })
    }))
    expect(reply).toHaveBeenCalled()
  })

  it('recovers a persisted WeChat inbox wake event through the original turn execution path', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'context-replay' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const persisted = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'replay-wechat-1', content: '重启后恢复的消息', contextToken: 'context-replay' })
    const secondPersisted = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'replay-wechat-2', content: '第二条恢复消息', contextToken: 'context-replay-2' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `wake-wechat-${++turnSequence}` } })
    const createDeferredConfirmationAdapter = vi.fn(() => ({ defer: vi.fn() }))
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    ;(router as unknown as { deps: { createDeferredConfirmationAdapter?: typeof createDeferredConfirmationAdapter } }).deps.createDeferredConfirmationAdapter = createDeferredConfirmationAdapter
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })
    await dispatcher.dispatchSession(sessionId)
    expect(mockRunAgent).toHaveBeenCalledTimes(2)
    expect(mockRunAgent.mock.calls[0]?.[0]).toMatchObject({ userMessage: '重启后恢复的消息', userId: 'wx-user@test' })
    const firstWakeArgs = mockRunAgent.mock.calls[0]?.[0] as { replyMessageId: string; remoteContext: { contextToken: string; turnId?: string } }
    expect(firstWakeArgs.replyMessageId).toBe('replay-wechat-1')
    expect(firstWakeArgs.remoteContext.contextToken).toBe('context-replay')
    expect(firstWakeArgs.remoteContext.turnId).toBe('wake-wechat-1')
    expect(createDeferredConfirmationAdapter).toHaveBeenCalledTimes(2)
    expect(mockRunAgent.mock.calls[1]?.[0]).toMatchObject({ userMessage: '第二条恢复消息', replyMessageId: 'replay-wechat-2', remoteContext: { contextToken: 'context-replay-2' } })
    expect(listWakeEvents(db, sessionId).map(({ type, status }) => ({ type, status }))).toEqual([
      { type: 'im-inbound', status: 'acked' }, { type: 'im-inbound', status: 'acked' }
    ])
    expect(getTurnByRequestId(db, sessionId, `wake:${persisted.eventId}`)).toMatchObject({ requestId: `wake:${persisted.eventId}`, userMessageId: persisted.messageId, outcome: 'completed' })
    await dispatcher.dispose()
  })

  it('acks a WeChat inbox wake when the remote turn parks for deferred approval', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'parked-context' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const persisted = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'parked-wechat-message', content: '发送并等待审批', contextToken: 'parked-context' })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `parked-wechat-${++sequence}` } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    mockRunAgent.mockResolvedValue({ summary: '', pendingConfirm: true, parked: true, ok: true })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId)

    expect(getTurnByRequestId(db, sessionId, `wake:${persisted.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'parked' })
    expect(listWakeEvents(db, sessionId)).toMatchObject([{ eventId: persisted.eventId, status: 'acked' }])
    expect(getDbConnection(db).prepare('SELECT state FROM im_inbox_claims WHERE message_id=?').get(persisted.messageId)).toEqual({ state: 'acked' })
    expect(reply).not.toHaveBeenCalled()
    await dispatcher.dispose()
  })

  it('consumes a persisted deferred completion wake and resumes the original WeChat task turn', async () => {
    mockedAppendMessage.mockImplementation((_db, message) => appendMessageOperation(db, message as never))
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'completion-context' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const scope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const persisted = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope: scope,
      channelMessageId: 'wechat-completion-source', contextToken: 'completion-context', content: '发送确认后的报告' })
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: 'a'.repeat(64) }
    const todo = todoStore.create({ todoId: 'wechat-completion-todo', invocationId: 'wechat-completion-invocation', channel: 'wechat',
      identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 1, rule, workflowId: 'workflow', taskId: 'task', stepId: 'publish',
      planRevision: 1, originSessionId: sessionId, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'wechat-completion-checkpoint', workflowRevision: 1 })
    createDeferredEnvelopeStore(db).put({ invocationId: todo.invocationId, requestId: 'wechat-source-request', turnId: 'source-turn',
      toolCallId: 'source-tool', toolName: 'send_message', canonicalArgs: {}, contentVersions: {}, executionContext: {
        currentUserMessageId: persisted.messageId, messageId: 'wechat-completion-source', contextToken: 'completion-context'
      } })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'source-turn', requestId: 'wechat-source-request', sessionId, lane: 'wechat',
      startToken: 'source-start', currentUserMessageId: persisted.messageId, transcriptVersion: 0,
      config: { lane: 'wechat', model: TEST_MODEL_NAME, llmServiceId: TEST_SERVICE_ID, thinkingEffort: 'low' } }))
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `wechat-completion-${++turnSequence}` } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })
    mockRunAgent.mockImplementationOnce(async () => {
      const models = JSON.parse(getConfigValue(db, 'config.models') ?? '[]') as Array<Record<string, unknown>>
      models.push({ id: 'alternate-model', name: 'deepseek-flash', enabled: true, supportsThinking: true })
      setConfigValue(db, 'config.models', JSON.stringify(models))
      const services = JSON.parse(getConfigValue(db, 'config.llmServices') ?? '[]') as Array<Record<string, unknown>>
      services.push({ id: 'alternate-service', name: 'Alternate Service', baseUrl: 'https://alternate.example', supportedModelIds: ['alternate-model'], createdAt: '2', updatedAt: '2' })
      setConfigValue(db, 'config.llmServices', JSON.stringify(services))
      setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([TEST_SERVICE_ID, 'alternate-service']))
      setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [TEST_SERVICE_ID]: 'enc:sk-test', 'alternate-service': 'enc:sk-alternate' }))
      setConfigValue(db, 'config.wechat', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'alternate-model', remoteThinkingEffort: 'high' }))
      return { summary: '原始任务已接受', pendingConfirm: false, ok: true }
    })
    await dispatcher.dispatchSession(sessionId)
    const resultStore = createDeferredExecutionResultStore(db)
    resultStore.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey: 'wechat-completion-dispatch' })
    resultStore.commitResult(todo.todoId, { kind: 'completed', outputRef: `deferred-result:${todo.invocationId}`, value: { ok: true, marker: 'REVIEW_TOOL_RESULT_WECHAT' } })
    mockRunAgent.mockResolvedValueOnce({ summary: '', pendingConfirm: true, parked: true, ok: true })
    await dispatcher.dispatchSession(sessionId)

    expect(mockRunAgent).toHaveBeenCalledTimes(2)
    expect(mockRunAgent.mock.calls[1]?.[0]).toMatchObject({
      acceptedTurn: { config: { model: TEST_MODEL_NAME, llmServiceId: TEST_SERVICE_ID, thinkingEffort: 'low' } }
    })
    expect(mockRunAgent.mock.calls[1]?.[0]).toMatchObject({ userMessage: '发送确认后的报告', replyMessageId: 'wechat-completion-source',
      remoteContext: { contextToken: 'completion-context', deferredContinuation: { todoId: todo.todoId, invocationId: todo.invocationId,
        workflowId: 'workflow', taskId: 'task', stepId: 'publish', planRevision: 1, checkpointId: 'wechat-completion-checkpoint',
        dispatchKey: 'wechat-completion-dispatch', outputRef: `deferred-result:${todo.invocationId}`,
        result: { kind: 'completed', outputRef: `deferred-result:${todo.invocationId}`, value: { ok: true, marker: 'REVIEW_TOOL_RESULT_WECHAT' } } } } })
    expect(resultStore.getByTodo(todo.todoId)?.state).toBe('delivered')
    expect(listWakeEvents(db, sessionId).every(({ status }) => status === 'acked')).toBe(true)
    expect(getTurnByRequestId(db, sessionId, `completion:${listWakeEvents(db, sessionId).find(({ type }) => type === 'safety-recovery')!.eventId}`))
      .toMatchObject({ state: 'terminal', outcome: 'parked' })
    await dispatcher.dispose()
  })

  it('routes approval replies to the safety ingress before Inbox or the Skill', async () => {
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const retryDeferredApprovalNotifications = vi.fn(async () => [])
    router = makeRouter(undefined, handleDeferredApprovalReply, true, retryDeferredApprovalNotifications)
    await router.handleSdkInbound(makeIncomingMessage({ text: '批准 07', quotedMessage: { text: '审批通知', type: 'text' } }))
    expect(handleDeferredApprovalReply).toHaveBeenCalledWith(expect.objectContaining({ text: '批准 07', replyToMessageId: undefined }))
    expect(retryDeferredApprovalNotifications).toHaveBeenCalledWith({ identityKey: 'wx-user@test', ownerId: 'wx-user@test' })
    expect(mockResolveSession).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('routes an approval-shaped message as an ordinary inbound while the durable gate is closed', async () => {
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    router = makeRouter({ dispatchSession }, handleDeferredApprovalReply, false)
    await router.handleSdkInbound(makeIncomingMessage({ text: '批准 07', raw: { ...makeIncomingMessage().raw, client_id: 'wechat-closed-approval-reply' } }))
    expect(handleDeferredApprovalReply).not.toHaveBeenCalled()
    expect(listWakeEvents(db, sessionId)).toHaveLength(1)
    expect(listWakeEvents(db, sessionId)[0]?.payloadRef.kind).toBe('im-inbox-message')
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    expect(listImInboxMessages(db, { queueScope }).map(({ content }) => content)).toContain('批准 07')
    expect(dispatchSession).toHaveBeenCalledWith(sessionId)
  })

  it('retries a real undelivered approval notification after owner authentication', async () => {
    const todoStore = createDeferredTodoStore(db)
    const now = Date.now()
    const todo = todoStore.create({ todoId: 'wechat-router-retry-todo', invocationId: 'wechat-router-retry-invocation', channel: 'wechat',
      identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 4, rule: { ruleId: 'write', factsHash: 'd'.repeat(64) },
      workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: sessionId,
      createdAt: now, expiresAt: now + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'wechat-router-retry-checkpoint', workflowRevision: 2 })
    const adapter = { send: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ messageId: 'wechat-approval-retry-msg' }) }
    let code = 7
    const delivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents, adapter,
      allocateShortCode: () => String(code++).padStart(2, '0'), audit: vi.fn() })
    await expect(delivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId, channel: 'wechat',
      identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule: todo.rule,
      safeActionSummary: '更新项目说明', userDelegation: '更新项目说明', untrustedMaterial: '' })).resolves.toMatchObject({ state: 'undelivered' })

    mockResolveSession.mockResolvedValue({ sessionId, isNew: false })
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    router = makeRouter({ dispatchSession }, undefined, false, ({ identityKey, ownerId }) => delivery.retryForAuthenticatedInbound({
      channel: 'wechat', identityKey, ownerId, authorizationEpoch: 4
    }))
    await router.handleSdkInbound(makeIncomingMessage({ text: '批准 07', raw: { ...makeIncomingMessage().raw, client_id: 'wechat-authenticated-notification-retry' } }))
    expect(adapter.send).toHaveBeenCalledTimes(2)
    expect(delivery.resolveCurrent({ channel: 'wechat', identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 4, shortCode: '08' }))
      .toMatchObject({ trustedMessageId: 'wechat-approval-retry-msg', notificationVersion: 2 })
  })

  it('remote agent 的非终态事实先进入 Runtime，终态由统一 adapter 消费', async () => {
    mockRunAgent.mockImplementation(async ({ emitFactEvent }: { emitFactEvent?: (event: unknown) => void }) => {
      emitFactEvent?.({ type: 'tool-use', id: 'tool-wechat-1', toolName: 'read_file', input: { path: 'README.md' } })
      return { summary: 'done', pendingConfirm: false, ok: true }
    })

    await router.handleSdkInbound(makeIncomingMessage({ text: 'read it' }))

    expect(mockConsumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'tool-use', id: 'tool-wechat-1' }),
      expect.any(String)
    )
    expect(mockConsumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      { type: 'source-completed' },
      expect.any(String)
    )
    const calls = mockConsumeForRequest.mock.calls
    expect(calls.findIndex(([, event]) => (event as { type: string }).type === 'tool-use'))
      .toBeLessThan(calls.findIndex(([, event]) => (event as { type: string }).type === 'source-completed'))
  })

  it('WeChat router 将同一个 prepared turn 交给 agent 并用该 turnId 写入终态', async () => {
    mockRunAgent.mockResolvedValue({ summary: 'done', pendingConfirm: false, ok: true })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `wechat-chain-${++turnSequence}` } })
    router = new WeChatCommandRouter({
      db,
      sessionStorage: createSqliteSessionStorage(db), turnRuntime: runtime,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed, imChannel: new WeChatImChannel(), auditLogger: audit,
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['wx-user@test'] }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => tmpDir, checkDirectoryWritable: () => ({ ok: true }) } as never,
      getUserDataPath: () => tmpDir, getApiKey: async () => 'key', getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never, getModel: () => 'm1', getToolsConfig: () => ({ deniedTools: [] }) as never
    })

    await router.handleSdkInbound(makeIncomingMessage({ text: 'identity chain' }))

    const [agentArgs] = mockRunAgent.mock.calls[0] as [{
      requestId: string
      turnId: string
      acceptedTurn: { turnId: string; requestId: string; sessionId: string; currentUserMessageId: string }
    }]
    const persisted = getPersistedTurn(db, agentArgs.turnId)
    expect(agentArgs.acceptedTurn).toMatchObject({
      turnId: agentArgs.turnId,
      requestId: agentArgs.requestId,
      sessionId,
      currentUserMessageId: persisted?.userMessageId
    })
    expect(persisted).toMatchObject({
      requestId: agentArgs.requestId, sessionId, state: 'terminal', outcome: 'completed'
    })
  })

  it('confirm-requested 进入 Core，并保留 WeChat pending-confirm 出站结果', async () => {
    mockRunAgent.mockImplementation(async ({ emitFactEvent }: { emitFactEvent?: (event: unknown) => void }) => {
      emitFactEvent?.({ type: 'confirm-requested', toolUseId: 'tool-wechat-confirm', toolName: 'run_shell' })
      return { summary: 'waiting', pendingConfirm: true, ok: true }
    })

    await router.handleSdkInbound(makeIncomingMessage({ text: 'confirm me' }))

    expect(mockConsumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'confirm-requested', toolUseId: 'tool-wechat-confirm' }),
      expect.any(String)
    )
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('已收到，正在处理'))
  })

  it('deduplicates same messageId', async () => {
    const raw = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'dup-1' } })
    await router.handleSdkInbound(raw)
    await router.handleSdkInbound(raw)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
  })

  it('persists a repeated channel message once and schedules one asynchronous wake', async () => {
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    router = makeRouter({ dispatchSession })
    const raw = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'wake-dup-1' }, text: 'do this once' })

    await router.handleSdkInbound(raw)
    await router.handleSdkInbound(raw)

    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    expect(listQueuedUserMessages(db, { sessionId, queueScope })).toHaveLength(1)
    expect(listWakeEvents(db, sessionId)).toHaveLength(1)
    expect(dispatchSession).toHaveBeenCalledTimes(1)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('does not acknowledge or dispatch when WeChat inbound persistence fails', async () => {
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    const markCompleted = vi.spyOn(processed, 'markCompleted')
    router = makeRouter({ dispatchSession })
    getDbConnection(db).exec(`CREATE TRIGGER fail_wechat_wake_outbox BEFORE INSERT ON wake_event_outbox
      BEGIN SELECT RAISE(ABORT, 'injected WeChat persistence failure'); END`)

    await router.handleSdkInbound(makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'wechat-persist-fail' }, text: 'persist first' }))

    expect(listQueuedUserMessages(db, {
      sessionId,
      queueScope: buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    })).toEqual([])
    expect(listWakeEvents(db, sessionId)).toEqual([])
    expect(dispatchSession).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(markCompleted).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'persistence_failed')
  })

  it('rejects allowlist sender', async () => {
    const raw = makeIncomingMessage({ userId: 'blocked@test' })
    const r2 = new WeChatCommandRouter({
      db,
      sessionStorage: createSqliteSessionStorage(db),
      turnRuntime: testTurnRuntime,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      imChannel: new WeChatImChannel(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['allowed@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => null,
      getModel: () => 'm1',
      getToolsConfig: () => ({ deniedTools: [] }) as never
    })
    await r2.handleSdkInbound(raw)
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('不是已绑定'))
  })

  it('rejects when allowlist is empty', async () => {
    const raw = makeIncomingMessage({ userId: 'anyone@test' })
    const r2 = new WeChatCommandRouter({
      db,
      sessionStorage: createSqliteSessionStorage(db),
      turnRuntime: testTurnRuntime,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      imChannel: new WeChatImChannel(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: undefined
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => null,
      getModel: () => 'm1',
      getToolsConfig: () => ({ deniedTools: [] }) as never
    })
    await r2.handleSdkInbound(raw)
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('不是已绑定'))
  })

  it('rejects second inbound when session is busy', async () => {
    tryClaimRemoteSession(sessionId, 'req-busy', 3)
    const raw2 = makeIncomingMessage({ text: 'second', raw: { ...makeIncomingMessage().raw, client_id: 'busy-2' } })
    await router.handleSdkInbound(raw2)

    expect(mockRunAgent).not.toHaveBeenCalled()
    // busy 拒绝经 sendWeChatRemoteOutbound 发出，会追加桌面会话引用后缀（供桌面端会话跟随解析）
    expect(reply).toHaveBeenCalledTimes(1)
    const sent = reply.mock.calls[0]![1] as string
    expect(sent).toContain(REMOTE_SESSION_BUSY_MESSAGE)
    expect(sent).toContain(`会话$${sessionId}$`)
    // Persist terminal claim state — must not leave a sticky `claimed` row.
    const entry = (
      processed as unknown as {
        data: { entries: Array<{ state: string; resultSummary?: string }> }
      }
    ).data.entries.find((e) => e.resultSummary === 'session_busy')
    expect(entry?.state).toBe('completed')
    expect(entry?.resultSummary).toBe('session_busy')
    releaseRemoteSession(sessionId, 'req-busy')
  })

  it('completion/audit stay on the origin session after a mid-run switch_session, while reply follows the switched session', async () => {
    const target = createSession(db, { name: 'Target' })
    const wcSend = vi.fn()
    mockRunAgent.mockImplementation(
      async ({ remoteContext }: { remoteContext: { outboundSessionId?: string; originSessionId?: string } }) => {
        expect(remoteContext.originSessionId).toBe(sessionId)
        remoteContext.outboundSessionId = target.id
        return { summary: 'done', pendingConfirm: false, ok: true }
      }
    )

    const r2 = new WeChatCommandRouter({
      db,
      sessionStorage: createSqliteSessionStorage(db),
      turnRuntime: testTurnRuntime,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      imChannel: new WeChatImChannel(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['wx-user@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: wcSend }) as never,
      getModel: () => 'm1',
      getToolsConfig: () => ({ deniedTools: [] }) as never
    })

    const raw = makeIncomingMessage({ text: 'switch then reply' })
    await r2.handleSdkInbound(raw)

    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`会话$${target.id}$`))
  })

  // 评审 1.1：入站处理链的 bot.reply 在 session 过期/凭据缺失时 reject——handleInbound 顶层
  // 兜底必须吞掉并只记日志，否则 rejection 沿 fire-and-forget 分发链逃逸崩溃主进程。
  it('handleInbound 顶层兜底：bot.reply reject 时 promise 链不向调用方逃逸', async () => {
    reply.mockRejectedValueOnce(new Error('session expired: credentials missing'))
    const raw = makeIncomingMessage({ userId: 'stranger@test' })

    // stranger 不在 allowlist → not_owner 拒答 reply（reject）——若顶层无兜底，此 await 会 reject
    await expect(router.handleSdkInbound(raw)).resolves.toBeUndefined()
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('handleInbound 顶层兜底：auditLogger.append reject 同样不逃逸', async () => {
    const appendBoom = vi.fn(async () => { throw new Error('audit disk io failed') })
    const raw = makeIncomingMessage({ text: 'audit boom' })
    // not_owner 之前不走 audit；走 accepted 分支需构造 allowlist 命中的消息，且 mock 掉 processCommand
    // 之前的链路——直接以 accept 命中 + audit reject 验证：构造一个 allowlist 命中但 processCommand 前
    // 途被 audit 拦住的场景即可，audit 即 :135 的 append。
    const r2 = new WeChatCommandRouter({
      db,
      sessionStorage: createSqliteSessionStorage(db),
      turnRuntime: testTurnRuntime,
      botService: {
        getBot: () => ({ reply: vi.fn(async () => undefined), sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: {
        tryClaim: async () => ({ ok: true as const, claimId: 'c1' }),
        markCompleted: async () => undefined
      } as never,
      imChannel: new WeChatImChannel(),
      auditLogger: { append: appendBoom } as never,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['wx-user@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => null,
      getModel: () => 'm1',
      getToolsConfig: () => ({ deniedTools: [] }) as never
    })

    await expect(r2.handleSdkInbound(raw)).resolves.toBeUndefined()
    expect(appendBoom).toHaveBeenCalled()
  })

  // 评审 1.1 防御纵深：dispatch 层 .catch 兜 handleSdkInbound（含 parse 阶段）的任何 rejection。
  it('dispatchWeChatSdkInbound：链路 rejection 不产生 unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const badRouter = { handleSdkInbound: vi.fn(async () => { throw new Error('dispatch boom') }) } as never
      dispatchWeChatSdkInbound(badRouter, makeIncomingMessage({ text: 'x' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
