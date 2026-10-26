import { getTurnByRequestId } from '../database/operations'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSession, createSession, getPersistedTurn } from '../database/operations'
import { openDatabase, getConfigValue, setConfigValue } from '../database'
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
import { appendMessage as appendMessageOperation, createPersistedTurn, listQueuedUserMessages } from '../database/operations'
import { listWakeEvents } from '../database/wakeEvents'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { getDbConnection } from '../database/sqliteStore'
import { ackImInboxMessage, appendImInboxMessageWithWakeEvent, claimImInboxMessage, listImInboxMessages, parkImInboxMessageForClarification } from '../database/imInbox'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredApprovalNotificationDelivery } from '../remote/deferredApprovalNotificationDelivery'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext } from '../database/acceptedTurnStorage'
import { attributeAndPersistRemoteMessage } from '../remote/remoteTrackAttributionService'
import { appendRemoteTrackEvent, createRemoteTrack, mapRemoteTrackMessage } from '../database/remoteTrackStore'
import { finishClarificationSendAttempt, startClarificationSendAttempt } from '../database/clarificationStore'
import { createDeferredApprovalRuntime } from '../remote/deferredApprovalRuntime'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'
import { loadEffectivePolicyRules } from '../confirmation/policyRulesRuntime'
import { FeishuImChannel } from './feishuImChannel'
import { assertImOutboundAllowed, type ImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'

vi.mock('../secureApiKey', () => ({ encryptSecret: (value: string) => `enc:${value}`, decryptSecret: (value: string) => value.replace(/^enc:/, '') , isSecretEncrypted: (value: string) => value.startsWith('enc:'), isLegacySecret: (value: string) => !value.startsWith('enc:'), }))

const mockRunFeishuRemoteAgent = vi.fn()
const mockResolveFeishuSession = vi.fn()
const mockSendFeishuRemoteOutbound = vi.fn()
const mockShouldAcceptInbound = vi.fn()
const mockConsumeForRequest = vi.fn()

function installFeishuOutboundGateMock(): void {
  mockSendFeishuRemoteOutbound.mockImplementation(async (value: unknown) => {
    const args = value as { body?: string; sessionId?: string; messageId?: string; recipient?: string; outboundDeliveryFacts?: ImOutboundFacts }
    if (!args.outboundDeliveryFacts || !args.body || !args.sessionId || !args.recipient || !args.messageId) {
      throw new Error('FEISHU_ROUTER_OUTBOUND_FACTS_MISSING')
    }
    assertImOutboundAllowed(args.outboundDeliveryFacts, { channel: 'feishu', body: args.body, sessionId: args.sessionId,
      recipient: args.recipient, destinationId: args.messageId })
    return undefined
  })
}

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
  sendFeishuRemoteOutbound: (...args: unknown[]) => mockSendFeishuRemoteOutbound(...args),
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
    installFeishuOutboundGateMock()
  })

  afterEach(() => {
    vi.clearAllMocks()
    mockSendFeishuRemoteOutbound.mockReset()
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
    options?: { maxParallel?: number; tryResolveConfirm?: boolean; imChannel?: FeishuImChannel; approvalGate?: boolean; wc?: { send: (...args: unknown[]) => void }; turnRuntime?: TurnRuntime; wakeDispatcher?: { dispatchSession: (sessionId: string) => Promise<void> }; retryDeferredApprovalNotifications?: (scope: { identityKey: string; ownerId: string }) => Promise<unknown>; handleDeferredApprovalReply?: (input: { message: FeishuInboundMessage; text: string }) => Promise<void>; isDeferredApprovalReplyTarget?: (input: { identityKey: string; ownerId: string; messageId: string }) => boolean; resolveQuotedReplyContext?: (input: { message: FeishuInboundMessage }) => Promise<{ content: string; sessionId?: string } | null>; handleClarificationReply?: (input: import('../remote/clarificationInbound').ClarificationResolverInput) => Promise<import('../remote/clarificationInbound').ClarificationResolverResult> }
  ) {
    const auditAppend = vi.fn().mockResolvedValue(undefined)
    const processedStore = makeProcessedStore()
    const router = new RemoteCommandRouter({
      turnRuntime: options?.turnRuntime ?? testTurnRuntime,
      db,
      sessionStorage: createSqliteSessionStorage(db),
      runner: { run: vi.fn() } as never,
      processedStore: processedStore as never,
      imChannel: options?.imChannel ?? {
        tryResolveFromInboundMessage: () => options?.tryResolveConfirm ?? false,
        listPendingTrackConfirmations: () => []
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
      isDeferredApprovalReplyTarget: options?.isDeferredApprovalReplyTarget,
      resolveQuotedReplyContext: options?.resolveQuotedReplyContext,
      handleClarificationReply: options?.handleClarificationReply,
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

  it.each(['批准 07', '拒绝 07'])('routes deferred approval controls to the safety ingress before Inbox or the Skill: %s', async (text) => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: text })
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const retryDeferredApprovalNotifications = vi.fn(async () => [])
    const { router, processedStore } = makeRouter(db, manager, { handleDeferredApprovalReply, retryDeferredApprovalNotifications })
    await router.handleInbound(makeInbound({ messageId: 'feishu-approval-reply', replyToMessageId: 'trusted-notice', content: text }))
    expect(handleDeferredApprovalReply).toHaveBeenCalledWith(expect.objectContaining({ text, replyToMessageId: 'trusted-notice' }))
    expect(retryDeferredApprovalNotifications).toHaveBeenCalledWith({ identityKey: 'chat-1', ownerId: 'user-1' })
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(processedStore.tryClaim).not.toHaveBeenCalled()
  })

  it('keeps an ordinary quoted rejection in the conversation when the quote is not an approval notice', async () => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '拒绝该提案' })
    const session = createSession(db, { name: 'Feishu proposal discussion', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: '已处理', pendingConfirm: false, ok: true })
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const resolveQuotedReplyContext = vi.fn(async () => ({ content: '已生成 Wiki Schema 变更提案；提案尚未批准、未应用。', sessionId: session.id }))
    const { router } = makeRouter(db, manager, { handleDeferredApprovalReply, isDeferredApprovalReplyTarget: () => false, resolveQuotedReplyContext })

    await router.handleInbound(makeInbound({ messageId: 'proposal-rejection', replyToMessageId: 'proposal-response', content: '拒绝该提案' }))

    expect(handleDeferredApprovalReply).not.toHaveBeenCalled()
    expect(resolveQuotedReplyContext).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ replyToMessageId: 'proposal-response' }) }))
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id,
      userMessage: expect.stringContaining('已生成 Wiki Schema 变更提案') }))
  })

  it('keeps malformed approval text replying to a trusted notice reserved for the safety ingress', async () => {
    const { db, manager } = setupDbAndManager()
    const handleDeferredApprovalReply = vi.fn(async () => undefined)
    const { router } = makeRouter(db, manager, { handleDeferredApprovalReply, isDeferredApprovalReplyTarget: () => true })

    await router.handleInbound(makeInbound({ messageId: 'malformed-approval-reply', replyToMessageId: 'trusted-notice', content: '拒绝该提案' }))

    expect(handleDeferredApprovalReply).toHaveBeenCalledWith(expect.objectContaining({ text: '拒绝该提案', replyToMessageId: 'trusted-notice' }))
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
  })

  it('fails closed when a quoted approval-like message has no readable app reply context', async () => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '拒绝该提案' })
    const { router, processedStore } = makeRouter(db, manager, {
      isDeferredApprovalReplyTarget: () => false,
      resolveQuotedReplyContext: async () => null
    })

    await router.handleInbound(makeInbound({ messageId: 'proposal-rejection-without-context', replyToMessageId: 'proposal-response', content: '拒绝该提案' }))

    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(processedStore.markCompleted).toHaveBeenCalledWith('proposal-rejection-without-context', expect.any(String), 'quoted_context_unavailable')
  })

  it('routes a strict synchronous confirmation through the Feishu adapter before async approval ingress', async () => {
    const { db, manager } = setupDbAndManager()
    const imChannel = new FeishuImChannel({ sendConfirmationPrompt: async () => ({ messageId: 'strict-feishu-trusted-prompt' }) })
    const confirmation = imChannel.request({ facts: { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium',
      signals: [], summary: { text: 'write report.md' } }, riskLevel: 'medium', memoryTiers: [], timeoutMs: 60_000 },
    { sessionId: 'strict-feishu-session', toolName: 'write_file', toolInput: { path: 'report.md' },
      messageId: 'strict-feishu-origin', matchKey: 'chat-1', authOwner: 'user-1' })
    await vi.waitFor(() => expect(imChannel.listPending()).toHaveLength(1))
    const confirmId = imChannel.listPending()[0]!.confirmId!
    expect(confirmId).toMatch(/^\d{2}$/)
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: `Y ${confirmId}` })
    const asyncApprovalIngress = vi.fn(async () => undefined)
    const { router, processedStore } = makeRouter(db, manager, { imChannel, handleDeferredApprovalReply: asyncApprovalIngress })

    await router.handleInbound(makeInbound({ messageId: 'strict-feishu-reply', replyToMessageId: 'strict-feishu-trusted-prompt',
      content: `Y ${confirmId}` }))

    await expect(confirmation).resolves.toMatchObject({ kind: 'approved', cause: 'user-approved' })
    expect(imChannel.listPending()).toHaveLength(0)
    expect(asyncApprovalIngress).not.toHaveBeenCalled()
    expect(processedStore.tryClaim).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })

  it('routes a Feishu adapter reply with a valid short code through SQLite approval runtime to one dispatch', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'feishu-real-approval-ingress' })
    const now = Date.now()
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: now, eventId: 'feishu-adapter-approval-policy' })
    const rule = { ruleId: 'write-rule', factsHash: 'b'.repeat(64) }
    const todoStore = createDeferredTodoStore(db)
    const todo = todoStore.create({ todoId: 'feishu-adapter-todo', invocationId: 'feishu-adapter-invocation', channel: 'feishu',
      identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 4, rule, workflowId: 'workflow', taskId: 'task',
      stepId: 'step', planRevision: 1, originSessionId: session.id, createdAt: now, expiresAt: now + 60_000 }).todo
    const intents = createSecurityActionIntentStore(db)
    intents.prepare({ invocationId: todo.invocationId, envelopeInvocationId: todo.invocationId, sessionId: session.id,
      workflowId: todo.workflowId, taskId: todo.taskId, stepId: todo.stepId, planRevision: todo.planRevision, now })
    intents.linkTodo(todo.invocationId, todo.todoId, now)
    intents.commitCheckpoint(todo.invocationId, { checkpointId: 'feishu-adapter-checkpoint', workflowRevision: 1 }, now)
    const envelopeStore = createDeferredEnvelopeStore(db)
    envelopeStore.put({ invocationId: todo.invocationId, requestId: 'feishu-source-request', turnId: 'feishu-source-turn',
      toolCallId: 'feishu-source-tool', toolName: 'write_file', canonicalArgs: { path: 'approved.md', content: 'approved' },
      contentVersions: {}, executionContext: { sessionId: session.id, channel: 'feishu', ownerId: todo.ownerId, identityKey: todo.identityKey,
        authorizationEpoch: todo.authorizationEpoch, invocationId: todo.invocationId, toolName: 'write_file',
        toolInput: { path: 'approved.md', content: 'approved' }, requestId: 'feishu-source-request', turnId: 'feishu-source-turn',
        toolCallId: 'feishu-source-tool', providerRouteId: 'feishu-route', messageId: 'source-message',
        policyBehaviorVersion: todo.policyBehaviorVersion, policyRevision: todo.policyRevision, policyEpoch: todo.policyEpoch,
        ruleId: rule.ruleId, factsHash: rule.factsHash }, now })
    const notificationDelivery = createDeferredApprovalNotificationDelivery({ db, todoStore, intentStore: intents,
      adapter: { send: async () => ({ messageId: 'feishu-trusted-notice' }) }, allocateShortCode: () => '07', audit: vi.fn() })
    const notification = await notificationDelivery.createAndSend({ todoId: todo.todoId, invocationId: todo.invocationId,
      channel: 'feishu', identityKey: todo.identityKey, ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch,
      rule, safeActionSummary: '更新项目说明', userDelegation: '更新项目说明', untrustedMaterial: '', now })
    expect(notification.state).toBe('delivered')
    const dispatch = vi.fn(async (_request, _currentTodo, envelope) => ({ dispatched: envelope.integrityHash.length > 0 }))
    const approvalRuntime = createDeferredApprovalRuntime({ db, channel: 'feishu', todoStore, envelopeStore, notificationDelivery,
      isEnabled: () => true, getAuthorizationEpoch: () => 4, maxParallel: 1,
      recheck: async (request, currentTodo, envelope) => ({ allowed: request.sessionId === currentTodo.originSessionId
        && envelope.invocationId === todo.invocationId && envelope.canonicalArgs.path === 'approved.md' }),
      dispatch, audit: vi.fn() })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '批准 07' })
    const { router } = makeRouter(db, manager, { handleDeferredApprovalReply: async ({ message, text, replyToMessageId }) => {
      await approvalRuntime.handleReply({ channel: 'feishu', identityKey: message.chatId, ownerId: message.senderOpenId,
        messageId: message.messageId, replyToMessageId, text, now: now + 1 })
    } })

    expect(dispatch).not.toHaveBeenCalled()
    await router.handleInbound(makeInbound({ messageId: 'feishu-adapter-approval-reply', replyToMessageId: 'feishu-trusted-notice', content: '批准 07' }))

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({ requestId: 'feishu-source-request', toolCallId: 'feishu-source-tool',
      canonicalArgs: { path: 'approved.md', content: 'approved' } })
    expect(todoStore.get(todo.todoId, { channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 4,
      originSessionId: session.id, rule })?.status)
      .toBe('consumed')
    expect(listImInboxMessages(db, { queueScope: buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }> }))
      .toHaveLength(0)
  })

  it('consumes clarification selections before the Agent and delegates only the strict parsed choice', async () => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '选择 ABCD-EFGH-JK345 2' })
    const handleClarificationReply = vi.fn(async () => ({ kind: 'resolved' as const, trackId: 'track-1', workId: 'work-1' }))
    const { router, processedStore } = makeRouter(db, manager, { handleClarificationReply })
    await router.handleInbound(makeInbound({ messageId: 'clarification-choice', content: '选择 ABCD-EFGH-JK345 2' }))
    expect(handleClarificationReply).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1', replyMessageId: 'clarification-choice',
      handle: 'ABCDEFGHJK345', option: 2
    }))
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(processedStore.markCompleted).toHaveBeenCalledWith('clarification-choice', expect.any(String), 'clarification_resolved')
  })

  it('resolves a Feishu clarification through the default resolver when chatId differs from senderOpenId', async () => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu clarification identity', metadata: {
      source: 'feishu', feishuChatId: 'chat-workspace-42', feishuSenderOpenId: 'user-1'
    } })
    createRemoteTrack(db, { trackId: 'feishu-identity-track', eventId: 'feishu-identity-root', idempotencyKey: 'feishu-identity-root-key',
      channel: 'feishu', identityKey: 'chat-workspace-42', ownerId: 'user-1', authorizationEpoch: 1,
      rootMessageId: 'feishu-identity-root-message', originSessionId: session.id, occurredAt: 1 })
    const parked = parkImInboxMessageForClarification(db, { sessionId: session.id, channel: 'feishu',
      queueScope: buildImQueueScope('feishu', session.id), channelMessageId: 'feishu-identity-source-message', content: '继续工作区任务',
      clarificationId: 'feishu-identity-clarification', identityKey: 'chat-workspace-42', ownerId: 'user-1', authorizationEpoch: 1,
      handle: 'GJKMNPQRST234', candidates: [{ trackId: 'feishu-identity-track', option: 1, label: '工作区任务', stateAtIssue: 'open' }],
      expiresAt: Date.now() + 60_000 })
    startClarificationSendAttempt(db, { sendAttemptId: 'feishu-identity-send', clarificationId: 'feishu-identity-clarification', version: 1, startedAt: Date.now() })
    finishClarificationSendAttempt(db, { sendAttemptId: 'feishu-identity-send', state: 'send-fulfilled', finishedAt: Date.now() })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '选择 GJKM-NPQR-ST234 1' })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["feishu"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `feishu-clarification-${++sequence}` } })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'continued', pendingConfirm: false, ok: true })
    let dispatcher: ReturnType<typeof createWakeEventDispatcher>
    const dispatchSession = vi.fn(async (sessionId: string) => dispatcher.dispatchSession(sessionId))
    const { router } = makeRouter(db, manager, { turnRuntime: runtime, wakeDispatcher: { dispatchSession } })
    dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await router.handleInbound(makeInbound({ messageId: 'feishu-identity-reply', chatId: 'chat-workspace-42', senderOpenId: 'user-1',
      content: '选择 GJKM-NPQR-ST234 1' }))

    expect(getDbConnection(db).prepare('SELECT state,selected_track_id FROM remote_clarifications WHERE clarification_id=?')
      .get('feishu-identity-clarification')).toEqual({ state: 'resolved', selected_track_id: 'feishu-identity-track' })
    expect(getDbConnection(db).prepare('SELECT session_id FROM remote_track_work_queue WHERE clarification_id=?')
      .get('feishu-identity-clarification')).toEqual({ session_id: session.id })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(parked.messageId)).toEqual({ status: 'sent' })
    expect(dispatchSession).toHaveBeenCalledWith(session.id)
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(mockRunFeishuRemoteAgent.mock.calls[0]?.[0]).toMatchObject({
      userMessage: '继续工作区任务', remoteContext: { trackContext: { trackId: 'feishu-identity-track' } }
    })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_track_work_queue WHERE clarification_id=?')
      .get('feishu-identity-clarification')).toEqual({ state: 'completed' })
    expect(getDbConnection(db).prepare('SELECT state FROM remote_tracks WHERE track_id=?')
      .get('feishu-identity-track')).toEqual({ state: 'completed' })
    await dispatcher.dispose()
  })

  it('reserves malformed clarification control syntax and does not queue it as user input', async () => {
    const { db, manager } = setupDbAndManager()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '选择 ABCD 1' })
    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'clarification-malformed', content: '选择 ABCD 1' }))
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('澄清回复格式无效') }))
    expect(getDbConnection(db).prepare('SELECT channel,platform_message_id,event_kind,reason_code FROM remote_track_diagnostic_events').get())
      .toEqual({ channel: 'feishu', platform_message_id: 'clarification-malformed', event_kind: 'clarification.reply', reason_code: 'invalid' })
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
    const dispatchSession = vi.fn(async () => undefined)
    const { router } = makeRouter(db, manager, { turnRuntime: runtime, wakeDispatcher: dispatchSession })
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
    mockRunFeishuRemoteAgent.mockRejectedValue(new Error('E_PROVIDER_TIMEOUT'))

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
    const outboundBodies = mockSendFeishuRemoteOutbound.mock.calls.map(([args]) => String((args as { body?: unknown }).body))
    const failureBodies = outboundBodies.filter((body) => body !== '已收到，正在处理…')
    expect(failureBodies).toHaveLength(1)
    expect(failureBodies[0]).not.toMatch(/E_PROVIDER_TIMEOUT|请打开 SpaceAssistant/)
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

  it.each([
    { name: 'non-owner DM', reason: 'non_owner', chatType: 'p2p' as const, ruleId: 'ingress-direct-other-deny', senderOpenId: 'external-user' },
    { name: 'group message', reason: 'group_disabled', chatType: 'group' as const, ruleId: 'ingress-feishu-group-deny', senderOpenId: 'user-1' }
  ])('passes a $name through the Feishu ingress policy when its rule is allow', async ({ reason, chatType, ruleId, senderOpenId }) => {
    const { db, manager } = setupDbAndManager()
    const session = createSession(db, { name: 'Feishu non-owner policy allow' })
    commitImPolicySnapshot(getDbConnection(db), { policyBehaviorVersion: 'im-v1.6',
      snapshot: { selectedPackage: 'custom', ruleOverrides: { [ruleId]: 'allow' } }, updatedAt: 1,
      eventId: `feishu-ingress-${ruleId}-allow` })
    expect(loadEffectivePolicyRules(db, 'feishu').find(({ id }) => id === ruleId)?.action).toBe('allow')
    mockShouldAcceptInbound.mockReturnValue({ accept: false, reason })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ ok: true, summary: 'done' })
    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: `${reason}-allowed`, chatType, senderOpenId }))
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledOnce()
  })
})

describe('RemoteCommandRouter busy guard', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  beforeEach(() => {
    installFeishuOutboundGateMock()
  })

  afterEach(() => {
    vi.clearAllMocks()
    installFeishuOutboundGateMock()
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
    options?: { maxParallel?: number; tryResolveConfirm?: boolean; turnRuntime?: TurnRuntime; wakeDispatcher?: { dispatchSession: (sessionId: string) => Promise<void> } }
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
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      wakeEventDispatcher: options?.wakeDispatcher as never
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
        sessionId: session.id,
        recipient: 'user-1',
        outboundIdentity: { identityKey: 'chat-1', ownerId: 'user-1', chatType: 'p2p' },
        outboundDeliveryFacts: expect.objectContaining({
          channel: 'feishu',
          purpose: 'system-reply',
          originSessionId: session.id,
          activeSessionId: session.id,
          identityKey: 'chat-1',
          ownerId: 'user-1',
          trustedRecipient: 'user-1',
          recipient: 'user-1',
          chatType: 'p2p',
          content: REMOTE_SESSION_BUSY_MESSAGE,
          contentAssessment: {
            source: 'host',
            content: REMOTE_SESSION_BUSY_MESSAGE,
            classification: 'ordinary',
            classifierVersion: 'host-im-outbound-v1'
          },
          destinationId: 'm2',
          contentCompleteness: 'complete'
        })
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

  it('uses the authenticated Feishu entry when the existing session metadata says WeChat', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu entry over WeChat metadata', metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user' } } })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'feishu entry' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'done', pendingConfirm: false, ok: true })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'feishu-entry-over-wechat-session' }))

    const agentArgs = mockRunFeishuRemoteAgent.mock.calls[0]?.[0] as { requestId: string; sessionId: string; acceptedTurn: { lane: string } }
    expect(agentArgs.acceptedTurn).toMatchObject({ lane: 'feishu' })
    expect(agentArgs.sessionId).toBe(session.id)
    expect(createSqliteSessionStorage(db).execution.readAccepted({ sessionId: session.id, requestId: agentArgs.requestId }))
      .toMatchObject({ lane: 'feishu', requestId: agentArgs.requestId })
  })

  it('Feishu wake replay validates persisted Track attribution and forwards the scoped view', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu Track wake' })
    const current = getSession(db, session.id)!
    getDbConnection(db).prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify({ ...current.metadata, source: 'feishu',
      feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1' }), session.id)
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const attribution = await attributeAndPersistRemoteMessage(db, { channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1',
      authorizationEpoch: 1, platformMessageId: 'feishu-track-wake-platform', text: 'queued research', now: 1, originSessionId: session.id }, { classify: vi.fn() },
      { sessionQueries: createSqliteSessionStorage(db).queries })
    if (attribution.kind !== 'attributed') throw new Error('expected a Track for zero candidates')
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'feishu-track-wake-platform', content: 'queued research', trackId: attribution.context.trackId,
      trackEventId: attribution.context.attributionEventId })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `feishu-track-wake-${++sequence}` } })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'done', pendingConfirm: false, ok: true })
    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(session.id)

    const [agentArgs] = mockRunFeishuRemoteAgent.mock.calls[0] as [{ remoteContext: { trackContext?: { trackId: string }; trackModelInputView?: { completeness: string }; turnId: string } }]
    expect(agentArgs.remoteContext.trackContext?.trackId).toBe(attribution.context.trackId)
    expect(agentArgs.remoteContext.trackModelInputView).toMatchObject({ completeness: 'complete' })
    expect(getDbConnection(db).prepare('SELECT track_id FROM turns WHERE turn_id=?').get(agentArgs.remoteContext.turnId)).toEqual({ track_id: attribution.context.trackId })
    expect(getTurnByRequestId(db, session.id, `wake:${inbox.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'completed' })
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(expect.objectContaining({
      trackDelivery: expect.objectContaining({ track: expect.objectContaining({ trackId: attribution.context.trackId }),
        requestId: `wake:${inbox.eventId}`, turnId: agentArgs.remoteContext.turnId })
    }))
    await dispatcher.dispose()
  })

  it('启动恢复会过期 Feishu 停放输入并重试投递未送达的终态回执', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu clarification expiry', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    createRemoteTrack(db, { trackId: 'feishu-expired-track', eventId: 'feishu-expired-event', idempotencyKey: 'feishu-expired-root',
      channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 1,
      rootMessageId: 'feishu-expired-root-message', originSessionId: session.id, occurredAt: 1 })
    parkImInboxMessageForClarification(db, { sessionId: session.id, channel: 'feishu', queueScope: buildImQueueScope('feishu', session.id),
      channelMessageId: 'feishu-expired-platform-message', content: '原始请求', clarificationId: 'feishu-expired-clarification',
      identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 1, handle: 'BCDEFGHJK3456',
      candidates: [{ trackId: 'feishu-expired-track', option: 1, label: '任务', stateAtIssue: 'open' }], expiresAt: 500, now: 100 })
    const { router } = makeRouter(db, manager)
    const run = vi.fn(async () => ({ timedOut: false, exitCode: 0, stdout: JSON.stringify({ code: 0 }) }))
    ;(router as unknown as { deps: { runner: { run: typeof run } } }).deps.runner.run = run

    await router.recoverClarificationLifecycle(500)

    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=(SELECT parked_input_ref FROM remote_clarifications WHERE clarification_id=?)')
      .get('feishu-expired-clarification')).toEqual({ status: 'clarification-expired' })
    expect(run).toHaveBeenCalledOnce()
    expect(JSON.stringify(run.mock.calls[0]?.[0])).toContain('user-1')
    expect(getDbConnection(db).prepare("SELECT state FROM im_lifecycle_outbox WHERE event_id='clarification-terminal:feishu-expired-clarification:expired'").get())
      .toEqual({ state: 'delivered' })
  })

  it('重启恢复会以同一澄清句柄重试结果未知的飞书提示', async () => {
    const { db, manager } = setup()
    const now = Date.now()
    const session = createSession(db, { name: 'Feishu clarification prompt recovery' })
    createRemoteTrack(db, { trackId: 'feishu-retry-track', eventId: 'feishu-retry-event', idempotencyKey: 'feishu-retry-root',
      channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 1,
      rootMessageId: 'feishu-retry-root-message', originSessionId: session.id, occurredAt: 1 })
    parkImInboxMessageForClarification(db, { sessionId: session.id, channel: 'feishu', queueScope: buildImQueueScope('feishu', session.id),
      channelMessageId: 'feishu-retry-platform-message', content: '原始请求', clarificationId: 'feishu-retry-clarification',
      identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 1, handle: 'CDEFGHJK34567',
      candidates: [{ trackId: 'feishu-retry-track', option: 1, label: '任务', stateAtIssue: 'open' }], expiresAt: now + 60_000, now: now - 120_000 })
    startClarificationSendAttempt(db, { sendAttemptId: 'feishu-retry-attempt-1', clarificationId: 'feishu-retry-clarification', version: 1, startedAt: now - 110_000 })
    finishClarificationSendAttempt(db, { sendAttemptId: 'feishu-retry-attempt-1', state: 'send-outcome-unknown', finishedAt: now - 100_000 })
    const { router } = makeRouter(db, manager)
    const run = vi.fn(async () => ({ timedOut: false, exitCode: 0, stdout: JSON.stringify({ code: 0 }) }))
    ;(router as unknown as { deps: { runner: { run: typeof run } } }).deps.runner.run = run

    await router.recoverClarificationLifecycle(now)

    expect(run).toHaveBeenCalledOnce()
    expect(JSON.stringify(run.mock.calls[0]?.[0])).toContain('CDEF-GHJK-34567')
    expect(getDbConnection(db).prepare(`SELECT state FROM remote_clarification_send_attempts
      WHERE clarification_id='feishu-retry-clarification' ORDER BY started_at DESC LIMIT 1`).get()).toEqual({ state: 'send-fulfilled' })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=(SELECT parked_input_ref FROM remote_clarifications WHERE clarification_id=?)')
      .get('feishu-retry-clarification')).toEqual({ status: 'parked' })
  })

  it('重启恢复 prepared accepted turn 时沿用飞书原 accepted 配置', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu prepared recovery', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    const queueScope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope,
      channelMessageId: 'feishu-prepared-platform-message', content: '恢复飞书原 accepted turn' })
    const frozenConfig = { lane: 'feishu' as const, model: 'claude-sonnet-4-20250514', llmServiceId: TEST_SERVICE_ID,
      thinkingEffort: 'low' as const, maximumContextTrusted: true, enableThinking: false }
    appendMessageOperation(db, { id: 'feishu-prepared-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'feishu-prepared-turn', requestId: `wake:${inbox.eventId}`, sessionId: session.id,
      userMessageId: inbox.messageId, assistantMessageId: 'feishu-prepared-assistant', state: 'prepared',
      startToken: 'feishu-prepared-token', executionConfig: frozenConfig })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'feishu-prepared-turn', requestId: `wake:${inbox.eventId}`, sessionId: session.id,
      lane: 'feishu', startToken: 'feishu-prepared-token', currentUserMessageId: inbox.messageId, transcriptVersion: 0, config: frozenConfig }))
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'missing-model', remoteThinkingEffort: 'low' }))
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'prepared turn resumed', pendingConfirm: false, ok: true })
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 10, id: () => 'unexpected-second-turn' } })
    const { router } = makeRouter(db, manager, { turnRuntime: runtime })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(session.id)

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledOnce()
    expect((mockRunFeishuRemoteAgent.mock.calls[0]?.[0] as { acceptedTurn: { turnId: string; config: { model: string; llmServiceId: string } } }).acceptedTurn)
      .toMatchObject({ turnId: 'feishu-prepared-turn', config: { model: 'claude-sonnet-4-20250514', llmServiceId: TEST_SERVICE_ID } })
    expect(getTurnByRequestId(db, session.id, `wake:${inbox.eventId}`)).toMatchObject({ state: 'terminal', outcome: 'completed' })
    expect(listWakeEvents(db, session.id)).toMatchObject([{ eventId: inbox.eventId, status: 'acked' }])
    await dispatcher.dispose()
  })

  it('provider 结果未知的终态 Feishu wake 只结算唤醒，不重发模型请求', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu uncertain terminal wake', metadata: {
      source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1'
    } })
    const queueScope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope,
      channelMessageId: 'feishu-uncertain-platform-message', content: '可能已执行的请求' })
    const requestId = `wake:${inbox.eventId}`
    const frozenConfig = { lane: 'feishu' as const, model: TEST_MODEL_NAME, llmServiceId: TEST_SERVICE_ID,
      thinkingEffort: 'low' as const, maximumContextTrusted: true, enableThinking: false }
    appendMessageOperation(db, { id: 'feishu-uncertain-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'failed' })
    createPersistedTurn(db, { turnId: 'feishu-uncertain-turn', requestId, sessionId: session.id,
      userMessageId: inbox.messageId, assistantMessageId: 'feishu-uncertain-assistant', state: 'terminal', outcome: 'commit-uncertain',
      startToken: 'feishu-uncertain-token', executionConfig: frozenConfig })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'feishu-uncertain-turn', requestId, sessionId: session.id,
      lane: 'feishu', startToken: 'feishu-uncertain-token', currentUserMessageId: inbox.messageId, transcriptVersion: 0, config: frozenConfig }))
    const inboxClaim = claimImInboxMessage(db, { queueScope, messageId: inbox.messageId, ownerId: 'prior-feishu-run' })
    expect(inboxClaim).not.toBeNull()
    expect(ackImInboxMessage(db, { queueScope, messageId: inbox.messageId, ownerId: 'prior-feishu-run' })).toBe(true)
    const { router } = makeRouter(db, manager)
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 2, launchLoop: (input) => router.dispatchWakeEventSet(input) })

    await dispatcher.dispatchSession(session.id, { retryExhausted: true })

    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(getTurnByRequestId(db, session.id, requestId)).toMatchObject({ state: 'terminal', outcome: 'commit-uncertain' })
    expect(listWakeEvents(db, session.id)).toMatchObject([{ eventId: inbox.eventId, status: 'acked' }])
    await dispatcher.dispose()
  })

  it('Track 路由先将 Feishu 新消息持久化到绑定归属的 inbox/wake，再交给 worker 执行', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu Track attribution', metadata: { source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1' } })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["feishu"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '新建调研' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    const dispatchSession = vi.fn(async () => undefined)
    const { router } = makeRouter(db, manager, { wakeDispatcher: dispatchSession })

    await router.handleInbound(makeInbound({ messageId: 'track-feishu-root', content: '新建调研' }))

    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    const context = getDbConnection(db).prepare(`SELECT context.track_id,context.track_event_id FROM im_inbox_message_context context
      WHERE context.platform_message_id='track-feishu-root'`).get() as { track_id: string; track_event_id: string }
    expect(context.track_id).toBeTruthy()
    expect(getDbConnection(db).prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(context.track_event_id))
      .toEqual({ track_id: context.track_id })
    expect(getDbConnection(db).prepare('SELECT track_id FROM remote_track_message_map WHERE channel=? AND platform_message_id=?').get('feishu', 'track-feishu-root'))
      .toEqual({ track_id: context.track_id })
    expect(listWakeEvents(db, session.id)).toMatchObject([{ type: 'im-inbound', status: 'pending' }])
  })

  it('Track execution 未接入持久 wake consumer 时 fail closed，不创建 Track 或运行 Agent', async () => {
    const { db, manager } = setup()
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["feishu"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '需要可靠执行的任务' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: 'unused-session', isNew: true })
    const { router } = makeRouter(db, manager)

    await router.handleInbound(makeInbound({ messageId: 'no-wake-feishu-root', content: '需要可靠执行的任务' }))

    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM remote_tracks WHERE root_message_id='no-wake-feishu-root'").get())
      .toEqual({ count: 0 })
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('本次未执行') }))
  })

  it('影子归属只记录脱敏观察，不改动飞书既有 Agent 路由', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'Feishu shadow attribution' })
    setConfigValue(db, 'remoteTrackPersist', 'true')
    setConfigValue(db, 'remoteTrackShadowAttribution', 'true')
    setConfigValue(db, 'remoteTrackRolloutChannels', '["feishu"]')
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'legacy research' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'legacy path', pendingConfirm: false, ok: true })
    const { router } = makeRouter(db, manager)

    await router.handleInbound(makeInbound({ messageId: 'shadow-feishu-1', content: 'legacy research' }))
    await vi.waitFor(() => expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_attribution_observations').get()).toEqual({ count: 1 }))

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(mockRunFeishuRemoteAgent.mock.calls[0]?.[0]).not.toHaveProperty('remoteContext.trackContext')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 0 })
    expect(getDbConnection(db).prepare('SELECT decision_kind FROM remote_track_attribution_observations').get()).toEqual({ decision_kind: 'new-track' })
  })

  it('微信 canary channel scope does not enable Track shadow attribution on Feishu', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'WeChat-only Track canary' })
    setConfigValue(db, 'remoteTrackPersist', 'true')
    setConfigValue(db, 'remoteTrackShadowAttribution', 'true')
    setConfigValue(db, 'remoteTrackRolloutChannels', '["wechat"]')
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'legacy research' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'legacy path', pendingConfirm: false, ok: true })
    const { router } = makeRouter(db, manager)

    await router.handleInbound(makeInbound({ messageId: 'outside-wechat-canary', content: 'legacy research' }))

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledOnce()
    expect(mockRunFeishuRemoteAgent.mock.calls[0]?.[0]).not.toHaveProperty('remoteContext.trackContext')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_track_attribution_observations').get())
      .toEqual({ count: 0 })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM remote_tracks').get()).toEqual({ count: 0 })
  })

  it('已有 Track 即使飞书 session idle resolver 给出新 session，也继续使用 Track 的 origin session', async () => {
    const { db, manager } = setup()
    const origin = createSession(db, { name: 'Feishu Track origin', metadata: { source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1' } })
    const unused = createSession(db, { name: 'Feishu unused session', metadata: { source: 'feishu', feishuChatId: 'chat-1', feishuSenderOpenId: 'user-1' } })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: unused.id, isNew: true })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["feishu"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    createRemoteTrack(db, { trackId: 'feishu-origin-track', eventId: 'feishu-origin-root', idempotencyKey: 'feishu-origin-root-key',
      channel: 'feishu', identityKey: 'chat-1', ownerId: 'user-1', authorizationEpoch: 1, rootMessageId: 'feishu-origin-platform-root',
      originSessionId: origin.id, occurredAt: 1 })
    appendRemoteTrackEvent(db, { eventId: 'feishu-origin-prompt-event', trackId: 'feishu-origin-track', eventKind: 'track.outbound.message',
      idempotencyKey: 'feishu-origin-prompt-event', messageId: 'feishu-origin-prompt', occurredAt: 2 })
    mapRemoteTrackMessage(db, { channel: 'feishu', platformMessageId: 'feishu-origin-prompt', trackId: 'feishu-origin-track',
      eventId: 'feishu-origin-prompt-event', direction: 'outbound' })
    let turnSequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 5, id: () => `feishu-origin-turn-${++turnSequence}` } })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '补充研究条件' })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'continued', pendingConfirm: false, ok: true })
    const dispatchSession = vi.fn(async () => undefined)
    const { router } = makeRouter(db, manager, { turnRuntime: runtime, wakeDispatcher: dispatchSession })

    await router.handleInbound(makeInbound({ messageId: 'feishu-origin-follow-up', content: '补充研究条件', replyToMessageId: 'feishu-origin-prompt' }))

    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(listImInboxMessages(db, { queueScope: buildImQueueScope('feishu', origin.id), limit: 10 }))
      .toContainEqual(expect.objectContaining({ content: '补充研究条件' }))
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(getSession(db, unused.id)).toBeDefined()
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
