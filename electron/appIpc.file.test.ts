import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { waitForToolConfirm } from './toolConfirmRegistry'
import * as databaseComposition from './database'
import * as databaseOperations from './database/operations'
import { getMainWindow } from './windowRef'
import { BrowserWindow } from 'electron'
import { getCallAdmissionGate } from './runtime/callAdmissionGate'
import * as turnExecutionConfig from './turnExecutionConfig'
import * as sessionStorageShadow from './sessionStorage/infrastructure/sqlite/sessionStorageShadow'
import * as sessionStorageCutover from './sessionStorage/certification'
import * as sessionTranscriptProjection from './runtime/sessionTranscriptProjection'
import * as sessionContentWriteAuthority from './runtime/sessionContentWriteAuthority'
import { backupPageReader, loadBackupPayload } from './ipc/ipcShared'
import { createMemoryAppDb, createTempDatabase } from './database/testHelpers'
import { SqliteAgentHistory } from './runtime/sqliteAgentHistory'
import { getDbConnection as getActualDbConnection } from './database/sqliteStore'
import { TurnCoordinator } from '../src/shared/turnCoordinator'
import type { SessionQueries } from './sessionStorage/public/ports'
import type { SessionStorage } from './sessionStorage/host/ports'
import { createSqliteSessionStorage } from './sessionStorage/sqliteSessionStorage'
import { createSessionCommands } from './sessionStorage/commands'
import { createSessionExecutionStore } from './sessionStorage/execution'
import { beginSessionMessageContentCleanup, clearNextSessionMessageContentBatch, markSessionMessageContentWriteStopped,
  verifyAndCompleteSessionMessageContentCleanup } from './sessionStorage/maintenance'
import { runHostedAgentTurn, type AgentTurnHost } from '../packages/agent-sdk/src/turn'
import { ModelProviderRegistry } from '../packages/agent-sdk/src/model'
import { RecordingModelProvider } from '../packages/agent-provider-testing/src'

const database = {
  listSessions: vi.fn(() => []),
  listPersistedTurns: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getPersistedTurn: vi.fn(),
  listTurnErrorsByAssistantMessageIds: vi.fn((): Array<{ assistantMessageId: string; message: string }> => []),
  setPersistedTurnExecutionConfig: vi.fn(() => true),
  createPersistedTurn: vi.fn(),
  failConfiguringTurn: vi.fn(() => true),
  getMessage: vi.fn(),
  getMessageSequence: vi.fn(),
  getRecentTurnRoutingMessages: vi.fn(() => []),
  hasVisionInTurnRoutingContext: vi.fn(() => false),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getSessionUsage: vi.fn(),
  getSessionMessageRevisionSnapshot: vi.fn((_db: unknown, sessionId: string) => ({ sessionId, generation: 'generation-1', messageRevision: 1 })),
  hasActiveTurn: vi.fn(() => false)
}

const WORK_DIR = path.resolve('/fake/workdir')
const mockReadTurnByRequest = vi.fn()

const mockFs = vi.hoisted(() => ({
  writeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  mkdtemp: vi.fn<() => Promise<string>>().mockResolvedValue('/tmp/spaceassistant-markdown-pdf-test'),
  mkdir: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  rm: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  rename: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  stat: vi.fn<() => Promise<import('fs').Stats>>().mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
  unlink: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('fs/promises', () => ({
  default: mockFs,
  ...mockFs
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: vi.fn()
}))

vi.mock('./database', () => ({
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  getDbConnection: vi.fn(() => ({ exec: vi.fn() }))
}))

vi.mock('./runtime/sessionContentWriteAuthority', () => ({
  writeCanonicalBackedMessageContent: vi.fn()
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
  createAnthropicClient: vi.fn()
}))

const mockSkillManager = vi.hoisted(() => ({
  route: vi.fn().mockResolvedValue({ skills: [] }),
  buildSystemPrompt: vi.fn(() => '')
}))

vi.mock('./skills/skillManager', () => ({
  createSkillManager: vi.fn(() => mockSkillManager)
}))

vi.mock('./turnExecutionConfig', () => ({
  resolveTrustedTurnExecutionConfig: vi.fn().mockResolvedValue({
    lane: 'desktop', model: 'deepseek-chat', llmServiceId: 'service-1', baseUrl: 'https://example.test', maxTokens: 4096, enableThinking: false
  })
}))

vi.mock('./llmServiceResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('./llmServiceResolver')>(),
  resolveLlmCredentialsForModel: vi.fn().mockResolvedValue({ serviceId: 'service-1', baseUrl: 'https://example.test', getApiKey: vi.fn() })
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn()
}))

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeWorkDirManager(): AppIpcContext['workDirManager'] {
  return {
    listProfiles: () => [],
    addProfile: vi.fn().mockReturnValue({ success: true }),
    updateProfile: vi.fn().mockReturnValue({ success: true }),
    removeProfile: vi.fn().mockReturnValue({ success: true }),
    switchProfile: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    getActiveProfile: () => undefined,
    getActiveWorkDir: () => WORK_DIR,
    getActiveProfileId: () => 'default',
    validateProfilesForSave: () => ({ valid: true }),
    validateProfileInput: () => ({ valid: true }),
    checkDirectoryWritable: () => ({ ok: true }),
    migrateFromLegacy: vi.fn(),
    persistProfiles: vi.fn()
  }
}

function makeCtx(db = createMemoryAppDb()): AppIpcContext {
  const ctx: AppIpcContext = {
    db,
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      deleteBackup: vi.fn()
    } as unknown as AppIpcContext['backup'],
    workDirManager: makeWorkDirManager(),
    getWorkDir: () => WORK_DIR,
    setWorkDir: vi.fn(),
    getUserDataPath: () => '/fake/userdata',
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
    getBrowserDetectContext: () => ({
      isPackaged: false,
      appPath: '/fake/app',
      devRoot: '/fake/project'
    })
  }
  const issuedFences = new WeakMap<object, {
    sessionId: string
    snapshot: ReturnType<typeof databaseOperations.getSessionMessageRevisionSnapshot>
    boundarySequence?: number
    excludeMessageIds: string[]
    limit?: number
    reuseUserMessageId?: string
    canonical?: sessionStorageCutover.CanonicalApiReadFence
  }>()
  const queries: SessionQueries = {
    readSession: (sessionId) => database.getSession(ctx.db, sessionId),
    listSessions: (options) => database.listSessions(ctx.db, options),
    readMessage: ({ sessionId, messageId }) => {
      const message = sessionTranscriptProjection.getProjectedMessage(ctx.db, messageId)
      return message?.sessionId === sessionId ? message : undefined
    },
    readMessages: ({ sessionId, limit, offset }) => sessionTranscriptProjection.getProjectedMessages(ctx.db, sessionId, limit, offset),
    readChatPage: ({ sessionId, beforeSequence, limit }) => sessionTranscriptProjection.getProjectedChatMessagePage(ctx.db, sessionId, beforeSequence, limit),
    readTurnContext: ({ sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds = [] }) =>
      sessionTranscriptProjection.getProjectedTurnContext(ctx.db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds),
    readApiBaseline: ({ sessionId, limit }) => limit === undefined
      ? sessionTranscriptProjection.getProjectedApiContextBaseline(ctx.db, sessionId)
      : sessionTranscriptProjection.getProjectedApiContextBaseline(ctx.db, sessionId, limit),
    readContextHistorySummaryBaseline: (sessionId) => ({ sessionId, entries: [] }),
    readRoutingInput: (input) => {
      const snapshot = database.getSessionMessageRevisionSnapshot(ctx.db, input.sessionId)
      if (!snapshot) throw new Error('TURN_SESSION_NOT_FOUND')
      const userMessageId = input.reuseUserMessageId ?? input.requiredUserMessageId
      const userMessage = userMessageId ? sessionTranscriptProjection.getProjectedMessage(ctx.db, userMessageId) : undefined
      const userInput = input.reuseUserMessageId ? userMessage?.content : input.userInput ?? userMessage?.content
      if ((input.reuseUserMessageId || input.requiredUserMessageId) && userInput === undefined) throw new Error('TURN_USER_MESSAGE_MISSING')
      const fence = Object.freeze({})
      issuedFences.set(fence, {
        sessionId: input.sessionId, snapshot, boundarySequence: input.boundarySequence,
        excludeMessageIds: input.excludeMessageIds ?? [], limit: input.limit,
        ...(input.reuseUserMessageId ? { reuseUserMessageId: input.reuseUserMessageId } : {})
      })
      return {
        recentMessages: sessionTranscriptProjection.getProjectedRecentTurnRoutingMessages(
          ctx.db, input.sessionId, input.limit, input.boundarySequence, input.excludeMessageIds
        ),
        ...(userInput !== undefined ? { userInput } : {}),
        hasVision: database.hasVisionInTurnRoutingContext(ctx.db, input.sessionId, input.boundarySequence, input.excludeMessageIds ?? []),
        fence: fence as import('./sessionStorage/public/model').SelectionFence
      }
    },
    resolveRoutingInput: ({ sessionId, selection, routeInput }) => {
      const issued = issuedFences.get(selection as object)
      if (!issued || issued.sessionId !== sessionId) throw new Error('TURN_CONTEXT_CHANGED_DURING_PREPARATION')
      try {
        sessionStorageShadow.shadowTurnRoutingInput(ctx.db, {
          sessionId,
          mode: issued.reuseUserMessageId ? 'reuse-user' : 'create-user',
          ...(issued.reuseUserMessageId ? { reuseUserMessageId: issued.reuseUserMessageId } : {}),
          routeInput,
          boundarySequence: issued.boundarySequence,
          excludeMessageIds: issued.excludeMessageIds,
          limit: issued.limit
        })
      } catch { /* test adapter keeps shadow failures observational */ }
      const canonical = sessionStorageCutover.readCanonicalTurnRoutingInputWithFenceIfEligible(ctx.db, {
        sessionId,
        mode: issued.reuseUserMessageId ? 'reuse-user' : 'create-user',
        ...(issued.reuseUserMessageId ? { reuseUserMessageId: issued.reuseUserMessageId } : {}),
        routeInput,
        boundarySequence: issued.boundarySequence,
        excludeMessageIds: issued.excludeMessageIds,
        limit: issued.limit
      })
      const fence = Object.freeze({})
      issuedFences.set(fence, { ...issued, ...(canonical ? { canonical: canonical.fence } : {}) })
      return { routeInput: canonical?.routeInput ?? routeInput, fence: fence as import('./sessionStorage/public/model').SelectionFence }
    },
    readSelectionSnapshot: (sessionId, fence) => {
      const issued = issuedFences.get(fence as object)
      if (!issued || issued.sessionId !== sessionId) return undefined
      const current = database.getSessionMessageRevisionSnapshot(ctx.db, sessionId)
      return current && issued.snapshot && current.generation === issued.snapshot.generation &&
        current.messageRevision === issued.snapshot.messageRevision ? issued.snapshot : undefined
    },
    isSelectionCurrent: (sessionId, token) => {
      const issued = issuedFences.get(token as object)
      if (!issued || issued.sessionId !== sessionId) return false
      if (issued.canonical && !sessionStorageCutover.isCanonicalApiReadFenceCurrent(ctx.db, sessionId, issued.canonical)) return false
      const current = database.getSessionMessageRevisionSnapshot(ctx.db, sessionId)
      return Boolean(current && issued.snapshot && current.generation === issued.snapshot.generation &&
        current.messageRevision === issued.snapshot.messageRevision)
    },
    readExportPage: ({ sessionId, fromSequence, pageSize }) =>
      sessionTranscriptProjection.getProjectedMessagesPageWithSequence(ctx.db, sessionId, fromSequence, pageSize),
    readSearchCorpusPage: ({ sessionId, fromSequence, pageSize }) =>
      sessionTranscriptProjection.getProjectedSearchCorpusPage(ctx.db, sessionId, fromSequence, pageSize),
    searchMessages: ({ query, activeProfileId, limit }) => sessionTranscriptProjection.searchProjectedMessages(ctx.db, query, activeProfileId, limit),
    readRetryTarget: ({ sessionId, failedAssistantMessageId }) =>
      sessionTranscriptProjection.resolveProjectedRetryContext(ctx.db, sessionId, failedAssistantMessageId),
    listTurnErrorsByAssistantMessageIds: (ids) => database.listTurnErrorsByAssistantMessageIds(ctx.db, ids),
    readMessageSequence: ({ sessionId, messageId }) => database.getMessageSequence(ctx.db, sessionId, messageId)
  }
  const execution = createSessionExecutionStore(ctx.db, queries)
  ctx.sessionStorage = {
    queries,
    commands: { ...createSessionCommands(ctx.db), renameSession: (sessionId: string, name: string) => database.updateSession(ctx.db, sessionId, { name }) },
    execution
  } satisfies SessionStorage
  return ctx
}

function routeSessionStorageTurnReadsThroughDatabaseMocks(ctx: AppIpcContext): void {
  const storage = ctx.sessionStorage!
  const execution = storage.execution
  ctx.sessionStorage = { ...storage, execution: {
    ...execution,
    readTurn: ({ sessionId, turnId }) => {
      const turn = database.getPersistedTurn(ctx.db, turnId)
      return turn?.sessionId === sessionId ? turn : undefined
    },
    readTurnByRequest: ({ sessionId, requestId }) => mockReadTurnByRequest(sessionId, requestId),
    commitExecutionConfig: ({ ref, config, intentFingerprint, fence }) => {
      const snapshot = storage.queries.readSelectionSnapshot(ref.sessionId, fence)
      return database.setPersistedTurnExecutionConfig(ctx.db, ref.turnId, config, intentFingerprint, snapshot ?? fence)
    },
    failConfiguring: ({ ref, version, error }) => database.failConfiguringTurn(ctx.db, ref.turnId, version, error)
  } } as SessionStorage
}

describe('file IPC handlers', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext
  let resetRealDbForwarding: (() => void) | undefined

  afterEach(() => {
    try { ctx?.db.close() } catch { /* real reopen tests close their database explicitly */ }
  })

  beforeEach(() => {
    resetRealDbForwarding?.()
    resetRealDbForwarding = undefined
    vi.clearAllMocks()
    mockReadTurnByRequest.mockReset()
    vi.mocked(databaseComposition.getConfigValue).mockReset()
    vi.mocked(databaseComposition.setConfigValue).mockReset()
    vi.mocked(databaseComposition.getDbConnection).mockReturnValue({
      exec: vi.fn(), prepare: vi.fn(() => ({ get: vi.fn(), all: vi.fn(() => []), run: vi.fn(() => ({ changes: 1 })) }))
    } as never)
    mockFs.writeFile.mockResolvedValue(undefined)
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.rm.mockResolvedValue(undefined)
    mockFs.rename.mockResolvedValue(undefined)
    mockFs.stat.mockReset()
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats)
    vi.mocked(BrowserWindow).mockReset()
    vi.mocked(BrowserWindow).mockImplementation(class {
      loadFile = vi.fn().mockResolvedValue(undefined)
      webContents = { printToPDF: vi.fn().mockResolvedValue(Buffer.from('pdf')) }
      destroy = vi.fn()
    } as never)
    mockSkillManager.route.mockResolvedValue({ skills: [] })
    vi.mocked(sessionContentWriteAuthority.writeCanonicalBackedMessageContent).mockResolvedValue(true)
    mockSkillManager.buildSystemPrompt.mockReturnValue('')
    vi.mocked(getMainWindow).mockReturnValue(undefined)

    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('auto backup reader resolves message bodies through the canonical-aware sequence page', async () => {
    const message = { id: 'backup-canonical-user', sessionId: 'backup-session', role: 'user' as const,
      content: 'canonical backup body', timestamp: 1, status: 'sent' as const, schemaVersion: 1 }
    const readPage = vi.spyOn(sessionTranscriptProjection, 'getProjectedMessagesPageWithSequence').mockReturnValue({
      rows: [{ message, sequence: 7 }], nextSequence: 8
    })
    const page = await backupPageReader(ctx, 'backup-session')(0, 25)

    expect(readPage).toHaveBeenCalledWith(ctx.db, 'backup-session', 0, 25)
    expect(page).toEqual({ messages: [message], nextSequence: 8 })
  })

  it('backup payload trusts the injected query result and does not fall back to a database reader', async () => {
    const queries = Object.freeze({ ...ctx.sessionStorage!.queries, readSession: vi.fn(() => undefined) })
    ctx.sessionStorage = { ...ctx.sessionStorage!, queries } as SessionStorage

    await expect(loadBackupPayload(ctx, 'missing-backup-session')).resolves.toBeNull()
    expect(database.getSession).not.toHaveBeenCalled()
    expect(queries.readSession).toHaveBeenCalledWith('missing-backup-session')
  })

  it('prepares canonical chat bodies before selecting the backup session snapshot', async () => {
    const events: string[] = []
    const queries = Object.freeze({ ...ctx.sessionStorage!.queries, readSession: vi.fn(() => { events.push('select'); return undefined }) })
    ctx.sessionStorage = { ...ctx.sessionStorage!, queries,
      ensureChatBodyV1: async ({ sessionId }: { sessionId: string }) => { events.push(`ensure:${sessionId}`); return [] } } as SessionStorage

    await expect(loadBackupPayload(ctx, 'backup-order-session')).resolves.toBeNull()

    expect(events).toEqual(['select'])
  })

  it('API context baseline IPC resolves the latest-window rows through canonical bodies', async () => {
    const message = { id: 'api-baseline-user', sessionId: 'api-baseline-session', role: 'user' as const,
      content: 'canonical api baseline', timestamp: 1, status: 'sent' as const, schemaVersion: 1 }
    const readBaseline = vi.spyOn(sessionTranscriptProjection, 'getProjectedApiContextBaseline').mockReturnValue({
      sessionId: 'api-baseline-session', entries: [{ message, sequence: 9 }]
    })

    await expect(ipc.getHandler('chat:get-api-context-baseline')!({}, { sessionId: 'api-baseline-session' }))
      .resolves.toEqual({ sessionId: 'api-baseline-session', entries: [{ message, sequence: 9 }] })
    expect(readBaseline).toHaveBeenCalledWith(ctx.db, 'api-baseline-session')
  })

  it('context token summary IPC delegates to the injected session query port', () => {
    expect(ipc.getHandler('chat:get-context-history-summary-baseline')!({}, { sessionId: 'summary-session' }))
      .toEqual({ sessionId: 'summary-session', entries: [] })
  })

  it('canonical-backed message edits go through the canonical append-and-mirror writer', async () => {
    const session = databaseOperations.createSession(ctx.db, { name: 'canonical edit', model: 'deepseek-chat' })
    const persisted = databaseOperations.appendMessage(ctx.db, { id: 'ipc-canonical-edit', sessionId: session.id, role: 'user', content: 'edited', timestamp: 1, status: 'sent' })
    const message = persisted.message
    getActualDbConnection(ctx.db).prepare("UPDATE messages SET content_storage_state='canonical-backed-dual-write' WHERE id=?").run(message.id)
    const events: string[] = []
    const storage = ctx.sessionStorage as unknown as { queries: SessionQueries; ensureChatBodyV1: (input: { sessionId: string }) => Promise<unknown> }
    const queries = storage.queries as SessionQueries & { readMessage: SessionQueries['readMessage'] }
    storage.ensureChatBodyV1 = async ({ sessionId }) => { events.push(`ensure:${sessionId}`) }
    const readMessage = queries.readMessage
    queries.readMessage = (input) => { events.push(`select:${input.sessionId}`); return readMessage(input) }
    vi.mocked(database.getMessage).mockReturnValue(message)
    vi.spyOn(sessionTranscriptProjection, 'getProjectedMessage').mockReturnValue(message)
    vi.mocked(database.getMessageSequence).mockReturnValue(4)

    const result = await ipc.getHandler('message:patch-non-turn')!({}, {
      sessionId: session.id, messageId: message.id, patch: { content: 'edited' }
    })

    expect(sessionContentWriteAuthority.writeCanonicalBackedMessageContent).toHaveBeenCalledWith(ctx.db, message.id, 'edited')
    expect(database.updateMessageContent).not.toHaveBeenCalled()
    expect(result).toEqual({ message, sequence: 4 })
    expect(events).toEqual([`ensure:${session.id}`, `select:${session.id}`])
  })

  it('rejects a real IPC edit after canonical-only cleanup has completed', async () => {
    vi.restoreAllMocks()
    const temp = createTempDatabase('canonical-only-ipc-edit-')
    const real = { ...await vi.importActual<typeof import('./database')>('./database'),
      ...await vi.importActual<typeof import('./database/operations')>('./database/operations') }
    ctx.db.close()
    ctx = makeCtx(temp.db)
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const session = real.createSession(ctx.db, { name: 'canonical-only IPC edit', model: 'test' })
    const user = real.appendMessage(ctx.db, { id: 'ipc-canonical-only-user', sessionId: session.id, role: 'user',
      content: 'canonical question', timestamp: 1, status: 'sent' })
    const assistant = real.appendMessage(ctx.db, { id: 'ipc-canonical-only-assistant', sessionId: session.id, role: 'assistant',
      content: 'canonical answer', timestamp: 2, status: 'completed' })
    let history = new SqliteAgentHistory(getActualDbConnection(ctx.db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'ipc-canonical-only-invocation', turnId: 'ipc-canonical-only-turn', sequence: 1, schemaVersion: 1,
      eventId: 'ipc-canonical-only-context', idempotencyKey: 'ipc-canonical-only-context', kind: 'invocation-context-committed',
      payload: { messages: [user.message, assistant.message].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
    }], 0)
    expect(sessionStorageCutover.certifyCanonicalSessionApiRead(ctx.db, session.id).status).toBe('eligible')
    sessionStorageCutover.setCanonicalApiReadFeatureEnabled(ctx.db, true)
    const actualWriteAuthority = await vi.importActual<typeof import('./runtime/sessionContentWriteAuthority')>('./runtime/sessionContentWriteAuthority')
    expect(actualWriteAuthority.enableCanonicalSessionWriteAuthority(ctx.db, session.id).status).toBe('enabled')
    expect(markSessionMessageContentWriteStopped(ctx.db, session.id)).toBe(true)
    expect(beginSessionMessageContentCleanup(ctx.db, session.id)).toBe(true)
    expect(clearNextSessionMessageContentBatch(ctx.db, session.id, 10).status).toBe('complete')
    const databasePath = temp.dbPath
    ctx.db.close()
    const reopened = real.openDatabase(databasePath)
    ctx = makeCtx(reopened)
    history = new SqliteAgentHistory(getActualDbConnection(ctx.db), 1, Date.now, session.id)
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    expect(verifyAndCompleteSessionMessageContentCleanup(ctx.db, session.id)).toBe(true)

    const before = history.readCanonicalSessionTranscriptForShadow(session.id)
    await expect(ipc.getHandler('message:patch-non-turn')!({}, {
      sessionId: session.id, messageId: 'ipc-canonical-only-user', patch: { content: 'edited after cleanup' }
    })).rejects.toThrow('canonical write authority requires a canonical History append')

    expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toEqual(before)
    expect(getActualDbConnection(ctx.db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?')
      .get('ipc-canonical-only-user')).toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    expect(getActualDbConnection(ctx.db).prepare('SELECT COUNT(*) AS count FROM turns WHERE session_id=?').get(session.id))
      .toEqual({ count: 0 })
    ctx.db.close()
    temp.cleanup()
  })

  it('routes toolCalls metadata through its dedicated command and rejects mixed patches', async () => {
    const beforeCalls = [{ id: 'shell-call', toolName: 'run_shell', input: {}, status: 'completed', riskLevel: 'medium', result: { success: true, data: { output: 'ok' } } }] as never
    const message = { id: 'ipc-tool-call-patch', sessionId: 'ipc-edit-session', role: 'assistant', content: 'kept body', timestamp: 1, toolCalls: beforeCalls } as import('../src/shared/domainTypes').Message
    const toolCalls = [{ ...beforeCalls[0], result: { ...beforeCalls[0].result, data: { ...beforeCalls[0].result.data, terminalScrollback: { cols: 80, rows: 24 } } } }] as never
    vi.spyOn(sessionTranscriptProjection, 'getProjectedMessage').mockReturnValue(message)
    vi.spyOn(databaseOperations, 'updateMessageContent').mockReturnValue({ message: { ...message, toolCalls }, sequence: 5 })

    const handler = ipc.getHandler('message:patch-non-turn')!
    await expect(handler({}, { sessionId: message.sessionId, messageId: message.id, patch: { toolCalls } }))
      .resolves.toEqual({ message: { ...message, toolCalls }, sequence: 5 })
    expect(databaseOperations.updateMessageContent).toHaveBeenCalledWith(ctx.db, message.id, { toolCalls })
    await expect(handler({}, { sessionId: message.sessionId, messageId: message.id, patch: { content: 'body', toolCalls } }))
      .rejects.toThrow('MESSAGE_PATCH_OPERATION_REQUIRED')
  })

  it('统一 Markdown 导出接口拒绝非法参数且不弹保存框', async () => {
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'html', markdown: '# x', sourcePath: 'x.md' })).resolves.toEqual({ ok: false, error: '导出参数无效' })
    const { dialog } = await import('electron')
    expect(vi.mocked(dialog.showSaveDialog)).not.toHaveBeenCalled()
  })

  it('统一 Markdown 导出接口拒绝非 Markdown 来源', async () => {
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# x', sourcePath: 'x.txt' })).resolves.toEqual({ ok: false, error: '仅支持导出 Markdown 文件' })
  })

  it('保存框取消时不生成文件', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' } as never)
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# x', sourcePath: '方案.v2.md' })).resolves.toEqual({ ok: false, canceled: true })
    expect(vi.mocked(dialog.showSaveDialog)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ defaultPath: expect.stringMatching(/方案\.v2\.pdf$/), filters: [{ name: 'PDF', extensions: ['pdf'] }] }))
  })

  it('DOCX 保存框使用正确过滤器并通过统一写入边界', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.docx' } as never)
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'docx', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: true, path: path.join('/tmp', '方案.docx') })
    expect(vi.mocked(dialog.showSaveDialog)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: [{ name: 'Word 文档', extensions: ['docx'] }] }))
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(mockFs.rename).toHaveBeenCalled()
  })

  it('补正扩展名后使用最终 PDF 路径完成导出', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.txt' } as never)
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1 } as never)
    let statCalls = 0
    mockFs.stat.mockImplementation(async () => ({ dev: 1, ino: statCalls++ === 0 ? 1 : 2, isDirectory: () => false } as unknown as import('fs').Stats))
    const handler = ipc.getHandler('file:export-markdown')!
    // normalizeMarkdownExportPath 经 path.parse/join 产出平台原生分隔符，断言不能用 posix 字面量
    await expect(handler({}, { format: 'pdf', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: true, path: path.join('/tmp', '方案.pdf') })
  })

  it('补正扩展名后目标已存在且取消覆盖时不写入', async () => {
    const { dialog } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.txt' } as never)
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0 } as never)
    let statCalls = 0
    mockFs.stat.mockImplementation(async () => ({ dev: 1, ino: statCalls++ === 0 ? 1 : 2, isDirectory: () => false } as unknown as import('fs').Stats))
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: false, canceled: true })
    expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalled()
    expect(mockFs.writeFile).not.toHaveBeenCalled()
  })

  it('PDF 使用离屏打印、A4 参数和原子写入', async () => {
    const { dialog, BrowserWindow } = await import('electron')
    vi.mocked(getMainWindow).mockReturnValue({} as never)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '/tmp/方案.txt' } as never)
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1 } as never)
    mockFs.stat.mockResolvedValueOnce({ dev: 1, ino: 1, isDirectory: () => false } as unknown as import('fs').Stats)
    mockFs.stat.mockRejectedValueOnce(new Error('ENOENT'))
    const printToPDF = vi.fn().mockResolvedValue(Buffer.from('pdf'))
    const destroy = vi.fn()
    vi.mocked(BrowserWindow).mockImplementation(class {
      loadURL = vi.fn().mockResolvedValue(undefined)
      loadFile = vi.fn().mockResolvedValue(undefined)
      webContents = { printToPDF }
      destroy = destroy
    } as never)
    const handler = ipc.getHandler('file:export-markdown')!
    await expect(handler({}, { format: 'pdf', markdown: '# 标题', sourcePath: '方案.md' })).resolves.toEqual({ ok: true, path: path.join('/tmp', '方案.pdf') })
    expect(printToPDF).toHaveBeenCalledWith({ printBackground: true, pageSize: 'A4', margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 } })
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(destroy).toHaveBeenCalled()
  })

  it('accepts a prepared turn and starts execution asynchronously', async () => {
    const executeTurn = vi.fn().mockResolvedValue(undefined)
    ctx.executeTurn = executeTurn
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:execute-turn')!
    const sender = { send: vi.fn() }
    const payload = {
      requestId: 'request-1',
      turnId: 'turn-1',
      turnStartToken: 'token-1',
      sessionId: 'session-1',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }]
    }

    await expect(handler({ sender }, payload)).resolves.toEqual({ ok: true, accepted: true, turnId: 'turn-1' })
    expect(executeTurn).toHaveBeenCalledWith(sender, {
      requestId: 'request-1', turnId: 'turn-1', turnStartToken: 'token-1', sessionId: 'session-1'
    })
  })

  it('相同 requestId 重放优先返回冻结 turn，不读取漂移后的当前配置', async () => {
    const frozenConfig = { lane: 'desktop' as const, model: 'deepseek-chat', maxTokens: 4096, enableThinking: false, locale: 'zh-CN' }
    mockReadTurnByRequest.mockReturnValue({
      turnId: 'frozen-turn', requestId: 'stable-request', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', userMessageId: 'user-1', state: 'prepared', version: 0,
      startToken: 'frozen-token',
      intentFingerprint: JSON.stringify({ mode: 'create-user', input: JSON.stringify({ v: 1, text: 'hello', attachments: [] }), excludeMessageIds: [], config: frozenConfig }),
      excludeMessageIds: [], executionConfig: frozenConfig
    })
    vi.mocked(database.getMessage).mockImplementation((_db, messageId) => messageId === 'user-1'
      ? { id: 'user-1', sessionId: 'session-1', role: 'user', content: 'hello', timestamp: 1, status: 'sent', schemaVersion: 1 }
      : { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 2, status: 'streaming', schemaVersion: 1 })
    vi.spyOn(sessionTranscriptProjection, 'getProjectedMessage').mockImplementation((_db, messageId) =>
      messageId === 'user-1'
        ? { id: 'user-1', sessionId: 'session-1', role: 'user', content: 'hello', timestamp: 1, status: 'sent', schemaVersion: 1 }
        : { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 2, status: 'streaming', schemaVersion: 1 })

    const coordinator = new TurnCoordinator({
      findByRequestId: (sessionId, requestId) => mockReadTurnByRequest(sessionId, requestId)
    } as never, { now: Date.now, id: () => 'unused-turn-id' })
    ctx.turnRuntime = { coordinator, cancel: vi.fn(), listActive: vi.fn(() => []), subscribe: vi.fn(() => () => undefined) } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    routeSessionStorageTurnReadsThroughDatabaseMocks(ctx)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const handler = ipc.getHandler('chat:prepare-turn')!
    await expect(handler({}, {
      mode: 'create-user', requestId: 'stable-request', sessionId: 'session-1', input: { text: 'hello' }, config: {}
    })).resolves.toMatchObject({ turnId: 'frozen-turn', startToken: 'frozen-token' })
    await expect(handler({}, {
      mode: 'create-user', requestId: 'stable-request', sessionId: 'session-1', input: { text: 'changed' }, config: {}
    })).rejects.toThrow('TURN_REQUEST_FINGERPRINT_MISMATCH')

    expect(database.getSession).not.toHaveBeenCalled()
    expect(database.getMessages).not.toHaveBeenCalled()
    expect(database.appendMessage).not.toHaveBeenCalled()
  })

  it('reuse-user 的旧正文为空时通过 canonical reader 路由，保留附件判定与 await 后 fence', async () => {
    const started = {
      turnId: 'reuse-turn', requestId: 'reuse-request', sessionId: 'session-1',
      userMessage: { id: 'reuse-user', sessionId: 'session-1', role: 'user' as const, content: 'queued input', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'reuse-assistant', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'reuse-token', intentFingerprint: '{}', executionConfig: {}
    }
    ctx.turnRuntime = {
      coordinator: { prepare: vi.fn().mockReturnValue(started), consume: vi.fn(), restoreTurn: vi.fn(), recover: vi.fn(), getTerminal: vi.fn() },
      cancel: vi.fn(), listActive: vi.fn(() => []), subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    mockReadTurnByRequest.mockReturnValueOnce(undefined)
    vi.mocked(database.getPersistedTurn).mockReturnValue({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 8, state: 'configuring', version: 0, startToken: started.startToken
    })
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)
    vi.mocked(database.getMessage).mockReturnValue({
      id: 'reuse-user', sessionId: 'session-1', role: 'user', content: '', timestamp: 1,
      status: 'sent', schemaVersion: 1, attachments: [{ id: 'image-1' }]
    } as never)
    const canonicalAwareUserMessage = { id: 'reuse-user', sessionId: 'session-1', role: 'user' as const,
      content: 'original queued text', timestamp: 1, status: 'sent' as const, schemaVersion: 1, attachments: [{ id: 'image-1' }] }
    const canonicalAwareMessageRead = vi.spyOn(sessionTranscriptProjection, 'getProjectedMessage').mockReturnValue(canonicalAwareUserMessage)
    const recentMessages = [{ role: 'assistant' as const, content: 'prior response' }, { role: 'user' as const, content: 'prior input' }]
    vi.mocked(database.getRecentTurnRoutingMessages).mockReturnValue(recentMessages)
    vi.spyOn(sessionTranscriptProjection, 'getProjectedRecentTurnRoutingMessages').mockReturnValue(recentMessages)
    let shadowRouteInput: unknown
    vi.spyOn(sessionStorageShadow, 'shadowTurnRoutingInput').mockImplementationOnce((_db, input) => {
      shadowRouteInput = input.routeInput
      throw new Error('injected shadow-only read failure')
    })
    const canonicalRecentMessages = [{ role: 'assistant' as const, content: 'canonical prior response' }]
    const canonicalRouteRead = vi.spyOn(sessionStorageCutover, 'readCanonicalTurnRoutingInputWithFenceIfEligible').mockImplementationOnce((_db, input) => ({
      routeInput: {
        ...input.routeInput,
        userInput: 'canonical queued text',
        recentMessages: canonicalRecentMessages
      },
      fence: { sessionGeneration: 'generation-1', messageRevision: 1, canonicalSessionSeq: 1, canonicalCommitOrder: 1,
        watermarkEventId: 'event-1', watermarkInvocationId: 'invocation-1' }
    }) as never)
    vi.spyOn(sessionStorageCutover, 'isCanonicalApiReadFenceCurrent').mockReturnValue(true)
    const intent = { mode: 'reuse-user' as const, requestId: started.requestId, sessionId: started.sessionId, userMessageId: 'reuse-user', excludeMessageIds: [], config: {} }
    const preparedView = { sessionId: started.sessionId, sessionGeneration: 'generation-1', sourceIdentityJson: '{"source":1}',
      scopeKey: 'chatBodyV1', specVersion: 3, payloadGeneration: 'projection-one', payloadDigest: 'a'.repeat(64),
      validatedRangeJson: '{}', cachePresent: true, stateSourceIdentityJson: '{"source":1}',
      statePayloadGeneration: 'projection-one', statePayloadDigest: 'a'.repeat(64), stateValidatedRangeJson: '{}' }
    const preparedMessageRead = vi.fn(async () => canonicalAwareUserMessage)
    const preparedRoutingRead = vi.fn(async () => undefined)

    ipc = mockIpcMain()
    routeSessionStorageTurnReadsThroughDatabaseMocks(ctx)
    ctx.sessionStorage = { ...ctx.sessionStorage!, ensureChatBodyV1: async () => preparedView,
      queries: { ...ctx.sessionStorage!.queries, readPreparedMessage: preparedMessageRead,
        readPreparedRoutingInput: preparedRoutingRead } as SessionQueries }
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    await expect(ipc.getHandler('chat:prepare-turn')!({}, intent)).resolves.toMatchObject({ turnId: started.turnId })
    await vi.waitFor(() => expect(mockSkillManager.route).toHaveBeenCalledTimes(1))

    expect(canonicalAwareMessageRead).toHaveBeenCalledWith(ctx.db, 'reuse-user')
    expect(preparedMessageRead).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'reuse-user', prepared: preparedView }))
    expect(preparedRoutingRead).toHaveBeenCalledWith(expect.objectContaining({ prepared: preparedView, signal: expect.any(AbortSignal) }))
    expect(database.getMessage(ctx.db, 'reuse-user')?.content).toBe('')
    expect(canonicalRouteRead).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      sessionId: 'session-1', mode: 'reuse-user', reuseUserMessageId: 'reuse-user',
      routeInput: expect.objectContaining({ userInput: 'original queued text', recentMessages })
    }))
    expect(mockSkillManager.route).toHaveBeenCalledWith(expect.objectContaining({
      userInput: 'canonical queued text',
      recentMessages: canonicalRecentMessages,
      sessionId: 'session-1'
    }))
    expect(shadowRouteInput).toMatchObject({
      userInput: 'original queued text', recentMessages, sessionState: {}, sessionMetadata: {},
      model: 'deepseek-chat', baseUrl: 'https://example.test', sessionId: 'session-1'
    })
    expect(database.setPersistedTurnExecutionConfig).toHaveBeenCalledWith(ctx.db, started.turnId, expect.any(Object), expect.any(String), {
      sessionId: 'session-1', generation: 'generation-1', messageRevision: 1
    })
    expect(turnExecutionConfig.resolveTrustedTurnExecutionConfig).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ readSession: expect.any(Function) }),
      expect.objectContaining({ updateSettings: expect.any(Function) }),
      'session-1',
      'desktop',
      { projectMemoryEnabled: true },
      { requiresVision: true }
    )
  })


  it('相同 requestId 在配置尚未冻结时等待同一单飞路由，且只路由一次', async () => {
    let releaseRoute!: (value: { skills: [] }) => void
    mockSkillManager.route.mockImplementationOnce(() => new Promise((resolve) => { releaseRoute = resolve }))
    const started = {
      turnId: 'configuring-turn', requestId: 'configuring-request', sessionId: 'session-1',
      userMessage: { id: 'user-1', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'configuring-token', intentFingerprint: '{}', executionConfig: {}
    }
    const coordinator = {
      prepare: vi.fn().mockReturnValue(started),
      consume: vi.fn(),
      restoreTurn: vi.fn(),
      recover: vi.fn(),
      getTerminal: vi.fn()
    }
    ctx.turnRuntime = {
      coordinator,
      consume: vi.fn(() => ({ ...started, version: 1 })),
      cancel: vi.fn(),
      listActive: vi.fn(() => []),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    const executeTurn = vi.fn().mockResolvedValue(undefined)
    ctx.executeTurn = executeTurn
    mockReadTurnByRequest
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
        assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
        contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
      })
    vi.mocked(database.getPersistedTurn).mockReturnValue({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
    })
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)

    ipc = mockIpcMain()
    routeSessionStorageTurnReadsThroughDatabaseMocks(ctx)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:prepare-turn')!
    const intent = { mode: 'create-user' as const, requestId: 'configuring-request', sessionId: 'session-1', input: { text: 'hello' }, config: {} }

    const first = handler({}, intent)
    await vi.waitFor(() => expect(mockSkillManager.route).toHaveBeenCalledTimes(1))
    await expect(first).resolves.toMatchObject({ turnId: started.turnId, startToken: started.startToken })
    const execute = ipc.getHandler('chat:execute-turn')!
    await expect(execute({ sender: {} }, {
      requestId: started.requestId, turnId: started.turnId, turnStartToken: started.startToken, sessionId: started.sessionId
    })).resolves.toMatchObject({ accepted: true, turnId: started.turnId })
    expect(executeTurn).not.toHaveBeenCalled()
    const retry = handler({}, intent)
    let retrySettled = false
    void Promise.resolve(retry).then(() => { retrySettled = true })
    await Promise.resolve()
    expect(retrySettled).toBe(false)
    expect(mockSkillManager.route).toHaveBeenCalledTimes(1)

    releaseRoute({ skills: [] })
    await expect(retry).resolves.toMatchObject({ turnId: started.turnId, startToken: started.startToken })
    await vi.waitFor(() => expect(executeTurn).toHaveBeenCalledTimes(1))
    expect(database.setPersistedTurnExecutionConfig).toHaveBeenCalledTimes(1)
  })

  it('技能路由等待期间 session revision 改变时拒绝冻结旧配置并终结 configuring turn', async () => {
    let releaseRoute!: (value: { skills: [] }) => void
    mockSkillManager.route.mockImplementationOnce(() => new Promise((resolve) => { releaseRoute = resolve }))
    const started = {
      turnId: 'stale-configuring-turn', requestId: 'stale-configuring-request', sessionId: 'session-1',
      userMessage: { id: 'stale-user', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'stale-assistant', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'stale-token', intentFingerprint: '{}', executionConfig: {}
    }
    const runtimeConsume = vi.fn(() => ({ ...started, version: 1 }))
    ctx.turnRuntime = {
      coordinator: { prepare: vi.fn().mockReturnValue(started), consume: vi.fn(), restoreTurn: vi.fn(), recover: vi.fn(), getTerminal: vi.fn() },
      consume: runtimeConsume,
      cancel: vi.fn(), listActive: vi.fn(() => []), subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    const provider = new RecordingModelProvider([
      { type: 'text-delta', text: 'should not reach provider' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ])
    const registry = new ModelProviderRegistry()
    registry.register({ routeId: 'desktop-test', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, provider)
    const hostedHost: AgentTurnHost = {
      createPorts: async () => ({
        registry, safetyGate: {} as never, prepareTool: vi.fn(), toolExecution: {} as never,
        request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 32 },
        routeId: 'desktop-test', invocationId: started.turnId, maxModelTurns: 1
      })
    }
    const executeTurn = vi.fn(async () => {
      await runHostedAgentTurn({ host: hostedHost, invocationId: started.turnId, turnId: started.turnId,
        routeId: 'desktop-test', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 32 } })
    })
    ctx.executeTurn = executeTurn
    mockReadTurnByRequest.mockReturnValueOnce(undefined)
    vi.mocked(database.getPersistedTurn).mockReturnValue({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
    })
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)
    vi.mocked(database.setPersistedTurnExecutionConfig).mockReturnValueOnce(false)

    ipc = mockIpcMain()
    routeSessionStorageTurnReadsThroughDatabaseMocks(ctx)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:prepare-turn')!
    await expect(handler({}, {
      mode: 'create-user', requestId: started.requestId, sessionId: started.sessionId, input: { text: 'hello' }, config: {}
    })).resolves.toMatchObject({ turnId: started.turnId, startToken: started.startToken })
    await vi.waitFor(() => expect(mockSkillManager.route).toHaveBeenCalledTimes(1))

    // 模拟消息编辑或 session generation 变化导致数据库 CAS fence 拒绝旧快照。
    releaseRoute({ skills: [] })
    await vi.waitFor(() => expect(runtimeConsume).toHaveBeenCalledWith(started.turnId, {
      type: 'source-failed', message: 'TURN_CONTEXT_CHANGED_DURING_PREPARATION'
    }))
    expect(database.setPersistedTurnExecutionConfig).toHaveBeenCalledWith(
      ctx.db, started.turnId, expect.any(Object), expect.any(String),
      { sessionId: 'session-1', generation: 'generation-1', messageRevision: 1 }
    )
    expect(database.failConfiguringTurn).toHaveBeenCalledWith(ctx.db, started.turnId, 1, expect.objectContaining({
      code: 'configuration-failed', message: 'TURN_CONTEXT_CHANGED_DURING_PREPARATION'
    }))
    expect(executeTurn).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(0)
  })

  it('配置阶段失败时把 source-failed 事实（含真实原因）交给 projection，渲染层才能标失败并显示原因', async () => {
    const started = {
      turnId: 'failed-configuring-turn', requestId: 'failed-configuring-request', sessionId: 'session-1',
      userMessage: { id: 'user-1', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'failed-token', intentFingerprint: '{}', executionConfig: {}
    }
    const runtimeConsume = vi.fn(() => ({
      ...started,
      version: 3,
      assistantMessage: { ...started.assistantMessage, status: 'failed' as const }
    }))
    ctx.turnRuntime = {
      coordinator: {
        prepare: vi.fn().mockReturnValue(started),
        consume: vi.fn(),
        restoreTurn: vi.fn(),
        recover: vi.fn(),
        getTerminal: vi.fn()
      },
      consume: runtimeConsume,
      cancel: vi.fn(),
      listActive: vi.fn(() => []),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    mockReadTurnByRequest.mockReturnValue(undefined)
    vi.mocked(database.getPersistedTurn).mockReturnValue({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: 'configuring', version: 0, startToken: started.startToken
    })
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)
    mockSkillManager.route.mockRejectedValueOnce(new Error('会话模型「claude-sonnet-4-20250514」当前不可用'))

    ipc = mockIpcMain()
    routeSessionStorageTurnReadsThroughDatabaseMocks(ctx)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('chat:prepare-turn')!

    // prepare 只交还已占有的 turn，配置在后台继续；失败必须经由 projection 出口通知渲染层。
    await expect(handler({}, {
      mode: 'create-user', requestId: 'failed-configuring-request', sessionId: 'session-1', input: { text: 'hello' }, config: {}
    })).resolves.toMatchObject({ turnId: 'failed-configuring-turn' })

    // 直接调用 coordinator.consume 不会经过 runtime 的 projection 出口，渲染层会一直停在「生成中」。
    await vi.waitFor(() => expect(runtimeConsume).toHaveBeenCalled())
    expect(runtimeConsume).toHaveBeenCalledWith('failed-configuring-turn', {
      type: 'source-failed',
      message: '会话模型「claude-sonnet-4-20250514」当前不可用'
    })
    expect(database.failConfiguringTurn).toHaveBeenCalledWith(
      expect.anything(),
      'failed-configuring-turn',
      3,
      expect.objectContaining({ code: 'configuration-failed' })
    )
  })

  it('取消 configuring turn 会中止技能路由，且 execute 不启动 provider', async () => {
    let routeSignal: AbortSignal | undefined
    mockSkillManager.route.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      routeSignal = signal
      signal?.addEventListener('abort', () => reject(new Error('routing aborted')), { once: true })
    }))
    const started = {
      turnId: 'cancel-configuring-turn', requestId: 'cancel-configuring-request', sessionId: 'session-1',
      userMessage: { id: 'cancel-user', sessionId: 'session-1', role: 'user' as const, content: 'hello', timestamp: 1, status: 'sent' as const, schemaVersion: 1 },
      assistantMessage: { id: 'cancel-assistant', sessionId: 'session-1', role: 'assistant' as const, content: '', timestamp: 2, status: 'streaming' as const, schemaVersion: 1 },
      version: 0, startToken: 'cancel-token', intentFingerprint: '{}', executionConfig: {}
    }
    const coordinator = {
      prepare: vi.fn().mockReturnValue(started),
      consume: vi.fn(),
      restoreTurn: vi.fn(),
      recover: vi.fn(),
      getTerminal: vi.fn()
    }
    const runtimeCancel = vi.fn(() => true)
    ctx.turnRuntime = { coordinator, cancel: runtimeCancel, listActive: vi.fn(() => []), subscribe: vi.fn(() => () => undefined) } as unknown as AppIpcContext['turnRuntime']
    const executeTurn = vi.fn().mockResolvedValue(undefined)
    ctx.executeTurn = executeTurn
    let cancelled = false
    mockReadTurnByRequest.mockReturnValueOnce(undefined)
    vi.mocked(database.getPersistedTurn).mockImplementation(() => ({
      turnId: started.turnId, requestId: started.requestId, sessionId: started.sessionId,
      assistantMessageId: started.assistantMessage.id, userMessageId: started.userMessage.id,
      contextBoundarySequence: 0, state: cancelled ? 'terminal' : 'configuring', version: 0, startToken: started.startToken
    }))
    vi.mocked(database.getSession).mockReturnValue({ id: 'session-1', model: 'deepseek-chat', skillsState: {}, metadata: {} } as never)

    ipc = mockIpcMain()
    routeSessionStorageTurnReadsThroughDatabaseMocks(ctx)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const prepared = await ipc.getHandler('chat:prepare-turn')!({}, {
      mode: 'create-user', requestId: started.requestId, sessionId: started.sessionId, input: { text: 'hello' }, config: {}
    }) as { turnId: string }
    await vi.waitFor(() => expect(routeSignal).toBeDefined())
    cancelled = true
    expect(ipc.getHandler('chat:cancel-turn')!({}, started.turnId)).toBe(true)
    expect(runtimeCancel).toHaveBeenCalledWith(started.turnId)
    expect(routeSignal?.aborted).toBe(true)

    await vi.waitFor(() => expect(database.failConfiguringTurn).not.toHaveBeenCalled())
    await expect(ipc.getHandler('chat:execute-turn')!({ sender: {} }, {
      requestId: started.requestId, turnId: prepared.turnId, turnStartToken: started.startToken, sessionId: started.sessionId
    })).resolves.toMatchObject({ accepted: false, turnId: started.turnId })
    expect(executeTurn).not.toHaveBeenCalled()
  })

  it('desktop cancel IPC delegates control to the Core coordinator', async () => {
    const cancel = vi.fn().mockReturnValue(true)
    const recover = vi.fn()
    const runtimeCancel = vi.fn().mockReturnValue(true)
    const cancelQueuedTurn = vi.spyOn(getCallAdmissionGate(), 'cancelByTurnId')
    ctx.turnRuntime = {
      coordinator: { cancel, recover },
      cancel: runtimeCancel,
      getTurn: vi.fn(() => ({ turnId: 'turn-desktop-1', requestId: 'req-desktop-1', sessionId: 'sess-1' })),
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const logger = await import('./agentLogger/agentLogger')
    const logSpy = vi.spyOn(logger, 'logAgentEvent')

    const result = await ipc.getHandler('chat:cancel-turn')!({}, 'turn-desktop-1')

    expect(result).toBe(true)
    expect(cancelQueuedTurn).toHaveBeenCalledWith('turn-desktop-1')
    expect(runtimeCancel).toHaveBeenCalledWith('turn-desktop-1')
    expect(cancel).not.toHaveBeenCalled()
    // turn.cancel：取消被接受的权威记录，requestId 从 turn 对象透传
    expect(logSpy).toHaveBeenCalledWith('warn', 'turn.cancel', {
      turnId: 'turn-desktop-1',
      requestId: 'req-desktop-1',
      accepted: true
    })
    logSpy.mockRestore()
  })

  it('desktop cancel IPC records turn.cancel with accepted=false when the turn is already terminal', async () => {
    const cancel = vi.fn().mockReturnValue(true)
    const recover = vi.fn()
    const runtimeCancel = vi.fn().mockReturnValue(false)
    ctx.turnRuntime = {
      coordinator: { cancel, recover },
      cancel: runtimeCancel,
      getTurn: vi.fn(() => undefined),
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const logger = await import('./agentLogger/agentLogger')
    const logSpy = vi.spyOn(logger, 'logAgentEvent')

    const result = await ipc.getHandler('chat:cancel-turn')!({}, 'turn-gone')

    expect(result).toBe(false)
    // turn 取不到时省略 requestId，不编造；accepted=false 如实记录「拒绝」
    expect(logSpy).toHaveBeenCalledWith('warn', 'turn.cancel', {
      turnId: 'turn-gone',
      accepted: false
    })
    logSpy.mockRestore()
  })

  it('desktop confirm IPC resolves the pending Core confirmation without emitting a fact directly', async () => {
    const pending = waitForToolConfirm('request-confirm-1', 'tool-1', [], { toolName: 'run_shell', lane: 'desktop', sessionId: 'session-1' })
    const handler = ipc.getHandler('tool:confirm-response')!

    await handler({}, { requestId: 'request-confirm-1', toolUseId: 'tool-1', sessionId: 'session-1', approved: false })
    await expect(pending).resolves.toBe('rejected')
  })

  it('records a local IPC handler dispatch baseline for the final pipeline report', async () => {
    const handler = ipc.getHandler('chat:list-active-turns')!
    const sampleCount = 1_000
    const startedAt = performance.now()
    for (let i = 0; i < sampleCount; i++) await handler({}, { sessionId: 's1' })
    const elapsedMs = performance.now() - startedAt
    console.log('[chat-ipc-dispatch-perf]', JSON.stringify({ sampleCount, elapsedMs, p50ApproxMs: elapsedMs / sampleCount }))
    expect(elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('renderer 无 known 重载时仍返回 checkpoint 尚未提交的 terminal', async () => {
    const terminal = {
      turnId: 'terminal-pending-1', requestId: 'request-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', version: 4, outcome: 'completed' as const,
      message: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: 'done', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    }
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus: vi.fn().mockReturnValue('pending')
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: Array<{ turnId: string; lifecycle: string }> }
    expect(changed.changed).toHaveLength(1)
    expect(changed.changed[0]).toMatchObject({ turnId: terminal.turnId, lifecycle: 'completed' })
  })

  it('重启恢复为 recovered 的未完成 turn 不会被重载投影成 completed', async () => {
    const terminal = {
      turnId: 'terminal-recovered-1', requestId: 'request-recovered-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-recovered-1', version: 5, outcome: 'recovered' as const,
      message: { id: 'assistant-recovered-1', sessionId: 'session-1', role: 'assistant' as const, content: 'partial', timestamp: 1, status: 'failed' as const, schemaVersion: 1 }
    }
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus: vi.fn().mockReturnValue('pending')
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: Array<{ turnId: string; lifecycle: string; outcome?: string }> }

    expect(changed.changed).toHaveLength(1)
    expect(changed.changed[0]).toMatchObject({ turnId: terminal.turnId, lifecycle: 'failed', outcome: 'interrupted' })
  })

  it('已提交的历史 terminal 不会在 renderer 无 known 重载时重新注入', async () => {
    const terminal = {
      turnId: 'terminal-committed-1', requestId: 'request-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', version: 4, outcome: 'completed' as const,
      message: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: 'done', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    }
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus: vi.fn().mockReturnValue('committed')
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: unknown[] }
    expect(changed.changed).toEqual([])
  })

  it('低版本 checkpoint 已提交时仍恢复更高版本的 terminal', async () => {
    const terminal = {
      turnId: 'terminal-versioned-1', requestId: 'request-1', sessionId: 'session-1',
      assistantMessageId: 'assistant-1', version: 4, outcome: 'completed' as const,
      message: { id: 'assistant-1', sessionId: 'session-1', role: 'assistant' as const, content: 'done', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }
    }
    const checkpointStatus = vi.fn((_turnId: string, targetVersion?: number) => targetVersion !== undefined && targetVersion > 3 ? 'pending' as const : 'committed' as const)
    ctx.turnRuntime = {
      coordinator: { recover: vi.fn() },
      listActive: vi.fn().mockReturnValue([]),
      subscribe: vi.fn(() => () => undefined),
      listTerminals: vi.fn().mockReturnValue([terminal]),
      checkpointStatus
    } as unknown as AppIpcContext['turnRuntime']
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const changed = await ipc.getHandler('chat:get-turn-displays')!({}, { known: [] }) as { changed: Array<{ turnId: string }> }
    expect(changed.changed).toHaveLength(1)
    expect(checkpointStatus).toHaveBeenCalledWith(terminal.turnId, terminal.version)
  })
  describe('chat:get-turn-errors', () => {
    it('按 assistantMessageId 返回持久化失败原因', async () => {
      vi.mocked(database.listTurnErrorsByAssistantMessageIds).mockReturnValue([
        { assistantMessageId: 'a1', message: '会话模型「x」当前不可用（未知模型）' }
      ])
      const handler = ipc.getHandler('chat:get-turn-errors')!

      expect(await handler({}, { assistantMessageIds: ['a1', 'a2'] })).toEqual([
        { assistantMessageId: 'a1', message: '会话模型「x」当前不可用（未知模型）' }
      ])
      expect(database.listTurnErrorsByAssistantMessageIds).toHaveBeenCalledWith(ctx.db, ['a1', 'a2'])
    })

    it('内存终态优先于持久化记录', async () => {
      vi.mocked(database.listTurnErrorsByAssistantMessageIds).mockReturnValue([
        { assistantMessageId: 'a1', message: '旧的持久化原因' }
      ])
      const getTerminalByAssistantMessageId = vi.fn((messageId: string) =>
        messageId === 'a1' ? { error: { code: 'source-failed', message: '内存里的最新原因' } } : undefined
      )
      ctx.turnRuntime = {
        coordinator: { getTerminalByAssistantMessageId, recover: vi.fn(), listActive: vi.fn(() => []) },
        listActive: vi.fn(() => []),
        cancel: vi.fn(),
        subscribe: vi.fn(() => () => undefined)
      } as unknown as AppIpcContext['turnRuntime']
      ipc = mockIpcMain()
      registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
      const handler = ipc.getHandler('chat:get-turn-errors')!

      expect(await handler({}, { assistantMessageIds: ['a1'] })).toEqual([
        { assistantMessageId: 'a1', message: '内存里的最新原因' }
      ])
      expect(getTerminalByAssistantMessageId).toHaveBeenCalledWith('a1')
    })

    it('没有可查 id 时不查库', async () => {
      const handler = ipc.getHandler('chat:get-turn-errors')!

      expect(await handler({}, { assistantMessageIds: [] })).toEqual([])
      expect(await handler({}, undefined)).toEqual([])
      expect(database.listTurnErrorsByAssistantMessageIds).not.toHaveBeenCalled()
    })
  })

  describe('file:create-file', () => {
    it('creates an empty file', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await handler({}, 'newfile.txt')
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join(WORK_DIR, 'newfile.txt'), '')
    })

    it('creates intermediate directories', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await handler({}, 'sub/dir/file.txt')
      expect(mockFs.mkdir).toHaveBeenCalledWith(path.join(WORK_DIR, 'sub', 'dir'), { recursive: true })
      expect(mockFs.writeFile).toHaveBeenCalledWith(path.join(WORK_DIR, 'sub', 'dir', 'file.txt'), '')
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:create-file')!
      await expect(handler({}, '../escape.txt')).rejects.toThrow()
    })
  })

  describe('file:create-directory', () => {
    it('creates a directory recursively', async () => {
      const handler = ipc.getHandler('file:create-directory')!
      await handler({}, 'a/b/c')
      expect(mockFs.mkdir).toHaveBeenCalledWith(path.join(WORK_DIR, 'a', 'b', 'c'), { recursive: true })
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:create-directory')!
      await expect(handler({}, '../evil')).rejects.toThrow()
    })
  })

  describe('file:delete', () => {
    it('deletes a file', async () => {
      const handler = ipc.getHandler('file:delete')!
      await handler({}, 'old.txt')
      expect(mockFs.rm).toHaveBeenCalledWith(path.join(WORK_DIR, 'old.txt'), { recursive: true, force: true })
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:delete')!
      await expect(handler({}, '../../etc/passwd')).rejects.toThrow()
    })
  })

  describe('file:rename', () => {
    it('renames a file', async () => {
      const handler = ipc.getHandler('file:rename')!
      await handler({}, 'old.txt', 'new.txt')
      expect(mockFs.rename).toHaveBeenCalledWith(path.join(WORK_DIR, 'old.txt'), path.join(WORK_DIR, 'new.txt'))
    })

    it('rejects newName with path separator /', async () => {
      const handler = ipc.getHandler('file:rename')!
      await expect(handler({}, 'file.txt', 'sub/evil.txt')).rejects.toThrow()
    })

    it('rejects newName with path separator \\', async () => {
      const handler = ipc.getHandler('file:rename')!
      await expect(handler({}, 'file.txt', 'sub\\evil.txt')).rejects.toThrow()
    })

    it('rejects path traversal in relPath', async () => {
      const handler = ipc.getHandler('file:rename')!
      await expect(handler({}, '../escape.txt', 'ok.txt')).rejects.toThrow()
    })
  })

  describe('file:move', () => {
    it('moves a file to target directory', async () => {
      const handler = ipc.getHandler('file:move')!
      await handler({}, 'src/file.txt', 'dest')
      expect(mockFs.rename).toHaveBeenCalledWith(path.join(WORK_DIR, 'src', 'file.txt'), path.join(WORK_DIR, 'dest', 'file.txt'))
    })

    it('rejects if destination is not a directory', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => false } as unknown as import('fs').Stats)
      const handler = ipc.getHandler('file:move')!
      await expect(handler({}, 'file.txt', 'notadir')).rejects.toThrow()
    })

    it('rejects path traversal in source', async () => {
      const handler = ipc.getHandler('file:move')!
      await expect(handler({}, '../escape', 'dest')).rejects.toThrow()
    })

    it('rejects path traversal in destination', async () => {
      const handler = ipc.getHandler('file:move')!
      await expect(handler({}, 'src', '../escape')).rejects.toThrow()
    })
  })

  describe('file:to-viewer-url', () => {
    it('returns file url for valid relative path', async () => {
      mockFs.stat.mockResolvedValueOnce({ isFile: () => true } as unknown as import('fs').Stats)
      const handler = ipc.getHandler('file:to-viewer-url')!
      const result = await handler({}, 'pages/index.html')
      expect(result).toEqual({
        ok: true,
        url: expect.stringMatching(/^file:\/\//)
      })
    })

    it('rejects path traversal', async () => {
      const handler = ipc.getHandler('file:to-viewer-url')!
      const result = await handler({}, '../escape.html')
      expect(result.ok).toBe(false)
    })

    it('rejects non-file paths', async () => {
      mockFs.stat.mockResolvedValueOnce({ isFile: () => false } as unknown as import('fs').Stats)
      const handler = ipc.getHandler('file:to-viewer-url')!
      const result = await handler({}, 'folder')
      expect(result).toEqual({ ok: false, error: 'not a file' })
    })
  })

  it('真实 SQLite prepare-turn 在 canonical-only + reopen 后向技能路由提供复用正文和历史上下文', async () => {
    vi.restoreAllMocks()
    const temp = createTempDatabase('prepare-turn-canonical-only-')
    const real = { ...await vi.importActual<typeof import('./database')>('./database'), ...await vi.importActual<typeof import('./database/operations')>('./database/operations') }
    const db = temp.db
    const session = real.createSession(db, { name: 'canonical prepare', model: 'deepseek-chat', workDirProfileId: 'default' })
    const earlierUser = real.appendMessage(db, { id: 'prepare-earlier-user', sessionId: session.id, role: 'user',
      content: 'earlier question', timestamp: 1, status: 'sent' }).message
    const earlierAssistant = real.appendMessage(db, { id: 'prepare-earlier-assistant', sessionId: session.id, role: 'assistant',
      content: 'earlier answer', timestamp: 2, status: 'completed' }).message
    const reused = real.appendMessage(db, { id: 'prepare-reuse-user', sessionId: session.id, role: 'user',
      content: 'reused canonical input', timestamp: 3, status: 'sent', attachments: [{ id: 'prepare-image', name: 'image.png', path: '/image.png', mimeType: 'image/png' }] }).message
    const conn = getActualDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'prepare-canonical-history', turnId: 'prepare-canonical-turn', sequence: 1, schemaVersion: 1,
      eventId: 'prepare-canonical-context', idempotencyKey: 'prepare-canonical-context', kind: 'invocation-context-committed',
      payload: { messages: [earlierUser, earlierAssistant, reused].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) }
    }], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    db.close()
    const reopened = real.openDatabase(temp.dbPath)

    const forwardingNames = ['getSession', 'getPersistedTurn', 'getSessionMessageRevisionSnapshot',
      'getMessage', 'listPersistedTurns', 'appendMessage', 'setPersistedTurnExecutionConfig', 'failConfiguringTurn',
      'getRecentTurnRoutingMessages', 'hasVisionInTurnRoutingContext'] as const
    const originalImplementations = new Map(forwardingNames.map((name) => [name, vi.mocked(database[name] as never).getMockImplementation()]))
    resetRealDbForwarding = () => {
      for (const name of forwardingNames) {
        const mock = vi.mocked(database[name] as never)
        mock.mockReset()
        const original = originalImplementations.get(name)
        if (original) mock.mockImplementation(original as never)
      }
    }
    const forward = <K extends keyof typeof real>(name: K) => vi.mocked(database[name] as never).mockImplementation((...args: never[]) =>
      (real[name] as (...values: never[]) => unknown)(...args) as never)
    for (const name of forwardingNames) forward(name)
    vi.mocked(databaseComposition.getDbConnection).mockImplementation(() => getActualDbConnection(reopened))
    vi.mocked(databaseComposition.getConfigValue).mockImplementation((_db, key) => real.getConfigValue(reopened, key))
    vi.mocked(databaseComposition.setConfigValue).mockImplementation((_db, key, value) => real.setConfigValue(reopened, key, value))
    ctx.db = reopened
    const projectionReadEvents: string[] = []
    const sqliteSessionStorage = createSqliteSessionStorage(reopened)
    ctx.sessionStorage = {
      ...sqliteSessionStorage,
      ensureChatBodyV1: vi.fn(async () => { projectionReadEvents.push('ensure') }),
      queries: { ...sqliteSessionStorage.queries, readRoutingInput: (input) => {
        projectionReadEvents.push('select')
        return sqliteSessionStorage.queries.readRoutingInput(input)
      } }
    }

    let coordinatorId = 0
    const storage = {
      findByRequestId: (sessionId: string, requestId: string) => {
        const turn = databaseOperations.getTurnByRequestId(reopened, sessionId, requestId)
        if (!turn) return undefined
        const assistantMessage = sessionTranscriptProjection.getProjectedMessage(reopened, turn.assistantMessageId)
        const userMessage = turn.userMessageId ? sessionTranscriptProjection.getProjectedMessage(reopened, turn.userMessageId) : undefined
        if (!assistantMessage) return undefined
        return { turnId: turn.turnId, requestId: turn.requestId, sessionId: turn.sessionId, assistantMessage,
          ...(userMessage ? { userMessage } : {}), version: turn.version, startToken: turn.startToken ?? '',
          ...(turn.intentFingerprint ? { intentFingerprint: turn.intentFingerprint } : {}),
          ...(turn.executionConfig ? { executionConfig: turn.executionConfig } : {}) }
      },
      hasActiveTurn: (sessionId: string) => real.hasActiveTurn(reopened, sessionId),
      getMessage: (messageId: string) => sessionTranscriptProjection.getProjectedMessage(reopened, messageId),
      append: (message: Parameters<typeof real.appendMessage>[1]) => real.appendMessage(reopened, message),
      appendMany: (messages: Parameters<typeof real.appendMessagesAtomically>[1]) => real.appendMessagesAtomically(reopened, messages),
      prepareAtomic: (input: Parameters<typeof real.prepareTurnAtomically>[1]) => real.prepareTurnAtomically(reopened, input),
      claimQueuedAtomic: (input: Parameters<typeof real.claimQueuedTurnAtomically>[1]) => real.claimQueuedTurnAtomically(reopened, input),
      update: (messageId: string, patch: Parameters<typeof real.updateMessageContent>[2]) => real.updateMessageContent(reopened, messageId, patch),
      updateIfStreaming: (messageId: string, patch: Parameters<typeof real.updateMessageContentIfStreaming>[2]) => real.updateMessageContentIfStreaming(reopened, messageId, patch),
      checkpoint: (turnId: string, version: number, message: { id: string } & Parameters<typeof real.updateMessageContent>[2]) =>
        real.checkpointTurnAtomically(reopened, turnId, version, message.id, message),
      listUnfinishedTurns: () => [],
      recoverTurn: () => false,
      saveTurn: (turn: Parameters<typeof real.createPersistedTurn>[1]) => { real.createPersistedTurn(reopened, turn) },
      updateTurnState: (turnId: string, state: string, patch?: Parameters<typeof real.updatePersistedTurnState>[3]) => {
        real.updatePersistedTurnState(reopened, turnId, state, patch)
      }
    }
    const coordinator = new TurnCoordinator(storage as never, { now: Date.now, id: () => `prepare-generated-${++coordinatorId}` })
    ctx.turnRuntime = { coordinator, consume: vi.fn((turnId: string, event: never) => coordinator.consume(turnId, event)),
      cancel: vi.fn(), listActive: vi.fn(() => []), subscribe: vi.fn(() => () => undefined) } as unknown as AppIpcContext['turnRuntime']
    let hostedExecution: () => Promise<void> = async () => undefined
    ctx.executeTurn = () => hostedExecution()
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    await expect(ipc.getHandler('chat:prepare-turn')!({}, {
      mode: 'reuse-user', requestId: 'prepare-real-request', sessionId: session.id, userMessageId: reused.id,
      excludeMessageIds: [], config: {}
    })).resolves.toMatchObject({ turnId: 'prepare-generated-2' })
    expect(projectionReadEvents).toEqual(['ensure', 'select'])
    await vi.waitFor(() => expect(mockSkillManager.route).toHaveBeenCalledTimes(1))
    expect(mockSkillManager.route).toHaveBeenCalledWith(expect.objectContaining({
      userInput: 'reused canonical input',
      recentMessages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'reused canonical input' }
      ],
      sessionId: session.id
    }))
    expect(turnExecutionConfig.resolveTrustedTurnExecutionConfig).toHaveBeenCalledWith(
      reopened, expect.objectContaining({ readSession: expect.any(Function) }),
      expect.objectContaining({ updateSettings: expect.any(Function) }),
      session.id, 'desktop', { projectMemoryEnabled: true }, { requiresVision: true }
    )
    expect(getActualDbConnection(reopened).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(reused.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    const preparedTurn = databaseOperations.getTurnByRequestId(reopened, session.id, 'prepare-real-request')
    expect(preparedTurn?.state).toBe('prepared')

    mockSkillManager.route.mockClear()
    coordinator.consume(preparedTurn!.turnId, { type: 'source-completed' })
    real.updatePersistedTurnState(reopened, preparedTurn!.turnId, 'terminal', { outcome: 'completed' })
    const canonicalEvent = getActualDbConnection(reopened).prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('prepare-canonical-context') as { payload_json: string }
    const damagedPayload = JSON.parse(canonicalEvent.payload_json) as { messages: Array<{ id: string }> }
    damagedPayload.messages = damagedPayload.messages.filter(({ id }) => id !== reused.id)
    getActualDbConnection(reopened).prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?')
      .run(JSON.stringify(damagedPayload), 'prepare-canonical-context')
    getActualDbConnection(reopened).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
      .run(session.id)
    await expect(ipc.getHandler('chat:prepare-turn')!({}, {
      mode: 'reuse-user', requestId: 'prepare-missing-canonical-request', sessionId: session.id, userMessageId: reused.id,
      excludeMessageIds: [], config: {}
    })).rejects.toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(mockSkillManager.route).not.toHaveBeenCalled()
    expect(databaseOperations.getTurnByRequestId(reopened, session.id, 'prepare-missing-canonical-request')).toBeUndefined()

    const editSession = real.createSession(reopened, { name: 'B02 editable legacy session', model: 'deepseek-chat', workDirProfileId: 'default' })
    const editEarlierUser = real.appendMessage(reopened, { id: 'prepare-edit-earlier-user', sessionId: editSession.id, role: 'user',
      content: 'history before edit', timestamp: 10, status: 'sent' }).message
    const editEarlierAssistant = real.appendMessage(reopened, { id: 'prepare-edit-earlier-assistant', sessionId: editSession.id, role: 'assistant',
      content: 'earlier answer', timestamp: 11, status: 'completed' })
    const editReuseUser = real.appendMessage(reopened, { id: 'prepare-edit-reuse-user', sessionId: editSession.id, role: 'user',
      content: 'current accepted question', timestamp: 12, status: 'sent' }).message
    let releaseConcurrentRoute!: (value: { skills: [] }) => void
    mockSkillManager.route.mockImplementationOnce(async () => {
      return await new Promise((resolve) => { releaseConcurrentRoute = resolve })
    })
    const concurrentProvider = new RecordingModelProvider([
      { type: 'text-delta', text: 'must not dispatch after stale selection' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ])
    const concurrentRegistry = new ModelProviderRegistry()
    concurrentRegistry.register({ routeId: 'desktop-test', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, concurrentProvider)
    const concurrentIntent = {
      mode: 'reuse-user', requestId: 'prepare-concurrent-change-request', sessionId: editSession.id, userMessageId: editReuseUser.id,
      excludeMessageIds: [], config: {}
    }
    await expect(ipc.getHandler('chat:prepare-turn')!({}, concurrentIntent)).resolves.toMatchObject({ turnId: expect.any(String) })
    await vi.waitFor(() => expect(releaseConcurrentRoute).toBeTypeOf('function'))
    const concurrentTurn = databaseOperations.getTurnByRequestId(reopened, editSession.id, concurrentIntent.requestId)
    expect(concurrentTurn).toBeDefined()
    hostedExecution = async () => {
      const context = createSqliteSessionStorage(reopened).execution.loadAcceptedMessages({ sessionId: editSession.id, turnId: concurrentTurn!.turnId })
      const currentUser = context.find((message) => message.id === editReuseUser.id)!
      const concurrentHost: AgentTurnHost = {
        createPorts: async () => ({
          registry: concurrentRegistry, safetyGate: {} as never, prepareTool: vi.fn(), toolExecution: {} as never,
          request: { messages: context.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })), maxTokens: 32 },
          routeId: 'desktop-test', invocationId: concurrentTurn!.turnId, maxModelTurns: 1, turnId: concurrentTurn!.turnId,
          currentUserMessageId: editReuseUser.id,
          requiredUserMessage: { id: editReuseUser.id, message: { id: editReuseUser.id, role: currentUser.role, content: currentUser.content, timestamp: currentUser.timestamp } }
        })
      }
      await runHostedAgentTurn({ host: concurrentHost, invocationId: concurrentTurn!.turnId, turnId: concurrentTurn!.turnId,
        routeId: 'desktop-test', request: { messages: context.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })), maxTokens: 32 },
        requiredUserMessage: { id: editReuseUser.id, message: { id: editReuseUser.id, role: currentUser.role, content: currentUser.content, timestamp: currentUser.timestamp } } })
    }
    await expect(ipc.getHandler('chat:execute-turn')!({ sender: {} }, {
      requestId: concurrentIntent.requestId, turnId: concurrentTurn!.turnId, turnStartToken: concurrentTurn!.startToken, sessionId: editSession.id
    })).resolves.toMatchObject({ accepted: true, turnId: concurrentTurn!.turnId })
    const editedPriorUser = await ipc.getHandler('message:patch-non-turn')!({}, {
      sessionId: editSession.id, messageId: editEarlierUser.id, patch: { content: 'edited dependent history through IPC' }
    }) as { message: { content: string } }
    expect(editedPriorUser.message.content).toBe('edited dependent history through IPC')
    expect(mockSkillManager.route).toHaveBeenCalledWith(expect.objectContaining({
      userInput: 'current accepted question',
      recentMessages: [
        { role: 'user', content: 'history before edit' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'current accepted question' }
      ],
      sessionId: editSession.id
    }))
    expect([
      real.getMessageSequence(reopened, editSession.id, editEarlierUser.id),
      real.getMessageSequence(reopened, editSession.id, editEarlierAssistant.message.id),
      real.getMessageSequence(reopened, editSession.id, editReuseUser.id)
    ]).toEqual([0, 1, 2])
    const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')
    expect(digest(editEarlierUser.content)).toBe('1f68e9318d352545523256d4ce1c59f1ade95fb0492a76ef26c87ea2238793d5')
    expect(digest(editedPriorUser.message.content)).toBe('c143e6ed9bb60e1e01be4a3ef1b21689fa7ecd97dec9557b10f0b21b4e4ad4f1')
    expect(createSqliteSessionStorage(reopened).queries.readMessage({ sessionId: editSession.id, messageId: editEarlierUser.id }))
      .toMatchObject({ content: 'edited dependent history through IPC' })
    const pendingConfiguration = ipc.getHandler('chat:prepare-turn')!({}, concurrentIntent)
    releaseConcurrentRoute({ skills: [] })
    expect(mockSkillManager.route).toHaveBeenCalledOnce()
    await expect(pendingConfiguration).rejects.toThrow('TURN_CONTEXT_CHANGED_DURING_PREPARATION')
    expect(databaseOperations.getTurnByRequestId(reopened, editSession.id, 'prepare-concurrent-change-request'))
      .toMatchObject({ state: 'terminal', outcome: 'failed', error: { code: 'configuration-failed', message: 'TURN_CONTEXT_CHANGED_DURING_PREPARATION' } })
    await vi.waitFor(() => expect(real.getPersistedTurn(reopened, concurrentTurn!.turnId)?.state).toBe('terminal'))
    expect(concurrentProvider.calls).toHaveLength(0)

    const controlSession = real.createSession(reopened, { name: 'B02 no-edit control', model: 'deepseek-chat', workDirProfileId: 'default' })
    const controlUser = real.appendMessage(reopened, { id: 'prepare-no-revision-user', sessionId: controlSession.id, role: 'user',
      content: 'unchanged accepted question', timestamp: 20, status: 'sent' }).message
    let releaseControlRoute!: (value: { skills: [] }) => void
    mockSkillManager.route.mockImplementationOnce(async () => await new Promise((resolve) => { releaseControlRoute = resolve }))
    const controlRequestId = 'prepare-no-revision-control-request'
    const controlIntent = { mode: 'reuse-user', requestId: controlRequestId, sessionId: controlSession.id, userMessageId: controlUser.id, excludeMessageIds: [], config: {} }
    const controlProvider = new RecordingModelProvider([
      { type: 'text-delta', text: 'route control reached provider' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ])
    const controlRegistry = new ModelProviderRegistry()
    controlRegistry.register({ routeId: 'desktop-test', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, controlProvider)
    let controlTurnId = ''
    hostedExecution = async () => {
      const context = createSqliteSessionStorage(reopened).execution.loadAcceptedMessages({ sessionId: controlSession.id, turnId: controlTurnId })
      const userMessage = context.find((message) => message.id === controlUser.id)!
      const controlHost: AgentTurnHost = {
        createPorts: async () => ({
          registry: controlRegistry, safetyGate: {} as never, prepareTool: vi.fn(), toolExecution: {} as never,
          request: { messages: context.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })), maxTokens: 32 },
          routeId: 'desktop-test', invocationId: controlTurnId, maxModelTurns: 1, turnId: controlTurnId,
          currentUserMessageId: controlUser.id,
          requiredUserMessage: { id: controlUser.id, message: { id: controlUser.id, role: userMessage.role, content: userMessage.content, timestamp: userMessage.timestamp } }
        })
      }
      await runHostedAgentTurn({ host: controlHost, invocationId: controlTurnId, turnId: controlTurnId, routeId: 'desktop-test',
        request: { messages: context.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })), maxTokens: 32 },
        requiredUserMessage: { id: controlUser.id, message: { id: controlUser.id, role: userMessage.role, content: userMessage.content, timestamp: userMessage.timestamp } } })
    }
    const controlPrepare = ipc.getHandler('chat:prepare-turn')!({}, controlIntent)
    await vi.waitFor(() => expect(releaseControlRoute).toBeTypeOf('function'))
    const controlTurn = databaseOperations.getTurnByRequestId(reopened, controlSession.id, controlRequestId)
    expect(controlTurn).toBeDefined()
    controlTurnId = controlTurn!.turnId
    await expect(ipc.getHandler('chat:execute-turn')!({ sender: {} }, {
      requestId: controlRequestId, turnId: controlTurnId, turnStartToken: controlTurn!.startToken, sessionId: controlSession.id
    })).resolves.toMatchObject({ accepted: true, turnId: controlTurnId })
    const controlRevisionBeforeRelease = real.getSessionMessageRevisionSnapshot(reopened, controlSession.id)
    releaseControlRoute({ skills: [] })
    await expect(controlPrepare).resolves.toMatchObject({ turnId: controlTurn!.turnId, startToken: controlTurn!.startToken })
    expect(real.getSessionMessageRevisionSnapshot(reopened, controlSession.id)).toEqual(controlRevisionBeforeRelease)
    await vi.waitFor(() => expect(controlProvider.calls).toHaveLength(1))
    expect(controlProvider.calls[0]?.route).toMatchObject({ routeId: 'desktop-test', modelId: 'test-model' })
    expect(controlProvider.calls[0]?.request.messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'unchanged accepted question' }))
    reopened.close()
    temp.cleanup()
  })

  it('display-message IPC 在 canonical-only + reopen 后读取 terminal 正文并拒绝畸形 History', async () => {
    vi.restoreAllMocks()
    const temp = createTempDatabase('display-terminal-canonical-only-')
    const real = { ...await vi.importActual<typeof import('./database')>('./database'), ...await vi.importActual<typeof import('./database/operations')>('./database/operations') }
    const db = temp.db
    const session = real.createSession(db, { name: 'terminal display', model: 'deepseek-chat', workDirProfileId: 'default' })
    const user = real.appendMessage(db, { id: 'display-terminal-user', sessionId: session.id, role: 'user',
      content: 'show terminal response', timestamp: 1, status: 'sent' }).message
    const assistant = real.appendMessage(db, { id: 'display-terminal-assistant', sessionId: session.id, role: 'assistant',
      content: 'canonical terminal answer', timestamp: 2, status: 'completed' }).message
    const conn = getActualDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'display-terminal-history', turnId: 'display-terminal-turn', sequence: 1, schemaVersion: 1,
        eventId: 'display-terminal-context', idempotencyKey: 'display-terminal-context', kind: 'invocation-context-committed',
        payload: { messages: [user, assistant].map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })) } },
      { invocationId: 'display-terminal-history', turnId: 'display-terminal-turn', sequence: 2, schemaVersion: 1,
        eventId: 'display-terminal-completed', idempotencyKey: 'display-terminal-completed', kind: 'invocation-completed',
        payload: { status: 'completed' } }
    ], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    db.close()
    const reopened = real.openDatabase(temp.dbPath)
    ctx.db = reopened
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const page = await ipc.getHandler('chat:get-display-message-page')!({}, { sessionId: session.id, limit: 10 }) as {
      entries: Array<{ display: { lifecycle: string; message: { id: string; content: string } }; sequence: number }>
    }
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      display: { lifecycle: 'completed', message: { id: assistant.id, content: 'canonical terminal answer' } },
      sequence: expect.any(Number)
    })
    expect(getActualDbConnection(reopened).prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(assistant.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    getActualDbConnection(reopened).prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?')
      .run('{"messages":', 'display-terminal-context')
    getActualDbConnection(reopened).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
      .run(session.id)
    await expect(Promise.resolve(ipc.getHandler('chat:get-display-message-page')!({}, { sessionId: session.id, limit: 10 })))
      .rejects.toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getActualDbConnection(reopened).prepare('SELECT content FROM messages WHERE id=?').get(assistant.id))
      .toEqual({ content: '' })
    getActualDbConnection(reopened).prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?')
      .run(JSON.stringify({ messages: [] }), 'display-terminal-context')
    getActualDbConnection(reopened).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
      .run(session.id)
    await expect(Promise.resolve(ipc.getHandler('chat:get-display-message-page')!({}, { sessionId: session.id, limit: 10 })))
      .rejects.toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    expect(getActualDbConnection(reopened).prepare('SELECT content FROM messages WHERE id=?').get(assistant.id))
      .toEqual({ content: '' })
    reopened.close()
    temp.cleanup()
  })

  // Keep this file-backed integration last: it restores module mocks and rebinds database handlers to its own file DB.
  it('B04 file-backed retry intent resolves the failed target and reaches the provider with edited history', async () => {
    vi.restoreAllMocks()
    const temp = createTempDatabase('desktop-retry-intent-')
    const real = { ...await vi.importActual<typeof import('./database')>('./database'), ...await vi.importActual<typeof import('./database/operations')>('./database/operations') }
    const db = temp.db
    const session = real.createSession(db, { name: 'retry intent', model: 'deepseek-chat', workDirProfileId: 'default' })
    const priorUser = real.appendMessage(db, { id: 'retry-intent-prior-user', sessionId: session.id, role: 'user', content: 'before prior edit', timestamp: 1, status: 'sent' })
    const priorAssistant = real.appendMessage(db, { id: 'retry-intent-prior-assistant', sessionId: session.id, role: 'assistant', content: 'before assistant edit', timestamp: 2, status: 'completed' })
    const targetUser = real.appendMessage(db, { id: 'retry-intent-target-user', sessionId: session.id, role: 'user', content: 'retry required user sentinel', timestamp: 3, status: 'sent' })
    const failedAssistant = real.appendMessage(db, { id: 'retry-intent-failed-assistant', sessionId: session.id, role: 'assistant', content: 'failed retry source sentinel', timestamp: 4, status: 'failed' })
    real.appendMessage(db, { id: 'retry-intent-later-user', sessionId: session.id, role: 'user', content: 'later physical user sentinel', timestamp: 5, status: 'sent' })
    real.createPersistedTurn(db, { turnId: 'retry-intent-source-turn', requestId: 'retry-intent-source-request', sessionId: session.id,
      userMessageId: targetUser.message.id, assistantMessageId: failedAssistant.message.id, state: 'terminal', outcome: 'failed' })
    real.setConfigValue(db, 'secrets.apiKeyEnc', 'safe:test-key')
    vi.mocked(database.appendMessage).mockImplementation((_db, input) => real.appendMessage(db, input))
    vi.mocked(database.createPersistedTurn).mockImplementation((_db, turn) => real.createPersistedTurn(db, turn))
    mockReadTurnByRequest.mockImplementation((_db, sessionId, requestId) => databaseOperations.getTurnByRequestId(db, sessionId, requestId))
    vi.mocked(database.getPersistedTurn).mockImplementation((_db, turnId) => real.getPersistedTurn(db, turnId))
    vi.mocked(database.hasActiveTurn).mockImplementation(() => real.hasActiveTurn(db, session.id))
    vi.mocked(database.setPersistedTurnExecutionConfig).mockImplementation((_db, turnId, config, fingerprint, fence) =>
      real.setPersistedTurnExecutionConfig(db, turnId, config, fingerprint, fence))
    vi.mocked(database.failConfiguringTurn).mockImplementation((_db, turnId, version, error) => real.failConfiguringTurn(db, turnId, version, error))
    vi.mocked(databaseComposition.getConfigValue).mockImplementation((_db, key) => real.getConfigValue(db, key))
    vi.mocked(databaseComposition.setConfigValue).mockImplementation((_db, key, value) => real.setConfigValue(db, key, value))
    vi.mocked(database.getSessionUsage).mockImplementation((_db, sessionId) => real.getSessionUsage(db, sessionId))
    vi.mocked(databaseComposition.getDbConnection).mockImplementation(() => getActualDbConnection(db))
    vi.mocked(database.getSessionMessageRevisionSnapshot).mockImplementation((_db, sessionId) => real.getSessionMessageRevisionSnapshot(db, sessionId))
    ctx.db = db
    ctx.sessionStorage = createSqliteSessionStorage(db)
    const retryProvider = new RecordingModelProvider([
      { type: 'text-delta', text: 'retry provider completed' },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ])
    ctx.executeTurn = async (_sender, payload) => {
      const context = ctx.sessionStorage!.execution.loadAcceptedMessages({ sessionId: session.id, turnId: payload.turnId })
      const currentUser = context.find((message) => message.id === targetUser.message.id)!
      const registry = new ModelProviderRegistry()
      registry.register({ routeId: 'desktop-test', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }, retryProvider)
      const host: AgentTurnHost = {
        createPorts: async () => ({
          registry, safetyGate: {} as never, prepareTool: vi.fn(), toolExecution: {} as never,
          request: { messages: context.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })), maxTokens: 32 },
          routeId: 'desktop-test', invocationId: payload.turnId, turnId: payload.turnId, maxModelTurns: 1,
          currentUserMessageId: targetUser.message.id,
          requiredUserMessage: { id: targetUser.message.id, message: { id: targetUser.message.id, role: currentUser.role, content: currentUser.content, timestamp: currentUser.timestamp } }
        })
      }
      await runHostedAgentTurn({ host, invocationId: payload.turnId, turnId: payload.turnId, routeId: 'desktop-test',
        request: { messages: context.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp })), maxTokens: 32 },
        requiredUserMessage: { id: targetUser.message.id, message: { id: targetUser.message.id, role: currentUser.role, content: currentUser.content, timestamp: currentUser.timestamp } } })
    }
    ipc = mockIpcMain()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const editedPriorUser = await ipc.getHandler('message:patch-non-turn')!({}, {
      sessionId: session.id, messageId: priorUser.message.id, patch: { content: 'edited retry prior user sentinel' }
    }) as { message: { content: string } }
    expect(editedPriorUser.message.content).toBe('edited retry prior user sentinel')
    const editedPriorAssistant = await ipc.getHandler('message:patch-non-turn')!({}, {
      sessionId: session.id, messageId: priorAssistant.message.id, patch: { content: 'edited retry prior assistant sentinel' }
    }) as { message: { content: string } }
    expect(editedPriorAssistant.message.content).toBe('edited retry prior assistant sentinel')

    const target = await ipc.getHandler('chat:resolve-retry-context')!({}, { sessionId: session.id, failedAssistantMessageId: failedAssistant.message.id }) as {
      currentUser: { message: { id: string; content: string }; sequence: number }; excludeMessageIds: string[]
    }
    expect(target).toMatchObject({ currentUser: { message: { id: targetUser.message.id, content: targetUser.message.content }, sequence: targetUser.sequence }, excludeMessageIds: [failedAssistant.message.id] })
    expect([
      real.getMessageSequence(db, session.id, priorUser.message.id),
      real.getMessageSequence(db, session.id, priorAssistant.message.id),
      real.getMessageSequence(db, session.id, targetUser.message.id),
      real.getMessageSequence(db, session.id, failedAssistant.message.id)
    ]).toEqual([0, 1, 2, 3])
    const submitted = await ipc.getHandler('chat:submit-outbound')!({}, {
      sessionId: session.id,
      text: target.currentUser.message.content,
      contextIntent: { kind: 'reuse-user', currentUser: { message: target.currentUser.message, order: { kind: 'persisted', sequence: target.currentUser.sequence } }, excludeMessageIds: target.excludeMessageIds }
    }) as { accepted: string; turnId: string }
    expect(submitted).toMatchObject({ accepted: 'turn-started', turnId: expect.any(String) })
    const retryTurn = real.getPersistedTurn(db, submitted.turnId)
    expect(retryTurn).toMatchObject({ requestId: expect.not.stringMatching('retry-intent-source-request'), userMessageId: targetUser.message.id,
      contextBoundarySequence: targetUser.sequence, excludeMessageIds: [failedAssistant.message.id] })
    await vi.waitFor(() => expect(retryProvider.calls).toHaveLength(1))
    const actual = retryProvider.calls[0]!.request.messages
    expect(retryProvider.calls[0]!.route).toMatchObject({ routeId: 'desktop-test', modelId: 'test-model' })
    const digest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')
    expect(digest(priorUser.message.content)).toBe('b38db8db2e9d5d295c481ff7ae86e159ccea9c787b1783cfc074fc234f5f6de1')
    expect(digest(editedPriorUser.message.content)).toBe('187056231ec189941f12a22a56c32440db4ba4b8a1de318f78f6d94d87e1ab4d')
    expect(digest(priorAssistant.message.content)).toBe('d9ced13e89a4a4c6c7eababa4cfbc40b87564addf6c5dee35b4b516fb4c24465')
    expect(digest(editedPriorAssistant.message.content)).toBe('7b59cb80f4ecdd016a260cdd32d4d43a85492520d2ce8447cce272d971c1b648')
    expect(digest(actual.find((message) => message.content === editedPriorUser.message.content)!.content)).toBe('187056231ec189941f12a22a56c32440db4ba4b8a1de318f78f6d94d87e1ab4d')
    expect(digest(actual.find((message) => message.content === editedPriorAssistant.message.content)!.content)).toBe('7b59cb80f4ecdd016a260cdd32d4d43a85492520d2ce8447cce272d971c1b648')
    expect(actual).toContainEqual(expect.objectContaining({ role: 'user', content: 'edited retry prior user sentinel' }))
    expect(actual).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'edited retry prior assistant sentinel' }))
    expect(actual.filter((message) => message.content === 'retry required user sentinel')).toHaveLength(1)
    expect(actual).not.toContainEqual(expect.objectContaining({ content: 'failed retry source sentinel' }))
    expect(actual).not.toContainEqual(expect.objectContaining({ content: 'later physical user sentinel' }))
    db.close()
    temp.cleanup()
  })
})
