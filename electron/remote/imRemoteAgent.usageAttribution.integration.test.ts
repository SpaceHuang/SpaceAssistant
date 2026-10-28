import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendMessage, createSession, prepareTurnAtomically } from '../database/operations'
import { getDbConnection, openDatabase, setConfigValue, type AppDatabase } from '../database'
import { getPersistedTurn, getUsageStepFactsForTurn, getUsageTurnFact } from '../database/operations'
import { queryUsageAttribution } from '../usageStats/usageStatsQueries'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { runImRemoteAgent } from './imRemoteAgent'
import type { WorkDirManager } from '../workDirManager'
import { acceptTurnContext, readAcceptedTurn } from '../database/acceptedTurnStorage'
import { commitSessionTranscript } from '../database/sessionTranscript'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { createSessionTurnRuntime, createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { certifyCanonicalSessionApiRead, setCanonicalApiReadFeatureEnabled } from '../sessionStorage/certification'
import { enableCanonicalSessionWriteAuthority } from '../sessionStorage/infrastructure/sqlite/sessionContentWriteAuthority'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { persistLlmServices } from '../llmServiceResolver'
import { appendMessage as appendMessageOperation } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { bindRemoteTrackToTurn, createRemoteTrack, remoteTrackTurnBindingEventId } from '../database/remoteTrackStore'
import { buildTrackModelInputViewRef as buildTrackModelInputView, recordTrackModelMessage as persistTrackModelMessage } from './trackModelInputViewStore'

function recordTrackModelMessage(db: AppDatabase, input: Parameters<typeof persistTrackModelMessage>[1]) {
  return persistTrackModelMessage(db, input, createSqliteSessionStorage(db).queries)
}
function buildTrackModelInputViewRef(db: AppDatabase, input: Parameters<typeof buildTrackModelInputView>[1]) {
  return buildTrackModelInputView(db, input, createSqliteSessionStorage(db).queries)
}
import { registerAgentIpc } from '../ipc/agentProtocolIpc'
import { queueInputFingerprint } from '../queueInputFingerprint'

async function seedCanonicalSessionTranscript(db: AppDatabase, sessionId: string,
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>): Promise<void> {
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).appendBatch([{
    invocationId: `b01-canonical-seed-${sessionId}`, turnId: `b01-canonical-seed-turn-${sessionId}`, sequence: 1, schemaVersion: 1,
    eventId: `b01-canonical-seed-event-${sessionId}`, idempotencyKey: `b01-canonical-seed-event-${sessionId}`,
    kind: 'invocation-context-committed', payload: { messages }
  }, {
    invocationId: `b01-canonical-seed-${sessionId}`, turnId: `b01-canonical-seed-turn-${sessionId}`, sequence: 2, schemaVersion: 1,
    eventId: `b01-canonical-seed-completed-${sessionId}`, idempotencyKey: `b01-canonical-seed-completed-${sessionId}`,
    kind: 'invocation-completed', payload: { status: 'completed', completedAt: Date.now() }
  }], 0)
}

function expectAcceptedInputPersistence(db: AppDatabase, acceptedTurn: ReturnType<typeof createAcceptedTurn>): void {
  expect(readAcceptedTurn(db, acceptedTurn.sessionId, acceptedTurn.requestId)).toEqual(acceptedTurn)
  expect(getPersistedTurn(db, acceptedTurn.turnId)).toMatchObject({
    userMessageId: acceptedTurn.currentUserMessageId,
    acceptedInputHistoryVersion: 1
  })
  const currentUser = getDbConnection(db).prepare('SELECT role,content,attachments FROM messages WHERE id=? AND session_id=?')
    .get(acceptedTurn.currentUserMessageId, acceptedTurn.sessionId) as { role: string; content: string; attachments: string | null }
  const acceptedInput = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, acceptedTurn.sessionId)
    .readSync(acceptedTurn.turnId).events.find(({ kind }) => kind === 'session-input-committed')
  expect(acceptedInput?.payload).toMatchObject({
    sessionId: acceptedTurn.sessionId,
    messageId: acceptedTurn.currentUserMessageId,
    role: currentUser.role,
    inputFingerprint: queueInputFingerprint({ text: currentUser.content, attachments: currentUser.attachments ? JSON.parse(currentUser.attachments) : [] })
  })
}

function expectProviderInputSentinelOnce(messages: readonly unknown[], sentinel: string): void {
  expect(JSON.stringify(messages).split(sentinel).length - 1).toBe(1)
}

vi.mock('../appIpc', () => ({ readAppLocale: () => 'zh-CN' }))
vi.mock('../secureApiKey', () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (stored: string) => stored.replace(/^enc:/, ''),
  isSecretEncrypted: (value: string) => value.startsWith('enc:'),
  isLegacySecret: (value: string) => !value.startsWith('enc:'),
}))

describe('Feishu production entry usage attribution SQLite integration', () => {
  let db: AppDatabase | undefined
  let workDir: string | undefined
  let previousRuntime: ReturnType<typeof getDefaultAgentRuntime> | undefined
  let tempDbPath: string | undefined

  afterEach(async () => {
    db?.close()
    db = undefined
    if (previousRuntime) setDefaultAgentRuntime(previousRuntime)
    previousRuntime = undefined
    if (workDir) await fs.rm(workDir, { recursive: true, force: true })
    workDir = undefined
    if (tempDbPath) {
      for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${tempDbPath}${suffix}`, { force: true })
      await fs.rm(path.dirname(tempDbPath), { recursive: true, force: true })
      tempDbPath = undefined
    }
  })

  it('runs runImRemoteAgent with real invocation assembly and writes linked attribution facts', async () => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'usage-attribution-fixture',
      stream: async function* () {
        yield { type: 'text-delta', text: 'Feishu attribution result' } as const
        yield { type: 'usage', inputTokens: 17, outputTokens: 5 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    db = openDatabase(':memory:')
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-usage-attribution-'))
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'feishu-usage-model'
    const serviceId = 'feishu-usage-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Usage attribution fixture', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true, supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'feishu-usage-attribution', model })
    prepareTurnAtomically(db, {
      user: { id: 'feishu-usage-user', sessionId: session.id, role: 'user', content: 'Check attribution', timestamp: 1, status: 'sent' },
      assistant: { id: 'feishu-usage-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'feishu-usage-turn', requestId: 'feishu-usage-request', sessionId: session.id, assistantMessageId: 'feishu-usage-assistant', state: 'prepared', startToken: 'feishu-usage-start' }
    })
    const acceptedTurn = createAcceptedTurn({
      turnId: 'feishu-usage-turn', requestId: 'feishu-usage-request', sessionId: session.id, lane: 'feishu',
      startToken: 'feishu-usage-start', currentUserMessageId: 'feishu-usage-user', transcriptVersion: 0,
      config: { lane: 'feishu', model, llmServiceId: serviceId, thinkingEffort: 'low' }
    })
    acceptTurnContext(db, acceptedTurn)

    const workDirManager: WorkDirManager = {
      listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => workDir!,
      checkDirectoryWritable: () => ({ ok: true })
    } as unknown as WorkDirManager
    const result = await runImRemoteAgent({
      db, sessionStorage: createSqliteSessionStorage(db), sessionId: session.id, requestId: 'feishu-usage-request', turnId: 'feishu-usage-turn', acceptedTurn, workDir, workDirManager,
      userDataDir: path.join(workDir, 'userdata'), getApiKey: async () => 'test-key',
      getBaseUrl: () => 'https://api.anthropic.com', getModel: () => model,
      remoteContext: { source: 'feishu', messageId: 'feishu-message-1', confirmPolicy: 'always' },
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      createProgressAdapter: () => ({ update: vi.fn(), close: vi.fn() } as never),
      buildSystemAppendix: () => 'Feishu attribution integration',
      progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG, progressConfig: {}
    })
    expect(result).toMatchObject({ ok: true, summary: 'Feishu attribution result' })

    const turn = getDbConnection(db).prepare('SELECT turn_id AS turnId FROM turns WHERE request_id = ?').get('feishu-usage-request') as { turnId?: string }
    expect(turn.turnId).toBeTruthy()
    const steps = getUsageStepFactsForTurn(db, session.id, turn.turnId!)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ sessionId: session.id, turnId: turn.turnId, stepId: 'feishu-usage-request:model:1:attempt:1' })
    expect(steps[0]?.attributionJson).not.toBeNull()
    expect(steps[0]?.estimatorVersion).not.toBeNull()
    const turnFact = getUsageTurnFact(db, turn.turnId!)
    expect(turnFact).toMatchObject({ sessionId: session.id, turnId: turn.turnId })
    expect(turnFact?.toolAttributionJson).not.toBeNull()
    expect(JSON.parse(turnFact!.toolAttributionJson!)).toMatchObject({
      tools: expect.any(Object), toolSource: expect.any(Object), toolResults: expect.any(Object)
    })
    const persistedToolDimensions = JSON.parse(turnFact!.toolAttributionJson!) as { tools: Record<string, number>; toolSource: Record<string, number> }
    expect(Object.values(persistedToolDimensions.tools).some((value) => value > 0)).toBe(true)
    expect(Object.values(persistedToolDimensions.toolSource).some((value) => value > 0)).toBe(true)
    const queriedUsage = queryUsageAttribution(db, {
      from: steps[0]!.day!, to: steps[0]!.day!, dimensions: { sessionIds: [session.id] }
    })
    expect(Object.values(queriedUsage.toolDimensions.tools).some((value) => value > 0)).toBe(true)
    expect(Object.values(queriedUsage.toolDimensions.toolSource).some((value) => value > 0)).toBe(true)
  })

  it.each([
    { checkpointed: false, edited: false }, { checkpointed: false, edited: true },
    { checkpointed: true, edited: false }, { checkpointed: true, edited: true }
  ])('sends only Track A history to the real Hosted provider while Track B stays isolated (checkpointed=$checkpointed edited=$edited)', async ({ checkpointed, edited }) => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'track-input-fixture', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        yield { type: 'text-delta', text: 'Track-scoped result' } as const
        yield { type: 'usage', inputTokens: 8, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    const tempDb = createTempDatabase('feishu-track-provider-reopen-')
    db = tempDb.db
    tempDbPath = tempDb.dbPath
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-track-input-'))
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'feishu-track-model'
    const serviceId = 'feishu-track-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Track fixture', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true, supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'feishu-track-input', model })
    const oldAUser = appendMessageOperation(db, { id: 'track-a-old-user', sessionId: session.id, role: 'user', content: 'Track A old user sentinel', timestamp: 1, status: 'sent' })
    const oldAAssistant = appendMessageOperation(db, { id: 'track-a-old-assistant', sessionId: session.id, role: 'assistant', content: 'Track A old assistant sentinel', timestamp: 2, status: 'completed' })
    const trackBUser = appendMessageOperation(db, { id: 'track-b-user', sessionId: session.id, role: 'user', content: 'Track B original secret sentinel', timestamp: 3, status: 'sent' })
    if (checkpointed) {
      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'track-input-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
        { id: oldAUser.message.id, role: 'user', content: oldAUser.message.content, timestamp: oldAUser.message.timestamp },
        { id: oldAAssistant.message.id, role: 'assistant', content: oldAAssistant.message.content, timestamp: oldAAssistant.message.timestamp },
        { id: trackBUser.message.id, role: 'user', content: trackBUser.message.content, timestamp: trackBUser.message.timestamp }
      ] })).toMatchObject({ committed: true, version: 1 })
    }
    const trackA = createRemoteTrack(db, { trackId: 'provider-track-a', eventId: 'provider-track-a-root', idempotencyKey: 'provider-track-a-inbound',
      channel: 'feishu', identityKey: 'sender-a', ownerId: 'owner-a', authorizationEpoch: 1, rootMessageId: oldAUser.message.id, originSessionId: session.id, occurredAt: 1 })
    const trackB = createRemoteTrack(db, { trackId: 'provider-track-b', eventId: 'provider-track-b-root', idempotencyKey: 'provider-track-b-inbound',
      channel: 'feishu', identityKey: 'sender-a', ownerId: 'owner-a', authorizationEpoch: 1, rootMessageId: trackBUser.message.id, originSessionId: session.id, occurredAt: 2 })
    recordTrackModelMessage(db, { trackId: trackA.trackId, eventId: 'provider-track-a-old-user', idempotencyKey: 'provider-track-a-old-user', sessionId: session.id,
      messageId: oldAUser.message.id, invocationId: 'track-a-prior-turn', occurredAt: 3, parentEventId: 'provider-track-a-root' })
    recordTrackModelMessage(db, { trackId: trackA.trackId, eventId: 'provider-track-a-old-assistant', idempotencyKey: 'provider-track-a-old-assistant', sessionId: session.id,
      messageId: oldAAssistant.message.id, invocationId: 'track-a-prior-turn', occurredAt: 4, parentEventId: 'provider-track-a-root' })
    recordTrackModelMessage(db, { trackId: trackB.trackId, eventId: 'provider-track-b-message', idempotencyKey: 'provider-track-b-message', sessionId: session.id,
      messageId: trackBUser.message.id, invocationId: 'track-b-turn', occurredAt: 5, parentEventId: 'provider-track-b-root' })
    const patchHandlers = new Map<string, (...args: unknown[]) => unknown>()
    let storage = createSqliteSessionStorage(db)
    const turnRuntime = createSessionTurnRuntime(storage, { deps: { now: Date.now, id: () => 'test-turn' } })
    const registerPatchHandlers = () => registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => patchHandlers.set(channel, handler) } as never, {
      db, sessionStorage: storage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => workDir!, setWorkDir: () => undefined, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir }) as never
    })
    registerPatchHandlers()
    if (edited) {
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldAUser.message.id, patch: { content: 'Track A edited user sentinel' } })
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldAAssistant.message.id, patch: { content: 'Track A edited assistant sentinel' } })
    }
    const expectedAUser = edited ? 'Track A edited user sentinel' : 'Track A old user sentinel'
    const expectedAAssistant = edited ? 'Track A edited assistant sentinel' : 'Track A old assistant sentinel'
    expect(getDbConnection(db).prepare('SELECT id,sequence,content FROM messages WHERE session_id=? ORDER BY sequence LIMIT 2').all(session.id))
      .toEqual([
        { id: oldAUser.message.id, sequence: 0, content: expectedAUser },
        { id: oldAAssistant.message.id, sequence: 1, content: expectedAAssistant }
      ])
    const accepted = prepareTurnAtomically(db, {
      user: { id: 'track-a-current-user', sessionId: session.id, role: 'user', content: 'Track A current input sentinel', timestamp: 6, status: 'sent' },
      assistant: { id: 'track-a-current-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 7, status: 'streaming' },
      turn: { turnId: 'track-a-current-turn', requestId: 'track-a-current-request', sessionId: session.id, assistantMessageId: 'track-a-current-assistant', state: 'prepared', startToken: 'track-a-current-token' }
    })
    bindRemoteTrackToTurn(db, { trackId: trackA.trackId, turnId: 'track-a-current-turn', sessionId: session.id, channel: 'feishu', identityKey: 'sender-a', ownerId: 'owner-a',
      authorizationEpoch: 1, eventId: remoteTrackTurnBindingEventId(trackA.trackId, 'track-a-current-turn'), occurredAt: 6 })
    recordTrackModelMessage(db, { trackId: trackA.trackId, eventId: 'provider-track-a-current-user', idempotencyKey: 'provider-track-a-current-user', sessionId: session.id,
      messageId: accepted.user.message.id, invocationId: 'track-a-current-turn', occurredAt: 7, parentEventId: 'provider-track-a-root' })
    const trackContext = { trackId: trackA.trackId, channel: 'feishu' as const, identityKey: 'sender-a', ownerId: 'owner-a', authorizationEpoch: 1,
      rootMessageId: oldAUser.message.id, attributionEventId: 'provider-track-a-root' }
    let view = buildTrackModelInputViewRef(db, { ...trackContext, sessionId: session.id, acceptedUserMessageId: accepted.user.message.id,
      currentInvocationId: 'track-a-current-turn' })
    const acceptedTrackViewVersion = view.viewVersion
    const acceptedTrackIncludedMessageIds = [...view.includedMessageIds]
    const acceptedTurn = createAcceptedTurn({ turnId: 'track-a-current-turn', requestId: 'track-a-current-request', sessionId: session.id, lane: 'feishu',
      startToken: 'track-a-current-token', currentUserMessageId: accepted.user.message.id, transcriptVersion: checkpointed ? 1 : 0,
      config: { lane: 'feishu', model, llmServiceId: serviceId, thinkingEffort: 'low' } })
    acceptTurnContext(db, acceptedTurn)
    const persistedPath = tempDbPath!
    db.close()
    db = openDatabase(persistedPath)
    storage = createSqliteSessionStorage(db)
    expectAcceptedInputPersistence(db, acceptedTurn)
    view = buildTrackModelInputViewRef(db, { ...trackContext, sessionId: session.id, acceptedUserMessageId: accepted.user.message.id,
      currentInvocationId: 'track-a-current-turn' })
    expect(view.viewVersion).toBe(acceptedTrackViewVersion)
    expect(view.includedMessageIds).toEqual(acceptedTrackIncludedMessageIds)
    expect(acceptedTrackIncludedMessageIds).toEqual([oldAUser.message.id, oldAAssistant.message.id, accepted.user.message.id])
    const workDirManager: WorkDirManager = { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => workDir!, checkDirectoryWritable: () => ({ ok: true }) } as unknown as WorkDirManager

    const result = await runImRemoteAgent({ db, sessionStorage: storage, sessionId: session.id, requestId: acceptedTurn.requestId, turnId: acceptedTurn.turnId,
      acceptedTurn, workDir, workDirManager, userDataDir: path.join(workDir, 'userdata'), getApiKey: async () => 'test-key',
      getBaseUrl: () => 'https://api.anthropic.com', getModel: () => model,
      remoteContext: { source: 'feishu', messageId: accepted.user.message.id, confirmPolicy: 'always', chatId: 'sender-a', authOwner: 'owner-a', trackContext, trackModelInputView: view },
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, createProgressAdapter: () => ({ update: vi.fn(), close: vi.fn() } as never),
      buildSystemAppendix: () => 'Track isolation integration', progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG, progressConfig: {} })

    expect(result).toMatchObject({ ok: true, summary: 'Track-scoped result' })
    expect(providerRequests).toHaveLength(1)
    expect(providerRoutes).toHaveLength(1)
    expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
    const requestText = JSON.stringify(providerRequests[0])
    expect(requestText).toContain(expectedAUser)
    expect(requestText).toContain(expectedAAssistant)
    expect(requestText).toContain('Track A current input sentinel')
    expectProviderInputSentinelOnce(providerRequests[0]!, 'Track A current input sentinel')
    expect(requestText).not.toContain(edited ? 'Track A old user sentinel' : 'Track A edited user sentinel')
    expect(requestText).not.toContain(edited ? 'Track A old assistant sentinel' : 'Track A edited assistant sentinel')
    expect(requestText).not.toContain('Track B original secret sentinel')
    expect(view.includedMessageIds).toEqual([oldAUser.message.id, oldAAssistant.message.id, accepted.user.message.id])
    expect(view.viewVersion).toBe(acceptedTrackViewVersion)
  })

  it.each([
    { checkpointed: false, canonicalRetained: false, edited: false },
    { checkpointed: false, canonicalRetained: false, edited: true },
    { checkpointed: true, canonicalRetained: false, edited: false },
    { checkpointed: true, canonicalRetained: false, edited: true },
    { checkpointed: false, canonicalRetained: true, edited: false },
    { checkpointed: false, canonicalRetained: true, edited: true }
  ])('sends non-Track Feishu history with checkpoint=$checkpointed canonicalRetained=$canonicalRetained edited=$edited', async ({ checkpointed, canonicalRetained, edited }) => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'feishu-non-track-input-fixture', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        yield { type: 'text-delta', text: 'Feishu non-Track result' } as const
        yield { type: 'usage', inputTokens: 8, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    const tempDb = createTempDatabase('feishu-non-track-provider-reopen-')
    db = tempDb.db
    tempDbPath = tempDb.dbPath
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-non-track-input-'))
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'feishu-non-track-model'
    const serviceId = 'feishu-non-track-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Non-Track fixture', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true, supportedModelIds: [modelId] }],
      [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'feishu non-track input', model })
    const oldUser = appendMessageOperation(db, { id: 'non-track-old-user', sessionId: session.id, role: 'user', content: 'old user before edit', timestamp: 1, status: 'sent' })
    const oldAssistant = appendMessageOperation(db, { id: 'non-track-old-assistant', sessionId: session.id, role: 'assistant', content: 'old assistant before edit', timestamp: 2, status: 'completed' })
    if (checkpointed) {
      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'non-track-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp }
      ] })).toMatchObject({ committed: true, version: 1 })
    }
    if (canonicalRetained) {
      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'non-track-canonical-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp }
      ] })).toMatchObject({ committed: true, version: 1 })
      setCanonicalApiReadFeatureEnabled(db, true)
      await seedCanonicalSessionTranscript(db, session.id, [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id)).toMatchObject({ status: 'eligible' })
      expect(enableCanonicalSessionWriteAuthority(db, session.id)).toMatchObject({ status: 'enabled' })
    }
    const patchHandlers = new Map<string, (...args: unknown[]) => unknown>()
    let storage = createSqliteSessionStorage(db)
    const turnRuntime = createSessionTurnRuntime(storage, { deps: { now: Date.now, id: () => 'test-turn' } })
    const registerPatchHandlers = () => registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => patchHandlers.set(channel, handler) } as never, {
      db, sessionStorage: storage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => workDir!, setWorkDir: () => undefined, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir }) as never
    })
    registerPatchHandlers()
    if (edited) {
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldUser.message.id, patch: { content: 'edited old user sentinel' } })
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldAssistant.message.id, patch: { content: 'edited old assistant sentinel' } })
    }
    const expectedOldUser = canonicalRetained && edited ? '' : edited ? 'edited old user sentinel' : 'old user before edit'
    const expectedOldAssistant = canonicalRetained && edited ? '' : edited ? 'edited old assistant sentinel' : 'old assistant before edit'
    expect(getDbConnection(db).prepare('SELECT id,sequence,content FROM messages WHERE session_id=? ORDER BY sequence LIMIT 2').all(session.id))
      .toEqual([
        { id: oldUser.message.id, sequence: 0, content: expectedOldUser },
        { id: oldAssistant.message.id, sequence: 1, content: expectedOldAssistant }
      ])
    if (canonicalRetained && edited) {
      const transcript = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).readCanonicalSessionTranscriptForShadow(session.id)
      expect(transcript.kind).toBe('matched')
      if (transcript.kind === 'matched') {
        expect(transcript.messages.filter(({ id }) => [oldUser.message.id, oldAssistant.message.id].includes(id))
          .map(({ content }) => content)).toEqual(['edited old user sentinel', 'edited old assistant sentinel'])
      }
    }
    if (canonicalRetained) {
      const latestHistory = await storage.execution.historyFor({ sessionId: session.id }).readLatestInvocationForSession(session.id)
      expect(latestHistory.kind).toBe('completed')
    }
    const accepted = prepareTurnAtomically(db, {
      user: { id: 'non-track-current-user', sessionId: session.id, role: 'user', content: 'current accepted sentinel', timestamp: 3, status: 'sent' },
      assistant: { id: 'non-track-current-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 4, status: 'streaming' },
      turn: { turnId: 'non-track-current-turn', requestId: 'non-track-current-request', sessionId: session.id,
        assistantMessageId: 'non-track-current-assistant', state: 'prepared', startToken: 'non-track-current-token' }
    })
    const acceptedTurn = createAcceptedTurn({ turnId: 'non-track-current-turn', requestId: 'non-track-current-request', sessionId: session.id,
      lane: 'feishu', startToken: 'non-track-current-token', currentUserMessageId: accepted.user.message.id, transcriptVersion: canonicalRetained ? 1 : 0,
      config: { lane: 'feishu', model, llmServiceId: serviceId, thinkingEffort: 'low' } })
    acceptTurnContext(db, acceptedTurn)
    db.close()
    db = openDatabase(tempDbPath!)
    const reopenedStorage = createSqliteSessionStorage(db)
    expectAcceptedInputPersistence(db, acceptedTurn)
    const workDirManager: WorkDirManager = { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => workDir!,
      checkDirectoryWritable: () => ({ ok: true }) } as unknown as WorkDirManager

    const result = await runImRemoteAgent({ db, sessionStorage: reopenedStorage, sessionId: session.id, requestId: acceptedTurn.requestId,
      turnId: acceptedTurn.turnId, acceptedTurn, workDir, workDirManager, userDataDir: path.join(workDir, 'userdata'),
      getApiKey: async () => 'test-key', getBaseUrl: () => 'https://api.anthropic.com', getModel: () => model,
      remoteContext: { source: 'feishu', messageId: accepted.user.message.id, confirmPolicy: 'always' },
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, createProgressAdapter: () => ({ update: vi.fn(), close: vi.fn() } as never),
      buildSystemAppendix: () => 'Feishu non-Track input integration', progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG, progressConfig: {} })

    expect(result).toMatchObject({ ok: true, summary: 'Feishu non-Track result' })
    expect(providerRequests).toHaveLength(1)
    expect(providerRoutes).toHaveLength(1)
    expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
    const requestText = JSON.stringify(providerRequests[0])
    expect(requestText).toContain(checkpointed || canonicalRetained || !edited ? 'old user before edit' : 'edited old user sentinel')
    expect(requestText).toContain(checkpointed || canonicalRetained || !edited ? 'old assistant before edit' : 'edited old assistant sentinel')
    expect(requestText).toContain('current accepted sentinel')
    expectProviderInputSentinelOnce(providerRequests[0]!, 'current accepted sentinel')
    if (edited) {
      expect(requestText).not.toContain(checkpointed || canonicalRetained ? 'edited old user sentinel' : 'old user before edit')
      expect(requestText).not.toContain(checkpointed || canonicalRetained ? 'edited old assistant sentinel' : 'old assistant before edit')
    }
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE session_id=? AND id=?').get(session.id, oldUser.message.id))
      .toEqual({ content: expectedOldUser })
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE session_id=? AND id=?').get(session.id, oldAssistant.message.id))
      .toEqual({ content: expectedOldAssistant })
    expect(reopenedStorage.queries.readMessage({ sessionId: session.id, messageId: accepted.user.message.id }))
      .toMatchObject({ content: 'current accepted sentinel', status: 'sent' })
  })

  it.each([
    { checkpointed: false, canonicalRetained: false, edited: false },
    { checkpointed: false, canonicalRetained: false, edited: true },
    { checkpointed: true, canonicalRetained: false, edited: false },
    { checkpointed: true, canonicalRetained: false, edited: true },
    { checkpointed: false, canonicalRetained: true, edited: false },
    { checkpointed: false, canonicalRetained: true, edited: true }
  ])('sends non-Track WeChat history and current accepted user with checkpoint=$checkpointed canonicalRetained=$canonicalRetained edited=$edited', async ({ checkpointed, canonicalRetained, edited }) => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'wechat-non-track-input-fixture', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        yield { type: 'text-delta', text: 'WeChat non-Track result' } as const
        yield { type: 'usage', inputTokens: 8, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    const tempDb = createTempDatabase('wechat-non-track-provider-reopen-')
    db = tempDb.db
    tempDbPath = tempDb.dbPath
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-non-track-input-'))
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'wechat-non-track-model'
    const serviceId = 'wechat-non-track-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Non-Track fixture', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true, supportedModelIds: [modelId] }],
      [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'wechat non-track input', model })
    const oldUser = appendMessageOperation(db, { id: 'wechat-non-track-old-user', sessionId: session.id, role: 'user', content: 'old WeChat user before edit', timestamp: 1, status: 'sent' })
    const oldAssistant = appendMessageOperation(db, { id: 'wechat-non-track-old-assistant', sessionId: session.id, role: 'assistant', content: 'old WeChat assistant before edit', timestamp: 2, status: 'completed' })
    if (checkpointed) {
      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'wechat-non-track-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp }
      ] })).toMatchObject({ committed: true, version: 1 })
    }
    if (canonicalRetained) {
      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'wechat-non-track-canonical-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp }
      ] })).toMatchObject({ committed: true, version: 1 })
      setCanonicalApiReadFeatureEnabled(db, true)
      await seedCanonicalSessionTranscript(db, session.id, [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp }
      ])
      expect(certifyCanonicalSessionApiRead(db, session.id)).toMatchObject({ status: 'eligible' })
      expect(enableCanonicalSessionWriteAuthority(db, session.id)).toMatchObject({ status: 'enabled' })
    }
    const patchHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const storage = createSqliteSessionStorage(db)
    const turnRuntime = createSessionTurnRuntime(storage, { deps: { now: Date.now, id: () => 'test-turn' } })
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => patchHandlers.set(channel, handler) } as never, {
      db, sessionStorage: storage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => workDir!, setWorkDir: () => undefined, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir }) as never
    })
    if (edited) {
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldUser.message.id, patch: { content: 'edited WeChat user sentinel' } })
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldAssistant.message.id, patch: { content: 'edited WeChat assistant sentinel' } })
    }
    const expectedOldUser = canonicalRetained && edited ? '' : edited ? 'edited WeChat user sentinel' : 'old WeChat user before edit'
    const expectedOldAssistant = canonicalRetained && edited ? '' : edited ? 'edited WeChat assistant sentinel' : 'old WeChat assistant before edit'
    expect(getDbConnection(db).prepare('SELECT id,sequence,content FROM messages WHERE session_id=? ORDER BY sequence LIMIT 2').all(session.id))
      .toEqual([
        { id: oldUser.message.id, sequence: 0, content: expectedOldUser },
        { id: oldAssistant.message.id, sequence: 1, content: expectedOldAssistant }
      ])
    if (canonicalRetained && edited) {
      const transcript = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).readCanonicalSessionTranscriptForShadow(session.id)
      expect(transcript.kind).toBe('matched')
      if (transcript.kind === 'matched') {
        expect(transcript.messages.filter(({ id }) => [oldUser.message.id, oldAssistant.message.id].includes(id))
          .map(({ content }) => content)).toEqual(['edited WeChat user sentinel', 'edited WeChat assistant sentinel'])
      }
    }
    const accepted = prepareTurnAtomically(db, {
      user: { id: 'wechat-non-track-current-user', sessionId: session.id, role: 'user', content: 'current WeChat accepted sentinel', timestamp: 3, status: 'sent' },
      assistant: { id: 'wechat-non-track-current-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 4, status: 'streaming' },
      turn: { turnId: 'wechat-non-track-current-turn', requestId: 'wechat-non-track-current-request', sessionId: session.id,
        assistantMessageId: 'wechat-non-track-current-assistant', state: 'prepared', startToken: 'wechat-non-track-current-token' }
    })
    const acceptedTurn = createAcceptedTurn({ turnId: 'wechat-non-track-current-turn', requestId: 'wechat-non-track-current-request', sessionId: session.id,
      lane: 'wechat', startToken: 'wechat-non-track-current-token', currentUserMessageId: accepted.user.message.id, transcriptVersion: canonicalRetained ? 1 : 0,
      config: { lane: 'wechat', model, llmServiceId: serviceId, thinkingEffort: 'low' } })
    acceptTurnContext(db, acceptedTurn)
    db.close()
    db = openDatabase(tempDbPath!)
    const reopenedStorage = createSqliteSessionStorage(db)
    expectAcceptedInputPersistence(db, acceptedTurn)
    const workDirManager: WorkDirManager = { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => workDir!,
      checkDirectoryWritable: () => ({ ok: true }) } as unknown as WorkDirManager

    const result = await runImRemoteAgent({ db, sessionStorage: reopenedStorage, sessionId: session.id, requestId: acceptedTurn.requestId,
      turnId: acceptedTurn.turnId, acceptedTurn, workDir, workDirManager, userDataDir: path.join(workDir, 'userdata'),
      getApiKey: async () => 'test-key', getBaseUrl: () => 'https://api.anthropic.com', getModel: () => model,
      remoteContext: { source: 'wechat', messageId: accepted.user.message.id, confirmPolicy: 'always' },
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, createProgressAdapter: () => ({ update: vi.fn(), close: vi.fn() } as never),
      buildSystemAppendix: () => 'WeChat non-Track input integration', progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG, progressConfig: {} })

    expect(result).toMatchObject({ ok: true, summary: 'WeChat non-Track result' })
    expect(providerRequests).toHaveLength(1)
    expect(providerRoutes).toHaveLength(1)
    expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
    const requestText = JSON.stringify(providerRequests[0])
    expect(requestText).toContain(checkpointed || canonicalRetained || !edited ? 'old WeChat user before edit' : 'edited WeChat user sentinel')
    expect(requestText).toContain(checkpointed || canonicalRetained || !edited ? 'old WeChat assistant before edit' : 'edited WeChat assistant sentinel')
    expect(requestText).toContain('current WeChat accepted sentinel')
    expectProviderInputSentinelOnce(providerRequests[0]!, 'current WeChat accepted sentinel')
    if (edited) {
      expect(requestText).not.toContain(checkpointed || canonicalRetained ? 'edited WeChat user sentinel' : 'old WeChat user before edit')
      expect(requestText).not.toContain(checkpointed || canonicalRetained ? 'edited WeChat assistant sentinel' : 'old WeChat assistant before edit')
    }
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE session_id=? AND id=?').get(session.id, oldUser.message.id))
      .toEqual({ content: expectedOldUser })
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE session_id=? AND id=?').get(session.id, oldAssistant.message.id))
      .toEqual({ content: expectedOldAssistant })
    expect(reopenedStorage.queries.readMessage({ sessionId: session.id, messageId: accepted.user.message.id }))
      .toMatchObject({ content: 'current WeChat accepted sentinel', status: 'sent' })
  })

  it.each([
    { checkpointed: false, edited: false }, { checkpointed: false, edited: true },
    { checkpointed: true, edited: false }, { checkpointed: true, edited: true }
  ])('sends only WeChat Track history to the real Hosted provider (checkpointed=$checkpointed edited=$edited)', async ({ checkpointed, edited }) => {
    previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    const originalRegister = runtime.modelProviders.register.bind(runtime.modelProviders)
    const providerRequests: Array<readonly unknown[]> = []
    const providerRoutes: Array<unknown> = []
    vi.spyOn(runtime.modelProviders, 'register').mockImplementation((profile, _provider) => originalRegister(profile, {
      providerId: 'wechat-track-input-fixture', stream: async function* (input) {
        providerRequests.push(structuredClone(input.request.messages))
        providerRoutes.push(structuredClone(input.route))
        yield { type: 'text-delta', text: 'WeChat Track result' } as const
        yield { type: 'usage', inputTokens: 8, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      }
    }))
    setDefaultAgentRuntime(runtime)
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-track-input-'))
    const tempDb = createTempDatabase('wechat-track-provider-reopen-')
    db = tempDb.db
    tempDbPath = tempDb.dbPath
    const model = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]
    const modelId = 'wechat-track-model'
    const serviceId = 'wechat-track-service'
    setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: model, enabled: true, supportsThinking: true }]))
    persistLlmServices(db, [{ id: serviceId, name: 'Track fixture', baseUrl: 'https://api.anthropic.com', apiKeyPresent: true, supportedModelIds: [modelId] }], [serviceId], { [serviceId]: 'test-key' })
    const session = createSession(db, { name: 'wechat-track-input', model })
    const oldUser = appendMessageOperation(db, { id: 'wechat-track-old-user', sessionId: session.id, role: 'user', content: 'WeChat old user sentinel', timestamp: 1, status: 'sent' })
    const oldAssistant = appendMessageOperation(db, { id: 'wechat-track-old-assistant', sessionId: session.id, role: 'assistant', content: 'WeChat old assistant sentinel', timestamp: 2, status: 'completed' })
    const otherUser = appendMessageOperation(db, { id: 'wechat-track-other-user', sessionId: session.id, role: 'user', content: 'Other WeChat Track secret sentinel', timestamp: 3, status: 'sent' })
    if (checkpointed) {
      expect(commitSessionTranscript(db, { sessionId: session.id, turnId: 'wechat-track-prior-turn', baseVersion: 0, outcome: 'completed', messages: [
        { id: oldUser.message.id, role: 'user', content: oldUser.message.content, timestamp: oldUser.message.timestamp },
        { id: oldAssistant.message.id, role: 'assistant', content: oldAssistant.message.content, timestamp: oldAssistant.message.timestamp },
        { id: otherUser.message.id, role: 'user', content: otherUser.message.content, timestamp: otherUser.message.timestamp }
      ] })).toMatchObject({ committed: true, version: 1 })
    }
    const track = createRemoteTrack(db, { trackId: 'wechat-provider-track-a', eventId: 'wechat-provider-track-a-root', idempotencyKey: 'wechat-provider-track-a-inbound',
      channel: 'wechat', identityKey: 'wechat-user-a', ownerId: 'wechat-owner-a', authorizationEpoch: 1, rootMessageId: oldUser.message.id, originSessionId: session.id, occurredAt: 1 })
    const otherTrack = createRemoteTrack(db, { trackId: 'wechat-provider-track-b', eventId: 'wechat-provider-track-b-root', idempotencyKey: 'wechat-provider-track-b-inbound',
      channel: 'wechat', identityKey: 'wechat-user-a', ownerId: 'wechat-owner-a', authorizationEpoch: 1, rootMessageId: otherUser.message.id, originSessionId: session.id, occurredAt: 2 })
    recordTrackModelMessage(db, { trackId: track.trackId, eventId: 'wechat-provider-old-user', idempotencyKey: 'wechat-provider-old-user', sessionId: session.id,
      messageId: oldUser.message.id, invocationId: 'wechat-track-prior-turn', occurredAt: 3, parentEventId: 'wechat-provider-track-a-root' })
    recordTrackModelMessage(db, { trackId: track.trackId, eventId: 'wechat-provider-old-assistant', idempotencyKey: 'wechat-provider-old-assistant', sessionId: session.id,
      messageId: oldAssistant.message.id, invocationId: 'wechat-track-prior-turn', occurredAt: 4, parentEventId: 'wechat-provider-track-a-root' })
    recordTrackModelMessage(db, { trackId: otherTrack.trackId, eventId: 'wechat-provider-other-message', idempotencyKey: 'wechat-provider-other-message', sessionId: session.id,
      messageId: otherUser.message.id, invocationId: 'wechat-track-other-turn', occurredAt: 5, parentEventId: 'wechat-provider-track-b-root' })
    const patchHandlers = new Map<string, (...args: unknown[]) => unknown>()
    const sessionStorage = createSqliteSessionStorage(db)
    const turnRuntime = createSessionTurnRuntime(sessionStorage, { deps: { now: Date.now, id: () => 'test-turn' } })
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => patchHandlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => workDir!, setWorkDir: () => undefined, getUserDataPath: () => path.join(workDir!, 'userdata'),
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir }) as never
    })
    if (edited) {
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldUser.message.id, patch: { content: 'WeChat edited user sentinel' } })
      await patchHandlers.get('message:patch-non-turn')!(null, { sessionId: session.id, messageId: oldAssistant.message.id, patch: { content: 'WeChat edited assistant sentinel' } })
    }
    const expectedOldUser = edited ? 'WeChat edited user sentinel' : 'WeChat old user sentinel'
    const expectedOldAssistant = edited ? 'WeChat edited assistant sentinel' : 'WeChat old assistant sentinel'
    expect(getDbConnection(db).prepare('SELECT id,sequence,content FROM messages WHERE session_id=? ORDER BY sequence LIMIT 2').all(session.id))
      .toEqual([
        { id: oldUser.message.id, sequence: 0, content: expectedOldUser },
        { id: oldAssistant.message.id, sequence: 1, content: expectedOldAssistant }
      ])
    const accepted = prepareTurnAtomically(db, {
      user: { id: 'wechat-track-current-user', sessionId: session.id, role: 'user', content: 'WeChat current input sentinel', timestamp: 6, status: 'sent' },
      assistant: { id: 'wechat-track-current-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 7, status: 'streaming' },
      turn: { turnId: 'wechat-track-current-turn', requestId: 'wechat-track-current-request', sessionId: session.id, assistantMessageId: 'wechat-track-current-assistant', state: 'prepared', startToken: 'wechat-track-current-token' }
    })
    bindRemoteTrackToTurn(db, { trackId: track.trackId, turnId: 'wechat-track-current-turn', sessionId: session.id, channel: 'wechat', identityKey: 'wechat-user-a', ownerId: 'wechat-owner-a',
      authorizationEpoch: 1, eventId: remoteTrackTurnBindingEventId(track.trackId, 'wechat-track-current-turn'), occurredAt: 6 })
    recordTrackModelMessage(db, { trackId: track.trackId, eventId: 'wechat-provider-current-user', idempotencyKey: 'wechat-provider-current-user', sessionId: session.id,
      messageId: accepted.user.message.id, invocationId: 'wechat-track-current-turn', occurredAt: 7, parentEventId: 'wechat-provider-track-a-root' })
    const acceptedTurn = createAcceptedTurn({ turnId: 'wechat-track-current-turn', requestId: 'wechat-track-current-request', sessionId: session.id, lane: 'wechat',
      startToken: 'wechat-track-current-token', currentUserMessageId: accepted.user.message.id, transcriptVersion: checkpointed ? 1 : 0,
      config: { lane: 'wechat', model, llmServiceId: serviceId, thinkingEffort: 'low' } })
    acceptTurnContext(db, acceptedTurn)
    const dbPath = tempDb.dbPath
    db.close()
    db = openDatabase(dbPath)
    const reopenedMessages = createSqliteSessionStorage(db).queries.readMessages({ sessionId: session.id })
    const reopenedOldUser = reopenedMessages.find(({ id }) => id === oldUser.message.id)!
    const trackContext = { trackId: track.trackId, channel: 'wechat' as const, identityKey: 'wechat-user-a', ownerId: 'wechat-owner-a', authorizationEpoch: 1,
      rootMessageId: reopenedOldUser.id, attributionEventId: 'wechat-provider-track-a-root' }
    const view = buildTrackModelInputViewRef(db, { ...trackContext, sessionId: session.id, acceptedUserMessageId: accepted.user.message.id,
      currentInvocationId: 'wechat-track-current-turn' })
    const acceptedTrackViewVersion = view.viewVersion
    const acceptedTrackIncludedMessageIds = [...view.includedMessageIds]
    const persistedAcceptedTurn = createAcceptedTurn({ turnId: 'wechat-track-current-turn', requestId: 'wechat-track-current-request', sessionId: session.id, lane: 'wechat',
      startToken: 'wechat-track-current-token', currentUserMessageId: accepted.user.message.id, transcriptVersion: checkpointed ? 1 : 0,
      config: { lane: 'wechat', model, llmServiceId: serviceId, thinkingEffort: 'low' } })
    expectAcceptedInputPersistence(db, persistedAcceptedTurn)
    expect(getDbConnection(db).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(getDbConnection(db).prepare('SELECT track_id FROM turns WHERE turn_id=?').get('wechat-track-current-turn')).toEqual({ track_id: track.trackId })
    const storage = createSqliteSessionStorage(db)
    const workDirManager: WorkDirManager = { listProfiles: () => [], getActiveProfileId: () => 'p1', getActiveWorkDir: () => workDir!, checkDirectoryWritable: () => ({ ok: true }) } as unknown as WorkDirManager

    const result = await runImRemoteAgent({ db, sessionStorage: storage, sessionId: session.id, requestId: persistedAcceptedTurn.requestId, turnId: persistedAcceptedTurn.turnId,
      acceptedTurn: persistedAcceptedTurn, workDir, workDirManager, userDataDir: path.join(workDir, 'userdata'), getApiKey: async () => 'test-key',
      getBaseUrl: () => 'https://api.anthropic.com', getModel: () => model,
      remoteContext: { source: 'wechat', messageId: accepted.user.message.id, confirmPolicy: 'always', userId: 'wechat-user-a', authOwner: 'wechat-owner-a', trackContext, trackModelInputView: view },
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG, createProgressAdapter: () => ({ update: vi.fn(), close: vi.fn() } as never),
      buildSystemAppendix: () => 'WeChat Track isolation integration', progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG, progressConfig: {} })

    expect(result).toMatchObject({ ok: true, summary: 'WeChat Track result' })
    expect(providerRequests).toHaveLength(1)
    expect(providerRoutes).toHaveLength(1)
    expect(providerRoutes[0]).toMatchObject({ modelId: model, endpoint: 'https://api.anthropic.com' })
    const requestText = JSON.stringify(providerRequests[0])
    expect(requestText).toContain(expectedOldUser)
    expect(requestText).toContain(expectedOldAssistant)
    if (edited) {
      expect(requestText).not.toContain('WeChat old user sentinel')
      expect(requestText).not.toContain('WeChat old assistant sentinel')
    } else {
      expect(requestText).not.toContain('WeChat edited user sentinel')
      expect(requestText).not.toContain('WeChat edited assistant sentinel')
    }
    expect(requestText).toContain('WeChat current input sentinel')
    expectProviderInputSentinelOnce(providerRequests[0]!, 'WeChat current input sentinel')
    expect(requestText).not.toContain('Other WeChat Track secret sentinel')
    expect(view.includedMessageIds).toEqual([oldUser.message.id, oldAssistant.message.id, accepted.user.message.id])
    expect(acceptedTrackIncludedMessageIds).toEqual(view.includedMessageIds)
    expect(view.viewVersion).toBe(acceptedTrackViewVersion)
  })
})
