import { getTurnByRequestId } from '../database/operations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claimQueuedTurnAtomically, createPersistedTurn, createSession, getPersistedTurn } from '../database/operations'
import { openDatabase, setConfigValue, getDbConnection, type AppDatabase } from '../database'
import { appendMessage as appendMessageOperation, updateMessageContent, updatePersistedTurnState } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { persistLlmServices } from '../llmServiceResolver'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext, readAcceptedTurn } from '../database/acceptedTurnStorage'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { commitSessionTranscript, readSessionTranscript } from '../database/sessionTranscript'
import { createSessionTurnRuntime, createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { TurnRuntime } from '../turnRuntime'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { WeChatCommandRouter } from './weChatCommandRouter'
import { WeChatProcessedStore } from './weChatProcessedStore'
import { WeChatAuditLogger } from './weChatAuditLogger'
import { WeChatImChannel } from './weChatImChannel'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createWakeEventRetryClock } from '../remote/wakeEventRetryPolicy'
import { appendImInboxMessageWithWakeEvent, claimImInboxMessage } from '../database/imInbox'
import { listWakeEvents } from '../database/wakeEvents'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { createWorkDirManager } from '../workDirManager'
import { attributeAndPersistRemoteMessage } from '../remote/remoteTrackAttributionService'
import { recordTrackModelMessage } from '../remote/trackModelInputViewStore'
import { registerAgentIpc } from '../ipc/agentProtocolIpc'

vi.mock('../appIpc', () => ({ readAppLocale: () => 'zh-CN' }))
vi.mock('../secureApiKey', () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (stored: string) => stored.replace(/^enc:/, ''),
  isSecretEncrypted: (value: string) => value.startsWith('enc:'),
  isLegacySecret: (value: string) => !value.startsWith('enc:'),
}))

function expectAcceptedInputFingerprint(db: AppDatabase, accepted: ReturnType<typeof createAcceptedTurn>): void {
  expect(readAcceptedTurn(db, accepted.sessionId, accepted.requestId)).toEqual(accepted)
  expect(getPersistedTurn(db, accepted.turnId)).toMatchObject({ requestId: accepted.requestId, acceptedInputHistoryVersion: 1 })
  const user = createSqliteSessionStorage(db).queries.readMessage({ sessionId: accepted.sessionId, messageId: accepted.currentUserMessageId })!
  const event = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, accepted.sessionId).readSync(accepted.turnId).events
    .find(({ kind }) => kind === 'session-input-committed')
  expect(event?.payload).toMatchObject({ sessionId: accepted.sessionId, messageId: accepted.currentUserMessageId, role: 'user',
    inputFingerprint: queueInputFingerprint({ text: user.content, attachments: user.attachments ?? [] }) })
}

describe('WeChat prepared wake to real provider integration', () => {
  let db: AppDatabase | undefined
  let dbPath: string | undefined
  let workDir: string | undefined
  let previousRuntime: ReturnType<typeof getDefaultAgentRuntime> | undefined

  afterEach(async () => {
    db?.close()
    db = undefined
    if (previousRuntime) setDefaultAgentRuntime(previousRuntime)
    previousRuntime = undefined
    if (dbPath) {
      for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${dbPath}${suffix}`, { force: true })
      await fs.rm(path.dirname(dbPath), { recursive: true, force: true })
      dbPath = undefined
    }
    if (workDir) await fs.rm(workDir, { recursive: true, force: true })
    workDir = undefined
  })

  it('resumes the prepared wake and dispatches the following durable wake independently', async () => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    const providerTranscriptStates: Array<{ version: number; lastTurnId?: string }> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'pi-ai-anthropic-messages', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        providerTranscriptStates.push(readSessionTranscript(db!, session.id))
        yield { type: 'text-delta', text: 'prepared wake provider result' } as const
        yield { type: 'usage', inputTokens: 7, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-prepared-provider-'))
    const temp = createTempDatabase('wechat-prepared-provider-db-')
    db = temp.db
    dbPath = temp.dbPath
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'wechat-prepared-provider-model'
    const serviceId = 'wechat-prepared-provider-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Prepared wake provider', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true,
      supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'wechat prepared provider', model, fixedWorkDir: workDir,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wechat-wake-user', lastContextToken: 'wake-context-token' } } })
    const scope = buildImQueueScope('wechat', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
      channelMessageId: 'wechat-prepared-platform-message', content: 'prepared wake accepted input sentinel', contextToken: 'wake-context-token' })
    const requestId = `wake:${inbox.eventId}`
    const frozenConfig = { lane: 'wechat' as const, model, llmServiceId: serviceId, thinkingEffort: 'low' as const }
    expect(claimImInboxMessage(db, { queueScope: scope, messageId: inbox.messageId, ownerId: 'crashed-wake-owner' })).not.toBeNull()
    const prepared = claimQueuedTurnAtomically(db, { sessionId: session.id, requestId, userMessageId: inbox.messageId,
      turnId: 'wechat-prepared-wake-turn', assistantMessageId: 'wechat-prepared-assistant',
      startToken: 'wechat-prepared-wake-token', state: 'prepared', executionConfig: frozenConfig, queueScope: scope })
    expect(prepared).not.toBeNull()
    const accepted = createAcceptedTurn({ turnId: 'wechat-prepared-wake-turn', requestId, sessionId: session.id, lane: 'wechat',
      startToken: 'wechat-prepared-wake-token', currentUserMessageId: prepared.user.message.id, transcriptVersion: 0,
      config: { lane: 'wechat', model, llmServiceId: serviceId, thinkingEffort: 'low' } })
    acceptTurnContext(db, accepted)
    expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'wechat-first-turn', baseVersion: 0, outcome: 'completed', messages: [
      { id: 'wechat-checkpoint-user', role: 'user', content: 'checkpoint v1 accepted history sentinel', timestamp: 10 },
      { id: 'wechat-checkpoint-assistant', role: 'assistant', content: 'checkpoint v1 answer sentinel', timestamp: 11 }
    ] })).toMatchObject({ committed: true, version: 1 })
    expect(readAcceptedTurn(db, session.id, requestId)?.transcriptVersion).toBe(0)
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 1, lastTurnId: 'wechat-first-turn' })
    expect(updatePersistedTurnState(db, 'wechat-prepared-wake-turn', 'running')).toBe(true)
    expect(updatePersistedTurnState(db, 'wechat-prepared-wake-turn', 'prepared')).toBe(true)
    getDbConnection(db).prepare('UPDATE im_inbox_claims SET lease_expires_at=0 WHERE message_id=?').run(inbox.messageId)
    db.close()
    db = openDatabase(dbPath)

    expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
      channelMessageId: 'wechat-prepared-platform-message', content: 'prepared wake accepted input sentinel', contextToken: 'wake-context-token' }))
      .toEqual({ messageId: inbox.messageId, eventId: inbox.eventId, duplicate: true })

    let sequence = 0
    const turnRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 100 + sequence, id: () => `unexpected-new-turn-${++sequence}` } })
    const reply = vi.fn(async () => undefined)
    const botService = { getBot: () => ({ reply, sendTyping: vi.fn(async () => undefined), stopTyping: vi.fn(async () => undefined) }), getRawBot: () => null }
    const storage = createSqliteSessionStorage(db)
    const workDirManager = { listProfiles: () => [], getActiveProfileId: () => 'profile-1', getActiveWorkDir: () => workDir!,
      checkDirectoryWritable: () => ({ ok: true }) }
    const router = new WeChatCommandRouter({ db, sessionStorage: storage, turnRuntime, botService: botService as never,
      processedStore: new WeChatProcessedStore(workDir), auditLogger: new WeChatAuditLogger(workDir), imChannel: new WeChatImChannel(),
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['wechat-wake-user'] }),
      getAppConfig: () => ({ defaultModel: model, maxParallelChatSessions: 2 }), getWorkDir: () => workDir!, workDirManager: workDirManager as never,
      getUserDataPath: () => path.join(workDir!, 'userdata'), getApiKey: async () => 'test-key', getBaseUrl: () => 'https://api.anthropic.com',
      getMainWebContents: () => null, getModel: () => model, getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }) })
    let retryNow = 1_000
    let retryWake!: () => void
    let failFinalizeOnce = true
    let run = 0
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'wechat', createRunId: () => `wechat-wake-run-${++run}`,
      launchLoop: async (input) => {
        await router.dispatchWakeEventSet(input)
        if (failFinalizeOnce && input.eventIds.includes(inbox.eventId)) {
          failFinalizeOnce = false
          throw new Error('injected crash after router commit before wake ack')
        }
      }, clock: createWakeEventRetryClock(() => retryNow), retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100, maxElapsedMs: 10_000, jitterRatio: 0, random: () => 0.5 },
      scheduleRetry: (_delay, callback) => { retryWake = callback } })
    const secondInbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
      channelMessageId: 'wechat-second-platform-message', content: 'WeChat second durable wake input sentinel', contextToken: 'wake-context-token' })
    try {
      await dispatcher.dispatchSession(session.id)
      expect(providerRequests).toHaveLength(2)
      expect(providerRoutes).toHaveLength(2)
      expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
      expect(providerRoutes[1]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
      const requestText = JSON.stringify(providerRequests[0])
      expect(requestText).toContain('prepared wake accepted input sentinel')
      expect(requestText).toContain('checkpoint v1 accepted history sentinel')
      expect(requestText).toContain('checkpoint v1 answer sentinel')
      expect(readAcceptedTurn(db, session.id, requestId)).toEqual(accepted)
      expect(providerTranscriptStates[0]).toMatchObject({ version: 1, lastTurnId: 'wechat-first-turn' })
      expectAcceptedInputFingerprint(db, accepted)
      expect(getTurnByRequestId(db, session.id, requestId)).toMatchObject({
        turnId: accepted.turnId,
        requestId: accepted.requestId,
        executionConfig: frozenConfig,
      })
      expect(getDbConnection(db).prepare('SELECT request_id,turn_id,state,user_message_id FROM turns WHERE turn_id=?').get('wechat-prepared-wake-turn'))
        .toMatchObject({ request_id: requestId, turn_id: 'wechat-prepared-wake-turn', state: 'terminal', user_message_id: inbox.messageId })
      expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(inbox.eventId)).toEqual({ status: 'pending' })
      expect(JSON.stringify(providerRequests[1])).toContain('WeChat second durable wake input sentinel')
      expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(secondInbox.eventId)).toEqual({ status: 'acked' })
      expect(getDbConnection(db).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      await dispatcher.dispatchSession(session.id)
      expect(providerRequests).toHaveLength(2)
      retryNow += 100
      retryWake()
      await vi.waitFor(() => expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(inbox.eventId)).toEqual({ status: 'acked' }))
      expect(providerRequests).toHaveLength(2)
      await dispatcher.dispose()
      db.close()
      db = openDatabase(dbPath)
      const replayAfterReopen = vi.fn(async () => undefined)
      const reopenedDispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'wechat', createRunId: () => 'wechat-wake-after-ack-reopen',
        launchLoop: replayAfterReopen })
      try {
        expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
          channelMessageId: 'wechat-prepared-platform-message', content: 'prepared wake accepted input sentinel', contextToken: 'wake-context-token' }))
          .toEqual({ messageId: inbox.messageId, eventId: inbox.eventId, duplicate: true })
        await reopenedDispatcher.dispatchSession(session.id)
        expect(replayAfterReopen).not.toHaveBeenCalled()
        expect(providerRequests).toHaveLength(2)
        expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(inbox.eventId)).toEqual({ status: 'acked' })
      } finally {
        await reopenedDispatcher.dispose()
      }
    } finally {
      await dispatcher.dispose()
    }
  })

  it('recovers a WeChat Track wake after reopen and sends only its scoped history to the real provider', async () => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'wechat-track-wake-fixture', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        yield { type: 'text-delta', text: 'track wake provider result' } as const
        yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-track-wake-provider-'))
    const temp = createTempDatabase('wechat-track-wake-provider-db-')
    db = temp.db
    dbPath = temp.dbPath
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'wechat-track-wake-model'
    const serviceId = 'wechat-track-wake-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Track wake provider', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true,
      supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["wechat"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    setConfigValue(db, 'config.defaultModel', model)
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([serviceId]))
    setConfigValue(db, 'config.llmServices', JSON.stringify([{ id: serviceId, name: 'Track wake provider', baseUrl: 'https://api.anthropic.com', supportedModelIds: [modelId] }]))
    setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [serviceId]: 'enc:test-key' }))
    const session = createSession(db, { name: 'WeChat Track wake provider', model,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wechat-track-owner', lastContextToken: 'track-wake-context' } } })
    appendMessageOperation(db, { id: 'wechat-track-prior-user', sessionId: session.id, role: 'user', content: 'Track A prior user sentinel', timestamp: 1, status: 'sent' })
    appendMessageOperation(db, { id: 'wechat-track-prior-assistant', sessionId: session.id, role: 'assistant', content: 'Track A prior assistant sentinel', timestamp: 2, status: 'sent' })
    appendMessageOperation(db, { id: 'wechat-track-other-user', sessionId: session.id, role: 'user', content: 'Track B secret sentinel', timestamp: 3, status: 'sent' })
    const attribution = await attributeAndPersistRemoteMessage(db, { channel: 'wechat', identityKey: 'wechat-track-owner', ownerId: 'wechat-track-owner',
      authorizationEpoch: 1, platformMessageId: 'wechat-track-wake-platform', text: 'Track A accepted input sentinel', now: 4, originSessionId: session.id }, { classify: vi.fn() },
      { sessionQueries: createSqliteSessionStorage(db).queries })
    if (attribution.kind !== 'attributed') throw new Error('expected an attributed Track')
    const scope = buildImQueueScope('wechat', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
      channelMessageId: 'wechat-track-wake-platform', content: 'Track A accepted input sentinel', contextToken: 'track-wake-context', trackId: attribution.context.trackId,
      trackEventId: attribution.context.attributionEventId })
    const patchHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const sessionStorage = createSqliteSessionStorage(db)
    const patchTurnRuntime = createSessionTurnRuntime(sessionStorage, { deps: { now: Date.now, id: () => 'test-turn' } })
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => patchHandlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime: patchTurnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => workDir!, setWorkDir: () => undefined, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir }) as never
    })
    recordTrackModelMessage(db, { trackId: attribution.context.trackId, eventId: 'wechat-track-prior-user-event', idempotencyKey: 'wechat-track-prior-user-event',
      sessionId: session.id, messageId: 'wechat-track-prior-user', invocationId: 'prior-track-turn', occurredAt: 1, parentEventId: attribution.context.attributionEventId }, createSqliteSessionStorage(db).queries)
    recordTrackModelMessage(db, { trackId: attribution.context.trackId, eventId: 'wechat-track-prior-assistant-event', idempotencyKey: 'wechat-track-prior-assistant-event',
      sessionId: session.id, messageId: 'wechat-track-prior-assistant', invocationId: 'prior-track-turn', occurredAt: 2, parentEventId: attribution.context.attributionEventId }, createSqliteSessionStorage(db).queries)
    const requestId = `wake:${inbox.eventId}`
    appendMessageOperation(db, { id: 'wechat-track-wake-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 5, status: 'streaming' })
    const frozenConfig = { lane: 'wechat' as const, model, llmServiceId: serviceId, thinkingEffort: 'low' as const }
    createPersistedTurn(db, { turnId: 'wechat-track-prepared-turn', requestId, sessionId: session.id, userMessageId: inbox.messageId,
      assistantMessageId: 'wechat-track-wake-assistant', state: 'prepared', startToken: 'wechat-track-start-token', executionConfig: frozenConfig })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'wechat-track-prepared-turn', requestId, sessionId: session.id, lane: 'wechat',
      startToken: 'wechat-track-start-token', currentUserMessageId: inbox.messageId, transcriptVersion: 0, config: frozenConfig }))
    await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: 'wechat-track-prior-user', patch: { content: 'Track A edited prior user sentinel' } })
    await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: 'wechat-track-prior-assistant', patch: { content: 'Track A edited prior assistant sentinel' } })
    expect(claimImInboxMessage(db, { queueScope: scope, messageId: inbox.messageId, ownerId: 'crashed-track-owner' })).not.toBeNull()
    expect(updateMessageContent(db, inbox.messageId, { status: 'sent' })).not.toBeNull()
    getDbConnection(db).prepare('UPDATE im_inbox_claims SET lease_expires_at=0 WHERE message_id=?').run(inbox.messageId)
    db.close()
    db = openDatabase(dbPath)
    expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
      channelMessageId: 'wechat-track-wake-platform', content: 'Track A accepted input sentinel', contextToken: 'track-wake-context',
      trackId: attribution.context.trackId, trackEventId: attribution.context.attributionEventId }))
      .toEqual({ messageId: inbox.messageId, eventId: inbox.eventId, duplicate: true })

    let sequence = 0
    const turnRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 100 + sequence, id: () => `unexpected-track-turn-${++sequence}` } })
    const reply = vi.fn(async () => undefined)
    const botService = { getBot: () => ({ reply, sendTyping: vi.fn(async () => undefined), stopTyping: vi.fn(async () => undefined) }), getRawBot: () => null }
    const manager = { listProfiles: () => [], getActiveProfileId: () => 'profile-1', getActiveWorkDir: () => workDir!, checkDirectoryWritable: () => ({ ok: true }) }
    const router = new WeChatCommandRouter({ db, sessionStorage: createSqliteSessionStorage(db), turnRuntime, botService: botService as never,
      processedStore: new WeChatProcessedStore(workDir), auditLogger: new WeChatAuditLogger(workDir), imChannel: new WeChatImChannel(),
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, enabled: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['wechat-track-owner'] }),
      getAppConfig: () => ({ defaultModel: model, maxParallelChatSessions: 2 }), getWorkDir: () => workDir!, workDirManager: manager as never,
      getUserDataPath: () => path.join(workDir!, 'userdata'), getApiKey: async () => 'test-key', getBaseUrl: () => 'https://api.anthropic.com',
      getMainWebContents: () => null, getModel: () => model, getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }) })
    const wake = listWakeEvents(db, session.id).find((event) => event.eventId === inbox.eventId)!
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'wechat', createRunId: () => 'wechat-track-wake-run',
      launchLoop: (input) => router.dispatchWakeEventSet(input) })
    try {
      await dispatcher.dispatchSession(session.id)
      expect(providerRequests).toHaveLength(1)
      expect(providerRoutes).toHaveLength(1)
      expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
      const requestText = JSON.stringify(providerRequests[0])
      expect(requestText).toContain('Track A edited prior user sentinel')
      expect(requestText).toContain('Track A edited prior assistant sentinel')
      expect(requestText).not.toContain('Track A prior user sentinel')
      expect(requestText).not.toContain('Track A prior assistant sentinel')
      expect(requestText).toContain('Track A accepted input sentinel')
      expect(requestText).not.toContain('Track B secret sentinel')
      expect(getTurnByRequestId(db, session.id, requestId)).toMatchObject({ turnId: 'wechat-track-prepared-turn', state: 'terminal' })
      expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(wake.eventId)).toEqual({ status: 'acked' })
      expect(getDbConnection(db).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      await dispatcher.dispatchSession(session.id)
      expect(providerRequests).toHaveLength(1)
      await dispatcher.dispose()
      db.close()
      db = openDatabase(dbPath)
      const replayAfterReopen = vi.fn(async () => undefined)
      const reopenedDispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'wechat', createRunId: () => 'wechat-track-wake-after-ack-reopen',
        launchLoop: replayAfterReopen })
      try {
        expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'wechat', queueScope: scope,
          channelMessageId: 'wechat-track-wake-platform', content: 'Track A accepted input sentinel', contextToken: 'track-wake-context',
          trackId: attribution.context.trackId, trackEventId: attribution.context.attributionEventId }))
          .toEqual({ messageId: inbox.messageId, eventId: inbox.eventId, duplicate: true })
        await reopenedDispatcher.dispatchSession(session.id)
        expect(replayAfterReopen).not.toHaveBeenCalled()
        expect(providerRequests).toHaveLength(1)
        expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(wake.eventId)).toEqual({ status: 'acked' })
      } finally {
        await reopenedDispatcher.dispose()
      }
    } finally {
      await dispatcher.dispose()
    }
  })
})
