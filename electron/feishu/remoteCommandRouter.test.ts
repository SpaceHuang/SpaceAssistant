import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSession, openDatabase, createSession, getConfigValue, setConfigValue, getPersistedTurn, getTurnByRequestId } from '../database'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { TurnRuntime } from '../turnRuntime'
import { createWorkDirManager } from '../workDirManager'
import { RemoteCommandRouter } from './remoteCommandRouter'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import {
  REMOTE_PARALLEL_FULL_MESSAGE,
  REMOTE_SESSION_BUSY_MESSAGE
} from '../remote/remoteSessionGuardMessages'
import {
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession,
  releaseRemoteSession
} from '../remote/remoteAgentRegistry'
import * as workDirBinding from '../workDirBinding'
import { listQueuedUserMessages } from '../database/operations'
import { listWakeEvents } from '../database/wakeEvents'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { getDbConnection } from '../database/sqliteStore'
import { ackImInboxMessage, appendImInboxMessageWithWakeEvent, listImInboxMessages } from '../database/imInbox'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from '../remote/deferredApprovalNotificationDelivery'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext } from '../database/acceptedTurnStorage'

vi.mock('../secureApiKey', () => ({ isSecretStorageAvailable: vi.fn(() => true), encryptSecret: (value: string) => `enc:${value}`, decryptSecret: (value: string) => value.replace(/^enc:/, '') }))

const mockRunFeishuRemoteAgent = vi.fn()
const mockResolveFeishuSession = vi.fn()
const mockSendFeishuRemoteOutbound = vi.fn()
const mockShouldAcceptInbound = vi.fn()
const mockConsumeForRequest = vi.fn()

const testTurnRuntime = {
  bindRequest: vi.fn(),
  unbindRequest: vi.fn(),
  prepare: vi.fn((intent: { requestId: string; sessionId: string }) => ({
    turnId: `turn-${intent.requestId}`,
    requestId: intent.requestId,
    sessionId: intent.sessionId,
    userMessage: { id: `user-${intent.requestId}` },
    assistantMessage: { id: `assistant-${intent.requestId}` },
    version: 0,
    startToken: `token-${intent.requestId}`
  })),
  executeWithSource: vi.fn(async (_turnId: string, token: string, source: (a: unknown, b: string) => Promise<unknown>) => source({}, token)),
  consumeForRequest: mockConsumeForRequest
} as unknown as TurnRuntime

vi.mock('./feishuRemoteAgent', () => ({
  runFeishuRemoteAgent: (...args: unknown[]) => mockRunFeishuRemoteAgent(...args)
}))

vi.mock('./feishuSessionResolver', () => ({
  resolveFeishuSession: (...args: unknown[]) => mockResolveFeishuSession(...args)
}))

vi.mock('./feishuRemoteOutbound', () => ({
  sendFeishuRemoteOutbound: (...args: unknown[]) => mockSendFeishuRemoteOutbound(...args)
}))

vi.mock('./feishuInboundParser', () => ({
  shouldAcceptInbound: (...args: unknown[]) => mockShouldAcceptInbound(...args)
}))

vi.mock('./feishuCliLogger', () => ({
  logFeishuCliEvent: vi.fn()
}))

vi.mock('../remote/remoteProgressStore', () => ({
  clearRemoteProgressSession: vi.fn()
}))

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-frr-'))
}

function makeInbound(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderOpenId: 'user-1',
    content: 'hello',
    createTime: '0',
    mentionsBot: false,
    ...overrides
  }
}

/** 测试会话模型 / 服务 id；可信 turn 快照会真的解析「会话模型 → 活跃服务 → Key」 */
const TEST_MODEL_NAME = 'claude-sonnet-4-20250514'
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

let claimIdSeq = 0
function makeProcessedStore() {
  return {
    has: vi.fn().mockResolvedValue(false),
    mark: vi.fn().mockResolvedValue(undefined),
    tryClaim: vi.fn().mockImplementation(async () => ({ ok: true as const, claimId: `claim-${++claimIdSeq}` })),
    markExecuting: vi.fn().mockResolvedValue(true),
    markCompleted: vi.fn().mockResolvedValue(true)
  }
}

describe('RemoteCommandRouter workdir binding', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  beforeEach(() => {
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
    resetRunningRemoteAgentRegistryForTests()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function makeRouter(
    db: ReturnType<typeof openDatabase>,
    manager: ReturnType<typeof createWorkDirManager>,
    options?: { maxParallel?: number; tryResolveConfirm?: boolean; approvalGate?: boolean; wc?: { send: (...args: unknown[]) => void }; turnRuntime?: TurnRuntime; wakeDispatcher?: { dispatchSession: (sessionId: string) => Promise<void> }; retryDeferredApprovalNotifications?: (scope: { identityKey: string; ownerId: string }) => Promise<unknown>; handleDeferredApprovalReply?: (input: { message: FeishuInboundMessage; text: string }) => Promise<void> }
  ) {
    const auditAppend = vi.fn().mockResolvedValue(undefined)
    const processedStore = makeProcessedStore()
    const router = new RemoteCommandRouter({
      turnRuntime: options?.turnRuntime ?? testTurnRuntime,
      db,
      sessionStorage: createSqliteSessionStorage(db),
      runner: { run: vi.fn() } as never,
      processedStore: processedStore as never,
      imChannel: {
        tryResolveFromInboundMessage: () => options?.tryResolveConfirm ?? false
      } as never,
      auditLogger: { append: auditAppend } as never,
      getFeishuConfig: () =>
        mergeFeishuConfig({
          enabled: true,
          remoteEnabled: true,
          appConfigured: true,
          remoteSenderAllowlist: ['user-1']
        }),
      getAppConfig: () => ({
        defaultModel: 'claude-sonnet-4-20250514',
        maxParallelChatSessions: options?.maxParallel ?? 3,
        workDirProfiles: manager.listProfiles(),
        activeWorkDirProfileId: manager.getActiveProfileId()
      }),
      getWorkDir: () => manager.getActiveWorkDir(),
      workDirManager: manager,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'key',
      getBaseUrl: () => '',
      getMainWebContents: () => (options?.wc as never) ?? null,
      getModel: () => 'claude-sonnet-4-20250514',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      wakeEventDispatcher: options?.wakeDispatcher,
      retryDeferredApprovalNotifications: options?.retryDeferredApprovalNotifications,
      handleDeferredApprovalReply: options?.handleDeferredApprovalReply,
      isRemoteAsyncApprovalEnabled: () => options?.approvalGate ?? true
    } as never)
    return { router, auditAppend, processedStore }
  }

  function setupDbAndManager() {
    const dirA = tempDir()
    dirs.push(dirA)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    seedLlmConfig(db)
    let workDir = dirA
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => workDir,
      setWorkDir: (d) => {
        workDir = d
      }
    })
    return { db, manager, dirA }
  }

  it('persists workDirProfileId when inbound command resolves @profile', async () => {
    const { db, manager, dirA } = setupDbAndManager()
    const dirB = tempDir()
    dirs.push(dirB)
    const a = manager.addProfile({ name: 'Alpha', path: dirA, aliases: ['alpha'] })
    manager.addProfile({ name: 'Beta', path: dirB })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '/sa @alpha list files' })
    const session = createSession(db, { name: 'Feishu Session' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ content: '/sa @alpha list files', messageId: 'msg-1' }))

    const updated = getSession(db, session.id)
    expect(updated?.workDirProfileId).toBe(a.profile!.id)
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: dirA,
        workDirManager: manager,
        acceptedTurn: expect.objectContaining({ sessionId: session.id, lane: 'feishu', currentUserMessageId: expect.stringMatching(/^user-/) })
      })
    )
  })

  it('routes approval replies to the safety ingress before Inbox or the Skill', async () => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '批准 07' })
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const retryDeferredApprovalNotifications = vi.fn(async () => [])
    const { router, processedStore } = makeRouter(db, manager, { handleDeferredApprovalReply, retryDeferredApprovalNotifications })
    await router.handleInbound(makeInbound({ messageId: 'feishu-approval-reply', replyToMessageId: 'trusted-notice', content: '批准 07' }))
    expect(handleDeferredApprovalReply).toHaveBeenCalledWith(expect.objectContaining({ text: '批准 07', replyToMessageId: 'trusted-notice' }))
    expect(retryDeferredApprovalNotifications).toHaveBeenCalledWith({ identityKey: 'chat-1', ownerId: 'user-1' })
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(processedStore.tryClaim).not.toHaveBeenCalled()
  })

  it('routes an approval-shaped message as an ordinary inbound while the durable gate is closed', async () => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '批准 07' })
    const session = createSession(db, { name: 'Feishu closed approval gate' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    const { router } = makeRouter(db, manager, { handleDeferredApprovalReply, wakeDispatcher: { dispatchSession }, approvalGate: false })
    await router.handleInbound(makeInbound({ messageId: 'feishu-closed-approval-reply', content: '批准 07' }))
    expect(handleDeferredApprovalReply).not.toHaveBeenCalled()
    expect(listWakeEvents(db, session.id)).toHaveLength(1)
    expect(listWakeEvents(db, session.id)[0]?.payloadRef.kind).toBe('im-inbox-message')
    const queueScope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    expect(listImInboxMessages(db, { queueScope }).map(({ content }) => content)).toContain('批准 07')
    expect(dispatchSession).toHaveBeenCalledWith(session.id)
  })

  it('retries a real undelivered approval notification after owner authentication', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu notification retry' })
    const todoStore = createDeferredTodoStore(db)
    const now = Date.now()
    const todo = todoStore.create({ todoId: 'router-retry-todo', invocationId: 'router-retry-invocation', channel: 'feishu',
      identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 4, rule: { ruleId: 'write', factsHash: 'c'.repeat(64) },
      workflowId: 'workflow', taskId: 'task', stepId: 'step', planRevision: 1, originSessionId: session.id,
      createdAt: now, expiresAt: now + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: session.id,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'router-retry-checkpoint', workflowRevision: 2 })
    const adapter = { send: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ messageId: 'approval-retry-msg' }) }
    let code = 7
    const delivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents, adapter,
      allocateShortCode: () => String(code++).padStart(2, '0'), audit: vi.fn() })
    await expect(delivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId, channel: 'feishu',
      identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule: todo.rule,
      safeActionSummary: '更新项目说明', userDelegation: '更新项目说明', untrustedMaterial: '' })).resolves.toMatchObject({ state: 'undelivered' })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '批准 07' })
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    const { router } = makeRouter(db, manager, { wakeDispatcher: { dispatchSession }, approvalGate: false,
      retryDeferredApprovalNotifications: ({ identityKey, ownerId }) => delivery.retryForAuthenticatedInbound({
        channel: 'feishu', identityKey, ownerId, authorizationEpoch: 4
      }) })
    await router.handleInbound(makeInbound({ messageId: 'authenticated-notification-retry', content: '批准 07' }))
    expect(adapter.send).toHaveBeenCalledTimes(2)
    expect(delivery.resolveCurrent({ channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 4, shortCode: '08' }))
      .toMatchObject({ trustedMessageId: 'approval-retry-msg', notificationVersion: 2 })
  })

  it('durably accepts an authenticated inbound before asynchronously dispatching its Loop', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu async acceptance' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'persist this first' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    let finishAgent!: (value: { summary: string; pendingConfirm: boolean; ok: boolean }) => void
    mockRunFeishuRemoteAgent.mockImplementation(() => new Promise((resolve) => { finishAgent = resolve }))
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    const { router, processedStore } = makeRouter(db, manager, { wakeDispatcher: { dispatchSession } })
    const queueScope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>

    const handled = router.handleInbound(makeInbound({ messageId: 'feishu-async-accept-1' }))
    const returnedQuickly = await Promise.race([
      handled.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ])
    if (finishAgent) finishAgent({ summary: 'done', pendingConfirm: false, ok: true })
    await handled

    expect(returnedQuickly).toBe(true)
    expect(listQueuedUserMessages(db, { sessionId: session.id, queueScope })).toHaveLength(1)
    expect(listWakeEvents(db, session.id)).toHaveLength(1)
    expect(dispatchSession).toHaveBeenCalledWith(session.id)
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })

  it('recovers a persisted Feishu inbox wake event through the original turn execution path', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu wake recovery', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    const queueScope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const persisted = appendImInboxMessageWithWakeEvent(db, {
      sessionId: session.id, channel: 'feishu', queueScope, channelMessageId: 'replay-feishu-1', content: '原始排队消息'
    })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `wake-feishu-${++turnSequence}` } })
    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'recovered', pendingConfirm: false, ok: true })

    await router.dispatchWakeEventSet({ sessionId: session.id, runId: 'wake-run-1', ownerId: 'wake-run-1',
      eventIds: [persisted.eventId], events: listWakeEvents(db, session.id) })

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(mockRunFeishuRemoteAgent.mock.calls[0]?.[0]).toMatchObject({ userMessage: '原始排队消息' })
    expect(mockRunFeishuRemoteAgent.mock.calls[0]?.[0]).toMatchObject({ replyMessageId: 'replay-feishu-1' })
    const turn = getTurnByRequestId(db, session.id, `wake:${persisted.eventId}`)
    expect(turn).toMatchObject({ requestId: `wake:${persisted.eventId}`, userMessageId: persisted.messageId, outcome: 'completed' })
    expect(getDbConnection(db).prepare('SELECT state FROM im_inbox_claims WHERE message_id=?').get(persisted.messageId)).toEqual({ state: 'acked' })
  })

  it('acks a Feishu inbox wake when the remote turn parks for deferred approval', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu parked wake', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const persisted = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'parked-feishu-message', content: '发布并等待审批' })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `parked-feishu-${++sequence}` } })
    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: '', pendingConfirm: true, parked: true, ok: true })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(session.id)

    expect(getTurnByRequestId(db, session.id, `wake:${persisted.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'parked' })
    expect(listWakeEvents(db, session.id)).toMatchObject([{ eventId: persisted.eventId, status: 'acked' }])
    expect(getDbConnection(db).prepare('SELECT state FROM im_inbox_claims WHERE message_id=?').get(persisted.messageId)).toEqual({ state: 'acked' })
    expect(mockSendFeishuRemoteOutbound).not.toHaveBeenCalled()
    await dispatcher.dispose()
  })

  it('consumes a persisted deferred completion wake and resumes the original Feishu task turn', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu completion wake', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const persisted = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'completion-source-message', content: '发布报告' })
    expect(listImInboxMessages(db, { queueScope: scope }).map(({ messageId, content }) => ({ messageId, content }))).toContainEqual({ messageId: persisted.messageId, content: '发布报告' })
    const todoStore = createDeferredTodoStore(db)
    const rule = { ruleId: 'write', factsHash: '9'.repeat(64) }
    const todo = todoStore.create({ todoId: 'feishu-completion-todo', invocationId: 'feishu-completion-invocation', channel: 'feishu',
      identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 1, rule, workflowId: 'workflow', taskId: 'task', stepId: 'publish',
      planRevision: 1, originSessionId: session.id, createdAt: Date.now(), expiresAt: Date.now() + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: session.id,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: 1 })
    intents.linkTodo(todo.invocationId, todo.todoId)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'feishu-completion-checkpoint', workflowRevision: 1 })
    createDeferredEnvelopeStore(db).put({ invocationId: todo.invocationId, requestId: 'source-request', turnId: 'source-turn',
      toolCallId: 'source-tool', toolName: 'write_file', canonicalArgs: {}, contentVersions: {}, executionContext: {
        currentUserMessageId: persisted.messageId, messageId: 'completion-source-message'
      } })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'source-turn', requestId: 'source-request', sessionId: session.id, lane: 'feishu',
      startToken: 'source-start', currentUserMessageId: persisted.messageId, transcriptVersion: 0,
      config: { lane: 'feishu', model: TEST_MODEL_NAME, llmServiceId: TEST_SERVICE_ID, thinkingEffort: 'low' } }))
    expect(createDeferredEnvelopeStore(db).get(todo.invocationId)?.executionContext.currentUserMessageId).toBe(persisted.messageId)
    const resultStore = createDeferredExecutionResultStore(db)
    resultStore.beginDispatch({ todoId: todo.todoId, invocationId: todo.invocationId, dispatchKey: 'feishu-completion-dispatch' })
    resultStore.commitResult(todo.todoId, { kind: 'completed', outputRef: 'deferred-result:feishu-completion-invocation', value: { ok: true, marker: 'REVIEW_TOOL_RESULT_FEISHU' } })
    expect(listWakeEvents(db, session.id)).toHaveLength(2)
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `feishu-completion-${++turnSequence}` } })
    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    mockRunFeishuRemoteAgent.mockImplementationOnce(async () => {
      setConfigValue(db, 'config.llmServices', JSON.stringify([
        { id: 'alternate-service', name: 'Alternate Service', baseUrl: 'https://alternate.example', supportedModelIds: [TEST_MODEL_NAME], createdAt: '2', updatedAt: '2' }
      ]))
      setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['alternate-service']))
      setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ 'alternate-service': 'enc:sk-alternate' }))
      setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: TEST_MODEL_NAME, remoteThinkingEffort: 'high' }))
      return { summary: '原始任务已接受', pendingConfirm: false, ok: true }
    })
      .mockResolvedValueOnce({ summary: '', pendingConfirm: true, parked: true, ok: true })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })
    await dispatcher.dispatchSession(session.id)
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(resultStore.getByTodo(todo.todoId)?.state).toBe('completion_outboxed')
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(listWakeEvents(db, session.id).find(({ type }) => type === 'safety-recovery')?.status).toBe('pending')
    await dispatcher.dispose()
  })

  it('runs the production wake dispatcher consumer after SQLite reopen', async () => {
    const dataDir = tempDir()
    dirs.push(dataDir)
    const databaseDir = tempDir()
    dirs.push(databaseDir)
    const dbPath = path.join(databaseDir, 'wake-reopen.db')
    const db = openDatabase(dbPath)
    openDbs.push(db)
    seedLlmConfig(db)
    const manager = createWorkDirManager({ db, getWorkDir: () => dataDir, setWorkDir: () => undefined })
    manager.addProfile({ name: 'Default', path: dataDir })
    setConfigValue(db, 'config.activeWorkDirProfileId', JSON.stringify(manager.getActiveProfileId()))
    const session = createSession(db, { name: 'Feishu wake restart', metadata: { source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1' } })
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const persisted = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'reopen-feishu-message', content: '重启后派发' })
    db.close()
    openDbs.splice(openDbs.indexOf(db), 1)
    const reopened = openDatabase(dbPath)
    openDbs.push(reopened)
    const managerAfterRestart = createWorkDirManager({ db: reopened, getWorkDir: () => dataDir, setWorkDir: () => undefined })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(reopened), deps: { now: () => 1, id: () => `wake-feishu-restart-${++turnSequence}` } })
    const { router } = makeRouter(reopened, managerAfterRestart, { turnRuntime: runtime })
    const dispatch = vi.spyOn(router, 'dispatchWakeEventSet')
    const dispatcher = createWakeEventDispatcher({ db: reopened, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 100_000, maxDelayMs: 100_000, maxElapsedMs: 100_000, jitterRatio: 0 } })
    await dispatcher.dispatchSession(session.id)
    expect(dispatch.mock.results[0]?.type).toBe('return')
    await expect(dispatch.mock.results[0]?.value).resolves.toBeUndefined()
    expect(listWakeEvents(reopened, session.id)).toMatchObject([{ status: 'acked', eventId: persisted.eventId }])
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    await dispatcher.dispose()
  })

  it('keeps one active Feishu turn when the production dispatcher receives concurrent wake signals', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu wake single flight', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'single-flight-message', content: 'only once' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `wake-single-${++turnSequence}` } })
    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    let finishAgent!: (value: { summary: string; pendingConfirm: boolean; ok: boolean }) => void
    mockRunFeishuRemoteAgent.mockImplementation(() => new Promise((resolve) => { finishAgent = resolve }))
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    const first = dispatcher.dispatchSession(session.id)
    await vi.waitFor(() => expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1))
    const concurrent = dispatcher.dispatchSession(session.id)
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    finishAgent({ summary: 'done', pendingConfirm: false, ok: true })
    await Promise.all([first, concurrent])

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(listWakeEvents(db, session.id).every(({ status }) => status === 'acked')).toBe(true)
    await dispatcher.dispose()
  })

  it('persists and dispatches new inbound work instead of rejecting it while the session is busy', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu busy async acceptance' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'queue behind current run' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'unexpected synchronous run', pendingConfirm: false, ok: true })
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    tryClaimRemoteSession(session.id, 'active-loop-owner', 3)
    const { router, processedStore } = makeRouter(db, manager, { wakeDispatcher: { dispatchSession } })
    const queueScope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>

    await router.handleInbound(makeInbound({ messageId: 'feishu-busy-queue-1' }))

    expect(listQueuedUserMessages(db, { sessionId: session.id, queueScope })).toHaveLength(1)
    expect(listWakeEvents(db, session.id)).toMatchObject([{ status: 'pending' }])
    expect(dispatchSession).toHaveBeenCalledWith(session.id)
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(mockSendFeishuRemoteOutbound).not.toHaveBeenCalledWith(expect.objectContaining({ body: REMOTE_SESSION_BUSY_MESSAGE }))
    releaseRemoteSession(session.id, 'active-loop-owner')
  })

  it('fails closed when inbound persistence fails without acknowledging or dispatching', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu failed persistence' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'must persist before acceptance' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    const dispatchSession = vi.fn().mockResolvedValue(undefined)
    const { router, processedStore } = makeRouter(db, manager, { wakeDispatcher: { dispatchSession } })
    getDbConnection(db).exec(`CREATE TRIGGER fail_feishu_wake_outbox BEFORE INSERT ON wake_event_outbox
      BEGIN SELECT RAISE(ABORT, 'injected Feishu persistence failure'); END`)

    await router.handleInbound(makeInbound({ messageId: 'feishu-persistence-failure' }))

    expect(listQueuedUserMessages(db, {
      sessionId: session.id,
      queueScope: buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    })).toEqual([])
    expect(listWakeEvents(db, session.id)).toEqual([])
    expect(dispatchSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(processedStore.markCompleted).toHaveBeenCalledWith('feishu-persistence-failure', expect.any(String), 'persistence_failed')
    expect(mockSendFeishuRemoteOutbound).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'feishu-persistence-failure', body: '已收到，正在处理…' })
    )
  })

  it('记录远端 Agent 执行失败为失败终态，而不是成功', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Failed Feishu turn' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'run and fail' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'provider failed', pendingConfirm: false, ok: false })

    const { router, auditAppend } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'failed-turn-1' }))

    expect(mockConsumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      { type: 'source-failed' },
      expect.any(String)
    )
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_done', sessionId: session.id, success: false
    }))
  })

  it('completion/audit/pending-confirm stay on the origin session after a mid-run switch_session, while outbound reply follows the switched session', async () => {
    const { db, manager } = setupDbAndManager()
    const origin = createSession(db, { name: 'Origin' })
    const target = createSession(db, { name: 'Target' })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: origin.id, isNew: false })
    mockRunFeishuRemoteAgent.mockImplementation(
      async ({ remoteContext }: { remoteContext: { outboundSessionId?: string; originSessionId?: string } }) => {
        // Simulate a switch_session tool call: only outbound moves, origin is immutable.
        expect(remoteContext.originSessionId).toBe(origin.id)
        remoteContext.outboundSessionId = target.id
        return { summary: 'done', pendingConfirm: true, ok: true }
      }
    )

    const wcSend = vi.fn()
    const { router, auditAppend } = makeRouter(db, manager, { wc: { send: wcSend } })
    await router.handleInbound(makeInbound({ messageId: 'switch-1' }))

    expect(wcSend).toHaveBeenCalledWith(
      'feishu:pending-confirm',
      expect.objectContaining({ sessionId: origin.id })
    )
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: target.id })
    )
    expect(auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent_done', sessionId: origin.id })
    )
  })

  it('rejects sensitive profile on inbound', async () => {
    const { db, manager, dirA } = setupDbAndManager()
    manager.addProfile({ name: 'Secret', path: dirA, aliases: ['secret'], sensitive: true })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '/sa @secret hi' })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'msg-2', content: '/sa @secret hi' }))

    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-2',
        body: '该项目为敏感项目，不允许远程访问'
      })
    )
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })
})

describe('RemoteCommandRouter busy guard', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  beforeEach(() => {
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
    resetRunningRemoteAgentRegistryForTests()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function makeRouter(
    db: ReturnType<typeof openDatabase>,
    manager: ReturnType<typeof createWorkDirManager>,
    options?: { maxParallel?: number; tryResolveConfirm?: boolean; turnRuntime?: TurnRuntime }
  ) {
    const processedStore = makeProcessedStore()
    const router = new RemoteCommandRouter({
      turnRuntime: options?.turnRuntime ?? testTurnRuntime,
      db,
      sessionStorage: createSqliteSessionStorage(db),
      runner: { run: vi.fn() } as never,
      processedStore: processedStore as never,
      imChannel: {
        tryResolveFromInboundMessage: () => options?.tryResolveConfirm ?? false
      } as never,
      auditLogger: { append: vi.fn().mockResolvedValue(undefined) } as never,
      getFeishuConfig: () =>
        mergeFeishuConfig({
          enabled: true,
          remoteEnabled: true,
          appConfigured: true,
          remoteSenderAllowlist: ['user-1']
        }),
      getAppConfig: () => ({
        defaultModel: 'claude-sonnet-4-20250514',
        maxParallelChatSessions: options?.maxParallel ?? 3,
        workDirProfiles: manager.listProfiles(),
        activeWorkDirProfileId: manager.getActiveProfileId()
      }),
      getWorkDir: () => manager.getActiveWorkDir(),
      workDirManager: manager,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'key',
      getBaseUrl: () => '',
      getMainWebContents: () => null,
      getModel: () => 'claude-sonnet-4-20250514',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG
    })
    return { router, processedStore }
  }

  function setup() {
    const dir = tempDir()
    dirs.push(dir)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    seedLlmConfig(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dir,
      setWorkDir: () => undefined
    })
    return { db, manager, dir }
  }

  it('rejects second inbound when session is busy', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'S1' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    tryClaimRemoteSession(session.id, 'req-busy', 3)
    const { router, processedStore } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'm2' }))

    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'm2',
        body: REMOTE_SESSION_BUSY_MESSAGE,
        sessionId: session.id
      })
    )
    expect(processedStore.markCompleted).toHaveBeenCalledWith('m2', expect.any(String), 'session_busy')
    releaseRemoteSession(session.id, 'req-busy')
  })

  it('TOCTOU: concurrent inbounds for same session start only one agent', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'S1' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const { router } = makeRouter(db, manager)
    await Promise.all([
      router.handleInbound(makeInbound({ messageId: 'm1' })),
      router.handleInbound(makeInbound({ messageId: 'm2' }))
    ])

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
  })

  it('allows confirm resolution without claiming session', async () => {
    const { db, manager } = setup()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'Y' })
    const { router } = makeRouter(db, manager, { tryResolveConfirm: true })
    await router.handleInbound(makeInbound({ content: 'Y', messageId: 'confirm-1' }))
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })

  it('remote agent 的非终态事实经 Runtime 消费，终态由统一 adapter 收敛', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Fact pipeline' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'run tool' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockImplementation(async ({ emitFactEvent }: { emitFactEvent?: (event: unknown) => void }) => {
      emitFactEvent?.({ type: 'tool-use', id: 'tool-1', toolName: 'read_file', input: { path: 'README.md' } })
      return { summary: 'done', pendingConfirm: false, ok: true }
    })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'fact-pipeline-1' }))

    expect(mockConsumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'tool-use', id: 'tool-1' }),
      expect.any(String)
    )
    expect(testTurnRuntime.consumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      { type: 'source-completed' },
      expect.any(String)
    )
    const calls = mockConsumeForRequest.mock.calls
    expect(calls.findIndex(([, event]) => (event as { type: string }).type === 'tool-use'))
      .toBeLessThan(calls.findIndex(([, event]) => (event as { type: string }).type === 'source-completed'))
  })

  it('Feishu router 将同一个 prepared turn 交给 agent 并用该 turnId 写入终态', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu turn identity chain' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `feishu-chain-${++turnSequence}` } })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'identity chain' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'done', pendingConfirm: false, ok: true })

    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    await router.handleInbound(makeInbound({ messageId: 'identity-chain-feishu' }))

    const [agentArgs] = mockRunFeishuRemoteAgent.mock.calls[0] as [{
      requestId: string
      turnId: string
      acceptedTurn: { turnId: string; requestId: string; sessionId: string; currentUserMessageId: string }
    }]
    const persisted = getPersistedTurn(db, agentArgs.turnId)
    expect(agentArgs.acceptedTurn).toMatchObject({
      turnId: agentArgs.turnId,
      requestId: agentArgs.requestId,
      sessionId: session.id,
      currentUserMessageId: persisted?.userMessageId
    })
    expect(persisted).toMatchObject({
      requestId: agentArgs.requestId, sessionId: session.id, state: 'terminal', outcome: 'completed'
    })
  })

  it('confirm-requested 进入 Core，并向 Feishu 出站 pending-confirm 提示', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Confirm pipeline' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'confirm me' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockImplementation(async ({ emitFactEvent }: { emitFactEvent?: (event: unknown) => void }) => {
      emitFactEvent?.({ type: 'confirm-requested', toolUseId: 'tool-feishu-confirm', toolName: 'run_shell' })
      return { summary: 'waiting', pendingConfirm: true, ok: true }
    })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'confirm-pipeline-1' }))

    expect(mockConsumeForRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'confirm-requested', toolUseId: 'tool-feishu-confirm' }),
      expect.any(String)
    )
    // pending-confirm 的桌面窗口通知已有 origin-session switch fixture 覆盖；此处锁定
    // 远程确认事实不会被 adapter 过滤掉。
  })

  it('releases claim when bind fails so retry can succeed', async () => {
    const { db, manager, dir } = setup()
    const good = manager.addProfile({ name: 'Good', path: dir, aliases: ['good'] })

    const session = createSession(db, { name: 'S1' })
    mockShouldAcceptInbound
      .mockReturnValueOnce({ accept: true, userMessage: '/sa @good hi' })
      .mockReturnValueOnce({ accept: true, userMessage: '/sa @good retry' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const bindSpy = vi.spyOn(workDirBinding, 'bindSessionWorkDir')
    bindSpy.mockResolvedValueOnce({ success: false, error: 'bind failed' })
    bindSpy.mockImplementationOnce(async (...args) => {
      bindSpy.mockRestore()
      return workDirBinding.bindSessionWorkDir(...args)
    })

    const { router, processedStore } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'bind-fail', content: '/sa @good hi' }))
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(processedStore.markCompleted).toHaveBeenCalledWith(
      'bind-fail',
      expect.any(String),
      'workdir_bind_failed'
    )

    await router.handleInbound(makeInbound({ messageId: 'bind-ok', content: '/sa @good retry' }))
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(getSession(db, session.id)?.workDirProfileId).toBe(good.profile!.id)
  })

  it('global parallel cap: only maxParallel agents start', async () => {
    const { db, manager } = setup()
    const s1 = createSession(db, { name: 'S1' })
    const s2 = createSession(db, { name: 'S2' })
    const s3 = createSession(db, { name: 'S3' })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession
      .mockResolvedValueOnce({ sessionId: s1.id, isNew: false })
      .mockResolvedValueOnce({ sessionId: s2.id, isNew: false })
      .mockResolvedValueOnce({ sessionId: s3.id, isNew: false })

    const releases: Array<() => void> = []
    mockRunFeishuRemoteAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ summary: 'ok', pendingConfirm: false, ok: true }))
        })
    )

    const { router, processedStore } = makeRouter(db, manager, { maxParallel: 2 })
    void router.handleInbound(makeInbound({ messageId: 'p1' }))
    void router.handleInbound(makeInbound({ messageId: 'p2' }))
    await vi.waitFor(() => expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(2))
    await router.handleInbound(makeInbound({ messageId: 'p3' }))

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(2)
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'p3',
        body: REMOTE_PARALLEL_FULL_MESSAGE,
        sessionId: s3.id
      })
    )
    expect(processedStore.markCompleted).toHaveBeenCalledWith('p3', expect.any(String), 'parallel_full')

    releases.forEach((r) => r())
  })
})
