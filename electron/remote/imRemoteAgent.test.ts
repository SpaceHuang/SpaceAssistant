import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import { createSession, getDbConnection, getSession, openDatabase, prepareTurnAtomically, type AppDatabase } from '../database'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import { reconcileStartupSessionTranscripts } from '../sessionStorage/recovery'

const mockRunToolChatSession = vi.fn()
const mockResolveLlmCredentialsForModel = vi.fn()
const mockGetMessages = vi.fn(() => [])
const mockStartRemoteProgressSession = vi.fn()
const mockStopRemoteProgressSession = vi.fn()
const mockClearRemoteProgressSession = vi.fn()
const mockUpdateRemoteProgressSnapshot = vi.fn()
const mockRequestRendererSessionSwitch = vi.fn()
const hostedRuntimeFailureInjection = vi.hoisted(() => ({ requestId: '', composeCalls: 0 }))
const mockResolveWorkDirForSession = vi.fn(() => ({
  profileId: 'p1',
  workDir: '/tmp',
  isSensitive: false
}))

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('../runtime/invocationAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/invocationAssembler')>()
  return {
    ...actual,
    assembleInvocation: (...args: Parameters<typeof actual.assembleInvocation>) => {
      const assembled = actual.assembleInvocation(...args)
      if (args[0].requestId === hostedRuntimeFailureInjection.requestId) {
        assembled.agentSdk.createHostedTurnRuntime = () => {
          hostedRuntimeFailureInjection.composeCalls += 1
          throw new Error('Feishu complete-gate Runtime unavailable')
        }
      }
      return assembled
    }
  }
})

vi.mock('../llmServiceResolver', () => ({
  resolveLlmCredentialsForModel: (...args: unknown[]) => mockResolveLlmCredentialsForModel(...args)
}))

vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>()
  return {
    ...actual,
    getMessages: (...args: unknown[]) => mockGetMessages(...args)
  }
})

vi.mock('../appIpc', () => ({
  readAppLocale: () => 'zh-CN'
}))

vi.mock('./remoteProgressCoordinator', () => ({
  startRemoteProgressSession: (...args: unknown[]) => mockStartRemoteProgressSession(...args),
  stopRemoteProgressSession: (...args: unknown[]) => mockStopRemoteProgressSession(...args)
}))

vi.mock('./remoteProgressStore', () => ({
  clearRemoteProgressSession: (...args: unknown[]) => mockClearRemoteProgressSession(...args),
  updateRemoteProgressSnapshot: (...args: unknown[]) => mockUpdateRemoteProgressSnapshot(...args)
}))

vi.mock('../remote/requestRendererSessionSwitch', () => ({
  requestRendererSessionSwitch: (...args: unknown[]) => mockRequestRendererSessionSwitch(...args)
}))

vi.mock('../windowRef', () => ({
  getMainWindow: () => ({ webContents: { id: 1, isDestroyed: () => false } })
}))

vi.mock('../workDirManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workDirManager')>()
  return {
    ...actual,
    resolveWorkDirForSession: (...args: unknown[]) => mockResolveWorkDirForSession(...args)
  }
})

import { runImRemoteAgent } from './imRemoteAgent'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext, readAcceptedTurn } from '../database/acceptedTurnStorage'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { ensureFinalRequestContextEvent, ensureRequestProjectionEvents, ensureRequestUsageEvent, ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, getSessionEventSink, readSessionEvents, SessionEventWriter } from '../sessionEvents'
import { ImChannel } from '../confirmation/imChannel'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { editFileExecutor, grepExecutor, listDirectoryExecutor, readFileExecutor, runScriptExecutor, writeFileExecutor } from '../tools/builtinExecutors'
import { runShellExecutor } from '../tools/runShellExecutor'
import { readFeishuAttachmentExecutor } from '../tools/readFeishuAttachmentExecutor'
import { browserExecutor } from '../tools/browserExecutor'
import { switchSessionExecutor } from '../tools/remoteSessionExecutors'
import { listWorkDirsExecutor, switchWorkDirExecutor } from '../tools/workDirExecutors'
import { releaseRemoteSession, tryClaimRemoteSession } from '../remote/remoteAgentRegistry'
import { readPolicyPackages, writePolicyPackages } from '../confirmation/policyRulesRuntime'
import { invalidateSkillsCache } from '../skills/skillCache'
import { setCallAdmissionGate } from '../runtime/callAdmissionGate'
import { HostedTurnFinalizedError } from '../runtime/hostedTurnFinalization'
import { recoverTurnCoordinatorForStartup } from '../sessionStorage/recoveryHelpers'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { TurnRuntime } from '../turnRuntime'
import { listPersistedTurns } from '../database/operations'
import { claimSessionExecution, readSessionTranscript } from '../database/sessionTranscript'

const SUPPORTED_ANTHROPIC_MODEL = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]

function makeDb(): AppDatabase {
  return openDatabase(':memory:')
}

function makeWorkDirManager() {
  return {
    listProfiles: () => [],
    getActiveProfileId: () => 'p1',
    getActiveWorkDir: () => '/tmp',
    checkDirectoryWritable: () => ({ ok: true })
  }
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  const adapter = { channel: 'feishu' as const, reply: vi.fn() }
  const db = overrides.db as AppDatabase | undefined ?? makeDb()
  return {
    db,
    sessionStorage: createSqliteSessionStorage(db),
    sessionId: 'sess-1',
    requestId: '00000000-0000-4000-8000-000000000001',
    workDir: '/tmp',
    workDirManager: makeWorkDirManager(),
    // Keep the user-data root separate from OS temp workspaces. On Linux,
    // temporary fixtures live under /tmp, so /tmp itself makes them sensitive.
    userDataDir: path.join(os.tmpdir(), 'spaceassistant-remote-test-user-data'),
    getMainWebContents: () => null as WebContents | null,
    getApiKey: async () => 'fallback-key',
    getBaseUrl: () => 'https://fallback.example.com',
    getModel: () => SUPPORTED_ANTHROPIC_MODEL,
    remoteContext: { source: 'feishu' as const, messageId: 'm1', confirmPolicy: 'always' as const },
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    createProgressAdapter: () => adapter,
    buildSystemAppendix: () => 'appendix',
    progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG,
    progressConfig: {},
    ...overrides
  }
}

describe('runImRemoteAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setCallAdmissionGate(null)
    hostedRuntimeFailureInjection.requestId = ''
    hostedRuntimeFailureInjection.composeCalls = 0
    mockRequestRendererSessionSwitch.mockReset().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
    setDefaultAgentRuntime(createDesktopAgentRuntime())
    mockResolveWorkDirForSession.mockReturnValue({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: false
    })
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: 'svc-1',
      baseUrl: 'https://creds.example.com',
      getApiKey: async () => 'creds-key'
    })
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('uses service apiKey and baseUrl when credentials resolve', async () => {
    let captured: { profile: { baseUrl?: string }; ports: { credentials: { resolveApiKey: () => Promise<string | null> } } } = {} as never
    mockRunToolChatSession.mockImplementation(async (invocation: never, ports: never) => {
      captured = { invocation, ports } as never
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs())

    expect(mockResolveLlmCredentialsForModel).toHaveBeenCalledWith(
      expect.anything(),
      SUPPORTED_ANTHROPIC_MODEL,
      {}
    )
    expect(captured.ports.credentials.networkTarget?.baseUrl).toBe('https://creds.example.com')
    expect(await captured.ports.credentials.resolveApiKey()).toBe('creds-key')
  })

  it('Feishu Anthropic invocation freezes its resolved provider route in the invocation profile', async () => {
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')?.[0]
    expect(modelId).toBeTruthy()
    let capturedInvocation: { profile: { providerRouteId?: string } } | undefined
    let capturedOptions: { onHostedTurnHandoff?: unknown } | undefined
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      capturedInvocation = invocation
      capturedOptions = options as never
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs({ getModel: () => modelId! }))

    const routeId = capturedInvocation?.profile.providerRouteId
    expect(routeId).toBeTruthy()
    expect(getDefaultAgentRuntime().modelProviders.getRoute(routeId!)).toMatchObject({
      profile: { modelId, endpoint: 'https://creds.example.com' },
      providerId: 'pi-ai-anthropic-messages'
    })
    expect(capturedOptions?.onHostedTurnHandoff).toEqual(expect.any(Function))
  })

  it('stops the Feishu Hosted turn when complete-gate Runtime composition fails', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-runtime-failure-'))
    const args = baseArgs({ workDir, userDataDir: workDir })
    const session = createSession(args.db, { name: 'feishu-hosted-runtime-failure', model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = 'feishu-hosted-runtime-failure-request'
    const logError = vi.fn()
    const executor = vi.spyOn(readFileExecutor, 'execute')
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-runtime-failure', workDir, isSensitive: false })
    hostedRuntimeFailureInjection.requestId = requestId
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-hosted-runtime-failure-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'must not complete without the safety Runtime' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: 'read the note' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'read_file', description: 'Read file', inputSchema: {
            type: 'object', properties: { path: { type: 'string' } }, required: ['path']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runImRemoteAgent({
        ...args, sessionId: session.id, requestId,
        workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
        logError
      })).rejects.toThrow('Feishu complete-gate Runtime unavailable')
      expect(hostedRuntimeFailureInjection.composeCalls).toBe(1)
      expect(mockRunToolChatSession).toHaveBeenCalledOnce()
      expect(providerCalls).toBe(0)
      expect(executor).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith('Feishu complete-gate Runtime unavailable')
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_call' || event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'failed' })
      } finally { await sink.close() }
    } finally {
      hostedRuntimeFailureInjection.requestId = ''
      executor.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu caller executes its real Hosted handoff through the SDK provider and History runtime', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-hosted-ledger-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'remote Hosted read ledger')
    const dbPath = path.join(workDir, 'history.db')
    let db = openDatabase(dbPath)
    const args = baseArgs({ db })
    const session = createSession(args.db, { name: 'remote-hosted-ledger', model: SUPPORTED_ANTHROPIC_MODEL })
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'remote-answer-1' }
      ))
    } })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'chat-1', imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'remote-ledger', workDir, isSensitive: false })
    let providerCalls = 0
    let releaseRemoteText!: () => void
    let markRemoteTextYielded!: () => void
    const remoteTextBarrier = new Promise<void>((resolve) => { releaseRemoteText = resolve })
    const remoteTextYielded = new Promise<void>((resolve) => { markRemoteTextYielded = resolve })
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: 'hosted-remote-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'remote-read-1', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'hosted remote answer' } as const
        markRemoteTextYielded()
        await remoteTextBarrier
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const handoff = await callback({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: 'remote question' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })
      return handoff.result
    })

    let sink: ReturnType<typeof getSessionEventSink> | undefined
    try {
      const pending = runImRemoteAgent(sessionArgs)
      await remoteTextYielded
      expect(mockUpdateRemoteProgressSnapshot).toHaveBeenCalledWith(session.id, {
        kind: 'text', label: '已生成一段回复，继续处理中', publishable: true
      })
      releaseRemoteText()
      await expect(pending).resolves.toMatchObject({ ok: true, summary: 'hosted remote answer', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      sink = getSessionEventSink(workDir, session.id, session.createdAt)
      const events = await readSessionEvents(sink.eventsPath)
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        'turn_start', 'step_start', 'request_header', 'request_context', 'request_usage', 'tool_call', 'tool_result', 'step_end', 'turn_end'
      ]))
      expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({
        turnId: events.find((event) => event.type === 'turn_start')?.payload.turnId, reason: 'completed'
      })
      expect(events.find((event) => event.type === 'request_usage')?.payload).toMatchObject({ usage: { input_tokens: 2, output_tokens: 3 } })
      expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: 'remote-read-1', name: 'read_file', args: { path: 'note.txt' } })
      expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
        toolUseId: 'remote-read-1', result: { success: true, data: { content: 'remote Hosted read ledger', encoding: 'utf8', path: 'note.txt' } }
      })
      expect((events.find((event) => event.type === 'tool_result')?.payload as { stepId?: string }).stepId)
        .toBe((events.find((event) => event.type === 'tool_call')?.payload as { stepId?: string }).stepId)
      const canonical = await new SqliteAgentHistory(getDbConnection(db)).read(args.requestId)
      const responseEnvelope = canonical.events.find((event) => event.kind === 'model-response-committed')
      const resultEnvelope = canonical.events.find((event) => event.kind === 'tool-call-finished')
      expect(responseEnvelope?.payload).toMatchObject({ sessionLedger: { toolCalls: [{ toolUseId: 'remote-read-1', name: 'read_file', args: { path: 'note.txt' } }] } })
      expect(resultEnvelope?.payload).toMatchObject({ toolCallId: 'remote-read-1', sessionLedger: { result: (events.find((event) => event.type === 'tool_result')?.payload as { result: unknown }).result } })
      expect((resultEnvelope?.payload as { sessionLedger?: { stepId?: string } }).sessionLedger?.stepId)
        .toBe((responseEnvelope?.payload as { sessionLedger?: { stepId?: string } }).sessionLedger?.stepId)

      await sink.close()
      const projectionTypes = new Set(['request_header', 'request_context', 'request_usage', 'tool_call', 'tool_result'])
      const expectedProjections = events.filter((event) => projectionTypes.has(event.type)).map(({ type, payload }) => ({ type, payload }))
      const existingLines = (await fs.readFile(sink.eventsPath, 'utf8')).trim().split('\n')
      const withoutProjections = existingLines.filter((line) => !projectionTypes.has(JSON.parse(line).type))
      await fs.writeFile(sink.eventsPath, `${withoutProjections.join('\n')}\n`, 'utf8')
      db.close()
      db = openDatabase(dbPath)
      const recoveredSink = getSessionEventSink(workDir, session.id, session.createdAt)
      const history = new SqliteAgentHistory(getDbConnection(db))
      const repairToolResult = vi.fn((location: { workDir: string; sessionId: string; createdAt: number }, repairEvent: Record<string, unknown>) =>
        ensureToolResultEvent(recoveredSink, repairEvent as never))
      const repairToolCall = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, proposal: Record<string, unknown>) =>
        ensureToolCallEvent(recoveredSink, proposal as never))
      const repairRequest = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, projection: Record<string, unknown>) =>
        ensureRequestProjectionEvents(recoveredSink, projection as never))
      const repairUsage = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, usage: Record<string, unknown>) =>
        ensureRequestUsageEvent(recoveredSink, usage as never))
      const repairFinalContext = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, context: Record<string, unknown>) =>
        ensureFinalRequestContextEvent(recoveredSink, context as never))
      const repairErrors: unknown[] = []
      const recoveryOptions = {
        repairToolLedger: repairToolResult,
        repairToolCallLedger: repairToolCall,
        repairModelRequestLedger: repairRequest,
        repairUsageLedger: repairUsage,
        repairFinalRequestContextLedger: repairFinalContext,
        onToolLedgerRepairError: (error: unknown) => repairErrors.push(error),
        onModelRequestLedgerRepairError: (error: unknown) => repairErrors.push(error)
      }
      await history.recoverInterruptedInvocations(recoveryOptions)
      await history.recoverInterruptedInvocations(recoveryOptions)
      expect(repairErrors).toEqual([])
      await expect(history.read(args.requestId)).resolves.toEqual(canonical)
      expect(repairToolResult).toHaveBeenCalled()
      expect(repairToolCall).toHaveBeenCalled()
      expect(repairToolResult.mock.calls[0]?.[1]).toMatchObject({ toolUseId: 'remote-read-1', stepId: expect.any(String), result: expect.any(Object) })
      expect(repairRequest).toHaveBeenCalled()
      expect(repairUsage).toHaveBeenCalled()
      expect(repairFinalContext).toHaveBeenCalled()
      const repairedEvents = await readSessionEvents(recoveredSink.eventsPath)
      const actualProjections = repairedEvents.filter((event) => projectionTypes.has(event.type)).map(({ type, payload }) => ({ type, payload }))
      expect(actualProjections).toEqual(expectedProjections)
      expect(repairedEvents.filter((event) => event.type === 'tool_result')).toHaveLength(1)
      await recoveredSink.close()
      await sink.close()
    } finally {
      await sink?.close()
      db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) => [false, true].map((matchingCheckpoint) => ({ lane, matchingCheckpoint }))))(
    '$lane wrapper after Hosted checkpoint failure $matchingCheckpoint startup reconciliation branch', async ({ lane, matchingCheckpoint }) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-checkpoint-uncertain-`))
    await fs.writeFile(path.join(workDir, 'checkpoint-evidence.txt'), 'executed before checkpoint failure')
    const dbPath = path.join(workDir, 'runtime.db')
    let db = openDatabase(dbPath)
    getDbConnection(db).exec(`CREATE TRIGGER fail_remote_transcript_checkpoint BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.version > 0 BEGIN SELECT RAISE(ABORT, 'injected remote checkpoint failure'); END`)
    const args = baseArgs({
      db,
      workDir,
      requestId: `${lane}-checkpoint-request`,
      remoteContext: { source: lane, messageId: `message-${lane}`, chatId: `chat-${lane}`, confirmPolicy: 'always' },
      createProgressAdapter: () => ({ channel: lane, reply: vi.fn() })
    })
    const session = createSession(db, { name: `${lane} checkpoint uncertainty`, model: SUPPORTED_ANTHROPIC_MODEL })
    const turnId = `${lane}-checkpoint-turn`
    const userMessageId = `${lane}-checkpoint-user`
    const startToken = `${lane}-checkpoint-start`
    prepareTurnAtomically(db, {
      user: { id: userMessageId, sessionId: session.id, role: 'user', content: `${lane} lifecycle check`, timestamp: 1, status: 'sent' },
      assistant: { id: `${lane}-checkpoint-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId, requestId: args.requestId, sessionId: session.id, assistantMessageId: `${lane}-checkpoint-assistant`, state: 'prepared', startToken }
    })
    const acceptedTurn = createAcceptedTurn({
      turnId, requestId: args.requestId, sessionId: session.id, lane, startToken,
      currentUserMessageId: userMessageId, transcriptVersion: 0, config: { lane, model: SUPPORTED_ANTHROPIC_MODEL }
    })
    acceptTurnContext(db, acceptedTurn)
    const context = {
      ...args, sessionId: session.id, turnId, acceptedTurn, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-checkpoint`, workDir, isSensitive: false })
    const requestId = args.requestId
    let providerCalls = 0
    const readExecutor = vi.spyOn(readFileExecutor, 'execute')
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error(`expected ${lane} provider route`)
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-checkpoint-uncertain-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `${lane}-checkpoint-read`, toolName: 'read_file', input: { path: 'checkpoint-evidence.txt' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: `${lane} answer` } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const acceptedUserContent = `${lane} lifecycle check`
      return (await handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: acceptedUserContent }], maxTokens: 64, credentials: { apiKey: 'remote-key' },
          tools: [{ name: 'read_file', description: 'Read evidence', inputSchema: {
            type: 'object', properties: { path: { type: 'string' } }, required: ['path']
          } }]
        },
        currentUserMessageId: userMessageId,
        requiredUserMessage: { id: userMessageId, message: { role: 'user', content: acceptedUserContent } },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runImRemoteAgent(context)).rejects.toMatchObject({
        name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain', message: expect.stringContaining('injected remote checkpoint failure')
      })
      expect(providerCalls).toBe(2)
      expect(readExecutor).toHaveBeenCalledOnce()
      const accepted = readAcceptedTurn(db, session.id, requestId)!
      const history = await new SqliteAgentHistory(getDbConnection(db)).read(accepted.turnId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: `${lane}-checkpoint-read`, result: { success: true, data: { content: 'executed before checkpoint failure' } }
      })
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      expect(getDbConnection(db).prepare('SELECT status FROM session_transcript_checkpoints WHERE session_id=?').get(session.id))
        .toEqual({ status: 'commit_uncertain' })
      expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(session.id))
        .toEqual({ status: 'commit_uncertain' })

      if (matchingCheckpoint) {
        // 模拟 checkpoint entry 已 durable commit、进程随后只来得及写入 uncertain fence。
        const conn = getDbConnection(db)
        conn.prepare(`INSERT INTO session_transcript_entries
          (session_id,turn_id,base_version,version,outcome,messages_json,created_at)
          VALUES(?,?,0,1,'completed',?,?)`).run(
          session.id, turnId, JSON.stringify([{ role: 'user', content: `${lane} lifecycle check` }]), 3
        )
        conn.prepare(`UPDATE session_transcript_checkpoints SET version=1,last_turn_id=?,status='commit_uncertain' WHERE session_id=?`)
          .run(turnId, session.id)
      }

      db.close()
      db = openDatabase(dbPath)
      const recoveredAccepted = readAcceptedTurn(db, session.id, requestId)
      expect(recoveredAccepted).toMatchObject({ turnId, requestId, sessionId: session.id })
      context.db = db
      context.sessionStorage = createSqliteSessionStorage(db)
      context.acceptedTurn = recoveredAccepted!
      const restartedRuntime = createDesktopAgentRuntime()
      setDefaultAgentRuntime(restartedRuntime)
      if (!matchingCheckpoint) {
        await expect(runImRemoteAgent(context)).rejects.toThrow('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')
        expect(getDbConnection(db).prepare('SELECT status FROM session_transcript_checkpoints WHERE session_id=?').get(session.id))
          .toEqual({ status: 'commit_uncertain' })
      } else {
        const storage = createTurnCoordinatorStorage(db)
        const turnRuntime = new TurnRuntime({ storage, deps: { now: () => 4_001, id: () => 'im-restart-recovery-id' } })
        const turnRecovery = recoverTurnCoordinatorForStartup(db, () => {
          for (const state of ['configuring', 'prepared', 'executing', 'waiting-confirm']) {
            for (const persisted of listPersistedTurns(db, state)) {
              const assistant = storage.getMessage(persisted.assistantMessageId)
              if (assistant) turnRuntime.coordinator.restoreTurn(persisted, assistant)
            }
          }
          turnRuntime.recover()
        })
        expect(turnRecovery.succeeded, turnRecovery.error instanceof Error ? turnRecovery.error.message : String(turnRecovery.error)).toBe(true)
        expect(reconcileStartupSessionTranscripts(db, {
          historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: turnRecovery.succeeded
        }, 4_000)).toMatchObject({ reconciled: 1 })
        expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 1, lastTurnId: turnId, status: 'ready' })
        expect(claimSessionExecution(db, { sessionId: session.id, turnId: `${turnId}-next`, ownerId: 'new-process' }))
          .toMatchObject({ acquired: true })
      }
      expect(providerCalls).toBe(2)
      expect(readExecutor).toHaveBeenCalledOnce()
    } finally {
      readExecutor.mockRestore()
      db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
    }
  )

  it.each(['feishu', 'wechat'] as const)('%s wrapper persists a failed terminal when SQLite rejects Hosted completion', async (lane) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-history-terminal-failure-`))
    const db = openDatabase(':memory:')
    getDbConnection(db).exec(`CREATE TRIGGER fail_remote_completed_terminal BEFORE INSERT ON agent_history_events
      WHEN NEW.kind='invocation-completed' BEGIN SELECT RAISE(ABORT, 'injected remote terminal failure'); END`)
    const args = baseArgs({
      db, workDir, requestId: `${lane}-history-terminal-request`, rethrowAsError: true,
      remoteContext: { source: lane, messageId: `message-${lane}`, chatId: `chat-${lane}`, confirmPolicy: 'always' },
      createProgressAdapter: () => ({ channel: lane, reply: vi.fn() })
    })
    const session = createSession(db, { name: `${lane} terminal failure`, model: SUPPORTED_ANTHROPIC_MODEL })
    const turnId = `${lane}-history-terminal-turn`
    const userMessageId = `${lane}-history-terminal-user`
    const startToken = `${lane}-history-terminal-start`
    const userContent = `${lane} terminal failure`
    prepareTurnAtomically(db, {
      user: { id: userMessageId, sessionId: session.id, role: 'user', content: userContent, timestamp: 1, status: 'sent' },
      assistant: { id: `${lane}-history-terminal-assistant`, sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId, requestId: args.requestId, sessionId: session.id, assistantMessageId: `${lane}-history-terminal-assistant`, state: 'prepared', startToken }
    })
    const acceptedTurn = createAcceptedTurn({
      turnId, requestId: args.requestId, sessionId: session.id, lane, startToken,
      currentUserMessageId: userMessageId, transcriptVersion: 0, config: { lane, model: SUPPORTED_ANTHROPIC_MODEL }
    })
    acceptTurnContext(db, acceptedTurn)
    const context = {
      ...args, sessionId: session.id, turnId, acceptedTurn, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-terminal-failure`, workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error(`expected ${lane} provider route`)
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-terminal-failure-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'response before terminal failure' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<unknown> }).onHostedTurnHandoff
      return await handoff({
        authorizedToolNames: new Set<string>(),
        request: { messages: [{ role: 'user', content: userContent }], maxTokens: 64, credentials: { apiKey: 'remote-key' } },
        currentUserMessageId: userMessageId,
        requiredUserMessage: { id: userMessageId, message: { role: 'user', content: userContent } },
        windowId: record.trace.windowId
      })
    })

    try {
      await expect(runImRemoteAgent(context)).rejects.toMatchObject({
        name: 'HostedTurnFinalizedError', outcome: 'failed', message: expect.stringContaining('injected remote terminal failure')
      })
      expect(providerCalls).toBe(1)
      const canonical = await new SqliteAgentHistory(getDbConnection(db)).read(turnId)
      expect(canonical.events.filter((event) => ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(event.kind)))
        .toEqual([expect.objectContaining({ kind: 'invocation-failed' })])
      expect(getDbConnection(db).prepare('SELECT outcome FROM session_transcript_entries WHERE session_id=? AND turn_id=?')
        .get(session.id, turnId)).toEqual({ outcome: 'failed' })
    } finally {
      db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Hosted Remote context uses the prepared turn user message instead of the session tail', async () => {
    const db = makeDb()
    const session = createSession(db, { name: 'remote-current-turn-input' })
    const { prepareTurnAtomically, appendMessage } = await import('../database')
    prepareTurnAtomically(db, {
      user: { id: 'remote-accepted-user', sessionId: session.id, role: 'user', content: 'accepted remote input', timestamp: 1, status: 'sent' },
      assistant: { id: 'remote-accepted-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'remote-accepted-turn', requestId: 'remote-accepted-request', sessionId: session.id, assistantMessageId: 'remote-accepted-assistant', state: 'prepared', startToken: 'remote-accepted-token' }
    })
    appendMessage(db, { id: 'remote-later-user', sessionId: session.id, role: 'user', content: 'unrelated session tail', timestamp: 3, status: 'sent' })
    mockGetMessages.mockReturnValueOnce([
      { id: 'remote-accepted-user', sessionId: session.id, role: 'user', content: 'accepted remote input', timestamp: 1, status: 'sent' },
      { id: 'remote-accepted-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      { id: 'remote-later-user', sessionId: session.id, role: 'user', content: 'unrelated session tail', timestamp: 3, status: 'sent' }
    ] as never)
    let captured: { messages: { list: Array<{ id?: string; content?: unknown }>; currentUserMessageId?: string }; acceptedTurn?: unknown } | undefined
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      captured = invocation as never
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    const acceptedTurn = createAcceptedTurn({
      turnId: 'remote-accepted-turn', requestId: 'remote-accepted-request', sessionId: session.id, lane: 'feishu',
      startToken: 'remote-accepted-token', currentUserMessageId: 'remote-accepted-user', transcriptVersion: 0, config: { lane: 'feishu' }
    })
    await runImRemoteAgent(baseArgs({ db, sessionId: session.id, requestId: 'remote-accepted-request', turnId: 'remote-accepted-turn', acceptedTurn }))

    expect(captured?.messages.list.map((message) => message.id)).toContain('remote-accepted-user')
    expect(captured?.messages.currentUserMessageId).toBe('remote-accepted-user')
    expect(captured?.messages.list.map((message) => message.content)).not.toContain('unrelated session tail')
    expect(captured?.acceptedTurn).toBe(acceptedTurn)
    expect(mockGetMessages).not.toHaveBeenCalled()
    db.close()
  })

  it('Hosted Remote fails closed if accepted user content changes before execution', async () => {
    const db = makeDb()
    const session = createSession(db, { name: 'remote-input-fingerprint' })
    const { prepareTurnAtomically, getDbConnection } = await import('../database')
    prepareTurnAtomically(db, {
      user: { id: 'remote-bound-user', sessionId: session.id, role: 'user', content: 'accepted remote input', timestamp: 1, status: 'sent' },
      assistant: { id: 'remote-bound-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'remote-bound-turn', requestId: 'remote-bound-request', sessionId: session.id, assistantMessageId: 'remote-bound-assistant', state: 'prepared', startToken: 'remote-bound-token' }
    })
    getDbConnection(db).prepare('UPDATE messages SET content = ? WHERE id = ?').run('changed after acceptance', 'remote-bound-user')

    await expect(runImRemoteAgent(baseArgs({ db, sessionId: session.id, requestId: 'remote-bound-request', turnId: 'remote-bound-turn' })))
      .rejects.toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    expect(mockRunToolChatSession).not.toHaveBeenCalled()
    db.close()
  })

  it('Hosted Remote fails closed if the input commitment belongs to a different turn', async () => {
    const db = makeDb()
    const session = createSession(db, { name: 'remote-input-turn-owner' })
    const { prepareTurnAtomically, getDbConnection } = await import('../database')
    prepareTurnAtomically(db, {
      user: { id: 'remote-turn-owner-user', sessionId: session.id, role: 'user', content: 'accepted remote input', timestamp: 1, status: 'sent' },
      assistant: { id: 'remote-turn-owner-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'remote-turn-owner-turn', requestId: 'remote-turn-owner-request', sessionId: session.id, assistantMessageId: 'remote-turn-owner-assistant', state: 'prepared', startToken: 'remote-turn-owner-token' }
    })
    getDbConnection(db).prepare("UPDATE agent_history_events SET turn_id = ? WHERE invocation_id = ? AND kind = 'session-input-committed'")
      .run('foreign-turn', 'remote-turn-owner-turn')

    await expect(runImRemoteAgent(baseArgs({ db, sessionId: session.id, requestId: 'remote-turn-owner-request', turnId: 'remote-turn-owner-turn' })))
      .rejects.toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
    expect(mockRunToolChatSession).not.toHaveBeenCalled()
    db.close()
  })

  it.each(['feishu', 'wechat'] as const)('%s Hosted caller executes list_directory and commits matching History projections', async (lane) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-hosted-directory-`))
    await fs.writeFile(path.join(workDir, 'visible.txt'), 'directory fixture')
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-hosted-directory`, model: SUPPORTED_ANTHROPIC_MODEL })
    const imChannel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: vi.fn() })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-directory-chat`, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-directory`, workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: `${lane}-hosted-directory-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `${lane}-directory-1`, toolName: 'list_directory', input: { path: '.' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'directory listed' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const handoff = await callback({
        authorizedToolNames: new Set(['list_directory']),
        request: {
          messages: [{ role: 'user', content: `${lane} directory question` }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'list_directory', description: 'List a directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })
      return handoff.result
    })

    let sink: ReturnType<typeof getSessionEventSink> | undefined
    try {
      await expect(runImRemoteAgent(sessionArgs)).resolves.toMatchObject({ ok: true, summary: 'directory listed' })
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      const proposal = history.events.find((event) => event.kind === 'model-response-committed')
      const finished = history.events.find((event) => event.kind === 'tool-call-finished')
      expect(proposal?.payload.sessionLedger).toMatchObject({
        toolCalls: [{ toolUseId: `${lane}-directory-1`, name: 'list_directory', args: { path: '.' } }]
      })
      expect(finished?.payload).toMatchObject({
        toolCallId: `${lane}-directory-1`, success: true,
        result: { success: true, data: { entries: expect.arrayContaining([expect.objectContaining({ name: 'visible.txt' })]) } }
      })
      expect(finished?.payload.sessionLedger).toMatchObject({ result: finished?.payload.result })
      const persistedSession = getSession(args.db, session.id)!
      sink = getSessionEventSink(workDir, session.id, persistedSession.createdAt)
      const events = await readSessionEvents(sink.eventsPath)
      expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({
        toolUseId: `${lane}-directory-1`, name: 'list_directory', args: { path: '.' }
      })
      expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
        toolUseId: `${lane}-directory-1`, result: finished?.payload.result
      })
      expect(events.find((event) => event.type === 'tool_result')?.payload.stepId)
        .toBe(events.find((event) => event.type === 'tool_call')?.payload.stepId)
      expect(history.events.filter((event) => event.kind === 'tool-call-not-dispatched')).toHaveLength(0)
    } finally {
      await sink?.close()
      args.db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) => ['list_directory', 'grep', 'read_file'].map((toolName) => ({ lane, toolName }))))(
    '$lane Hosted $toolName refuses a replaced target before dispatch', async ({ lane, toolName }) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-directory-drift-`))
    const isDirectory = toolName === 'list_directory'
    const targetPath = path.join(workDir, isDirectory ? 'reports' : 'note.txt')
    const replacementPath = `${targetPath}.authorized`
    const toolInput = isDirectory
      ? { path: 'reports' }
      : toolName === 'grep'
        ? { pattern: 'needle', path: 'note.txt', output_mode: 'content' }
        : { path: 'note.txt' }
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-${toolName}-drift`, model: SUPPORTED_ANTHROPIC_MODEL })
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${lane}-${toolName}-identity-drift-approved` }
      ))
    } })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-${toolName}-drift-chat`, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-${toolName}-drift`, workDir, isSensitive: false })
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...args) => originalAdmission.markPermitConsumed(...args),
      beginDispatch: async (...dispatchArgs) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...dispatchArgs)
      },
      invalidate: (...args) => originalAdmission.invalidate(...args),
      settle: (...args) => originalAdmission.settle(...args)
    }
    const executor = vi.spyOn(isDirectory ? listDirectoryExecutor : toolName === 'grep' ? grepExecutor : readFileExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: `${lane}-hosted-${toolName}-drift-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `${lane}-${toolName}-drift-1`, toolName, input: toolInput } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'Authorized target changed; read denied.' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const handoff = await callback({
        authorizedToolNames: new Set([toolName]),
        request: {
          messages: [{ role: 'user', content: `${lane} use ${toolName}` }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: toolName, description: `Run ${toolName}`, inputSchema: { type: 'object' } }]
        },
        windowId: record.trace.windowId
      })
      return handoff.result
    })

    try {
      if (isDirectory) {
        await fs.mkdir(targetPath)
        await fs.writeFile(path.join(targetPath, 'authorized.txt'), 'authorized entry')
      } else {
        await fs.writeFile(targetPath, 'authorized needle')
      }
      const runningAgent = runImRemoteAgent(sessionArgs)
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      await fs.rename(targetPath, replacementPath)
      if (isDirectory) {
        await fs.mkdir(targetPath)
        await fs.writeFile(path.join(targetPath, 'replacement-secret.txt'), 'replacement secret')
      } else {
        await fs.writeFile(targetPath, 'replacement needle secret')
      }
      releaseClaim()
      await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: 'Authorized target changed; read denied.' })

      expect(providerCalls).toBe(2)
      expect(executor).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(JSON.stringify(history.events)).toContain(isDirectory ? 'read-directory-identity-changed' : 'read-target-identity-changed')
      expect(JSON.stringify(history.events)).not.toContain('replacement-secret.txt')
      expect(JSON.stringify(history.events)).not.toContain('replacement secret')
      expect(JSON.stringify(history.events)).not.toContain('replacement needle secret')
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
    } finally {
      releaseClaim()
      executor.mockRestore()
      args.db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) =>
    ['read_file', 'list_directory', 'grep'].flatMap((toolName) =>
      (['authorization-change', 'revoke', 'cancel'] as const).map((termination) => ({ lane, toolName, termination }))
    )
  ))(
    '$lane Hosted $toolName rejects $termination before dispatch claim', async ({ lane, toolName, termination }) => {
      const previousRuntime = getDefaultAgentRuntime()
      const runtime = createDesktopAgentRuntime()
      setDefaultAgentRuntime(runtime)
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-${toolName}-auth-version-`))
      const isDirectory = toolName === 'list_directory'
      const targetPath = path.join(workDir, isDirectory ? 'reports' : 'note.txt')
      const toolInput = isDirectory
        ? { path: 'reports' }
        : toolName === 'grep'
          ? { pattern: 'needle', path: 'note.txt', output_mode: 'content' }
          : { path: 'note.txt' }
      const args = baseArgs()
      const session = createSession(args.db, { name: `${lane}-${toolName}-auth-version`, model: SUPPORTED_ANTHROPIC_MODEL })
      let imChannel!: ImChannel
      imChannel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
        queueMicrotask(() => imChannel.tryResolveFromInbound(
          { kind: 'approve', confirmId: pending.confirmId },
          { matchKey: pending.matchKey, messageId: `${lane}-${toolName}-auth-version-approved` }
        ))
      } })
      const sessionArgs = {
        ...args, sessionId: session.id, workDir,
        workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
        remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-${toolName}-auth-version`, imChannel }
      }
      mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-${toolName}-auth-version`, workDir, isSensitive: false })
      const packages = readPolicyPackages(args.db)
      packages[lane] = 'standard'
      writePolicyPackages(args.db, packages)
      args.db.flushSave()
      const requestId = args.requestId
      if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, lane, requestId)

      const originalAdmission = runtime.executionAdmission
      let reachedClaim!: () => void
      let releaseClaim!: () => void
      const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
      const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
      runtime.executionAdmission = {
        markPermitConsumed: (...dispatchArgs) => originalAdmission.markPermitConsumed(...dispatchArgs),
        beginDispatch: async (...dispatchArgs) => {
          reachedClaim()
          await claimBarrier
          return originalAdmission.beginDispatch(...dispatchArgs)
        },
        invalidate: (...dispatchArgs) => originalAdmission.invalidate(...dispatchArgs),
        settle: (...dispatchArgs) => originalAdmission.settle(...dispatchArgs)
      }
      const executorPort = isDirectory ? listDirectoryExecutor : toolName === 'grep' ? grepExecutor : readFileExecutor
      const execute = vi.spyOn(executorPort, 'execute')
      const toolUseId = `${lane}-${toolName}-auth-version`
      let providerCalls = 0
      mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
        const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
        const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
        if (!route) throw new Error('expected invocation provider route')
        runtime.modelProviders.register(route.profile, { providerId: `${lane}-${toolName}-auth-version-fixture`, stream: async function* () {
          providerCalls += 1
          if (providerCalls === 1) {
            yield { type: 'tool-call', toolCallId: toolUseId, toolName, input: toolInput } as const
            yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
            yield { type: 'finish', reason: 'tool-calls' } as const
            return
          }
          yield { type: 'text-delta', text: 'Authorization changed; read stopped.' } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'stop' } as const
        } })
        const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
        const chatSignal = runtime.chatCancels.register(requestId)
        return (await handoff({
          authorizedToolNames: new Set([toolName]),
          request: {
            messages: [{ role: 'user', content: `Use ${toolName}` }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: chatSignal,
            tools: [{ name: toolName, description: `Run ${toolName}`, inputSchema: { type: 'object' } }]
          },
          windowId: record.trace.windowId
        })).result
      })

      try {
        if (isDirectory) {
          await fs.mkdir(targetPath)
          await fs.writeFile(path.join(targetPath, 'visible.txt'), 'authorized entry')
        } else {
          await fs.writeFile(targetPath, 'authorized needle')
        }
        const runningAgent = runImRemoteAgent(sessionArgs)
        await atClaim
        expect(execute).not.toHaveBeenCalled()
        if (termination === 'authorization-change') {
          const updatedPackages = readPolicyPackages(args.db)
          updatedPackages[lane] = 'strict'
          writePolicyPackages(args.db, updatedPackages)
          args.db.flushSave()
          runtime.policyAuthorizationChanges.publish(lane)
        } else if (termination === 'revoke') {
          expect(runtime.toolRevocations.revokeToolForLane(lane, toolName)).toBe(1)
        } else {
          runtime.chatCancels.signalChatCancel(requestId)
        }
        releaseClaim()
        if (termination === 'cancel') {
          await expect(runningAgent).rejects.toThrow(/cancelled/i)
        } else {
          await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: 'Authorization changed; read stopped.' })
        }

        expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
        expect(execute).not.toHaveBeenCalled()
        const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
        expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
          toolCallId: toolUseId,
          reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
        })
        expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
        expect(history.events.at(-1)).toMatchObject({
          kind: termination === 'cancel' ? 'invocation-interrupted' : 'invocation-completed',
          payload: { status: termination === 'cancel' ? 'cancelled' : 'completed' }
        })
      } finally {
        releaseClaim()
        execute.mockRestore()
        runtime.chatCancels.clear(requestId)
        args.db.close()
        setDefaultAgentRuntime(previousRuntime)
        await fs.rm(workDir, { recursive: true, force: true })
      }
    }
  )

  it('Remote Hosted preserves completed History when turn_end projection fails and repairs JSONL on restart', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-hosted-terminal-recovery-'))
    const dbPath = path.join(workDir, 'history.db')
    let db = openDatabase(dbPath)
    const args = baseArgs({ db })
    const session = createSession(args.db, { name: 'remote-hosted-terminal-recovery', model: SUPPORTED_ANTHROPIC_MODEL })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'remote-terminal-recovery', workDir, isSensitive: false })
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Remote invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-remote-terminal-recovery-fixture', stream: async function* () {
        yield { type: 'text-delta', text: 'completed Remote turn' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(),
        request: { messages: [{ role: 'user', content: 'finish this remote task' }], maxTokens: 64, credentials: { apiKey: 'creds-key' } },
        windowId: record.trace.windowId
      })).result
    })

    const append = SessionEventWriter.prototype.appendCritical
    let failTurnEnd = true
    const appendSpy = vi.spyOn(SessionEventWriter.prototype, 'appendCritical').mockImplementation(function (this: SessionEventWriter, event) {
      if (event.type === 'turn_end' && failTurnEnd) {
        failTurnEnd = false
        return Promise.reject(new Error('injected Remote turn_end projection failure'))
      }
      return append.call(this, event)
    })
    let sink: ReturnType<typeof getSessionEventSink> | undefined
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: 'completed Remote turn' })
      let history = new SqliteAgentHistory(getDbConnection(args.db))
      const canonical = await history.read(args.requestId)
      expect(canonical.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })

      sink = getSessionEventSink(workDir, session.id, session.createdAt)
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'turn_end')).toHaveLength(0)
      await sink.close()
      appendSpy.mockRestore()
      db.close()
      db = openDatabase(dbPath)
      history = new SqliteAgentHistory(getDbConnection(db))

      const recoveredSink = getSessionEventSink(workDir, session.id, session.createdAt)
      const repairErrors: unknown[] = []
      const recovery = {
        repairInvocationTerminal: (location: { workDir: string; sessionId: string; createdAt: number }, terminal: Record<string, unknown>) => {
          expect(location).toEqual({ workDir, sessionId: session.id, createdAt: session.createdAt })
          return ensureTurnEndEvent(recoveredSink, terminal.turnId as string, terminal.reason as string)
        },
        onInvocationTerminalRepairError: (error: unknown) => repairErrors.push(error)
      }
      await history.recoverInterruptedInvocations(recovery)
      await history.recoverInterruptedInvocations(recovery)
      expect(repairErrors).toEqual([])
      const repaired = await readSessionEvents(recoveredSink.eventsPath)
      expect(repaired.filter((event) => event.type === 'turn_end')).toHaveLength(1)
      expect(repaired.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'completed' })
      await recoveredSink.close()
    } finally {
      appendSpy.mockRestore()
      await sink?.close()
      db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted handoff rejects legacy transcript drift against canonical session History', async () => {
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-history-cutover', model: SUPPORTED_ANTHROPIC_MODEL })
    const priorMessages = [{ role: 'user', content: 'canonical prior question' }, { role: 'assistant', content: 'canonical prior answer' }]
    const history = new SqliteAgentHistory(getDbConnection(args.db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'prior-feishu', turnId: 'prior-feishu-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-feishu-context', idempotencyKey: 'prior-feishu-context', kind: 'invocation-context-committed', payload: { messages: priorMessages } },
      { invocationId: 'prior-feishu', turnId: 'prior-feishu-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-feishu-done', idempotencyKey: 'prior-feishu-done', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    let handoffError: unknown
    mockRunToolChatSession.mockImplementation(async (_invocation: never, _ports: never, options: never) => {
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<unknown> }).onHostedTurnHandoff
      try {
        await callback({
          authorizedToolNames: new Set(),
          request: { messages: [{ role: 'user', content: 'stale legacy transcript' }, { role: 'user', content: 'current Feishu question' }], maxTokens: 64 },
          requiredUserMessage: { id: 'feishu-current-user', message: { role: 'user', content: 'current Feishu question' } }
        })
      } catch (error) { handoffError = error }
      return { ok: false, error: handoffError instanceof Error ? handoffError.message : 'handoff unexpectedly proceeded', content: [], stopReason: 'end_turn' }
    })

    const result = await runImRemoteAgent({ ...args, sessionId: session.id })

    expect(result.ok).toBe(false)
    expect(handoffError).toMatchObject({ message: 'Canonical session History could not safely provide the Hosted transcript' })
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu production Hosted caller aborts an active CLI lease after %s', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-hosted-cli-${termination}-`))
    const session = createSession(args.db, { name: `feishu-hosted-cli-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `cli-${termination}-approved` }
      ))
    } })
    const requestId = `feishu-hosted-cli-${termination}`
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const chatSignal = runtime.chatCancels.register(requestId)
    const runner = {
      resolveExecutable: () => '/approved/lark-cli',
      run: vi.fn(async (options: { signal?: AbortSignal }) => {
        observedSignal = options.signal
        enteredRunner()
        return await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve({ exitCode: 143, stdout: '', stderr: `terminated after ${termination}`, timedOut: false }), { once: true })
        })
      })
    }
    let observedSignal: AbortSignal | undefined
    let markRunnerEntered!: () => void
    const runnerEntered = new Promise<void>((resolve) => { markRunnerEntered = resolve })
    // Keep the runner callback's entry signal explicit so the policy mutation occurs after dispatch claim.
    const enteredRunner = () => markRunnerEntered()
    const sessionArgs = {
      ...args, sessionId: session.id, requestId, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: `chat-${termination}`, imChannel },
      toolChatExtras: {
        feishuConfig: { larkCliDefaultTimeoutSec: 45, larkCliWriteRequiresConfirm: true } as never,
        larkCliRunner: runner as never
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `feishu-cli-${termination}`, workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: `hosted-feishu-cli-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: `feishu-${termination}-cli`, toolName: 'run_lark_cli', input: { args: ['doc', 'get', '--doc-token', 'doc-token-1'] } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_lark_cli']),
        request: {
          messages: [{ role: 'user', content: '读取这个飞书文档' }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: chatSignal,
          tools: [{ name: 'run_lark_cli', description: 'run Feishu CLI', inputSchema: { type: 'object' } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const invocation = runImRemoteAgent(sessionArgs)
      await runnerEntered
      expect(observedSignal?.aborted).toBe(false)
      if (termination === 'authorization-change') {
        const packages = readPolicyPackages(args.db)
        packages.feishu = 'strict'
        writePolicyPackages(args.db, packages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'run_lark_cli')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)

      await expect(invocation).rejects.toThrow(/cancel|uncertain|after dispatch/i)
      expect(observedSignal?.aborted).toBe(true)
      expect(runner.run).toHaveBeenCalledOnce()
      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted' } })
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: `feishu-${termination}-cli` })
      expect(history.events.some((event) => event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
      const ledger = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(ledger.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: `feishu-${termination}-cli`, name: 'run_lark_cli' })
        expect(events.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: requestId, reason: 'interrupted' })
      } finally { await ledger.close() }
    } finally {
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted confirmed run_lark_cli rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-lark-cli-${termination}-claim-`))
    const args = baseArgs()
    const session = createSession(args.db, { name: `feishu-lark-cli-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `feishu-lark-cli-${termination}-approved` }
      ))
    } })
    const requestId = args.requestId
    const runner = { resolveExecutable: () => '/approved/lark-cli', run: vi.fn(async () => ({ exitCode: 0, stdout: 'should not run', stderr: '', timedOut: false })) }
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: `feishu-lark-cli-${termination}`, imChannel: channel },
      toolChatExtras: { feishuConfig: { larkCliDefaultTimeoutSec: 45, larkCliWriteRequiresConfirm: true } as never, larkCliRunner: runner as never }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `feishu-lark-cli-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...values) => originalAdmission.markPermitConsumed(...values),
      beginDispatch: async (...values) => { reachedClaim(); await claimBarrier; return originalAdmission.beginDispatch(...values) },
      invalidate: (...values) => originalAdmission.invalidate(...values),
      settle: (...values) => originalAdmission.settle(...values)
    }
    const toolCallId = `feishu-lark-cli-${termination}`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-lark-cli-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'run_lark_cli', input: { args: ['doc', 'create'] } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'CLI 授权变化后命令未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_lark_cli']),
        request: {
          messages: [{ role: 'user', content: '创建飞书文档' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'run_lark_cli', description: 'Feishu CLI', inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      const runningAgent = runImRemoteAgent(context)
      await atClaim
      expect(runner.run).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.feishu = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'run_lark_cli')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(runningAgent).rejects.toThrow(/cancelled/i)
      else await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: 'CLI 授权变化后命令未执行。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(runner.run).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({ toolCallId, approved: true })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: termination === 'cancel' ? 'invocation-interrupted' : 'invocation-completed',
        payload: { status: termination === 'cancel' ? 'cancelled' : 'completed' }
      })
    } finally {
      releaseClaim()
      runtime.chatCancels.clear(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) =>
    (['write_file', 'edit_file'] as const).flatMap((toolName) =>
      (['authorization-change', 'revoke', 'cancel'] as const).map((termination) => ({ lane, toolName, termination }))
    )
  ))('$lane Hosted confirmed $toolName rejects $termination before dispatch claim', async ({ lane, toolName, termination }) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-write-${termination}-`))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    if (toolName === 'edit_file') await fs.writeFile(targetPath, 'original edit target')
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-write-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    let channel!: ImChannel
    channel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${lane}-write-${termination}-approved` }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-write-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-write-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages[lane] = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, lane, requestId)

    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...dispatchArgs) => originalAdmission.markPermitConsumed(...dispatchArgs),
      beginDispatch: async (...dispatchArgs) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...dispatchArgs)
      },
      invalidate: (...dispatchArgs) => originalAdmission.invalidate(...dispatchArgs),
      settle: (...dispatchArgs) => originalAdmission.settle(...dispatchArgs)
    }
    const executor = toolName === 'edit_file' ? editFileExecutor : writeFileExecutor
    const executeWrite = vi.spyOn(executor, 'execute')
    const toolCallId = `${lane}-${toolName}-${termination}`
    const toolInput = toolName === 'edit_file'
      ? { path: 'must-not-exist.txt', old_string: 'original edit target', new_string: 'should never be written' }
      : { path: 'must-not-exist.txt', content: 'should never be written' }
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-write-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName, input: toolInput } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '写入授权已变化，操作未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const chatSignal = runtime.chatCancels.register(requestId)
      return (await handoff({
        authorizedToolNames: new Set([toolName]),
        request: {
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: chatSignal,
          tools: [toolName === 'edit_file'
            ? { name: toolName, description: 'Edit a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } }
            : { name: toolName, description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runImRemoteAgent(context)
      await atClaim
      expect(executeWrite).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const updatedPackages = readPolicyPackages(args.db)
        updatedPackages[lane] = 'strict'
        writePolicyPackages(args.db, updatedPackages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish(lane)
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane(lane, toolName)).toBe(1)
      } else {
        runtime.chatCancels.signalChatCancel(requestId)
      }
      releaseClaim()
      if (termination === 'cancel') {
        await expect(runningAgent).rejects.toThrow(/cancelled/i)
      } else {
        await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: '写入授权已变化，操作未执行。' })
      }

      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeWrite).not.toHaveBeenCalled()
      if (toolName === 'edit_file') await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('original edit target')
      else await expect(fs.access(targetPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId, approved: true, answerer: 'user'
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: termination === 'cancel' ? 'invocation-interrupted' : 'invocation-completed',
        payload: { status: termination === 'cancel' ? 'cancelled' : 'completed' }
      })
    } finally {
      releaseClaim()
      executeWrite.mockRestore()
      runtime.chatCancels.clear(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) =>
    (['write_file', 'edit_file'] as const).flatMap((toolName) =>
      (['authorization-change', 'revoke', 'cancel'] as const).map((termination) => ({ lane, toolName, termination }))
    )
  ))('$lane Hosted $toolName preserves unknown outcome after dispatch when $termination arrives', async ({ lane, toolName, termination }) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-write-post-claim-${termination}-`))
    const targetPath = path.join(workDir, 'committed-before-ack-loss.txt')
    if (toolName === 'edit_file') await fs.writeFile(targetPath, 'original edit target')
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-write-post-claim-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    let channel!: ImChannel
    channel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${lane}-write-post-claim-${termination}-approved` }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-write-post-claim-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-write-post-claim-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages[lane] = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, lane, requestId)

    let executorEntered!: () => void
    let releaseExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { executorEntered = resolve })
    const executorBarrier = new Promise<void>((resolve) => { releaseExecutor = resolve })
    let executorSignal: AbortSignal | undefined
    const executor = toolName === 'edit_file' ? editFileExecutor : writeFileExecutor
    const executeWrite = vi.spyOn(executor, 'execute').mockImplementation(async (_input, executionContext) => {
      executorSignal = executionContext.signal
      executorEntered()
      await executorBarrier
      await fs.writeFile(targetPath, 'side effect committed; acknowledgement lost')
      throw new Error('simulated acknowledgement loss after write')
    })
    const toolCallId = `${lane}-${toolName}-post-claim-${termination}`
    const toolInput = toolName === 'edit_file'
      ? { path: 'committed-before-ack-loss.txt', old_string: 'original edit target', new_string: 'side effect' }
      : { path: 'committed-before-ack-loss.txt', content: 'side effect' }
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-write-post-claim-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName, input: toolInput } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set([toolName]),
        request: {
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [toolName === 'edit_file'
            ? { name: toolName, description: 'Edit a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } }
            : { name: toolName, description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runImRemoteAgent(context)
      await atExecutor
      expect(executorSignal?.aborted).toBe(false)
      if (termination === 'authorization-change') {
        const updatedPackages = readPolicyPackages(args.db)
        updatedPackages[lane] = 'strict'
        writePolicyPackages(args.db, updatedPackages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish(lane)
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane(lane, toolName)).toBe(1)
      } else {
        runtime.chatCancels.signalChatCancel(requestId)
      }
      expect(executorSignal?.aborted).toBe(true)
      releaseExecutor()
      await expect(runningAgent).rejects.toThrow(/after dispatch|uncertain|interrupted/i)
      expect(providerCalls).toBe(1)
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('side effect committed; acknowledgement lost')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted',
        payload: { status: 'interrupted', sessionLedger: { reason: 'interrupted' } }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'interrupted' })
      } finally { await sink.close() }
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      releaseExecutor()
      executeWrite.mockRestore()
      runtime.chatCancels.clear(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) =>
    (['authorization-change', 'revoke', 'cancel'] as const).map((termination) => ({ lane, termination }))
  ))('$lane Hosted browser act rejects $termination before dispatch claim', async ({ lane, termination }) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-browser-${termination}-`))
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-browser-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${lane}-browser-${termination}-approved` }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getBrowserConfig: () => ({ ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }),
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-browser-${termination}`, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-browser-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages[lane] = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, lane, requestId)

    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...dispatchArgs) => originalAdmission.markPermitConsumed(...dispatchArgs),
      beginDispatch: async (...dispatchArgs) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...dispatchArgs)
      },
      invalidate: (...dispatchArgs) => originalAdmission.invalidate(...dispatchArgs),
      settle: (...dispatchArgs) => originalAdmission.settle(...dispatchArgs)
    }
    const executeBrowser = vi.spyOn(browserExecutor, 'execute')
    const toolCallId = `${lane}-browser-${termination}`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-browser-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '浏览器授权已变化，操作未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['browser']),
        request: {
          messages: [{ role: 'user', content: '提交当前网页表单' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'browser', description: 'Browser action', inputSchema: { type: 'object', properties: { action: { type: 'string' }, instruction: { type: 'string' } }, required: ['action', 'instruction'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runImRemoteAgent(context)
      await atClaim
      expect(executeBrowser).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const updatedPackages = readPolicyPackages(args.db)
        updatedPackages[lane] = 'strict'
        writePolicyPackages(args.db, updatedPackages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish(lane)
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane(lane, 'browser')).toBe(1)
      } else {
        runtime.chatCancels.signalChatCancel(requestId)
      }
      releaseClaim()
      if (termination === 'cancel') await expect(runningAgent).rejects.toThrow(/cancelled/i)
      else await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: '浏览器授权已变化，操作未执行。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeBrowser).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId, approved: true, answerer: 'user'
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: termination === 'cancel' ? 'invocation-interrupted' : 'invocation-completed',
        payload: { status: termination === 'cancel' ? 'cancelled' : 'completed' }
      })
    } finally {
      releaseClaim()
      executeBrowser.mockRestore()
      runtime.chatCancels.clear(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each((['feishu', 'wechat'] as const).flatMap((lane) =>
    (['authorization-change', 'revoke', 'cancel'] as const).map((termination) => ({ lane, termination }))
  ))('$lane Hosted browser act preserves unknown outcome after dispatch when $termination arrives', async ({ lane, termination }) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-browser-post-claim-${termination}-`))
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-browser-post-claim-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    const browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${lane}-browser-post-claim-${termination}-approved` }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getBrowserConfig: () => browserConfig,
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-browser-post-claim-${termination}`, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-browser-post-claim-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages[lane] = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, lane, requestId)

    let executorEntered!: () => void
    let releaseExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { executorEntered = resolve })
    const executorBarrier = new Promise<void>((resolve) => { releaseExecutor = resolve })
    let executorSignal: AbortSignal | undefined
    let pageActionCommitted = false
    const executeBrowser = vi.spyOn(browserExecutor, 'execute').mockImplementation(async (_input, executionContext) => {
      executorSignal = executionContext.signal
      executorEntered()
      await executorBarrier
      pageActionCommitted = true
      throw new Error('simulated browser action committed; acknowledgement lost')
    })
    const toolCallId = `${lane}-browser-post-claim-${termination}`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-browser-post-claim-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['browser']),
        request: {
          messages: [{ role: 'user', content: '提交当前网页表单' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'browser', description: 'Browser action', inputSchema: { type: 'object', properties: { action: { type: 'string' }, instruction: { type: 'string' } }, required: ['action', 'instruction'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runImRemoteAgent(context)
      await atExecutor
      expect(executorSignal?.aborted).toBe(false)
      if (termination === 'authorization-change') {
        const updatedPackages = readPolicyPackages(args.db)
        updatedPackages[lane] = 'strict'
        writePolicyPackages(args.db, updatedPackages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish(lane)
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane(lane, 'browser')).toBe(1)
      } else {
        runtime.chatCancels.signalChatCancel(requestId)
      }
      expect(executorSignal?.aborted).toBe(true)
      releaseExecutor()
      await expect(runningAgent).rejects.toThrow(/after dispatch|uncertain|interrupted/i)
      expect(pageActionCommitted).toBe(true)
      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({ toolCallId, approved: true })
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted',
        payload: { status: 'interrupted', sessionLedger: { reason: 'interrupted' } }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'interrupted' })
      } finally { await sink.close() }
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      releaseExecutor()
      executeBrowser.mockRestore()
      runtime.chatCancels.clear(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['feishu', 'wechat'] as const)('%s Hosted browser act dispatches after user confirmation', async (lane) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `remote-${lane}-browser-confirmed-success-`))
    const args = baseArgs()
    const session = createSession(args.db, { name: `${lane}-browser-confirmed-success`, model: SUPPORTED_ANTHROPIC_MODEL })
    const browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${lane}-browser-confirmed-success-approved` }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getBrowserConfig: () => browserConfig,
      remoteContext: { ...args.remoteContext, source: lane, chatId: `${lane}-browser-confirmed-success`, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `${lane}-browser-confirmed-success`, workDir, isSensitive: false })
    const toolCallId = `${lane}-browser-confirmed-success`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `${lane}-browser-confirmed-success-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '表单已提交。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['browser']),
        request: {
          messages: [{ role: 'user', content: '提交当前网页表单' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(args.requestId),
          tools: [{ name: 'browser', description: 'Browser action', inputSchema: { type: 'object', properties: { action: { type: 'string' }, instruction: { type: 'string' } }, required: ['action', 'instruction'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeBrowser = vi.spyOn(browserExecutor, 'execute').mockResolvedValue({ success: true, result: 'Form submitted' })

    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '表单已提交。' })
      expect(providerCalls).toBe(2)
      expect(executeBrowser).toHaveBeenCalledOnce()
      expect(executeBrowser.mock.calls[0][1]).toMatchObject({ toolUserConfirmed: true, lane })
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({ toolCallId, approved: true })
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId })
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({ toolCallId, success: true })
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'tool_result')?.payload).toMatchObject({ toolUseId: toolCallId, result: { success: true } })
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      executeBrowser.mockRestore()
      runtime.chatCancels.clear(args.requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted revocation before dispatch claim records not-dispatched and never enters read executor', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const originalAdmission = runtime.executionAdmission
    const originalRead = readFileExecutor.execute
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-read-claim-revoke-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'must not read')
    const args = baseArgs({ workDir, remoteContext: { source: 'feishu' as const, messageId: 'feishu-revoke-message', chatId: 'feishu-revoke-chat' } })
    const session = createSession(args.db, { name: 'feishu-hosted-read-claim-revoke', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'feishu-read-revoke-approval' }
      ))
    } })
    args.remoteContext.imChannel = channel
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-read-claim-revoke', workDir, isSensitive: false })
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const executor = vi.spyOn(readFileExecutor, 'execute')
    runtime.executionAdmission = {
      markPermitConsumed: (...call) => originalAdmission.markPermitConsumed(...call),
      beginDispatch: async (...call) => {
        reachedClaim()
        await claimBarrier
        return originalAdmission.beginDispatch(...call)
      },
      invalidate: (...call) => originalAdmission.invalidate(...call),
      settle: (...call) => originalAdmission.settle(...call)
    }
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-read-claim-revoke', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-read-claim-revoked', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '读取已撤销，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const runningTurn = handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: 'read note from Feishu' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      expect(runtime.toolRevocations.revokeToolForLane('feishu', 'read_file')).toBe(1)
      releaseClaim()
      return (await runningTurn).result
    })

    try {
      // The mocked legacy loop normally registers the request before invoking this Hosted handoff.
      runtime.toolRevocations.registerToolRevocationRequest(args.requestId, 'feishu', args.requestId)
      await expect(runImRemoteAgent({ ...args, sessionId: session.id })).resolves.toMatchObject({ ok: true, summary: '读取已撤销，未执行。' })
      expect(providerCalls).toBe(2)
      expect(executor).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-read-claim-revoked', reason: 'REVOKED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      runtime.executionAdmission = originalAdmission
      readFileExecutor.execute = originalRead
      setDefaultAgentRuntime(previousRuntime)
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu caller executes run_lark_cli through Hosted SDK and persists matching History/session ledger', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-hosted-lark-cli-'))
    const args = baseArgs()
    const session = createSession(args.db, { name: 'remote-hosted-lark-cli', model: SUPPORTED_ANTHROPIC_MODEL })
    const runner = {
      resolveExecutable: () => '/approved/lark-cli',
      run: vi.fn(async () => ({ exitCode: 0, stdout: '{"title":"Quarterly plan"}', stderr: '', timedOut: false }))
    }
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'lark-cli-answer-1' }
      ))
    } })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'chat-1', imChannel },
      toolChatExtras: {
        feishuConfig: { larkCliDefaultTimeoutSec: 45, larkCliWriteRequiresConfirm: true } as never,
        larkCliRunner: runner as never
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'remote-lark-cli', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: 'hosted-feishu-lark-cli-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'remote-lark-cli-1', toolName: 'run_lark_cli', input: { args: ['doc', 'get', '--doc-token', 'doc-token-1'] } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '已读取文档：Quarterly plan' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const handoff = await callback({
        authorizedToolNames: new Set(['run_lark_cli']),
        request: {
          messages: [{ role: 'user', content: '读取这个飞书文档' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'run_lark_cli', description: 'run Feishu CLI', inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] } }]
        },
        windowId: record.trace.windowId
      })
      return handoff.result
    })

    try {
      await expect(runImRemoteAgent(sessionArgs)).resolves.toMatchObject({ ok: true, summary: '已读取文档：Quarterly plan', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      expect(runner.run).toHaveBeenCalledTimes(1)
      expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
        args: ['doc', 'get', '--doc-token', 'doc-token-1'], resolvedExecutable: '/approved/lark-cli', timeoutSec: 45
      }))
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      const events = await readSessionEvents(sink.eventsPath)
      expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({
        toolUseId: 'remote-lark-cli-1', name: 'run_lark_cli', args: { args: ['doc', 'get', '--doc-token', 'doc-token-1'] }
      })
      const toolResult = events.find((event) => event.type === 'tool_result')?.payload as { result?: unknown } | undefined
      expect(toolResult?.result).toMatchObject({ success: true, data: { stdout: '{"title":"Quarterly plan"}', status: 'succeeded', exitCode: 0 } })
      const canonical = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      const responseEnvelope = canonical.events.find((event) => event.kind === 'model-response-committed')
      const resultEnvelope = canonical.events.find((event) => event.kind === 'tool-call-finished')
      expect(responseEnvelope?.payload).toMatchObject({ sessionLedger: { toolCalls: [{
        toolUseId: 'remote-lark-cli-1', name: 'run_lark_cli', args: { args: ['doc', 'get', '--doc-token', 'doc-token-1'] }
      }] } })
      expect(resultEnvelope?.payload).toMatchObject({ toolCallId: 'remote-lark-cli-1', sessionLedger: { result: toolResult?.result } })
      const terminal = canonical.events.find((event) => event.kind === 'invocation-completed')
      expect(terminal?.payload).toMatchObject({ sessionLedger: { location: { workDir, sessionId: session.id, createdAt: session.createdAt }, turnId: expect.any(String), reason: 'completed' } })
      await sink.close()
      const beforeRepair = await readSessionEvents(sink.eventsPath)
      await fs.writeFile(sink.eventsPath, `${beforeRepair.filter((event) => event.type !== 'turn_end').map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
      const repairedSink = getSessionEventSink(workDir, session.id, session.createdAt)
      await new SqliteAgentHistory(getDbConnection(args.db)).recoverInterruptedInvocations({
        repairInvocationTerminal: (location, projectedTerminal) => ensureTurnEndEvent(repairedSink, String(projectedTerminal.turnId), String(projectedTerminal.reason))
      })
      await repairedSink.close()
      const afterRepair = await readSessionEvents(sink.eventsPath)
      expect(afterRepair.filter((event) => event.type === 'turn_end')).toHaveLength(1)
      expect(afterRepair.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'completed' })
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted run_lark_cli rejects a changed default timeout after confirmation before execution', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-lark-cli-config-drift-'))
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-lark-cli-config-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    const runner = {
      resolveExecutable: () => '/approved/lark-cli',
      run: vi.fn(async () => ({ exitCode: 0, stdout: 'unexpected execution', stderr: '', timedOut: false }))
    }
    const feishuConfig = { larkCliDefaultTimeoutSec: 45, larkCliWriteRequiresConfirm: true }
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      feishuConfig.larkCliDefaultTimeoutSec = 90
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'lark-cli-config-drift-approved' }
      ))
    } })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'feishu-lark-cli-config-drift', imChannel },
      toolChatExtras: { feishuConfig: feishuConfig as never, larkCliRunner: runner as never }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-lark-cli-config-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-lark-cli-config-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-lark-cli-config-drift', toolName: 'run_lark_cli', input: { args: ['doc', 'create'] } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'CLI 配置在确认期间变化，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_lark_cli']),
        request: {
          messages: [{ role: 'user', content: '创建飞书文档' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'run_lark_cli', description: 'Feishu CLI', inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runImRemoteAgent(sessionArgs)).resolves.toMatchObject({ ok: true, summary: 'CLI 配置在确认期间变化，未执行。' })
      expect(providerCalls).toBe(2)
      expect(runner.run).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId: 'feishu-lark-cli-config-drift', approved: true
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-lark-cli-config-drift'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted caller confirms and executes run_script through the SDK RegisteredTool', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-hosted-run-script-'))
    const args = baseArgs()
    const session = createSession(args.db, { name: 'remote-hosted-run-script', model: SUPPORTED_ANTHROPIC_MODEL })
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'run-script-answer-1' }
      ))
    } })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'chat-run-script', imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'remote-run-script', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: 'hosted-feishu-run-script-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-run-script-1', toolName: 'run_script', input: {
            language: 'javascript', code: 'process.stdout.write("feishu-hosted-script-ok")'
          } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '脚本执行完成。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const handoff = await callback({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '运行这段 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'run_script', description: 'Run JavaScript', inputSchema: {
            type: 'object', properties: { code: { type: 'string' }, language: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })
      return handoff.result
    })

    try {
      await expect(runImRemoteAgent(sessionArgs)).resolves.toMatchObject({ ok: true, summary: '脚本执行完成。', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      const events = await readSessionEvents(sink.eventsPath)
      expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({
        toolUseId: 'feishu-run-script-1', name: 'run_script', args: {
          language: 'javascript', code: 'process.stdout.write("feishu-hosted-script-ok")'
        }
      })
      const toolResult = events.find((event) => event.type === 'tool_result')?.payload as { result?: unknown } | undefined
      expect(toolResult?.result).toMatchObject({ success: true, data: { stdout: 'feishu-hosted-script-ok' } })
      const canonical = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(canonical.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-run-script-1', result: { success: true, data: { stdout: 'feishu-hosted-script-ok' } }
      })
      expect(canonical.events.find((event) => event.kind === 'invocation-completed')?.payload).toMatchObject({
        sessionLedger: { location: { workDir, sessionId: session.id, createdAt: session.createdAt }, reason: 'completed' }
      })
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['timeout', (config: typeof DEFAULT_TOOLS_CONFIG) => ({ ...config, scriptTimeout: config.scriptTimeout + 1 })],
    ['JavaScript interpreter', (config: typeof DEFAULT_TOOLS_CONFIG) => ({
      ...config,
      scriptInterpreterPaths: { ...config.scriptInterpreterPaths, javascript: '/definitely/missing/feishu-agent-node' }
    })]
  ])('Feishu Hosted run_script rejects confirmation-time %s changes before execution', async (_setting, changeConfig) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-run-script-config-drift-'))
    const markerPath = path.join(workDir, 'script-must-not-start')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-run-script-config-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let toolsConfig: typeof DEFAULT_TOOLS_CONFIG = { ...DEFAULT_TOOLS_CONFIG }
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      toolsConfig = changeConfig(toolsConfig)
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'run-script-config-drift-approved' }
      ))
    } })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getToolsConfig: () => toolsConfig,
      remoteContext: { ...args.remoteContext, chatId: 'feishu-run-script-config-drift', imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-run-script-config-drift', workDir, isSensitive: false })
    const code = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-run-script-config-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-run-script-config-drift', toolName: 'run_script', input: { language: 'javascript', code } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '脚本配置在确认期间变化，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '运行这段 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'run_script', description: 'Run JavaScript', inputSchema: {
            type: 'object', properties: { code: { type: 'string' }, language: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeScript = vi.spyOn(runScriptExecutor, 'execute')
    try {
      await expect(runImRemoteAgent(sessionArgs)).resolves.toMatchObject({ ok: true, summary: '脚本配置在确认期间变化，未执行。' })
      expect(providerCalls).toBe(2)
      expect(executeScript).not.toHaveBeenCalled()
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId: 'feishu-run-script-config-drift', approved: true
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-run-script-config-drift'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeScript.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted confirmed run_script rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-run-script-${termination}-`))
    const session = createSession(args.db, { name: `feishu-run-script-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `feishu-run-script-${termination}-approved` }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: `feishu-run-script-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `feishu-run-script-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(args.requestId, 'feishu', args.requestId)
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...values) => originalAdmission.markPermitConsumed(...values),
      beginDispatch: async (...values) => { reachedClaim(); await claimBarrier; return originalAdmission.beginDispatch(...values) },
      invalidate: (...values) => originalAdmission.invalidate(...values),
      settle: (...values) => originalAdmission.settle(...values)
    }
    const markerPath = path.join(workDir, 'script-must-not-run')
    const code = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed')`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-run-script-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `feishu-run-script-${termination}`, toolName: 'run_script', input: { language: 'javascript', code } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '授权变化后脚本未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '运行这段 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(args.requestId),
          tools: [{ name: 'run_script', description: 'Run JavaScript', inputSchema: {
            type: 'object', properties: { code: { type: 'string' }, language: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const running = runImRemoteAgent(context)
      await atClaim
      expect(await fs.stat(markerPath).catch(() => undefined)).toBeUndefined()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.feishu = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'run_script')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(args.requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(running).rejects.toThrow(/cancelled/i)
      else await expect(running).resolves.toMatchObject({ ok: true, summary: '授权变化后脚本未执行。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(await fs.stat(markerPath).catch(() => undefined)).toBeUndefined()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId: `feishu-run-script-${termination}`, approved: true
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `feishu-run-script-${termination}`,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      runtime.chatCancels.clear(args.requestId)
      runtime.toolRevocations.clearToolRevocationRequest(args.requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted run_script keeps a post-claim %s result unknown', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-run-script-postclaim-${termination}-`))
    const markerPath = path.join(workDir, 'script-side-effect.txt')
    const args = baseArgs()
    const session = createSession(args.db, { name: `feishu-run-script-postclaim-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = `feishu-run-script-postclaim-${termination}`
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `${requestId}-approved` }
      ))
    } })
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const chatSignal = runtime.chatCancels.register(requestId)
    const workDirManager = { ...args.workDirManager, getActiveWorkDir: () => workDir }
    const sessionArgs = {
      ...args, sessionId: session.id, requestId, workDir, workDirManager,
      remoteContext: { ...args.remoteContext, chatId: `chat-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: requestId, workDir, isSensitive: false })
    const code = `import('node:fs').then(({ writeFileSync }) => { writeFileSync(${JSON.stringify(markerPath)}, 'effect-committed'); setTimeout(() => {}, 10000) })`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `${requestId}-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: requestId, toolName: 'run_script', input: { language: 'javascript', code } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '执行这个 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: chatSignal,
          tools: [{ name: 'run_script', description: 'Run JavaScript', inputSchema: {
            type: 'object', properties: { code: { type: 'string' }, language: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const originalExecute = runScriptExecutor.execute
    let executorEntered!: () => void
    const entered = new Promise<void>((resolve) => { executorEntered = resolve })
    const executeSpy = vi.spyOn(runScriptExecutor, 'execute').mockImplementation(async (input, context) => {
      executorEntered()
      return originalExecute(input, context)
    })
    try {
      const running = runImRemoteAgent(sessionArgs)
      await entered
      const deadline = Date.now() + 5_000
      let markerContent: string | undefined
      while (Date.now() < deadline) {
        try {
          markerContent = await fs.readFile(markerPath, 'utf8')
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      expect(markerContent).toBe('effect-committed')
      if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'run_script')).toBe(1)
      } else if (termination === 'cancel') {
        runtime.chatCancels.signalChatCancel(requestId)
      } else {
        const packages = readPolicyPackages(args.db)
        packages.feishu = 'strict'
        writePolicyPackages(args.db, packages)
        args.db.flushSave()
        expect(runtime.policyAuthorizationChanges.publish('feishu')).toBeGreaterThan(0)
      }
      await expect(running).rejects.toMatchObject({ outcome: 'interrupted', historyTerminalCommitted: true })
      expect(await fs.readFile(markerPath, 'utf8')).toBe('effect-committed')
      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: requestId })
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted' } })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: requestId, name: 'run_script' })
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === requestId && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'interrupted' })
      } finally { await sink.close() }
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      if (termination === 'cancel') runtime.chatCancels.signalChatCancel(requestId)
      else runtime.toolRevocations.revokeToolForLane('feishu', 'run_script')
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      executeSpy.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted run_shell remains locked-denied before executor dispatch', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-shell-denied-'))
    const session = createSession(args.db, { name: 'feishu-hosted-shell-denied', model: SUPPORTED_ANTHROPIC_MODEL })
    const markerPath = path.join(workDir, 'shell-must-not-run')
    const executor = vi.spyOn(runShellExecutor, 'execute')
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getShellConfig: () => ({ enabled: true, shellDefaultTimeoutSec: 10, maxInlineOutputBytes: 1024, rules: [] })
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-shell-denied', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-locked-shell-deny-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-shell-denied', toolName: 'run_shell', input: {
            command: `printf executed > ${JSON.stringify(markerPath)}`
          } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '远程 shell 被安全策略拒绝。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_shell']),
        request: {
          messages: [{ role: 'user', content: '执行远程命令' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'run_shell', description: 'Run shell', inputSchema: {
            type: 'object', properties: { command: { type: 'string' } }, required: ['command']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '远程 shell 被安全策略拒绝。' })
      expect(providerCalls).toBe(2)
      expect(executor).not.toHaveBeenCalled()
      await expect(fs.stat(markerPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-shell-denied', reason: 'POLICY_DENY'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executor.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['sensitive', 'unknown'] as const)('Feishu Hosted switch_work_dir locked-denies a %s target', async (targetKind) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-workdir-${targetKind}-deny-`))
    const session = createSession(args.db, { name: `feishu-workdir-${targetKind}-deny`, model: SUPPORTED_ANTHROPIC_MODEL })
    const profiles = targetKind === 'sensitive'
      ? [{ id: 'sensitive-profile', name: 'Sensitive', path: workDir, sensitive: true }]
      : []
    const manager = {
      ...args.workDirManager,
      listProfiles: () => profiles,
      getActiveProfileId: () => 'active-profile',
      getActiveWorkDir: () => workDir
    }
    const context = {
      ...args, sessionId: session.id, workDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, chatId: `feishu-workdir-${targetKind}-deny` }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'active-profile', workDir, isSensitive: false })
    const executeSwitch = vi.spyOn(switchWorkDirExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-workdir-${targetKind}-deny-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `feishu-switch-workdir-${targetKind}`, toolName: 'switch_work_dir', input: {
            profile_id: targetKind === 'sensitive' ? 'sensitive-profile' : 'missing-profile'
          } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '该工作目录未获授权，未切换。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_work_dir']),
        request: {
          messages: [{ role: 'user', content: '切换飞书会话工作目录' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '该工作目录未获授权，未切换。' })
      expect(providerCalls).toBe(2)
      expect(executeSwitch).not.toHaveBeenCalled()
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe(session.workDirProfileId)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `feishu-switch-workdir-${targetKind}`, reason: 'POLICY_DENY'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted switch_work_dir rebinds the session only after an authorized Runtime dispatch', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-workdir-current-'))
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-workdir-target-'))
    const profile = { id: 'target-profile', name: 'Target project', path: targetDir, aliases: ['target'] }
    const manager = {
      ...args.workDirManager,
      listProfiles: () => [profile],
      getActiveProfileId: () => 'current-profile',
      getActiveWorkDir: () => currentDir
    }
    const session = createSession(args.db, { name: 'feishu-workdir-switch-success', model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'current-profile' })
    const channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'feishu-workdir-switch-approved' }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir: currentDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, chatId: 'feishu-workdir-switch-success', imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'current-profile', workDir: currentDir, isSensitive: false })
    expect(tryClaimRemoteSession(session.id, args.requestId, 4)).toBe('ok')
    const executeSwitch = vi.spyOn(switchWorkDirExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-workdir-switch-success-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-switch-workdir-success', toolName: 'switch_work_dir', input: { profile_id: 'target-profile' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '已切换到目标工作目录。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_work_dir']),
        request: {
          messages: [{ role: 'user', content: '切换到目标工作目录' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已切换到目标工作目录。' })
      expect(providerCalls).toBe(2)
      expect(executeSwitch).toHaveBeenCalledOnce()
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('target-profile')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.some((event) => event.kind === 'approval-resolved' && event.payload.toolCallId === 'feishu-switch-workdir-success')).toBe(false)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-switch-workdir-success', result: { success: true, data: { profileId: 'target-profile', workDir: targetDir } }
      })
    } finally {
      releaseRemoteSession(session.id, args.requestId)
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(currentDir, { recursive: true, force: true })
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted switch_work_dir rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-workdir-${termination}-current-`))
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-workdir-${termination}-target-`))
    const profile = { id: 'target-profile', name: 'Target project', path: targetDir, aliases: ['target'] }
    const manager = {
      ...args.workDirManager,
      listProfiles: () => [profile],
      getActiveProfileId: () => 'current-profile',
      getActiveWorkDir: () => currentDir
    }
    const session = createSession(args.db, { name: `feishu-workdir-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'current-profile' })
    const channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: vi.fn() })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir: currentDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, chatId: `feishu-workdir-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'current-profile', workDir: currentDir, isSensitive: false })
    expect(tryClaimRemoteSession(session.id, requestId, 4)).toBe('ok')
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...values) => originalAdmission.markPermitConsumed(...values),
      beginDispatch: async (...values) => { reachedClaim(); await claimBarrier; return originalAdmission.beginDispatch(...values) },
      invalidate: (...values) => originalAdmission.invalidate(...values),
      settle: (...values) => originalAdmission.settle(...values)
    }
    const executeSwitch = vi.spyOn(switchWorkDirExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-workdir-${termination}-claim-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `feishu-workdir-${termination}`, toolName: 'switch_work_dir', input: { profile_id: 'target-profile' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '准入变化后未切换工作目录。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_work_dir']),
        request: {
          messages: [{ role: 'user', content: '切换工作目录' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const running = runImRemoteAgent(context)
      await atClaim
      expect(executeSwitch).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.feishu = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'switch_work_dir')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(running).rejects.toThrow(/cancelled/i)
      else await expect(running).resolves.toMatchObject({ ok: true, summary: '准入变化后未切换工作目录。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeSwitch).not.toHaveBeenCalled()
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('current-profile')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `feishu-workdir-${termination}`,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      runtime.chatCancels.clear(requestId)
      releaseRemoteSession(session.id, requestId)
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(currentDir, { recursive: true, force: true })
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted switch_work_dir preserves an unknown binding change after dispatch when %s arrives', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-workdir-postclaim-${termination}-current-`))
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-workdir-postclaim-${termination}-target-`))
    const profile = { id: 'target-profile', name: 'Target project', path: targetDir, aliases: ['target'] }
    const manager = {
      ...args.workDirManager,
      listProfiles: () => [profile],
      getActiveProfileId: () => 'current-profile',
      getActiveWorkDir: () => currentDir
    }
    const session = createSession(args.db, { name: `feishu-workdir-postclaim-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'current-profile' })
    const channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: vi.fn() })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir: currentDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, chatId: `feishu-workdir-postclaim-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'current-profile', workDir: currentDir, isSensitive: false })
    expect(tryClaimRemoteSession(session.id, requestId, 4)).toBe('ok')
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    let dispatchReached!: () => void
    let releaseDispatch!: () => void
    let dispatchSignal!: AbortSignal
    const atDispatch = new Promise<void>((resolve) => { dispatchReached = resolve })
    const dispatchBarrier = new Promise<void>((resolve) => { releaseDispatch = resolve })
    const originalExecuteSwitch = switchWorkDirExecutor.execute
    const executeSwitch = vi.spyOn(switchWorkDirExecutor, 'execute').mockImplementation(async (input, toolContext) => {
      const result = await originalExecuteSwitch.call(switchWorkDirExecutor, input, toolContext)
      dispatchSignal = toolContext.signal
      dispatchReached()
      await dispatchBarrier
      return result
    })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-workdir-${termination}-postclaim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: `feishu-workdir-postclaim-${termination}`, toolName: 'switch_work_dir', input: { profile_id: 'target-profile' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_work_dir']),
        request: {
          messages: [{ role: 'user', content: '切换工作目录' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const running = runImRemoteAgent(context)
      const runningResult = running.then((value) => ({ value }), (error: unknown) => ({ error }))
      await atDispatch
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('target-profile')
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.feishu = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'switch_work_dir')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      await vi.waitFor(() => expect(dispatchSignal.aborted).toBe(true))
      releaseDispatch()
      const result = await runningResult
      expect(result).toHaveProperty('error')
      expect(String((result as { error: unknown }).error)).toMatch(/failed after dispatch|unknown/i)
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
      expect(providerCalls).toBe(1)
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('target-profile')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-started')).toBe(true)
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      const sink = getSessionEventSink(currentDir, session.id, session.createdAt)
      const projected = await readSessionEvents(sink.eventsPath)
      expect(projected.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
      expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'interrupted' })
      await sink.close()
    } finally {
      releaseDispatch()
      runtime.chatCancels.clear(requestId)
      releaseRemoteSession(session.id, requestId)
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(currentDir, { recursive: true, force: true })
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted list_work_dirs returns configured profiles through the RegisteredTool', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-list-workdirs-'))
    const profiles = [
      { id: 'bound-profile', name: 'Bound project', path: workDir, isDefault: true },
      { id: 'other-profile', name: 'Other project', path: path.join(workDir, 'other'), aliases: ['other'] }
    ]
    const manager = {
      ...args.workDirManager,
      listProfiles: () => profiles,
      getActiveProfileId: () => 'bound-profile',
      getActiveWorkDir: () => workDir
    }
    const session = createSession(args.db, { name: 'feishu-list-workdirs', model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'bound-profile' })
    const context = { ...args, sessionId: session.id, workDir, workDirManager: manager }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'bound-profile', workDir, isSensitive: false })
    const executeList = vi.spyOn(listWorkDirsExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-list-workdirs-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-list-workdirs', toolName: 'list_work_dirs', input: {} } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '已列出工作目录。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['list_work_dirs']),
        request: {
          messages: [{ role: 'user', content: '列出工作目录' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'list_work_dirs', description: 'List work directories', inputSchema: { type: 'object', properties: {} } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已列出工作目录。' })
      expect(providerCalls).toBe(2)
      expect(executeList).toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-list-workdirs', result: {
          success: true,
          data: {
            currentBoundId: 'bound-profile', activeProfileId: 'bound-profile',
            directories: [
              { id: 'bound-profile', isBound: true, isActive: true },
              { id: 'other-profile', isBound: false, isActive: false }
            ]
          }
        }
      })
    } finally {
      executeList.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted skills.read returns the registered skill through the snapshot RegisteredTool', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseArgs()
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-skills-read-'))
    const userDataDir = path.join(workDir, 'user-data')
    const skillPath = path.join(workDir, '.space-skills', 'remote-skill', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.writeFile(skillPath, '---\nname: remote-skill\ndescription: Feishu remote skill fixture\n---\nFeishu skill body.\n')
    invalidateSkillsCache()
    const session = createSession(args.db, { name: 'feishu-skills-read', model: SUPPORTED_ANTHROPIC_MODEL })
    const context = {
      ...args, sessionId: session.id, workDir, userDataDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-skills-read', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-skills-read-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-skills-read', toolName: 'skills.read', input: { name: 'remote-skill' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '已读取技能说明。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['skills.read']),
        request: {
          messages: [{ role: 'user', content: '读取 remote-skill 的说明' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'skills.read', description: 'Read registered skill', inputSchema: {
            type: 'object', properties: { name: { type: 'string' }, max_chars: { type: 'integer' } }, required: ['name']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已读取技能说明。' })
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-skills-read', result: { success: true, data: { name: 'remote-skill', content: expect.stringContaining('Feishu skill body.') } }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'feishu-skills-read', result: { success: true, data: { name: 'remote-skill', content: expect.stringContaining('Feishu skill body.') } }
        })
      } finally { await sink.close() }
    } finally {
      invalidateSkillsCache()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted history.read preserves the existing unavailable result when Remote history facts are absent', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-history-read-unavailable-'))
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-history-read-unavailable', model: SUPPORTED_ANTHROPIC_MODEL })
    const sessionArgs = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'feishu-history-read-unavailable' }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-history-read-unavailable', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-history-read-unavailable-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-history-read-unavailable', toolName: 'history.read', input: { limit: 1 } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '当前远程会话没有可供回查的压缩历史。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['history.read']),
        request: {
          messages: [{ role: 'user', content: '查询压缩历史' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'history.read', description: 'Read compressed history', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runImRemoteAgent(sessionArgs)).resolves.toMatchObject({ ok: true, summary: '当前远程会话没有可供回查的压缩历史。' })
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-history-read-unavailable',
        result: { success: false, error: 'History is unavailable for this session' }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'feishu-history-read-unavailable',
          result: { success: false, error: 'History is unavailable for this session' }
        })
      } finally { await sink.close() }
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('用量统计的 llmServiceId 取实际解析出的 creds.serviceId，而非会话冻结配置（DIM3，评审 P1-2）', async () => {
    const db = makeDb()
    const session = createSession(db, { name: 'remote-usage-config' })
    const { prepareTurnAtomically } = await import('../database')
    prepareTurnAtomically(db, {
      user: { id: 'remote-usage-user', sessionId: session.id, role: 'user', content: 'usage', timestamp: 1, status: 'sent' },
      assistant: { id: 'remote-usage-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'turn-remote-1', requestId: '00000000-0000-4000-8000-000000000001', sessionId: session.id, assistantMessageId: 'remote-usage-assistant', state: 'prepared', startToken: 'remote-usage-token' }
    })
    let captured: { profile: { llmServiceId?: string }; trace: { turnId?: string } } = {} as never
    mockRunToolChatSession.mockImplementation(async (invocation: never) => {
      captured = invocation
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    // 会话配置指向 svc-stale，但 resolver 实际解析到 svc-1（远程 resolver 未带 serviceId，可能回落默认服务）
    await runImRemoteAgent({ ...baseArgs({ db, sessionId: session.id }), llmServiceId: 'svc-stale', turnId: 'turn-remote-1' })

    expect(captured.profile.llmServiceId).toBe('svc-1')
    expect(captured.trace.turnId).toBe('turn-remote-1')
    db.close()
  })

  it('falls back to getApiKey when credentials resolve with error', async () => {
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: '',
      baseUrl: undefined,
      getApiKey: async () => null,
      error: '当前无可用服务支持模型「x」'
    })
    let captured: { profile: { baseUrl?: string }; ports: { credentials: { resolveApiKey: () => Promise<string | null> } } } = {} as never
    mockRunToolChatSession.mockImplementation(async (invocation: never, ports: never) => {
      captured = { invocation, ports } as never
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs())

    expect(await captured.ports.credentials.resolveApiKey()).toBe('fallback-key')
    expect(captured.ports.credentials.networkTarget?.baseUrl).toBe('https://fallback.example.com')
  })

  it('blocks sensitive workdir and still stops progress session', async () => {
    mockResolveWorkDirForSession.mockReturnValue({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: true
    })
    const logSensitiveBlocked = vi.fn()
    const onFinally = vi.fn()

    const result = await runImRemoteAgent(baseArgs({ logSensitiveBlocked, onFinally }))

    expect(result).toEqual({
      summary: SENSITIVE_WORKDIR_ERROR,
      pendingConfirm: false,
      ok: false
    })
    expect(mockRunToolChatSession).not.toHaveBeenCalled()
    expect(logSensitiveBlocked).toHaveBeenCalledOnce()
    expect(mockStartRemoteProgressSession).toHaveBeenCalledOnce()
    expect(mockStopRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(mockClearRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(onFinally).toHaveBeenCalledOnce()
  })

  it('starts and stops progress session on success', async () => {
    const onFinally = vi.fn()
    const result = await runImRemoteAgent(baseArgs({ onFinally }))
    expect(result.ok).toBe(true)
    expect(mockStartRemoteProgressSession).toHaveBeenCalledOnce()
    expect(mockStopRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(mockClearRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(onFinally).toHaveBeenCalledOnce()
  })

  it('保留 tool loop 的 cancelled outcome 供上层 Runtime 映射 source-cancelled', async () => {
    mockRunToolChatSession.mockResolvedValue({ ok: false, error: '用户取消执行', cancelled: true })
    const result = await runImRemoteAgent(baseArgs())
    expect(result).toMatchObject({ ok: false, pendingConfirm: false, outcome: 'cancelled' })
  })

  it('rethrowAsError preserves Hosted terminal classification for the remote turn adapter', async () => {
    const terminalError = new HostedTurnFinalizedError(new Error('provider deadline exceeded'), 'timed-out')
    mockRunToolChatSession.mockRejectedValue(terminalError)

    await expect(runImRemoteAgent(baseArgs({ rethrowAsError: true }))).rejects.toBe(terminalError)
  })
})

describe('调用方契约特征化（P0：入参 → Core args 平移）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveWorkDirForSession.mockReturnValue({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: false
    })
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: 'svc-1',
      baseUrl: 'https://creds.example.com',
      getApiKey: async () => 'creds-key'
    })
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('remoteContext 与事件出口接线平移给 Core；emitFactEvent 透传、emitSessionEvent 为 no-op 出口', async () => {
    const emitFactEvent = vi.fn()
    let invocation: Record<string, any> = {}
    let ports: Record<string, any> = {}
    mockRunToolChatSession.mockImplementation(async (inv: Record<string, unknown>, prt: Record<string, unknown>) => {
      invocation = inv
      ports = prt
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs({ emitFactEvent }))

    // lane 推导基础：remoteContext 原样平移为 driverContext（Core 内据此推导 im lane）
    expect(invocation.driverContext).toMatchObject({ source: 'feishu', messageId: 'm1', confirmPolicy: 'always' })
    // 事件出口：fact 出口透传调用方实现；session 台账出口为显式 no-op（远程无窗口）
    expect(invocation.events.onFact).toBe(emitFactEvent)
    expect(invocation.events.onSessionEvent).toBeTypeOf('function')
    await invocation.events.onSessionEvent({ type: 'request_header' })
    // Core 输入：会话锚点与消息装载
    expect(invocation.session.sessionId).toBe('sess-1')
    expect(ports.legacy?.appDb).toBeTypeOf('object')
  })

  it('Feishu Hosted confirmation denial does not write the proposed file', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-write-denied-'))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-write-denied', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'reject', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'feishu-reject-1' }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'feishu-chat-1', imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-write-denied', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-write-denied-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-write-denied-1', toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'denied' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '写入已拒绝。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['write_file']),
        request: {
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '写入已拒绝。', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      await expect(fs.access(targetPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-write-denied-1', reason: expect.stringMatching(/CONFIRMATION|USER/)
      })
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId: 'feishu-write-denied-1' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'feishu-write-denied-1', approved: false, answerer: 'user', cause: 'user-denied' }) })
      ]))
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted rechecks a confirmed write against a target created while approval is pending', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-write-target-drift-'))
    const targetPath = path.join(workDir, 'approved-target.txt')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-write-target-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      void fs.writeFile(targetPath, 'created-during-approval').then(() => {
        channel.tryResolveFromInbound(
          { kind: 'approve', confirmId: pending.confirmId },
          { matchKey: pending.matchKey, messageId: 'feishu-target-drift-approved' }
        )
      })
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'feishu-target-drift', imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-target-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-target-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-write-target-drift', toolName: 'write_file', input: { path: 'approved-target.txt', content: 'must-not-overwrite' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '目标变化后已停止写入。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['write_file']),
        request: {
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeWrite = vi.spyOn(writeFileExecutor, 'execute')
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '目标变化后已停止写入。' })
      expect(providerCalls).toBe(2)
      expect(executeWrite).not.toHaveBeenCalled()
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('created-during-approval')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-write-target-drift', reason: 'FACTS_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeWrite.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted rechecks a confirmed sensitive read when the file identity changes during approval', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-read-identity-drift-'))
    const targetPath = path.join(workDir, '.env')
    await fs.writeFile(targetPath, 'SECRET=before')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-read-identity-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'feishu', timeoutMs: 1_000, sendPrompt: (pending) => {
      void (async () => {
        await fs.rename(targetPath, `${targetPath}.approved`)
        await fs.writeFile(targetPath, 'SECRET=after')
        channel.tryResolveFromInbound(
          { kind: 'approve', confirmId: pending.confirmId },
          { matchKey: pending.matchKey, messageId: 'feishu-read-identity-drift-approved' }
        )
      })()
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, chatId: 'feishu-read-identity-drift', imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-read-identity-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-read-identity-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-read-identity-drift', toolName: 'read_file', input: { path: '.env' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '确认期间文件身份发生变化，已停止读取。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: '读取环境配置' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeRead = vi.spyOn(readFileExecutor, 'execute')
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '确认期间文件身份发生变化，已停止读取。' })
      expect(providerCalls).toBe(2)
      expect(executeRead).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-read-identity-drift', reason: 'FACTS_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeRead.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('Feishu Hosted reads a registered attachment and projects the same result to History and session ledger', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-attachment-hosted-success-'))
    const userDataDir = path.join(workDir, 'user-data')
    const mediaDir = path.join(userDataDir, 'feishu-media', 'cache', 'm1')
    const attachmentPath = path.join(mediaDir, 'brief.txt')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(attachmentPath, 'Registered attachment body')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-attachment-hosted-success', model: SUPPORTED_ANTHROPIC_MODEL })
    const context = {
      ...args, sessionId: session.id, workDir, userDataDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: 'feishu-attachment-hosted-success',
        feishuAttachments: [{ id: 'attachment-1', messageId: 'm1', localPath: attachmentPath, fileName: 'brief.txt', mimeType: 'text/plain' }]
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-attachment-hosted-success', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-attachment-hosted-success-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-attachment-hosted-success', toolName: 'read_feishu_attachment', input: { attachmentId: 'attachment-1' } } as const
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '附件内容已读取。' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_feishu_attachment']),
        request: {
          messages: [{ role: 'user', content: '读取飞书附件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'read_feishu_attachment', description: 'Read a registered Feishu attachment', inputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeAttachment = vi.spyOn(readFeishuAttachmentExecutor, 'execute')
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '附件内容已读取。' })
      expect(providerCalls).toBe(2)
      expect(executeAttachment).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-attachment-hosted-success', success: true,
        result: { success: true, data: { content: 'Registered attachment body', fileName: 'brief.txt' } }
      })
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: 'feishu-attachment-hosted-success', name: 'read_feishu_attachment' })
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'feishu-attachment-hosted-success', result: { success: true, data: { content: 'Registered attachment body', fileName: 'brief.txt' } }
        })
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      executeAttachment.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted read_feishu_attachment rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-attachment-${termination}-claim-`))
    const userDataDir = path.join(workDir, 'user-data')
    const mediaDir = path.join(userDataDir, 'feishu-media', 'cache', 'm1')
    const attachmentPath = path.join(mediaDir, 'brief.txt')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(attachmentPath, 'registered attachment content')
    const args = baseArgs()
    const session = createSession(args.db, { name: `feishu-attachment-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir, userDataDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: `feishu-attachment-${termination}`,
        feishuAttachments: [{ id: 'attachment-1', messageId: 'm1', localPath: attachmentPath, fileName: 'brief.txt', mimeType: 'text/plain' }]
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `feishu-attachment-${termination}`, workDir, isSensitive: false })
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const chatSignal = runtime.chatCancels.register(requestId)
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...values) => originalAdmission.markPermitConsumed(...values),
      beginDispatch: async (...values) => { reachedClaim(); await claimBarrier; return originalAdmission.beginDispatch(...values) },
      invalidate: (...values) => originalAdmission.invalidate(...values),
      settle: (...values) => originalAdmission.settle(...values)
    }
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-attachment-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `attachment-${termination}`, toolName: 'read_feishu_attachment', input: { attachmentId: 'attachment-1' } } as const
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '附件读取已被安全拦截。' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_feishu_attachment']),
        request: {
          messages: [{ role: 'user', content: '读取飞书附件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: chatSignal,
          tools: [{ name: 'read_feishu_attachment', description: 'Read a registered Feishu attachment', inputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeAttachment = vi.spyOn(readFeishuAttachmentExecutor, 'execute')
    try {
      const runningAgent = runImRemoteAgent(context)
      await atClaim
      expect(executeAttachment).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const packages = readPolicyPackages(args.db)
        packages.feishu = 'strict'
        writePolicyPackages(args.db, packages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'read_feishu_attachment')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(runningAgent).rejects.toThrow(/cancel/i)
      else await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: '附件读取已被安全拦截。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeAttachment).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `attachment-${termination}`,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      executeAttachment.mockRestore()
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted read_feishu_attachment keeps a post-claim %s result unprojected', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-attachment-${termination}-postclaim-`))
    const userDataDir = path.join(workDir, 'user-data')
    const mediaDir = path.join(userDataDir, 'feishu-media', 'cache', 'm1')
    const attachmentPath = path.join(mediaDir, 'brief.txt')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(attachmentPath, 'registered attachment content')
    const args = baseArgs()
    const session = createSession(args.db, { name: `feishu-attachment-${termination}-postclaim`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir, userDataDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: `feishu-attachment-${termination}-postclaim`,
        feishuAttachments: [{ id: 'attachment-1', messageId: 'm1', localPath: attachmentPath, fileName: 'brief.txt', mimeType: 'text/plain' }]
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `feishu-attachment-${termination}-postclaim`, workDir, isSensitive: false })
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const chatSignal = runtime.chatCancels.register(requestId)
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-attachment-${termination}-postclaim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: `attachment-${termination}-postclaim`, toolName: 'read_feishu_attachment', input: { attachmentId: 'attachment-1' } } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_feishu_attachment']),
        request: {
          messages: [{ role: 'user', content: '读取飞书附件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: chatSignal,
          tools: [{ name: 'read_feishu_attachment', description: 'Read a registered Feishu attachment', inputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const originalExecute = readFeishuAttachmentExecutor.execute
    let markRead!: () => void
    let releaseRead!: () => void
    const readEntered = new Promise<void>((resolve) => { markRead = resolve })
    const heldResult = new Promise<void>((resolve) => { releaseRead = resolve })
    let observedSignal: AbortSignal | undefined
    const executeAttachment = vi.spyOn(readFeishuAttachmentExecutor, 'execute').mockImplementation(async (input, executionContext) => {
      const result = await originalExecute(input, executionContext)
      observedSignal = (executionContext as { signal?: AbortSignal }).signal
      markRead()
      await heldResult
      return result
    })
    try {
      const runningAgent = runImRemoteAgent(context)
      await readEntered
      expect(executeAttachment).toHaveBeenCalledOnce()
      expect(observedSignal?.aborted).toBe(false)
      if (termination === 'authorization-change') {
        const packages = readPolicyPackages(args.db)
        packages.feishu = 'strict'
        writePolicyPackages(args.db, packages)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'read_feishu_attachment')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      expect(observedSignal?.aborted).toBe(true)
      releaseRead()
      await expect(runningAgent).rejects.toThrow(/cancel|uncertain|after dispatch|interrupted/i)
      expect(providerCalls).toBe(1)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: `attachment-${termination}-postclaim` })
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted' } })
      expect(JSON.stringify(history.events)).not.toContain('registered attachment content')
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: `attachment-${termination}-postclaim`, name: 'read_feishu_attachment' })
        expect(events.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'interrupted' })
      } finally { await sink.close() }
    } finally {
      releaseRead()
      executeAttachment.mockRestore()
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('Feishu Hosted refuses to read a replaced cached attachment before returning its bytes', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-attachment-identity-drift-'))
    const userDataDir = path.join(workDir, 'user-data')
    const mediaDir = path.join(userDataDir, 'feishu-media', 'cache', 'm1')
    const attachmentPath = path.join(mediaDir, 'brief.txt')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(attachmentPath, 'approved attachment content')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-attachment-identity-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    const context = {
      ...args, sessionId: session.id, workDir, userDataDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: 'feishu-attachment-identity-drift',
        feishuAttachments: [{ id: 'attachment-1', messageId: 'm1', localPath: attachmentPath, fileName: 'brief.txt', mimeType: 'text/plain' }]
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-attachment-identity-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-attachment-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-attachment-identity-drift', toolName: 'read_feishu_attachment', input: { attachmentId: 'attachment-1' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '附件缓存身份发生变化，已停止读取。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const callback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await callback({
        authorizedToolNames: new Set(['read_feishu_attachment']),
        request: {
          messages: [{ role: 'user', content: '读取飞书附件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'read_feishu_attachment', description: 'Read a registered Feishu attachment', inputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const originalExecuteAttachment = readFeishuAttachmentExecutor.execute
    const executeAttachment = vi.spyOn(readFeishuAttachmentExecutor, 'execute').mockImplementation(async (input, executionContext) => {
      await fs.rename(attachmentPath, `${attachmentPath}.approved`)
      await fs.writeFile(attachmentPath, 'replacement attachment content')
      return originalExecuteAttachment(input, executionContext)
    })
    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '附件缓存身份发生变化，已停止读取。' })
      expect(providerCalls).toBe(2)
      expect(executeAttachment).toHaveBeenCalledOnce()
      await expect(fs.readFile(attachmentPath, 'utf8')).resolves.toBe('replacement attachment content')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'feishu-attachment-identity-drift', success: false,
        result: { success: false, diagnostic: { caseId: 'read-target-identity-changed' } }
      })
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'feishu-attachment-identity-drift' })
      expect(JSON.stringify(history.events)).not.toContain('replacement attachment content')
    } finally {
      executeAttachment.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['feishu', 'wechat'] as const)('%s Hosted rejects a browser call when remote authorization changes during confirmation', async (lane) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-browser-config-drift-'))
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-browser-config-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }
    const context = {
      ...args,
      sessionId: session.id,
      workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getBrowserConfig: () => browserConfig
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-browser-config-drift', workDir, isSensitive: false })
    let prompted!: () => void
    const didPrompt = new Promise<void>((resolve) => { prompted = resolve })
    let channel!: ImChannel
    channel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: (pending) => {
      browserConfig = { ...browserConfig, allowRemoteSessions: false }
      prompted()
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'feishu-browser-config-drift-approved' }
      ))
    } })
    context.remoteContext.imChannel = channel
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-browser-config-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'feishu-browser-config-drift', toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '浏览器授权已变化，操作未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['browser']),
        request: {
          messages: [{ role: 'user', content: '提交当前网页表单' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'browser', description: 'Browser action', inputSchema: { type: 'object', properties: { action: { type: 'string' }, instruction: { type: 'string' } }, required: ['action', 'instruction'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeBrowser = vi.spyOn(browserExecutor, 'execute')
    try {
      await expect(runImRemoteAgent({ ...context, remoteContext: { ...context.remoteContext, source: lane, chatId: `${lane}-browser-config-drift`, imChannel: channel } }))
        .resolves.toMatchObject({ ok: true, summary: '浏览器授权已变化，操作未执行。', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      expect(executeBrowser).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'feishu-browser-config-drift', reason: 'BROWSER_PREPARED_POLICY_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      executeBrowser.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted switch_session rejects %s before renderer dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-switch-session-${termination}-claim-`))
    const args = baseArgs()
    const callerSession = createSession(args.db, { name: `switch-caller-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    const targetSession = createSession(args.db, {
      name: `switch-target-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'feishu', feishuChatId: `switch-chat-${termination}` }
    })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: callerSession.id, requestId, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: `switch-chat-${termination}`, originSessionId: callerSession.id
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `switch-session-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)
    const originalAdmission = runtime.executionAdmission
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    runtime.executionAdmission = {
      markPermitConsumed: (...values) => originalAdmission.markPermitConsumed(...values),
      beginDispatch: async (...values) => { reachedClaim(); await claimBarrier; return originalAdmission.beginDispatch(...values) },
      invalidate: (...values) => originalAdmission.invalidate(...values),
      settle: (...values) => originalAdmission.settle(...values)
    }
    const executeSwitch = vi.spyOn(switchSessionExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu switch_session invocation route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-switch-session-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `switch-session-${termination}`, toolName: 'switch_session', input: { session_id: targetSession.id } } as const
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '会话切换在执行前被安全拦截。' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_session']),
        request: {
          messages: [{ role: 'user', content: '切换到另一个飞书会话' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_session', description: 'Switch active Feishu session', inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runImRemoteAgent(context)
      const observedAgent = runningAgent.then((value) => ({ value }), (error: unknown) => ({ error }))
      await atClaim
      expect(executeSwitch).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.feishu = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'switch_session')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      const outcome = await observedAgent
      if (termination === 'cancel') expect(outcome).toHaveProperty('error')
      else expect(outcome).toMatchObject({ value: { ok: true, summary: '会话切换在执行前被安全拦截。' } })
      expect(executeSwitch).not.toHaveBeenCalled()
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `switch-session-${termination}`,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: termination === 'cancel' ? 'invocation-interrupted' : 'invocation-completed',
        payload: { status: termination === 'cancel' ? 'cancelled' : 'completed' }
      })
    } finally {
      releaseClaim()
      executeSwitch.mockRestore()
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('Feishu Hosted switch_session projects an acknowledged session change to History and session ledger', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-switch-session-hosted-success-'))
    const args = baseArgs()
    const callerSession = createSession(args.db, {
      name: 'switch-caller-success', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'feishu', feishuChatId: 'switch-success-chat' }
    })
    const targetSession = createSession(args.db, {
      name: 'switch-target-success', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'feishu', feishuChatId: 'switch-success-chat' }
    })
    const context = {
      ...args, sessionId: callerSession.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: 'switch-success-chat', originSessionId: callerSession.id,
        outboundSessionId: callerSession.id
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'switch-session-success', workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    mockRequestRendererSessionSwitch.mockResolvedValue({ desktopSwitched: true, viewChanged: true })

    const toolCallId = 'feishu-switch-session-hosted-success'
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu switch_session invocation route')
      runtime.modelProviders.register(route.profile, { providerId: 'feishu-switch-session-hosted-success-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'switch_session', input: { session_id: targetSession.id } } as const
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '已切换到目标会话。' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_session']),
        request: {
          messages: [{ role: 'user', content: '切换到另一个飞书会话' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          tools: [{ name: 'switch_session', description: 'Switch active Feishu session', inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeSwitch = vi.spyOn(switchSessionExecutor, 'execute')

    try {
      await expect(runImRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已切换到目标会话。' })
      expect(providerCalls).toBe(2)
      expect(executeSwitch).toHaveBeenCalledOnce()
      expect(mockRequestRendererSessionSwitch).toHaveBeenCalledOnce()
      expect(context.remoteContext.outboundSessionId).toBe(targetSession.id)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId, success: true,
        result: { success: true, data: { sessionId: targetSession.id, desktopSwitched: true, viewChanged: true } }
      })
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      const sink = getSessionEventSink(workDir, callerSession.id, callerSession.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: toolCallId, name: 'switch_session' })
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: toolCallId, result: { success: true, data: { sessionId: targetSession.id, desktopSwitched: true, viewChanged: true } }
        })
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      executeSwitch.mockRestore()
      mockRequestRendererSessionSwitch.mockReset().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('Feishu Hosted switch_session preserves unknown outcome after renderer request when %s arrives', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `feishu-switch-session-${termination}-postclaim-`))
    const args = baseArgs()
    const callerSession = createSession(args.db, { name: `switch-caller-${termination}-postclaim`, model: SUPPORTED_ANTHROPIC_MODEL })
    const targetSession = createSession(args.db, {
      name: `switch-target-${termination}-postclaim`, model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'feishu', feishuChatId: `switch-postclaim-chat-${termination}` }
    })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: callerSession.id, requestId, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, chatId: `switch-postclaim-chat-${termination}`, originSessionId: callerSession.id,
        outboundSessionId: callerSession.id
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `switch-session-${termination}-postclaim`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.feishu = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'feishu', requestId)

    let markRendererRequested!: () => void
    let rejectRenderer!: (error: Error) => void
    const rendererRequested = new Promise<void>((resolve) => { markRendererRequested = resolve })
    mockRequestRendererSessionSwitch.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectRenderer = reject
      markRendererRequested()
    }))
    let executorSignal: AbortSignal | undefined
    const originalExecute = switchSessionExecutor.execute
    const executeSwitch = vi.spyOn(switchSessionExecutor, 'execute').mockImplementation(async (input, executionContext) => {
      executorSignal = executionContext.signal
      return originalExecute(input, executionContext)
    })
    const toolCallId = `switch-session-${termination}-postclaim`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu switch_session invocation route')
      runtime.modelProviders.register(route.profile, { providerId: `feishu-switch-session-${termination}-postclaim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'switch_session', input: { session_id: targetSession.id } } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_session']),
        request: {
          messages: [{ role: 'user', content: '切换到另一个飞书会话' }], maxTokens: 64, credentials: { apiKey: 'creds-key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_session', description: 'Switch active Feishu session', inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runImRemoteAgent(context)
      const observedAgent = runningAgent.then((value) => ({ value }), (error: unknown) => ({ error }))
      await rendererRequested
      expect(executeSwitch).toHaveBeenCalledOnce()
      expect(executorSignal?.aborted).toBe(false)
      expect(context.remoteContext.outboundSessionId).toBe(callerSession.id)
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.feishu = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('feishu')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('feishu', 'switch_session')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      expect(executorSignal?.aborted).toBe(true)
      rejectRenderer(new Error('renderer acknowledgement lost after dispatch request'))
      const outcome = await observedAgent
      expect(outcome).toHaveProperty('error')
      expect(providerCalls).toBe(1)
      expect(context.remoteContext.outboundSessionId).toBe(callerSession.id)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId })
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({
        kind: 'invocation-interrupted', payload: { status: 'interrupted', sessionLedger: { reason: 'interrupted' } }
      })
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
      const sink = getSessionEventSink(workDir, callerSession.id, callerSession.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: toolCallId, name: 'switch_session' })
        expect(projected.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId && !('diagnosticType' in event.payload))).toBe(false)
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: requestId, reason: 'interrupted' })
      } finally { await sink.close() }
    } finally {
      rejectRenderer?.(new Error('test cleanup'))
      executeSwitch.mockRestore()
      mockRequestRendererSessionSwitch.mockReset().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['feishu', 'wechat'] as const)('%s Hosted request cancellation while awaiting confirmation never dispatches the write', async (lane) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-hosted-write-cancelled-'))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    const args = baseArgs()
    const session = createSession(args.db, { name: 'feishu-hosted-write-cancelled', model: SUPPORTED_ANTHROPIC_MODEL })
    const toolCallId = `${lane}-write-cancelled-1`
    const controller = new AbortController()
    let announcePrompt!: () => void
    const prompted = new Promise<void>((resolve) => { announcePrompt = resolve })
    const channel = new ImChannel({ lane, timeoutMs: 1_000, sendPrompt: () => announcePrompt() })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, source: lane, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'feishu-write-cancelled', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected Feishu invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-feishu-write-cancelled-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'cancelled' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['write_file']),
        request: {
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'creds-key' }, signal: controller.signal,
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const invocation = runImRemoteAgent(context)
      await prompted
      controller.abort()
      await expect(invocation).rejects.toThrow(/agent turn cancelled/i)
      expect(providerCalls).toBe(1)
      await expect(fs.access(targetPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId, answerer: 'user' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId, approved: false, outcome: 'cancelled', cause: 'cancelled' }) }),
        expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId, reason: 'REQUEST_CANCELLED' }) }),
        expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
      ]))
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'cancelled' })
      } finally { await sink.close() }
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})
