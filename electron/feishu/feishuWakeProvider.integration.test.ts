import { getTurnByRequestId } from '../database/operations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claimQueuedTurnAtomically, createPersistedTurn, createSession, getPersistedTurn } from '../database/operations'
import { getDbConnection, openDatabase, setConfigValue, type AppDatabase } from '../database'
import { appendMessage as appendMessageOperation, updateMessageContent, updatePersistedTurnState } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { persistLlmServices } from '../llmServiceResolver'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext } from '../database/acceptedTurnStorage'
import { createSessionTurnRuntime, createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { TurnRuntime } from '../turnRuntime'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { RemoteCommandRouter } from './remoteCommandRouter'
import { FeishuProcessedStore } from './feishuProcessedStore'
import { FeishuAuditLogger } from './feishuAuditLogger'
import { FeishuImChannel } from './feishuImChannel'
import { canResumePreparedRemoteTurn } from '../remote/remoteTrackWorkRecovery'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { commitSessionTranscript, readSessionTranscript } from '../database/sessionTranscript'
import { createWakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { createWakeEventRetryClock } from '../remote/wakeEventRetryPolicy'
import { listWakeEvents } from '../database/wakeEvents'
import { claimImInboxMessage } from '../database/imInbox'
import { appendImInboxMessageWithWakeEvent } from '../database/imInbox'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { DEFAULT_FEISHU_CONFIG } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { createWorkDirManager } from '../workDirManager'
import { attributeAndPersistRemoteMessage } from '../remote/remoteTrackAttributionService'
import { tryClaimRemoteSession, releaseRemoteSession } from '../remote/remoteAgentRegistry'
import { recordTrackModelMessage } from '../remote/trackModelInputViewStore'
import { registerAgentIpc } from '../ipc/agentProtocolIpc'
import { queueInputFingerprint } from '../queueInputFingerprint'

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

describe('Feishu prepared wake to real provider integration', () => {
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
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-prepared-provider-'))
    const temp = createTempDatabase('feishu-prepared-provider-db-')
    db = temp.db
    dbPath = temp.dbPath
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'feishu-prepared-provider-model'
    const serviceId = 'feishu-prepared-provider-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Prepared wake provider', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true,
      supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'feishu prepared provider', model,
      metadata: { source: 'feishu', feishuChatId: 'feishu-wake-chat', feishuSenderOpenId: 'feishu-wake-user' } })
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    setConfigValue(db, 'config.defaultModel', model)
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([serviceId]))
    setConfigValue(db, 'config.llmServices', JSON.stringify([{ id: serviceId, name: 'Prepared wake provider', baseUrl: 'https://api.anthropic.com', supportedModelIds: [modelId] }]))
    setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [serviceId]: 'enc:test-key' }))
    const inputText = 'Feishu prepared wake accepted input sentinel'
    const secondInputText = 'Feishu second durable wake input sentinel'
    const inbound = { messageId: 'feishu-prepared-platform-message', chatId: 'feishu-wake-chat', senderOpenId: 'feishu-wake-user', chatType: 'p2p', content: inputText } as never
    const storageBeforeRestart = createSqliteSessionStorage(db)
    const workDirManagerBeforeRestart = createWorkDirManager({ db, getWorkDir: () => workDir!, setWorkDir: () => undefined })
    const acceptedRouter = new RemoteCommandRouter({ db, sessionStorage: storageBeforeRestart, runner: { run: vi.fn() } as never,
      processedStore: new FeishuProcessedStore(workDir), auditLogger: new FeishuAuditLogger(workDir), imChannel: new FeishuImChannel(),
      getFeishuConfig: () => ({ ...DEFAULT_FEISHU_CONFIG, enabled: true, appConfigured: true, userAuthorized: true, remoteEnabled: true,
        remoteSenderAllowlist: ['feishu-wake-user'] }),
      getAppConfig: () => ({ defaultModel: model, maxParallelChatSessions: 2, workDirProfiles: [], activeWorkDirProfileId: 'profile-1' }),
      getWorkDir: () => workDir!, workDirManager: workDirManagerBeforeRestart, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', getBaseUrl: () => 'https://api.anthropic.com', getMainWebContents: () => null,
      getModel: () => model, getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }),
      turnRuntime: new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 100, id: () => 'feishu-before-restart-turn' } }),
      wakeEventDispatcher: { dispatchSession: async () => undefined } })
    await acceptedRouter.handleInbound(inbound)
    const inbox = listWakeEvents(db, session.id)[0]!
    const requestId = `wake:${inbox.eventId}`
    const userMessageId = inbox.payloadRef.messageId
    const frozenConfig = { lane: 'feishu' as const, model, llmServiceId: serviceId, thinkingEffort: 'low' as const }
    expect(claimImInboxMessage(db, { queueScope: scope, messageId: userMessageId, ownerId: 'crashed-feishu-owner' })).not.toBeNull()
    const prepared = claimQueuedTurnAtomically(db, { sessionId: session.id, requestId, userMessageId,
      turnId: 'feishu-prepared-wake-turn', assistantMessageId: 'feishu-prepared-wake-assistant',
      startToken: 'feishu-prepared-wake-token', state: 'prepared', executionConfig: frozenConfig, queueScope: scope })
    const acceptedTurn = createAcceptedTurn({ turnId: 'feishu-prepared-wake-turn', requestId, sessionId: session.id, lane: 'feishu',
      startToken: 'feishu-prepared-wake-token', currentUserMessageId: prepared.user.message.id, transcriptVersion: 0, config: frozenConfig })
    acceptTurnContext(db, acceptedTurn)
    expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'feishu-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
      { id: 'feishu-checkpoint-user', role: 'user', content: 'Feishu checkpoint v1 user sentinel', timestamp: 10 },
      { id: 'feishu-checkpoint-assistant', role: 'assistant', content: 'Feishu checkpoint v1 assistant sentinel', timestamp: 11 }
    ] })).toMatchObject({ committed: true, version: 1 })
    expect(readAcceptedTurn(db, session.id, requestId)?.transcriptVersion).toBe(0)
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 1, lastTurnId: 'feishu-prior-turn' })
    expect(updatePersistedTurnState(db, 'feishu-prepared-wake-turn', 'running')).toBe(true)
    expect(updatePersistedTurnState(db, 'feishu-prepared-wake-turn', 'prepared')).toBe(true)
    getDbConnection(db).prepare('UPDATE im_inbox_claims SET lease_expires_at=0 WHERE message_id=?').run(userMessageId)
    expect(storageBeforeRestart.queries.readMessage({ sessionId: session.id, messageId: userMessageId })).toMatchObject({ role: 'user', status: 'sent', content: inputText })
    expect(canResumePreparedRemoteTurn({ turnState: 'prepared', turnId: acceptedTurn.turnId, requestId, sessionId: session.id, userMessageId, turnConfig: frozenConfig, accepted: readAcceptedTurn(db, session.id, requestId) })).toBe(true)
    db.close()
    db = openDatabase(dbPath)

    expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'feishu-prepared-platform-message', content: inputText }))
      .toEqual({ messageId: userMessageId, eventId: inbox.eventId, duplicate: true })

    let sequence = 0
    const turnRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 100 + sequence, id: () => `unexpected-new-turn-${++sequence}` } })
    const runner = { run: vi.fn(async () => ({ stdout: JSON.stringify({ code: 0, data: { message_id: 'feishu-prepared-wake-reply' } }), stderr: '', exitCode: 0 })) }
    const storage = createSqliteSessionStorage(db)
      expect(storage.queries.readMessage({ sessionId: session.id, messageId: acceptedTurn.currentUserMessageId })).toMatchObject({ role: 'user', status: 'sent', content: inputText })
    const workDirManager = createWorkDirManager({ db, getWorkDir: () => workDir!, setWorkDir: () => undefined })
    const router = new RemoteCommandRouter({ db, sessionStorage: storage, turnRuntime,
      runner: runner as never, processedStore: new FeishuProcessedStore(workDir), auditLogger: new FeishuAuditLogger(workDir), imChannel: new FeishuImChannel(),
      getFeishuConfig: () => ({ ...DEFAULT_FEISHU_CONFIG, enabled: true, appConfigured: true, userAuthorized: true,
        remoteEnabled: true, remoteSenderAllowlist: ['feishu-wake-user'] }),
      getAppConfig: () => ({ defaultModel: model, maxParallelChatSessions: 2, workDirProfiles: [], activeWorkDirProfileId: 'profile-1' }),
      getWorkDir: () => workDir!, workDirManager, getUserDataPath: () => path.join(workDir!, 'userdata'), getApiKey: async () => 'test-key',
      getBaseUrl: () => 'https://api.anthropic.com', getMainWebContents: () => null, getModel: () => model,
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }) })
    let retryNow = 1_000
    let retryWake!: () => void
    let failFinalizeOnce = true
    let run = 0
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'feishu', createRunId: () => `feishu-wake-run-${++run}`,
      launchLoop: async (input) => {
        await router.dispatchWakeEventSet(input)
        if (failFinalizeOnce && input.eventIds.includes(inbox.eventId)) {
          failFinalizeOnce = false
          throw new Error('injected crash after router commit before wake ack')
        }
      }, clock: createWakeEventRetryClock(() => retryNow), retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100, maxElapsedMs: 10_000, jitterRatio: 0, random: () => 0.5 },
      scheduleRetry: (_delay, callback) => { retryWake = callback } })
    const secondInbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'feishu-second-platform-message', content: secondInputText })
    try {
      await dispatcher.dispatchSession(session.id)
      expect(providerRequests).toHaveLength(2)
      expect(providerRoutes).toHaveLength(2)
      expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
      expect(providerRoutes[1]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
      const requestText = JSON.stringify(providerRequests[0])
      expect(requestText).toContain(inputText)
      expect(requestText).toContain('Feishu checkpoint v1 user sentinel')
      expect(requestText).toContain('Feishu checkpoint v1 assistant sentinel')
      expect(readAcceptedTurn(db, session.id, requestId)).toEqual(acceptedTurn)
      expect(providerTranscriptStates[0]).toMatchObject({ version: 1, lastTurnId: 'feishu-prior-turn' })
      expectAcceptedInputFingerprint(db, acceptedTurn)
      expect(getTurnByRequestId(db, session.id, requestId)).toMatchObject({ turnId: acceptedTurn.turnId, state: 'terminal', userMessageId: acceptedTurn.currentUserMessageId, executionConfig: frozenConfig })
      expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(inbox.eventId)).toEqual({ status: 'pending' })
      expect(JSON.stringify(providerRequests[1])).toContain(secondInputText)
      expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(secondInbox.eventId)).toEqual({ status: 'acked' })
      expect(getDbConnection(db).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      await dispatcher.dispatchSession(session.id)
      expect(providerRequests, JSON.stringify({ message: getDbConnection(db).prepare('SELECT id,status,content,queue_scope FROM messages WHERE id=?').get(acceptedTurn.currentUserMessageId), turn: getDbConnection(db).prepare('SELECT request_id,turn_id,session_id,user_message_id,state,execution_config_json FROM turns WHERE turn_id=?').get(acceptedTurn.turnId), accepted: getDbConnection(db).prepare('SELECT accepted_turn_json FROM accepted_turn_contexts WHERE request_id=?').get(requestId) })).toHaveLength(2)
      retryNow += 100
      retryWake()
      await vi.waitFor(() => expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(inbox.eventId)).toEqual({ status: 'acked' }))
      expect(providerRequests).toHaveLength(2)
      await dispatcher.dispose()
      db.close()
      db = openDatabase(dbPath)
      const replayAfterReopen = vi.fn(async () => undefined)
      const reopenedDispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'feishu', createRunId: () => 'feishu-wake-after-ack-reopen',
        launchLoop: replayAfterReopen })
      try {
        expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
          channelMessageId: 'feishu-prepared-platform-message', content: inputText }))
          .toEqual({ messageId: userMessageId, eventId: inbox.eventId, duplicate: true })
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

  it('recovers a Feishu Track wake after reopen and sends only its scoped history to the real provider', async () => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'feishu-track-wake-fixture', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        yield { type: 'text-delta', text: 'track wake provider result' } as const
        yield { type: 'usage', inputTokens: 5, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-track-wake-provider-'))
    const temp = createTempDatabase('feishu-track-wake-provider-db-')
    db = temp.db
    dbPath = temp.dbPath
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'feishu-track-wake-model'
    const serviceId = 'feishu-track-wake-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Track wake provider', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true,
      supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    for (const [key, value] of Object.entries({ remoteTrackPersist: 'true', remoteTrackRolloutChannels: '["feishu"]', remoteTrackExecution: 'true',
      remoteTrackRecovery: 'true', remoteTrackScopedModelInput: 'true', remoteTrackClarification: 'true' })) setConfigValue(db, key, value)
    setConfigValue(db, 'config.defaultModel', model)
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([serviceId]))
    setConfigValue(db, 'config.llmServices', JSON.stringify([{ id: serviceId, name: 'Track wake provider', baseUrl: 'https://api.anthropic.com', supportedModelIds: [modelId] }]))
    setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [serviceId]: 'enc:test-key' }))
    const session = createSession(db, { name: 'Feishu Track wake provider', model,
      metadata: { source: 'feishu', feishuChatId: 'feishu-track-chat', feishuSenderOpenId: 'feishu-track-owner' } })
    appendMessageOperation(db, { id: 'feishu-track-prior-user', sessionId: session.id, role: 'user', content: 'Track A prior user sentinel', timestamp: 1, status: 'sent' })
    appendMessageOperation(db, { id: 'feishu-track-prior-assistant', sessionId: session.id, role: 'assistant', content: 'Track A prior assistant sentinel', timestamp: 2, status: 'sent' })
    appendMessageOperation(db, { id: 'feishu-track-other-user', sessionId: session.id, role: 'user', content: 'Track B secret sentinel', timestamp: 3, status: 'sent' })
    const attribution = await attributeAndPersistRemoteMessage(db, { channel: 'feishu', identityKey: 'feishu-track-chat', ownerId: 'feishu-track-owner',
      authorizationEpoch: 1, platformMessageId: 'feishu-track-wake-platform', text: 'Track A accepted input sentinel', now: 4, originSessionId: session.id }, { classify: vi.fn() },
      { sessionQueries: createSqliteSessionStorage(db).queries })
    if (attribution.kind !== 'attributed') throw new Error('expected an attributed Track')
    const scope = buildImQueueScope('feishu', session.id) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const inbox = appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'feishu-track-wake-platform', content: 'Track A accepted input sentinel', trackId: attribution.context.trackId,
      trackEventId: attribution.context.attributionEventId })
    const patchHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const sessionStorage = createSqliteSessionStorage(db)
    const patchTurnRuntime = createSessionTurnRuntime(sessionStorage, { deps: { now: Date.now, id: () => 'test-turn' } })
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => patchHandlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime: patchTurnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => workDir!, setWorkDir: () => undefined, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir }) as never
    })
    recordTrackModelMessage(db, { trackId: attribution.context.trackId, eventId: 'feishu-track-prior-user-event', idempotencyKey: 'feishu-track-prior-user-event',
      sessionId: session.id, messageId: 'feishu-track-prior-user', invocationId: 'prior-track-turn', occurredAt: 1, parentEventId: attribution.context.attributionEventId }, createSqliteSessionStorage(db).queries)
    recordTrackModelMessage(db, { trackId: attribution.context.trackId, eventId: 'feishu-track-prior-assistant-event', idempotencyKey: 'feishu-track-prior-assistant-event',
      sessionId: session.id, messageId: 'feishu-track-prior-assistant', invocationId: 'prior-track-turn', occurredAt: 2, parentEventId: attribution.context.attributionEventId }, createSqliteSessionStorage(db).queries)
    const userMessageId = inbox.messageId
    const turnRuntimeBeforeRestart = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 10, id: () => 'feishu-track-prepared-turn' } })
    const tempDirPath = workDir
    const managerBeforeRestart = createWorkDirManager({ db, getWorkDir: () => tempDirPath, setWorkDir: () => undefined })
    const acceptedRouter = new RemoteCommandRouter({ db, sessionStorage: createSqliteSessionStorage(db), turnRuntime: turnRuntimeBeforeRestart,
      runner: { run: vi.fn(async () => ({ stdout: JSON.stringify({ code: 0, data: { message_id: 'feishu-track-wake-reply' } }), stderr: '', exitCode: 0 })) } as never,
      processedStore: new FeishuProcessedStore(tempDirPath), auditLogger: new FeishuAuditLogger(tempDirPath),
      imChannel: new FeishuImChannel(), getFeishuConfig: () => ({ ...DEFAULT_FEISHU_CONFIG, enabled: true, appConfigured: true,
        userAuthorized: true, remoteEnabled: true, remoteSenderAllowlist: ['feishu-track-owner'] }),
      getAppConfig: () => ({ defaultModel: model, maxParallelChatSessions: 2, workDirProfiles: [], activeWorkDirProfileId: 'profile-1' }),
      getWorkDir: () => tempDirPath, workDirManager: managerBeforeRestart, getUserDataPath: () => path.join(tempDirPath, 'userdata'),
      getApiKey: async () => 'test-key', getBaseUrl: () => 'https://api.anthropic.com', getMainWebContents: () => null, getModel: () => model,
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }), wakeEventDispatcher: { dispatchSession: async () => undefined } as never })
    expect(tryClaimRemoteSession(session.id, 'simulated-crashed-agent', 2)).toBe('ok')
    await acceptedRouter.handleInbound({ messageId: 'feishu-track-wake-platform', chatId: 'feishu-track-chat', senderOpenId: 'feishu-track-owner',
      chatType: 'p2p', content: 'Track A accepted input sentinel' } as never)
    await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: 'feishu-track-prior-user', patch: { content: 'Track A edited prior user sentinel' } })
    await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: 'feishu-track-prior-assistant', patch: { content: 'Track A edited prior assistant sentinel' } })
    releaseRemoteSession(session.id, 'simulated-crashed-agent')
    const wake = listWakeEvents(db, session.id).find((event) => event.payloadRef.kind === 'im-inbox-message')!
    const requestId = `wake:${wake.eventId}`
    const assistant = appendMessageOperation(db, { id: 'feishu-track-wake-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 5, status: 'streaming' })
    const frozenConfig = { lane: 'feishu' as const, model, llmServiceId: serviceId, thinkingEffort: 'low' as const }
    createPersistedTurn(db, { turnId: 'feishu-track-prepared-turn', requestId, sessionId: session.id, userMessageId,
      assistantMessageId: assistant.message.id, state: 'prepared', startToken: 'feishu-track-start-token', executionConfig: frozenConfig })
    acceptTurnContext(db, createAcceptedTurn({ turnId: 'feishu-track-prepared-turn', requestId, sessionId: session.id, lane: 'feishu',
      startToken: 'feishu-track-start-token', currentUserMessageId: userMessageId, transcriptVersion: 0, config: frozenConfig }))
    expect(claimImInboxMessage(db, { queueScope: scope, messageId: userMessageId, ownerId: 'crashed-track-owner' })).not.toBeNull()
    expect(updateMessageContent(db, userMessageId, { status: 'sent' })).not.toBeNull()
    getDbConnection(db).prepare('UPDATE im_inbox_claims SET lease_expires_at=0 WHERE message_id=?').run(userMessageId)
    db.close()
    db = openDatabase(dbPath)
    expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
      channelMessageId: 'feishu-track-wake-platform', content: 'Track A accepted input sentinel', trackId: attribution.context.trackId,
      trackEventId: attribution.context.attributionEventId }))
      .toEqual({ messageId: inbox.messageId, eventId: inbox.eventId, duplicate: true })
    let sequence = 0
    const turnRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 100 + sequence, id: () => `unexpected-track-turn-${++sequence}` } })
    const manager = createWorkDirManager({ db, getWorkDir: () => tempDirPath, setWorkDir: () => undefined })
    const router = new RemoteCommandRouter({ db, sessionStorage: createSqliteSessionStorage(db), turnRuntime,
      runner: { run: vi.fn(async () => ({ stdout: JSON.stringify({ code: 0, data: { message_id: 'feishu-track-wake-reply' } }), stderr: '', exitCode: 0 })) } as never,
      processedStore: new FeishuProcessedStore(tempDirPath), auditLogger: new FeishuAuditLogger(tempDirPath), imChannel: new FeishuImChannel(),
      getFeishuConfig: () => ({ ...DEFAULT_FEISHU_CONFIG, enabled: true, appConfigured: true, userAuthorized: true, remoteEnabled: true,
        remoteSenderAllowlist: ['feishu-track-owner'] }), getAppConfig: () => ({ defaultModel: model, maxParallelChatSessions: 2, workDirProfiles: [], activeWorkDirProfileId: 'profile-1' }),
      getWorkDir: () => tempDirPath, workDirManager: manager, getUserDataPath: () => path.join(tempDirPath, 'userdata'), getApiKey: async () => 'test-key',
      getBaseUrl: () => 'https://api.anthropic.com', getMainWebContents: () => null, getModel: () => model,
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, allowedTools: [] }) })
    const dispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'feishu', createRunId: () => 'feishu-track-recovery-run',
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
      expect(getTurnByRequestId(db, session.id, requestId)).toMatchObject({ turnId: 'feishu-track-prepared-turn', state: 'terminal' })
      expect(getDbConnection(db).prepare('SELECT status FROM wake_events WHERE event_id=?').get(wake.eventId)).toEqual({ status: 'acked' })
      expect(providerRequests).toHaveLength(1)
      db.close()
      db = openDatabase(dbPath)
      const replayAfterReopen = vi.fn(async () => undefined)
      const reopenedDispatcher = createWakeEventDispatcher({ db, maxParallel: 1, ownerChannel: 'feishu', createRunId: () => 'feishu-track-wake-after-ack-reopen',
        launchLoop: replayAfterReopen })
      try {
        expect(appendImInboxMessageWithWakeEvent(db, { sessionId: session.id, channel: 'feishu', queueScope: scope,
          channelMessageId: 'feishu-track-wake-platform', content: 'Track A accepted input sentinel',
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
