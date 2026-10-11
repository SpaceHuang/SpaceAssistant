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
import { openDatabase, createSession, getConfigValue, setConfigValue, getPersistedTurn, getSession, getTurnByRequestId, createPersistedTurn, appendMessage as mockedAppendMessage } from '../database'
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
import { appendImInboxMessageWithWakeEvent, listImInboxMessages, parkImInboxMessageForClarification } from '../database/imInbox'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from '../remote/deferredApprovalNotificationDelivery'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext } from '../database/acceptedTurnStorage'
import { attributeAndPersistRemoteMessage } from '../remote/remoteTrackAttributionService'
import { appendRemoteTrackEvent, createRemoteTrack, mapRemoteTrackMessage } from '../database/remoteTrackStore'
import { formatClarificationHandle } from '../remote/clarificationHandle'
import { startClarificationSendAttempt, finishClarificationSendAttempt } from '../database/clarificationStore'

vi.mock('../secureApiKey', () => ({ isSecretStorageAvailable: vi.fn(() => true), encryptSecret: (value: string) => `enc:${value}`, decryptSecret: (value: string) => value.replace(/^enc:/, '') }))
vi.mock('../anthropicClientFactory', () => ({ createAnthropicClient: () => ({ messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: '{"scores":[]}' }] })) } }) }))

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
    const session = createSession(db, { name: 'WeChat Session', metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } } })
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

  it('consumes clarification control text before Agent routing and invokes only the resolver', async () => {
    const resolve = vi.fn(async () => ({ kind: 'resolved' as const, trackId: 'track-1', workId: 'work-1' }))
    ;(router as unknown as { deps: { handleClarificationReply?: typeof resolve } }).deps.handleClarificationReply = resolve
    await router.handleSdkInbound(makeIncomingMessage({ text: '选择 ABCD-EFGH-JK345 2', raw: {
      from_user_id: 'wx-user@test', to_user_id: 'bot', client_id: 'clarification-reply-1', create_time_ms: Date.now(),
      message_type: 1, message_state: 2, context_token: 'ctx', item_list: []
    } as never }))
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'wechat', identityKey: 'wx-user@test', ownerId: 'wx-user@test', replyMessageId: expect.any(String),
      handle: 'ABCDEFGHJK345', option: 2
    }))
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), '已收到选择，正在继续处理。')
  })

  it('does not send malformed clarification control syntax to the Agent', async () => {
    await router.handleSdkInbound(makeIncomingMessage({ text: '选择 ABCD 1', raw: {
      from_user_id: 'wx-user@test', to_user_id: 'bot', client_id: 'clarification-malformed-diagnostic', create_time_ms: Date.now(),
      message_type: 1, message_state: 2, context_token: 'ctx', item_list: []
    } as never }))
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('澄清回复格式无效'))
    expect(getDbConnection(db).prepare('SELECT channel,platform_message_id,event_kind,reason_code FROM remote_track_diagnostic_events').get())
      .toEqual({ channel: 'wechat', platform_message_id: 'clarification-malformed-diagnostic', event_kind: 'clarification.reply', reason_code: 'invalid' })
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
    const firstWakeArgs = mockRunAgent.mock.calls[0]?.[0] as { replyMessageId: string; inboundRaw: { _contextToken?: string }; remoteContext: { contextToken: string; turnId?: string } }
    expect(firstWakeArgs.replyMessageId).toBe('replay-wechat-1')
    expect(firstWakeArgs.inboundRaw._contextToken).toBe('context-replay')
    expect(firstWakeArgs.remoteContext.contextToken).toBe('context-replay')
    expect(firstWakeArgs.remoteContext.turnId).toBe('wake-wechat-1')
    expect(createDeferredConfirmationAdapter).toHaveBeenCalledTimes(2)
    expect(mockRunAgent.mock.calls[1]?.[0]).toMatchObject({ userMessage: '第二条恢复消息', replyMessageId: 'replay-wechat-2', inboundRaw: { _contextToken: 'context-replay-2' }, remoteContext: { contextToken: 'context-replay-2' } })
    expect(listWakeEvents(db, sessionId).map(({ type, status }) => ({ type, status }))).toEqual([
      { type: 'im-inbound', status: 'acked' }, { type: 'im-inbound', status: 'acked' }
    ])
    expect(getTurnByRequestId(db, sessionId, `wake:${persisted.eventId}`)).toMatchObject({ requestId: `wake:${persisted.eventId}`, userMessageId: persisted.messageId, outcome: 'completed' })
    await dispatcher.dispose()
  })

  it('wake replay rehydrates and validates the persisted Track before building the turn view', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify({ ...session.metadata, source: 'wechat',
      wechatMeta: { userId: 'wx-user@test', lastContextToken: 'track-wake-context' } }), sessionId)
    const attribution = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'wx-user@test', ownerId: 'wx-user@test',
      authorizationEpoch: 1, platformMessageId: 'track-wake-platform', text: 'persisted track task', now: 1, originSessionId: sessionId }, { classify: vi.fn() })
    if (attribution.kind !== 'attributed') throw new Error('expected a Track for zero candidates')
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'track-wake-platform', content: 'persisted track task', contextToken: 'track-wake-context',
      trackId: attribution.context.trackId, trackEventId: attribution.context.attributionEventId })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `track-wake-${++turnSequence}` } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId)

    const [agentArgs] = mockRunAgent.mock.calls[0] as [{ remoteContext: { trackContext?: { trackId: string }; trackModelInputView?: { completeness: string }; turnId: string } }]
    expect(agentArgs.remoteContext.trackContext?.trackId).toBe(attribution.context.trackId)
    expect(agentArgs.remoteContext.trackModelInputView).toMatchObject({ completeness: 'complete' })
    expect(getDbConnection(db).prepare('SELECT track_id FROM turns WHERE turn_id=?').get(agentArgs.remoteContext.turnId)).toEqual({ track_id: attribution.context.trackId })
    expect(getTurnByRequestId(db, sessionId, `wake:${inbox.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'completed' })
    await dispatcher.dispose()
  })

  it('acks an already terminal wake before looking for its consumed inbox message', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'terminal-context' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const completed = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'terminal-wechat-message', content: '已完成但唤醒未结算', contextToken: 'terminal-context' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `terminal-wechat-${++turnSequence}` } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId)
    expect(getTurnByRequestId(db, sessionId, `wake:${completed.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'completed' })

    // Simulate a crash after the turn committed and consumed the queue message, but before
    // the dispatcher finalized the durable wake event.
    getDbConnection(db).prepare("UPDATE wake_events SET status='pending',claimed_by=NULL,run_id=NULL,lease_expires_at=NULL WHERE event_id=?")
      .run(completed.eventId)
    getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(completed.messageId)
    const next = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'next-wechat-message', content: '下一条消息应继续处理', contextToken: 'next-context' })

    await dispatcher.dispatchSession(sessionId)

    expect(getTurnByRequestId(db, sessionId, `wake:${next.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'completed' })
    expect(listWakeEvents(db, sessionId).map(({ eventId, status }) => ({ eventId, status }))).toEqual([
      { eventId: completed.eventId, status: 'acked' },
      { eventId: next.eventId, status: 'acked' }
    ])
    await dispatcher.dispose()
  })

  it('recovers a nonterminal orphan turn before it can block later WeChat wake events', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'orphan-context' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const orphan = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'orphan-wechat-message', content: '上次中断的指令', contextToken: 'orphan-context' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `orphan-wechat-turn-${++turnSequence}` } })
    appendMessageOperation(db, { id: 'orphan-wechat-assistant', sessionId, role: 'assistant', content: '', timestamp: Date.now(), status: 'streaming' })
    createPersistedTurn(db, { turnId: 'orphan-wechat-turn-existing', requestId: `wake:${orphan.eventId}`, sessionId,
      assistantMessageId: 'orphan-wechat-assistant', userMessageId: orphan.messageId, state: 'prepared' })
    getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(orphan.messageId)
    const next = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'after-orphan-wechat-message', content: '继续处理下一条', contextToken: 'next-context' })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId)

    expect(getTurnByRequestId(db, sessionId, `wake:${orphan.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    expect(getTurnByRequestId(db, sessionId, `wake:${next.eventId}`), JSON.stringify({ events: listWakeEvents(db, sessionId), retry: getDbConnection(db).prepare('SELECT * FROM wake_event_retry_state').all() })).toMatchObject({ state: 'terminal', outcome: 'completed' })
    expect(listWakeEvents(db, sessionId).map(({ status }) => status)).toEqual(['acked', 'acked'])
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

  it('recovers an unfinished deferred completion turn and does not replay it', async () => {
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
    const completionEvent = listWakeEvents(db, sessionId).find(({ type }) => type === 'safety-recovery')!
    const completionRequestId = `completion:${completionEvent.eventId}`
    runtime.prepare({ mode: 'reuse-user', requestId: completionRequestId, sessionId, userMessageId: persisted.messageId,
      excludeMessageIds: [], config: {} })
    const recoveryNoticeSend = vi.fn(async () => undefined)
    ;(router as unknown as { deps: { botService: { getRawBot: () => { send: typeof recoveryNoticeSend } } } }).deps.botService.getRawBot = () => ({ send: recoveryNoticeSend })
    await dispatcher.dispatchSession(sessionId)

    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(recoveryNoticeSend).toHaveBeenCalledWith('wx-user@test', expect.stringContaining('原操作结果已保存'))
    expect(resultStore.getByTodo(todo.todoId)?.state).toBe('delivered')
    expect(listWakeEvents(db, sessionId).every(({ status }) => status === 'acked')).toBe(true)
    expect(getTurnByRequestId(db, sessionId, completionRequestId)).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    expect(getDbConnection(db).prepare("SELECT state FROM im_lifecycle_outbox WHERE event_id=?").get(`deferred-completion-interrupted:${todo.todoId}`))
      .toEqual({ state: 'delivered' })
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
    expect(dispatchSession).toHaveBeenCalledWith(sessionId, { retryExhausted: true })
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

  it('Track 路由将新消息归属、accepted turn 与模型输入视图绑定后再调用 Agent', async () => {
    const dispatchSession = vi.fn(async () => undefined)
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 5, id: () => `track-direct-${++turnSequence}` } })
    router = new WeChatCommandRouter({
      db, sessionStorage: createSqliteSessionStorage(db), turnRuntime: runtime,
      botService: { getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }), getRawBot: () => null } as never,
      processedStore: processed, imChannel: new WeChatImChannel(), auditLogger: audit,
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['wx-user@test'] }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }), getWorkDir: () => tmpDir,
      workDirManager: { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => tmpDir, checkDirectoryWritable: () => ({ ok: true }) } as never,
      getUserDataPath: () => tmpDir, getApiKey: async () => 'key', getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never, getModel: () => 'm1', getToolsConfig: () => ({ deniedTools: [] }) as never,
      wakeEventDispatcher: { dispatchSession } as never
    })

    await router.handleSdkInbound(makeIncomingMessage({ text: '新建一个研究任务', raw: { ...makeIncomingMessage().raw, client_id: 'track-direct-root' } }))

    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(dispatchSession).toHaveBeenCalledWith(sessionId, { retryExhausted: true })
    const context = getDbConnection(db).prepare(`SELECT context.track_id,context.track_event_id FROM im_inbox_message_context context
      WHERE context.platform_message_id='track-direct-root'`).get() as { track_id: string; track_event_id: string }
    expect(context.track_id).toBeTruthy()
    expect(getDbConnection(db).prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(context.track_event_id))
      .toEqual({ track_id: context.track_id })
    expect(getDbConnection(db).prepare('SELECT track_id FROM remote_track_message_map WHERE channel=? AND platform_message_id=?').get('wechat', 'track-direct-root'))
      .toEqual({ track_id: context.track_id })
    expect(listWakeEvents(db, sessionId)).toMatchObject([{ type: 'im-inbound', status: 'pending' }])
  })

  it('Track execution 未接入持久 wake consumer 时 fail closed，不创建 Track 或运行 Agent', async () => {
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    await router.handleSdkInbound(makeIncomingMessage({ text: '需要可靠执行的任务', raw: { ...makeIncomingMessage().raw, client_id: 'no-wake-track-root' } }))

    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM remote_tracks WHERE root_message_id='no-wake-track-root'").get())
      .toEqual({ count: 0 })
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('本次未执行'))
  })

  it('ambiguous Track 消息会原子暂存并发送带句柄的选项，而不会启动 Agent turn', async () => {
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true', remoteTrackRecovery: 'true',
      remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    for (const [id, event, occurredAt] of [['clarify-track-a', 'clarify-root-a', 2], ['clarify-track-b', 'clarify-root-b', 1]] as const) {
      createRemoteTrack(db, { trackId: id, eventId: event, idempotencyKey: `inbound:${id}`, channel: 'wechat', identityKey: 'wx-user@test',
        ownerId: 'wx-user@test', authorizationEpoch: 1, rootMessageId: `${id}-platform`, originSessionId: sessionId, occurredAt })
    }
    router = makeRouter({ dispatchSession: vi.fn(async () => undefined) })
    mockResolveSession.mockResolvedValue({ sessionId, isNew: false })
    const raw = makeIncomingMessage({ text: '继续之前的研究', raw: { ...makeIncomingMessage().raw, client_id: 'ambiguous-wechat-input' } })
    await router.handleSdkInbound(raw)

    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('选择 '))
    const clarification = getDbConnection(db).prepare(`SELECT clarification_id,parked_input_ref,state,current_version FROM remote_clarifications
      WHERE source_message_id='ambiguous-wechat-input'`).get() as { clarification_id: string; parked_input_ref: string; state: string; current_version: number }
    expect(clarification).toMatchObject({ state: 'pending', current_version: 1 })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(clarification.parked_input_ref)).toEqual({ status: 'parked' })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_clarification_send_attempts WHERE clarification_id=?').get(clarification.clarification_id))
      .toEqual({ state: 'send-fulfilled' })
    expect(listWakeEvents(db, sessionId)).toEqual([])

    const handle = getDbConnection(db).prepare('SELECT handle FROM remote_clarification_versions WHERE clarification_id=?').get(clarification.clarification_id) as { handle: string }
    await router.handleSdkInbound(makeIncomingMessage({ text: '1', raw: { ...makeIncomingMessage().raw, client_id: 'legacy-clarification-option' } }))
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT state FROM remote_clarifications WHERE clarification_id=?').get(clarification.clarification_id))
      .toEqual({ state: 'pending' })
    expect(getDbConnection(db).prepare("SELECT reason_code FROM remote_track_diagnostic_events WHERE platform_message_id='legacy-clarification-option'").get())
      .toEqual({ reason_code: 'invalid' })
    mockRunAgent.mockResolvedValue({ summary: 'continued', pendingConfirm: false, ok: true })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 5, id: () => `clarification-resume-${++turnSequence}` } })
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })
    router.setWakeEventDispatcher(dispatcher)
    await router.handleSdkInbound(makeIncomingMessage({ text: `选择 ${formatClarificationHandle(handle.handle)} 1`, raw: {
      ...makeIncomingMessage().raw, client_id: 'clarification-choice-message'
    } }))
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(mockRunAgent.mock.calls[0]?.[0]).toMatchObject({ userMessage: '继续之前的研究', remoteContext: { trackContext: { trackId: 'clarify-track-a' } } })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_clarifications WHERE clarification_id=?').get(clarification.clarification_id)).toEqual({ state: 'resolved' })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_track_work_queue WHERE clarification_id=?').get(clarification.clarification_id)).toEqual({ state: 'completed' })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?').get('clarify-track-a')).toEqual({ state: 'completed' })
    expect(getDbConnection(db).prepare('SELECT session_id,request_id,turn_id,user_message_id,model_view_version FROM remote_track_work_queue WHERE clarification_id=?')
      .get(clarification.clarification_id)).toMatchObject({ session_id: sessionId, request_id: expect.any(String),
        turn_id: expect.any(String), user_message_id: clarification.parked_input_ref, model_view_version: expect.stringContaining('view-') })
    expect(listWakeEvents(db, sessionId).map(({ status }) => status)).toEqual(['acked'])
    await dispatcher.dispose()
  })

  it('周期恢复会终结已超时的停放输入，并通过持久 outbox 投递一次回执', async () => {
    createRemoteTrack(db, { trackId: 'expired-track', eventId: 'expired-track-event', idempotencyKey: 'expired-track-root',
      channel: 'wechat', identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 1,
      rootMessageId: 'expired-track-root-message', originSessionId: sessionId, occurredAt: 1 })
    parkImInboxMessageForClarification(db, { sessionId, channel: 'wechat', queueScope: buildImQueueScope('wechat', sessionId),
      channelMessageId: 'expired-platform-message', content: '原始请求', clarificationId: 'expired-clarification',
      identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 1, handle: 'ABCDEFGHJK345',
      candidates: [{ trackId: 'expired-track', option: 1, label: '任务', stateAtIssue: 'open' }], expiresAt: 500, now: 100 })
    const send = vi.fn(async () => undefined)
    ;(router as unknown as { deps: { botService: { getRawBot: () => unknown } } }).deps.botService.getRawBot = () => ({ send })

    await router.recoverClarificationLifecycle(500)

    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=(SELECT parked_input_ref FROM remote_clarifications WHERE clarification_id=?)')
      .get('expired-clarification')).toEqual({ status: 'clarification-expired' })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]).toMatchObject(['wx-user@test', expect.stringContaining('原消息没有执行')])
    expect(getDbConnection(db).prepare("SELECT state FROM im_lifecycle_outbox WHERE event_id='clarification-terminal:expired-clarification:expired'").get())
      .toEqual({ state: 'delivered' })
    await router.recoverClarificationLifecycle(501)
    expect(send).toHaveBeenCalledOnce()
  })

  it('重启恢复会对发送结果未知的澄清重用原句柄重发提示', async () => {
    const now = Date.now()
    createRemoteTrack(db, { trackId: 'retry-track', eventId: 'retry-track-event', idempotencyKey: 'retry-track-root',
      channel: 'wechat', identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 1,
      rootMessageId: 'retry-track-root-message', originSessionId: sessionId, occurredAt: 1 })
    parkImInboxMessageForClarification(db, { sessionId, channel: 'wechat', queueScope: buildImQueueScope('wechat', sessionId),
      channelMessageId: 'retry-platform-message', content: '继续原请求', clarificationId: 'retry-clarification',
      identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 1, handle: 'BCDEFGHJK3456',
      candidates: [{ trackId: 'retry-track', option: 1, label: '原任务', stateAtIssue: 'open' }], expiresAt: now + 60_000, now: now - 120_000 })
    startClarificationSendAttempt(db, { sendAttemptId: 'retry-attempt-1', clarificationId: 'retry-clarification', version: 1, startedAt: now - 110_000 })
    finishClarificationSendAttempt(db, { sendAttemptId: 'retry-attempt-1', state: 'send-outcome-unknown', finishedAt: now - 100_000 })
    const send = vi.fn(async () => undefined)
    ;(router as unknown as { deps: { botService: { getRawBot: () => unknown } } }).deps.botService.getRawBot = () => ({ send })

    await router.recoverClarificationLifecycle(now)

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]).toMatchObject(['wx-user@test', expect.stringContaining('BCDE-FGHJ-K3456')])
    expect(getDbConnection(db).prepare(`SELECT state FROM remote_clarification_send_attempts
      WHERE clarification_id='retry-clarification' ORDER BY started_at DESC LIMIT 1`).get()).toEqual({ state: 'send-fulfilled' })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=(SELECT parked_input_ref FROM remote_clarifications WHERE clarification_id=?)')
      .get('retry-clarification')).toEqual({ status: 'parked' })
  })

  it('重启恢复 prepared accepted turn 时沿用已接受的模型配置快照', async () => {
    const session = getSession(db, sessionId)!
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify({ ...session.metadata, source: 'wechat',
      wechatMeta: { userId: 'wx-user@test', lastContextToken: 'prepared-recovery-context' } }), sessionId)
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'prepared-recovery-platform-message', content: '恢复原 accepted turn', contextToken: 'prepared-recovery-context' })
    const frozenConfig = { lane: 'wechat' as const, model: TEST_MODEL_NAME, llmServiceId: TEST_SERVICE_ID,
      thinkingEffort: 'low' as const, maximumContextTrusted: true, enableThinking: false }
    appendMessageOperation(db, { id: 'prepared-recovery-assistant', sessionId, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'prepared-recovery-turn', requestId: `wake:${inbox.eventId}`, sessionId,
      userMessageId: inbox.messageId, assistantMessageId: 'prepared-recovery-assistant', state: 'prepared',
      startToken: 'prepared-recovery-token', executionConfig: frozenConfig })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'prepared-recovery-turn', requestId: `wake:${inbox.eventId}`, sessionId,
      lane: 'wechat', startToken: 'prepared-recovery-token', currentUserMessageId: inbox.messageId, transcriptVersion: 0, config: frozenConfig }))
    setConfigValue(db, 'config.wechat', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'missing-model', remoteThinkingEffort: 'low' }))
    mockRunAgent.mockResolvedValue({ summary: 'prepared turn resumed', pendingConfirm: false, ok: true })
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 10, id: () => 'unexpected-second-turn' } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId)

    expect(mockRunAgent).toHaveBeenCalledOnce()
    expect((mockRunAgent.mock.calls[0]?.[0] as { acceptedTurn: { turnId: string; config: { model: string; llmServiceId: string } } }).acceptedTurn)
      .toMatchObject({ turnId: 'prepared-recovery-turn', config: { model: TEST_MODEL_NAME, llmServiceId: TEST_SERVICE_ID } })
    expect(getTurnByRequestId(db, sessionId, `wake:${inbox.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'completed' })
    expect(listWakeEvents(db, sessionId)).toMatchObject([{ eventId: inbox.eventId, status: 'acked' }])
    await dispatcher.dispose()
  })

  it('影子归属只记录脱敏观察，不改动微信既有 Agent 路由', async () => {
    mockRunAgent.mockResolvedValue({ summary: 'legacy path', pendingConfirm: false, ok: true })
    setConfigValue(db, 'remoteTrackPersist', 'true')
    setConfigValue(db, 'remoteTrackShadowAttribution', 'true')
    setConfigValue(db, 'remoteTrackRolloutChannels', '["wechat"]')
    router = new WeChatCommandRouter({
      db, sessionStorage: createSqliteSessionStorage(db), turnRuntime: testTurnRuntime,
      botService: { getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }), getRawBot: () => null } as never,
      processedStore: processed, imChannel: new WeChatImChannel(), auditLogger: audit,
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['wx-user@test'] }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }), getWorkDir: () => tmpDir,
      workDirManager: { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => tmpDir, checkDirectoryWritable: () => ({ ok: true }) } as never,
      getUserDataPath: () => tmpDir, getApiKey: async () => 'key', getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never, getModel: () => 'm1', getToolsConfig: () => ({ deniedTools: [] }) as never
    })

    await router.handleSdkInbound(makeIncomingMessage({ text: 'legacy request', raw: { ...makeIncomingMessage().raw, client_id: 'shadow-wechat-1' } }))
    await vi.waitFor(() => expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_attribution_observations').get()).toEqual({ count: 1 }))

    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(mockRunAgent.mock.calls[0]?.[0]).not.toHaveProperty('remoteContext.trackContext')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 0 })
    expect(getDbConnection(db).prepare('SELECT decision_kind FROM remote_track_attribution_observations').get()).toEqual({ decision_kind: 'new-track' })
  })

  it('已有 Track 即使微信 session idle resolver 给出新 session，也继续使用 Track 的 origin session', async () => {
    mockRunAgent.mockResolvedValue({ summary: 'continued', pendingConfirm: false, ok: true })
    const unusedSession = createSession(db, { name: 'unused-new-session', metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } } })
    mockResolveSession.mockResolvedValue({ sessionId: unusedSession.id, isNew: true })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    createRemoteTrack(db, { trackId: 'origin-track', eventId: 'origin-root-event', idempotencyKey: 'origin-track-root', channel: 'wechat',
      identityKey: 'wx-user@test', ownerId: 'wx-user@test', authorizationEpoch: 1, rootMessageId: 'origin-root-message',
      originSessionId: sessionId, occurredAt: 1 })
    appendRemoteTrackEvent(db, { eventId: 'origin-prompt-event', trackId: 'origin-track', eventKind: 'track.outbound.message',
      idempotencyKey: 'origin-prompt-event', messageId: 'origin-prompt-message', occurredAt: 2 })
    mapRemoteTrackMessage(db, { channel: 'wechat', platformMessageId: 'origin-prompt-message', trackId: 'origin-track',
      eventId: 'origin-prompt-event', direction: 'outbound' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 5, id: () => `origin-track-turn-${++turnSequence}` } })
    const dispatchSession = vi.fn(async () => undefined)
    router = new WeChatCommandRouter({
      db, sessionStorage: createSqliteSessionStorage(db), turnRuntime: runtime,
      botService: { getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }), getRawBot: () => null } as never,
      processedStore: processed, imChannel: new WeChatImChannel(), auditLogger: audit,
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['wx-user@test'] }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }), getWorkDir: () => tmpDir,
      workDirManager: { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => tmpDir, checkDirectoryWritable: () => ({ ok: true }) } as never,
      getUserDataPath: () => tmpDir, getApiKey: async () => 'key', getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never, getModel: () => 'm1', getToolsConfig: () => ({ deniedTools: [] }) as never,
      wakeEventDispatcher: { dispatchSession } as never
    })

    await router.handleInbound({ messageId: 'origin-track-follow-up', userId: 'wx-user@test', text: '补充研究条件', type: 'text',
      timestamp: new Date().toISOString(), contextToken: 'ctx', quotedMessageId: 'origin-prompt-message' },
    makeIncomingMessage({ text: '补充研究条件' }))

    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(dispatchSession).toHaveBeenCalledWith(sessionId, { retryExhausted: true })
    expect(listImInboxMessages(db, { queueScope: buildImQueueScope('wechat', sessionId), limit: 10 })).toContainEqual(expect.objectContaining({ content: '补充研究条件' }))
    expect(mockResolveSession).not.toHaveBeenCalled()
    expect(getSession(db, unusedSession.id)).toBeDefined()
  })

  it('在 transcript 准入拒绝时也将 prepared turn 结算失败，避免界面永久显示生成中', async () => {
    getDbConnection(db).prepare("INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,0,'uncertain-turn','commit_uncertain',1)").run(sessionId)
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => Date.now(), id: () => `blocked-wechat-${++turnSequence}` } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime

    await router.handleSdkInbound(makeIncomingMessage({ text: '这条请求应明确失败，而不是一直生成' }))

    const turn = getDbConnection(db).prepare('SELECT turn_id,state,outcome,assistant_message_id FROM turns WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId) as
      { turn_id: string; state: string; outcome: string | null; assistant_message_id: string }
    const assistant = getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(turn.assistant_message_id)
    expect(turn).toMatchObject({ state: 'terminal', outcome: 'failed' })
    expect(assistant).toEqual({ status: 'failed' })
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED'))
  })

  it('持久化微信 wake 遇到 transcript 未恢复时终结 turn 并告知用户本次未执行', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'blocked-context' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'blocked-transcript-message', content: '本次应明确失败', contextToken: 'blocked-context' })
    getDbConnection(db).prepare("INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,0,'uncertain-turn','commit_uncertain',1)").run(sessionId)
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => Date.now(), id: () => `blocked-wake-${++turnSequence}` } })
    router = makeRouter(undefined)
    ;(router as unknown as { deps: { turnRuntime?: TurnRuntime } }).deps.turnRuntime = runtime
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId)

    expect(getTurnByRequestId(db, sessionId, `wake:${inbox.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'failed' })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=(SELECT assistant_message_id FROM turns WHERE request_id=?)')
      .get(`wake:${inbox.eventId}`)).toEqual({ status: 'failed' })
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('本次请求尚未执行'))
    expect(mockRunAgent).not.toHaveBeenCalled()
    await dispatcher.dispose()
  })

  it('恢复已有 transcript 失败终态的 wake 时补发此前无法送出的确定性失败回执', async () => {
    const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const session = getSession(db, sessionId)!
    const metadata = { ...session.metadata, source: 'wechat', wechatMeta: { userId: 'wx-user@test', lastContextToken: 'blocked-context' } }
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(metadata), sessionId)
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'terminal-transcript-failure-message', content: '这条请求曾因历史状态异常失败', contextToken: 'blocked-context' })
    appendMessageOperation(db, { id: 'failed-assistant-message', sessionId, role: 'assistant', content: '', timestamp: Date.now(), status: 'failed' })
    createPersistedTurn(db, { turnId: 'terminal-transcript-failure-turn', requestId: `wake:${inbox.eventId}`, sessionId,
      userMessageId: inbox.messageId, assistantMessageId: 'failed-assistant-message', state: 'terminal', outcome: 'failed',
      error: { code: 'source-failed', message: 'SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED' } })
    router = makeRouter()
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(sessionId, { retryExhausted: true })

    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('本次请求尚未执行'))
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(listWakeEvents(db, sessionId).find(({ eventId }) => eventId === inbox.eventId)?.status).toBe('acked')
    await dispatcher.dispose()
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
