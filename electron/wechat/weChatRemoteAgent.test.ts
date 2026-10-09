import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { AppDatabase, appendMessage, createPersistedTurn, getConfigValue, openDatabase, setConfigValue, updateMessageContent } from '../database'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { createDesktopAgentRuntime } from '../runtime/desktopAgentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSession, getDbConnection, getSession } from '../database'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext, readAcceptedTurn } from '../database/acceptedTurnStorage'
import { listPersistedTurns } from '../database/operations'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { ensureFinalRequestContextEvent, ensureRequestProjectionEvents, ensureRequestUsageEvent, ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, getSessionEventSink, readSessionEvents, SessionEventWriter } from '../sessionEvents'
import { ImChannel } from '../confirmation/imChannel'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { readFileExecutor } from '../tools/builtinExecutors'
import { writeFileExecutor } from '../tools/builtinExecutors'
import { browserExecutor } from '../tools/browserExecutor'
import { readPolicyPackages, writePolicyPackages } from '../confirmation/policyRulesRuntime'
import { wechatReplyExecutor } from '../tools/wechatExecutors'
import { WeChatOutboundExecutionUncertainError } from '../tools/weChatToolExecutor'
import { switchWorkDirExecutor } from '../tools/workDirExecutors'
import { runScriptExecutor } from '../tools/builtinExecutors'
import { tryClaimRemoteSession, releaseRemoteSession } from '../remote/remoteAgentRegistry'
import { switchSessionExecutor } from '../tools/remoteSessionExecutors'
import { invalidateSkillsCache } from '../skills/skillCache'

const mockGetWeChatBundle = vi.hoisted(() => vi.fn())
const hostedRuntimeFailureInjection = vi.hoisted(() => ({ requestId: '', composeCalls: 0 }))
const mockRequestRendererSessionSwitch = vi.hoisted(() => vi.fn())
const mockResolveLlmCredentialsForPair = vi.fn()
const acceptedTurnFixtures = new Map<string, { db: AppDatabase; acceptedTurn: import('../../src/shared/acceptedTurn').AcceptedTurn }>()
vi.mock('./weChatIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./weChatIpc')>()
  return { ...actual, getWeChatBundle: (...args: unknown[]) => mockGetWeChatBundle(...args) }
})

vi.mock('../runtime/invocationAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/invocationAssembler')>()
  return {
    ...actual,
    assembleInvocation: (...args: Parameters<typeof actual.assembleInvocation>) => {
      const assembled = actual.assembleInvocation(...args)
      if (args[0].requestId === hostedRuntimeFailureInjection.requestId) {
        assembled.agentSdk.createHostedTurnRuntime = () => {
          hostedRuntimeFailureInjection.composeCalls += 1
          throw new Error('WeChat complete-gate Runtime unavailable')
        }
      }
      return assembled
    }
  }
})

const mockResolveWorkDirForSession = vi.fn(() => ({ profileId: 'p1', workDir: '/tmp', isSensitive: false }))

const SUPPORTED_ANTHROPIC_MODEL = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]

const mockRunToolChatSession = vi.fn()
const mockGetMessages = vi.fn(() => [])
const mockResolveLlmCredentialsForModel = vi.fn()

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => {
    const [invocation, ports, options] = args as [
      { acceptedTurn?: import('../../src/shared/acceptedTurn').AcceptedTurn; messages?: { currentUserMessageId?: string }; trace?: { requestId?: string } },
      unknown,
      { onHostedTurnHandoff?: (input: Record<string, unknown>) => unknown }
    ]
    const originalHandoff = options?.onHostedTurnHandoff
    const wrappedOptions = originalHandoff ? {
      ...options,
      onHostedTurnHandoff: (input: Record<string, unknown>) => {
        const accepted = invocation.acceptedTurn
        const fixture = invocation.trace?.requestId ? acceptedTurnFixtures.get(invocation.trace.requestId) : undefined
        const request = input.request as { messages?: Array<{ role?: string; content?: unknown }> } | undefined
        const lastUser = [...(request?.messages ?? [])].reverse().find((message) => message.role === 'user')
        const currentUserMessageId = input.currentUserMessageId ?? accepted?.currentUserMessageId ?? invocation.messages?.currentUserMessageId
        let requiredUserMessage = input.requiredUserMessage as { id?: string; message?: { role?: string; content?: unknown } } | undefined
        if (!requiredUserMessage && currentUserMessageId && lastUser && fixture) {
          const content = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)
          updateMessageContent(fixture.db, currentUserMessageId, { content })
          requiredUserMessage = { id: currentUserMessageId, message: { role: 'user', content } }
        }
        return originalHandoff({ ...input, ...(currentUserMessageId ? { currentUserMessageId } : {}), ...(requiredUserMessage ? { requiredUserMessage } : {}) })
      }
    } : options
    return mockRunToolChatSession(invocation, ports, wrappedOptions)
  }
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

vi.mock('../llmServiceResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('../llmServiceResolver')>(),
  resolveLlmCredentialsForModel: (...args: unknown[]) => mockResolveLlmCredentialsForModel(...args),
  resolveLlmCredentialsForPair: (...args: unknown[]) => mockResolveLlmCredentialsForPair(...args),
  readActiveLlmServiceId: () => undefined
}))

vi.mock('../remote/remoteProgressCoordinator', () => ({
  startRemoteProgressSession: vi.fn(),
  stopRemoteProgressSession: vi.fn()
}))

vi.mock('../remote/remoteProgressStore', () => ({
  clearRemoteProgressSession: vi.fn()
}))

vi.mock('../windowRef', () => ({
  getMainWindow: () => ({ webContents: { id: 1, isDestroyed: () => false } })
}))

vi.mock('../remote/requestRendererSessionSwitch', () => ({
  requestRendererSessionSwitch: (...args: unknown[]) => mockRequestRendererSessionSwitch(...args)
}))

vi.mock('../workDirManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workDirManager')>()
  return {
    ...actual,
    resolveWorkDirForSession: (...args: unknown[]) => mockResolveWorkDirForSession(...args as [])
  }
})

import { runWeChatRemoteAgent as runWeChatRemoteAgentImpl } from './weChatRemoteAgent'

function makeDb(): AppDatabase {
  const db = openDatabase(':memory:')
  setConfigValue(db, 'config.locale', 'en-US')
  return db
}

function makeWorkDirManager() {
  return {
    listProfiles: () => [],
    getActiveProfileId: () => 'p1',
    getActiveWorkDir: () => '/tmp',
    checkDirectoryWritable: () => ({ ok: true })
  }
}

function baseCtx(getMainWebContents: () => WebContents | null, db: AppDatabase = makeDb()) {
  return {
    db,
    sessionStorage: createSqliteSessionStorage(db),
    sessionId: 'sess-1',
    userMessage: 'hello',
    replyMessageId: 'msg-1',
    requestId: '00000000-0000-4000-8000-000000000001',
    wechatConfig: { ...DEFAULT_WECHAT_CONFIG, remoteTypingEnabled: false, remoteProgressHeartbeatSec: 0 },
    workDir: '/tmp',
    workDirManager: makeWorkDirManager(),
    // Keep test user data disjoint from OS temp workspaces (which are /tmp on Linux).
    userDataDir: path.join(os.tmpdir(), 'spaceassistant-wechat-test-user-data'),
    getMainWebContents,
    getApiKey: async () => 'key',
    getBaseUrl: () => 'https://api.example.com',
    getModel: () => SUPPORTED_ANTHROPIC_MODEL,
    botService: { getBot: () => null } as never,
    imChannel: {} as never,
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
    remoteContext: {
      source: 'wechat' as const,
      messageId: 'msg-1',
      userId: 'wx-user@test',
      contextToken: 'ctx'
    },
    inboundRaw: makeIncomingMessage(),
    userId: 'wx-user@test'
  }
}

async function runWeChatRemoteAgent(ctx: Parameters<typeof runWeChatRemoteAgentImpl>[0]) {
  if (ctx.acceptedTurn) {
    acceptedTurnFixtures.set(ctx.requestId, { db: ctx.db, acceptedTurn: ctx.acceptedTurn })
    return runWeChatRemoteAgentImpl(ctx).finally(() => { acceptedTurnFixtures.delete(ctx.requestId) })
  }
  const session = ctx.sessionStorage.queries.readSession(ctx.sessionId)
  const model = session?.model ?? (ctx as typeof ctx & { getModel?: () => string }).getModel?.() ?? SUPPORTED_ANTHROPIC_MODEL
  const models = JSON.parse(getConfigValue(ctx.db, 'config.models') ?? '[]') as Array<Record<string, unknown>>
  if (!models.some((entry) => entry.name === model)) {
    models.push({ id: `wechat-test-${ctx.requestId}`, name: model, enabled: true, isVision: false, supportsThinking: true })
    setConfigValue(ctx.db, 'config.models', JSON.stringify(models))
  }
  const existing = session
    ? listPersistedTurns(ctx.db).find((turn) => turn.requestId === ctx.requestId && turn.sessionId === ctx.sessionId)
    : undefined
  const storedAccepted = session ? readAcceptedTurn(ctx.db, ctx.sessionId, ctx.requestId) : undefined
  if (storedAccepted) {
    acceptedTurnFixtures.set(ctx.requestId, { db: ctx.db, acceptedTurn: storedAccepted })
    return runWeChatRemoteAgentImpl({ ...ctx, turnId: storedAccepted.turnId, acceptedTurn: storedAccepted }).finally(() => { acceptedTurnFixtures.delete(ctx.requestId) })
  }
  const turnId = existing?.turnId ?? ctx.turnId ?? ctx.requestId
  const startToken = existing?.startToken ?? `wechat-test-start-${turnId}`
  let userMessageId = existing?.userMessageId
  if (session && !existing) {
    const latestUser = getDbConnection(ctx.db).prepare("SELECT id FROM messages WHERE session_id=? AND role='user' ORDER BY sequence DESC LIMIT 1").get(ctx.sessionId) as { id: string } | undefined
    userMessageId = latestUser?.id ?? `wechat-test-user-${turnId}`
    if (!latestUser) appendMessage(ctx.db, { id: userMessageId, sessionId: ctx.sessionId, role: 'user', content: ctx.userMessage, timestamp: Date.now(), status: 'sent' })
    const assistantMessageId = `wechat-test-assistant-${turnId}`
    appendMessage(ctx.db, { id: assistantMessageId, sessionId: ctx.sessionId, role: 'assistant', content: '', timestamp: Date.now() + 1, status: 'streaming' })
    createPersistedTurn(ctx.db, { turnId, requestId: ctx.requestId, sessionId: ctx.sessionId, userMessageId, assistantMessageId, state: 'prepared', startToken })
  }
  const acceptedTurn = createAcceptedTurn({
    turnId, requestId: ctx.requestId, sessionId: ctx.sessionId, lane: 'wechat', startToken,
    currentUserMessageId: userMessageId ?? `wechat-test-user-${turnId}`, transcriptVersion: 0,
    config: { lane: 'wechat', model, llmServiceId: 'svc-1', thinkingEffort: 'low' }
  })
  if (session) acceptTurnContext(ctx.db, acceptedTurn)
  acceptedTurnFixtures.set(ctx.requestId, { db: ctx.db, acceptedTurn })
  return runWeChatRemoteAgentImpl({ ...ctx, ...(session ? { turnId } : {}), acceptedTurn }).finally(() => { acceptedTurnFixtures.delete(ctx.requestId) })
}

describe('runWeChatRemoteAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequestRendererSessionSwitch.mockReset().mockResolvedValue({ desktopSwitched: true, viewChanged: true })
    hostedRuntimeFailureInjection.requestId = ''
    hostedRuntimeFailureInjection.composeCalls = 0
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'p1', workDir: '/tmp', isSensitive: false })
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: 'svc-1',
      baseUrl: 'https://api.example.com',
      getApiKey: async () => 'key'
    })
    mockResolveLlmCredentialsForPair.mockImplementation(async (db: AppDatabase, modelId: string, serviceId: string) => {
      const models = JSON.parse(getConfigValue(db, 'config.models') ?? '[]') as Array<Record<string, unknown>>
      const model = models.find((entry) => entry.id === modelId)
      return model
        ? { model, serviceId, providerModelName: model.name, baseUrl: 'https://api.example.com', getApiKey: async () => 'key' }
        : { error: 'frozen model missing' }
    })
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('invokes runToolChatSession with wechat appendix', async () => {
    let capturedSystem: string | undefined
    mockRunToolChatSession.mockImplementation(async (invocation: { profile: { system?: string } }) => {
      capturedSystem = invocation.profile.system
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    const sender = { send: vi.fn() } as unknown as WebContents
    const result = await runWeChatRemoteAgent(baseCtx(() => sender))

    expect(mockRunToolChatSession).toHaveBeenCalledTimes(1)
    expect(capturedSystem).toContain('wechat_remote_command')
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('ok')
  })

  it('Hosted wechat_reply rejects router inbound drift at dispatch claim before bot.reply', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-reply-inbound-drift-'))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-reply-inbound-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let currentInbound: { userId: string; timestamp: Date; raw: { client_id: string } } = {
      userId: 'wx-user@test', timestamp: new Date(1_000), raw: { client_id: 'msg-1' }
    }
    const reply = vi.fn()
    const originalAdmission = runtime.executionAdmission
    runtime.executionAdmission = {
      markPermitConsumed: (...call) => originalAdmission.markPermitConsumed(...call),
      beginDispatch: async (...call) => {
        currentInbound = { ...currentInbound, raw: { client_id: 'msg-2-arrived-before-dispatch' } }
        return originalAdmission.beginDispatch(...call)
      },
      invalidate: (...call) => originalAdmission.invalidate(...call),
      settle: (...call) => originalAdmission.settle(...call)
    }
    const context = {
      ...args,
      sessionId: session.id,
      workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      botService: { getBot: () => null, getRawBot: () => ({ reply }) } as never,
      remoteContext: { ...args.remoteContext, messageId: 'msg-1' }
    }
    const bundle = {
      botService: { getRawBot: () => ({ reply }) },
      auditLogger: { append: vi.fn() },
      router: { getInboundForSession: () => currentInbound }
    }
    mockGetWeChatBundle.mockReturnValue(bundle)
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat reply invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-reply-inbound-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-reply-inbound-drift', toolName: 'wechat_reply', input: { text: 'reply to msg-1' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '入站消息已变化，没有发送回复。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['wechat_reply']),
        request: {
          messages: [{ role: 'user', content: 'reply to this message' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'wechat_reply', description: 'Reply to current WeChat inbound', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeReply = vi.spyOn(wechatReplyExecutor, 'execute')
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '入站消息已变化，没有发送回复。' })
      expect(providerCalls).toBe(2)
      expect(executeReply).toHaveBeenCalledOnce()
      expect(reply).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(context.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'wechat-reply-inbound-drift', success: false,
        result: { success: false, error: '微信入站消息已变化，请重新授权回复' }
      })
      expect(JSON.stringify(history.events)).not.toContain('msg-2-arrived-before-dispatch')
    } finally {
      executeReply.mockRestore()
      mockGetWeChatBundle.mockReset()
      runtime.executionAdmission = originalAdmission
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted wechat_reply rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-reply-${termination}-before-claim-`))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: `wechat-reply-${termination}-before-claim`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `wechat-reply-${termination}-approved` }
      ))
    } })
    const reply = vi.fn()
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      botService: { getBot: () => null, getRawBot: () => ({ reply }) } as never,
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `wechat-reply-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)

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
    const executeReply = vi.spyOn(wechatReplyExecutor, 'execute')
    const toolCallId = `wechat-reply-${termination}`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat reply invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-reply-${termination}-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'wechat_reply', input: { text: 'reply to msg-1' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '回复授权已变化，未发送消息。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['wechat_reply']),
        request: {
          messages: [{ role: 'user', content: '回复当前微信消息' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'wechat_reply', description: 'Reply to the current WeChat inbound', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runWeChatRemoteAgent(context)
      await atClaim
      expect(executeReply).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'wechat_reply')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(runningAgent).rejects.toThrow(/cancelled/i)
      else await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: '回复授权已变化，未发送消息。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeReply).not.toHaveBeenCalled()
      expect(reply).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
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
      executeReply.mockRestore()
      runtime.chatCancels.clear(requestId)
      runtime.executionAdmission = originalAdmission
      mockGetWeChatBundle.mockReset()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('WeChat Hosted wechat_reply sends to the current inbound and persists matching History/session result', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-reply-hosted-success-'))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-reply-hosted-success', model: SUPPORTED_ANTHROPIC_MODEL })
    const inbound = { userId: 'wx-user@test', timestamp: new Date(1_000), raw: { client_id: 'msg-1' } }
    const reply = vi.fn(async () => undefined)
    const bundle = {
      botService: { getRawBot: () => ({ reply }) },
      auditLogger: { append: vi.fn() },
      router: { getInboundForSession: () => inbound }
    }
    mockGetWeChatBundle.mockReturnValue(bundle)
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      botService: { getBot: () => null, getRawBot: () => ({ reply }) } as never,
      remoteContext: { ...args.remoteContext, messageId: 'msg-1', originSessionId: session.id }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-reply-hosted-success', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat reply invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-reply-hosted-success-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-reply-hosted-success', toolName: 'wechat_reply', input: { text: 'Approved reply text' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '微信回复已发送。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['wechat_reply']),
        request: {
          messages: [{ role: 'user', content: '回复当前消息' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'wechat_reply', description: 'Reply to the current WeChat inbound', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '微信回复已发送。' })
      expect(providerCalls).toBe(2)
      expect(reply).toHaveBeenCalledOnce()
      expect(reply).toHaveBeenCalledWith(inbound, 'Approved reply text\n\n完整过程请查看 SpaceAssistant 桌面会话')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'wechat-reply-hosted-success' })
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({ toolCallId: 'wechat-reply-hosted-success', success: true })
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const projected = await readSessionEvents(sink.eventsPath)
        expect(projected.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: 'wechat-reply-hosted-success', name: 'wechat_reply' })
        expect(projected.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'wechat-reply-hosted-success', result: { success: true }
        })
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      mockGetWeChatBundle.mockReset()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted wechat_reply preserves unknown outcome after dispatch when %s arrives', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-reply-${termination}-post-claim-`))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: `wechat-reply-${termination}-post-claim`, model: SUPPORTED_ANTHROPIC_MODEL })
    const requestId = args.requestId
    let finishBotReply!: () => void
    let botReplyEntered!: () => void
    const atBotReply = new Promise<void>((resolve) => { botReplyEntered = resolve })
    const reply = vi.fn(async () => {
      botReplyEntered()
      await new Promise<void>((resolve) => { finishBotReply = resolve })
      return { success: true }
    })
    const bundle = {
      botService: { getRawBot: () => ({ reply }) },
      auditLogger: { append: vi.fn() },
      router: { getInboundForSession: () => ({ userId: 'wx-user@test', timestamp: new Date(1_000), raw: { client_id: 'msg-1' } }) }
    }
    mockGetWeChatBundle.mockReturnValue(bundle)
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      botService: { getBot: () => null, ...bundle.botService } as never,
      remoteContext: { ...args.remoteContext, messageId: 'msg-1', originSessionId: session.id }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `wechat-reply-${termination}-post-claim`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    if (termination === 'revoke') runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)

    let executorSignal: AbortSignal | undefined
    const originalExecute = wechatReplyExecutor.execute
    const executeReply = vi.spyOn(wechatReplyExecutor, 'execute').mockImplementation(async (input, executionContext) => {
      executorSignal = executionContext.signal
      return originalExecute(input, executionContext)
    })
    const toolCallId = `wechat-reply-${termination}-post-claim`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat reply invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-reply-${termination}-post-claim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'wechat_reply', input: { text: 'reply to msg-1' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['wechat_reply']),
        request: {
          messages: [{ role: 'user', content: '回复当前微信消息' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'wechat_reply', description: 'Reply to the current WeChat inbound', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runWeChatRemoteAgent(context)
      await atBotReply
      expect(executorSignal?.aborted).toBe(false)
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'wechat_reply')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      expect(executorSignal?.aborted).toBe(true)
      finishBotReply()
      await expect(runningAgent).rejects.toThrow(/after dispatch|uncertain|interrupted/i)
      expect(reply).toHaveBeenCalledOnce()
      expect(providerCalls).toBe(1)
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
        expect(projected.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: toolCallId, name: 'wechat_reply' })
        expect(projected.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId && !('diagnosticType' in event.payload))).toBe(false)
        expect(projected.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'interrupted' })
      } finally { await sink.close() }
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      finishBotReply?.()
      executeReply.mockRestore()
      runtime.chatCancels.clear(requestId)
      mockGetWeChatBundle.mockReset()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('passes shellConfig into runToolChatSession', async () => {
    const sender = { send: vi.fn() } as unknown as WebContents
    await runWeChatRemoteAgent(baseCtx(() => sender))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          tools: expect.objectContaining({
            shellConfig: expect.objectContaining({ maxInlineOutputBytes: 1024 })
          })
        })
      }),
      expect.anything(),
      expect.objectContaining({ onHostedTurnHandoff: expect.any(Function) })
    )
  })

  it('works when main webContents is null', async () => {
    await runWeChatRemoteAgent(baseCtx(() => null))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ legacy: expect.objectContaining({ appDb: expect.anything() }) }),
      expect.objectContaining({ onHostedTurnHandoff: expect.any(Function) })
    )
  })

  it('passes workDirManager and resolveWorkDir to runToolChatSession', async () => {
    await runWeChatRemoteAgent(baseCtx(() => null))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspace: expect.objectContaining({
          workDirManager: expect.anything(),
          resolveWorkDir: expect.any(Function)
        })
      }),
      expect.objectContaining({ onHostedTurnHandoff: expect.any(Function) })
    )
  })

  it('WeChat production wrapper executes its real Hosted handoff through SDK and History', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'hosted WeChat answer' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const outcome = await handoff({
        authorizedToolNames: new Set<string>(),
        request: { messages: [{ role: 'user', content: 'question from WeChat' }], maxTokens: 64, credentials: { apiKey: 'key' } },
        windowId: record.trace.windowId
      })
      return outcome.result
    })

    try {
      await expect(runWeChatRemoteAgent(baseCtx(() => null))).resolves.toMatchObject({ ok: true, summary: 'hosted WeChat answer' })
      expect(providerCalls).toBe(1)
    } finally {
      setDefaultAgentRuntime(previousRuntime)
    }
  })

  it('WeChat Hosted switch_work_dir rebinds the session after an authorized Runtime dispatch', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-workdir-current-'))
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-workdir-target-'))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-workdir-switch-success', model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'current-profile' })
    const profile = { id: 'target-profile', name: 'Target project', path: targetDir, aliases: ['target'] }
    const manager = {
      ...args.workDirManager,
      listProfiles: () => [profile],
      getActiveProfileId: () => 'current-profile',
      getActiveWorkDir: () => currentDir
    }
    const context = {
      ...args, sessionId: session.id, workDir: currentDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, chatId: 'wechat-workdir-switch-success', messageId: 'wechat-workdir-switch-message' }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'current-profile', workDir: currentDir, isSensitive: false })
    expect(tryClaimRemoteSession(session.id, args.requestId, 4)).toBe('ok')
    const executeSwitch = vi.spyOn(switchWorkDirExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-workdir-switch-success-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-switch-workdir-success', toolName: 'switch_work_dir', input: { profile_id: 'target-profile' } } as const
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
          messages: [{ role: 'user', content: '切换工作目录' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已切换到目标工作目录。' })
      expect(providerCalls).toBe(2)
      expect(executeSwitch).toHaveBeenCalledOnce()
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('target-profile')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'wechat-switch-workdir-success', result: { success: true, data: { profileId: 'target-profile', workDir: targetDir } }
      })
      const sink = getSessionEventSink(currentDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'wechat-switch-workdir-success', result: { success: true, data: { profileId: 'target-profile', workDir: targetDir } }
        })
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      releaseRemoteSession(session.id, args.requestId)
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(currentDir, { recursive: true, force: true })
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted switch_work_dir rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-workdir-${termination}-current-`))
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-workdir-${termination}-target-`))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: `wechat-workdir-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'current-profile' })
    const profile = { id: 'target-profile', name: 'Target project', path: targetDir, aliases: ['target'] }
    const manager = {
      ...args.workDirManager,
      listProfiles: () => [profile],
      getActiveProfileId: () => 'current-profile',
      getActiveWorkDir: () => currentDir
    }
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir: currentDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, messageId: `wechat-workdir-${termination}`, chatId: `wechat-workdir-${termination}` }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'current-profile', workDir: currentDir, isSensitive: false })
    expect(tryClaimRemoteSession(session.id, requestId, 4)).toBe('ok')
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)
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
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-workdir-${termination}-claim-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `wechat-workdir-${termination}`, toolName: 'switch_work_dir', input: { profile_id: 'target-profile' } } as const
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
          messages: [{ role: 'user', content: '切换工作目录' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const running = runWeChatRemoteAgent(context)
      await atClaim
      expect(executeSwitch).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'switch_work_dir')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(running).rejects.toThrow(/cancelled/i)
      else await expect(running).resolves.toMatchObject({ ok: true, summary: '准入变化后未切换工作目录。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeSwitch).not.toHaveBeenCalled()
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('current-profile')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `wechat-workdir-${termination}`,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      runtime.chatCancels.clear(requestId)
      releaseRemoteSession(session.id, requestId)
      runtime.executionAdmission = originalAdmission
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(currentDir, { recursive: true, force: true })
      await fs.rm(targetDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted switch_work_dir preserves an unknown binding change after dispatch when %s arrives', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-workdir-postclaim-${termination}-current-`))
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-workdir-postclaim-${termination}-target-`))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: `wechat-workdir-postclaim-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'current-profile' })
    const profile = { id: 'target-profile', name: 'Target project', path: targetDir, aliases: ['target'] }
    const manager = {
      ...args.workDirManager,
      listProfiles: () => [profile],
      getActiveProfileId: () => 'current-profile',
      getActiveWorkDir: () => currentDir
    }
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir: currentDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, messageId: `wechat-workdir-postclaim-${termination}`, chatId: `wechat-workdir-postclaim-${termination}` }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'current-profile', workDir: currentDir, isSensitive: false })
    expect(tryClaimRemoteSession(session.id, requestId, 4)).toBe('ok')
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)
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
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-workdir-${termination}-postclaim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: `wechat-workdir-postclaim-${termination}`, toolName: 'switch_work_dir', input: { profile_id: 'target-profile' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_work_dir']),
        request: {
          messages: [{ role: 'user', content: '切换工作目录' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_work_dir', description: 'Switch work directory', inputSchema: {
            type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const running = runWeChatRemoteAgent(context)
      const runningResult = running.then((value) => ({ value }), (error: unknown) => ({ error }))
      await atDispatch
      expect(getSession(args.db, session.id)?.workDirProfileId).toBe('target-profile')
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'switch_work_dir')).toBe(1)
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
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'interrupted' })
      } finally { await sink.close() }
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

  it('WeChat Hosted skills.read returns a registered skill through the snapshot RegisteredTool', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-skills-read-'))
    const userDataDir = path.join(workDir, 'user-data')
    const skillPath = path.join(workDir, '.space-skills', 'remote-skill', 'SKILL.md')
    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.writeFile(skillPath, '---\nname: remote-skill\ndescription: WeChat remote skill fixture\n---\nWeChat skill body.\n')
    invalidateSkillsCache()
    const args = baseCtx(() => null)
    const session = createSession(args.db, {
      name: 'wechat-skills-read', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } }
    })
    const context = {
      ...args, sessionId: session.id, workDir, userDataDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, messageId: 'wechat-skills-read', originSessionId: session.id, outboundSessionId: session.id }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-skills-read', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-skills-read-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-skills-read', toolName: 'skills.read', input: { name: 'remote-skill' } } as const
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
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已读取技能说明。' })
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'wechat-skills-read', result: { success: true, data: { name: 'remote-skill', content: expect.stringContaining('WeChat skill body.') } }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'wechat-skills-read', result: { success: true, data: { name: 'remote-skill', content: expect.stringContaining('WeChat skill body.') } }
        })
      } finally { await sink.close() }
    } finally {
      invalidateSkillsCache()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('WeChat Hosted run_shell remains locked-denied before executor dispatch', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseCtx(() => null)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-shell-denied-'))
    const session = createSession(args.db, {
      name: 'wechat-hosted-shell-denied', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } }
    })
    const markerPath = path.join(workDir, 'shell-must-not-run')
    const executor = vi.spyOn((await import('../tools/runShellExecutor')).runShellExecutor, 'execute')
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getShellConfig: () => ({ enabled: true, shellDefaultTimeoutSec: 10, maxInlineOutputBytes: 1024, rules: [] }),
      remoteContext: { ...args.remoteContext, messageId: 'wechat-shell-denied', originSessionId: session.id, outboundSessionId: session.id }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-shell-denied', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-locked-shell-deny-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-shell-denied', toolName: 'run_shell', input: {
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
        }, windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '远程 shell 被安全策略拒绝。' })
      expect(providerCalls).toBe(2)
      expect(executor).not.toHaveBeenCalled()
      await expect(fs.stat(markerPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-shell-denied', reason: 'POLICY_DENY'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executor.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('WeChat Hosted list_work_dirs returns configured profiles through the RegisteredTool', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseCtx(() => null)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-list-workdirs-'))
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
    const session = createSession(args.db, {
      name: 'wechat-list-workdirs', model: SUPPORTED_ANTHROPIC_MODEL, workDirProfileId: 'bound-profile',
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } }
    })
    const context = {
      ...args, sessionId: session.id, workDir, workDirManager: manager,
      remoteContext: { ...args.remoteContext, messageId: 'wechat-list-workdirs', originSessionId: session.id, outboundSessionId: session.id }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'bound-profile', workDir, isSensitive: false })
    const { listWorkDirsExecutor } = await import('../tools/workDirExecutors')
    const executeList = vi.spyOn(listWorkDirsExecutor, 'execute')
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-list-workdirs-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-list-workdirs', toolName: 'list_work_dirs', input: {} } as const
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
        }, windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已列出工作目录。' })
      expect(providerCalls).toBe(2)
      expect(executeList).toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'wechat-list-workdirs', result: {
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
      args.db.close()
    }
  })

  it('WeChat Hosted history.read preserves the unavailable result when Remote history facts are absent', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const args = baseCtx(() => null)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-history-read-unavailable-'))
    const session = createSession(args.db, {
      name: 'wechat-history-read-unavailable', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } }
    })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, messageId: 'wechat-history-read-unavailable', originSessionId: session.id, outboundSessionId: session.id }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-history-read-unavailable', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-history-read-unavailable-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-history-read-unavailable', toolName: 'history.read', input: { limit: 1 } } as const
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
        }, windowId: record.trace.windowId
      })).result
    })
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '当前远程会话没有可供回查的压缩历史。' })
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'wechat-history-read-unavailable', result: { success: false, error: 'History is unavailable for this session' }
      })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'wechat-history-read-unavailable', result: { success: false, error: 'History is unavailable for this session' }
        })
      } finally { await sink.close() }
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it('WeChat Hosted switch_session projects an acknowledged session change to History and session ledger', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-switch-session-hosted-success-'))
    const args = baseCtx(() => null)
    const callerSession = createSession(args.db, {
      name: 'wechat-switch-caller-success', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } }
    })
    const targetSession = createSession(args.db, {
      name: 'wechat-switch-target-success', model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } }
    })
    const context = {
      ...args, sessionId: callerSession.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, messageId: 'wechat-switch-session-success', originSessionId: callerSession.id,
        outboundSessionId: callerSession.id
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-switch-session-success', workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    mockRequestRendererSessionSwitch.mockResolvedValue({ desktopSwitched: true, viewChanged: true })

    const toolCallId = 'wechat-switch-session-hosted-success'
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat switch_session invocation route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-switch-session-hosted-success-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'switch_session', input: { session_id: targetSession.id } } as const
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '已切换到目标微信会话。' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_session']),
        request: {
          messages: [{ role: 'user', content: '切换到另一个微信会话' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'switch_session', description: 'Switch active WeChat session', inputSchema: {
            type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeSwitch = vi.spyOn(switchSessionExecutor, 'execute')

    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '已切换到目标微信会话。' })
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

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted switch_session rejects %s before renderer dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-switch-session-${termination}-claim-`))
    const args = baseCtx(() => null)
    const callerSession = createSession(args.db, { name: `wechat-switch-caller-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } } })
    const targetSession = createSession(args.db, { name: `wechat-switch-target-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } } })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: callerSession.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, messageId: `wechat-switch-session-${termination}`, originSessionId: callerSession.id,
        outboundSessionId: callerSession.id
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `wechat-switch-session-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)
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
    const toolCallId = `wechat-switch-session-${termination}`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat switch_session invocation route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-switch-session-${termination}-claim-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId, toolName: 'switch_session', input: { session_id: targetSession.id } } as const
          yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '准入变化后未切换微信会话。' } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_session']),
        request: {
          messages: [{ role: 'user', content: '切换微信会话' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_session', description: 'Switch active WeChat session', inputSchema: {
            type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const running = runWeChatRemoteAgent(context)
      await atClaim
      expect(executeSwitch).not.toHaveBeenCalled()
      expect(mockRequestRendererSessionSwitch).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'switch_session')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      if (termination === 'cancel') await expect(running).rejects.toThrow(/cancelled/i)
      else await expect(running).resolves.toMatchObject({ ok: true, summary: '准入变化后未切换微信会话。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeSwitch).not.toHaveBeenCalled()
      expect(mockRequestRendererSessionSwitch).not.toHaveBeenCalled()
      expect(context.remoteContext.outboundSessionId).toBe(callerSession.id)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId, reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      runtime.chatCancels.clear(requestId)
      runtime.toolRevocations.clearToolRevocationRequest(requestId)
      runtime.executionAdmission = originalAdmission
      executeSwitch.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
      args.db.close()
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted switch_session keeps a post-request renderer result unknown when %s arrives', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-switch-session-${termination}-postclaim-`))
    const args = baseCtx(() => null)
    const callerSession = createSession(args.db, { name: `wechat-switch-caller-${termination}-postclaim`, model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } } })
    const targetSession = createSession(args.db, { name: `wechat-switch-target-${termination}-postclaim`, model: SUPPORTED_ANTHROPIC_MODEL,
      metadata: { source: 'wechat', wechatMeta: { userId: 'wx-user@test' } } })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: callerSession.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: {
        ...args.remoteContext, messageId: `wechat-switch-session-${termination}-postclaim`, originSessionId: callerSession.id,
        outboundSessionId: callerSession.id
      }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `wechat-switch-session-${termination}-postclaim`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)
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
    const toolCallId = `wechat-switch-session-${termination}-postclaim`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat switch_session invocation route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-switch-session-${termination}-postclaim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId, toolName: 'switch_session', input: { session_id: targetSession.id } } as const
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['switch_session']),
        request: {
          messages: [{ role: 'user', content: '切换微信会话' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'switch_session', description: 'Switch active WeChat session', inputSchema: {
            type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runWeChatRemoteAgent(context)
      const observedAgent = runningAgent.then((value) => ({ value }), (error: unknown) => ({ error }))
      await rendererRequested
      expect(executeSwitch).toHaveBeenCalledOnce()
      expect(executorSignal?.aborted).toBe(false)
      expect(context.remoteContext.outboundSessionId).toBe(callerSession.id)
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'switch_session')).toBe(1)
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
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
      const sink = getSessionEventSink(workDir, callerSession.id, callerSession.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({ toolUseId: toolCallId, name: 'switch_session' })
        expect(events.some((event) => event.type === 'tool_result' && event.payload.toolUseId === toolCallId && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ turnId: args.requestId, reason: 'interrupted' })
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

  it('WeChat Hosted caller confirms and executes run_script through the SDK RegisteredTool', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-run-script-'))
    const markerPath = path.join(workDir, 'script-side-effect.txt')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-run-script', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-run-script-approved' }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, messageId: 'wechat-run-script-message', imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-run-script', workDir, isSensitive: false })
    const code = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'executed')\nprocess.stdout.write('wechat-hosted-script-ok')`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-hosted-run-script-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-run-script', toolName: 'run_script', input: { language: 'javascript', code } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'JavaScript 脚本执行完成。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '运行 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'run_script', description: 'Run a script', inputSchema: {
            type: 'object', properties: { language: { type: 'string' }, code: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: 'JavaScript 脚本执行完成。' })
      expect(providerCalls).toBe(2)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId: 'wechat-run-script', approved: true
      })
      expect(history.events.find((event) => event.kind === 'tool-call-finished')?.payload).toMatchObject({
        toolCallId: 'wechat-run-script', result: { success: true, data: { stdout: 'wechat-hosted-script-ok' } }
      })
      await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('executed')
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
          toolUseId: 'wechat-run-script', result: { success: true, data: { stdout: 'wechat-hosted-script-ok' } }
        })
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'completed' })
      } finally { await sink.close() }
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted run_script rejects a changed timeout after approval before execution', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-run-script-config-drift-'))
    const markerPath = path.join(workDir, 'script-must-not-start')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-run-script-config-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let toolsConfig: typeof DEFAULT_TOOLS_CONFIG = { ...DEFAULT_TOOLS_CONFIG }
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      toolsConfig = { ...toolsConfig, scriptTimeout: toolsConfig.scriptTimeout + 1 }
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-run-script-config-drift-approved' }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getToolsConfig: () => toolsConfig,
      remoteContext: { ...args.remoteContext, messageId: 'wechat-run-script-config-drift', imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-run-script-config-drift', workDir, isSensitive: false })
    const code = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'executed')`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-run-script-config-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-run-script-config-drift', toolName: 'run_script', input: { language: 'javascript', code } } as const
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
          messages: [{ role: 'user', content: '运行 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'run_script', description: 'Run a script', inputSchema: {
            type: 'object', properties: { language: { type: 'string' }, code: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })
    const executeScript = vi.spyOn(runScriptExecutor, 'execute')

    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '脚本配置在确认期间变化，未执行。' })
      expect(providerCalls).toBe(2)
      expect(executeScript).not.toHaveBeenCalled()
      await expect(fs.access(markerPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId: 'wechat-run-script-config-drift', approved: true
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-run-script-config-drift'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeScript.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('stops the WeChat Hosted turn when complete-gate Runtime composition fails', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-runtime-fail-stop-'))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-runtime-fail-stop', model: SUPPORTED_ANTHROPIC_MODEL })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-runtime-fail-stop', workDir, isSensitive: false })
    hostedRuntimeFailureInjection.requestId = args.requestId
    let providerCalls = 0
    const executor = vi.spyOn(readFileExecutor, 'execute')
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'wechat-runtime-fail-stop-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'provider must not start' } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const rawHandoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<unknown> }).onHostedTurnHandoff
      const handoff = async (input: Record<string, unknown>) => {
        const acceptedTurn = (invocation as unknown as { acceptedTurn?: { currentUserMessageId?: string } }).acceptedTurn
        return rawHandoff({
          ...input,
          ...(acceptedTurn?.currentUserMessageId ? { requiredUserMessage: { id: acceptedTurn.currentUserMessageId, message: { role: 'user', content: '读取当前目录下的文件' } } } : {})
        })
      }
      return handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: '读取当前目录下的文件' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]
        },
        requiredUserMessage: { id: 'wechat-runtime-fail-stop-user', message: { role: 'user', content: '读取当前目录下的文件' } },
        windowId: record.trace.windowId
      })
    })

    try {
      await expect(runWeChatRemoteAgent(context)).rejects.toThrow('WeChat complete-gate Runtime unavailable')
      expect(hostedRuntimeFailureInjection.composeCalls).toBe(1)
      expect(providerCalls).toBe(0)
      expect(executor).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_call' || event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'failed' })
      } finally { await sink.close() }
    } finally {
      executor.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted confirmed run_script rejects %s before dispatch claim', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-run-script-${termination}-claim-`))
    const markerPath = path.join(workDir, 'script-must-not-run')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: `wechat-run-script-${termination}-claim`, model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `wechat-run-script-${termination}-approved` }
      ))
    } })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, messageId: `wechat-run-script-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `wechat-run-script-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)
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
    const executeScript = vi.spyOn(runScriptExecutor, 'execute')
    const code = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'executed')`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-run-script-${termination}-claim-fixture`, stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: `wechat-run-script-${termination}`, toolName: 'run_script', input: { language: 'javascript', code } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '授权变化后脚本未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const runningTurn = handoff({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '运行 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'run_script', description: 'Run a script', inputSchema: {
            type: 'object', properties: { language: { type: 'string' }, code: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })
      await atClaim
      expect(executeScript).not.toHaveBeenCalled()
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'run_script')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      releaseClaim()
      return (await runningTurn).result
    })

    try {
      const runningAgent = runWeChatRemoteAgent(context)
      if (termination === 'cancel') await expect(runningAgent).rejects.toThrow(/cancelled/i)
      else await expect(runningAgent).resolves.toMatchObject({ ok: true, summary: '授权变化后脚本未执行。' })
      expect(providerCalls).toBe(termination === 'cancel' ? 1 : 2)
      expect(executeScript).not.toHaveBeenCalled()
      await expect(fs.access(markerPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.find((event) => event.kind === 'approval-resolved')?.payload).toMatchObject({
        toolCallId: `wechat-run-script-${termination}`, approved: true
      })
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: `wechat-run-script-${termination}`,
        reason: termination === 'authorization-change' ? 'AUTHORIZATION_STALE' : termination === 'revoke' ? 'REVOKED' : 'REQUEST_CANCELLED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      releaseClaim()
      runtime.chatCancels.clear(requestId)
      runtime.executionAdmission = originalAdmission
      executeScript.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each(['authorization-change', 'revoke', 'cancel'] as const)('WeChat Hosted run_script keeps a post-claim %s result unknown', async (termination) => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `wechat-run-script-postclaim-${termination}-`))
    const markerPath = path.join(workDir, 'script-side-effect.txt')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: `wechat-run-script-postclaim-${termination}`, model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: `wechat-run-script-postclaim-${termination}-approved` }
      ))
    } })
    const requestId = args.requestId
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, messageId: `wechat-run-script-postclaim-${termination}`, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: `wechat-run-script-postclaim-${termination}`, workDir, isSensitive: false })
    const packages = readPolicyPackages(args.db)
    packages.wechat = 'standard'
    writePolicyPackages(args.db, packages)
    args.db.flushSave()
    runtime.toolRevocations.registerToolRevocationRequest(requestId, 'wechat', requestId)
    let dispatchReached!: () => void
    let releaseDispatch!: () => void
    let dispatchSignal!: AbortSignal
    const atDispatch = new Promise<void>((resolve) => { dispatchReached = resolve })
    const dispatchBarrier = new Promise<void>((resolve) => { releaseDispatch = resolve })
    const originalExecuteScript = runScriptExecutor.execute
    const executeScript = vi.spyOn(runScriptExecutor, 'execute').mockImplementation(async (input, toolContext) => {
      const result = await originalExecuteScript.call(runScriptExecutor, input, toolContext)
      dispatchSignal = toolContext.signal
      dispatchReached()
      await dispatchBarrier
      return result
    })
    const code = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(markerPath)}, 'executed')\nprocess.stdout.write('script done')`
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: `wechat-run-script-${termination}-postclaim-fixture`, stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: `wechat-run-script-postclaim-${termination}`, toolName: 'run_script', input: { language: 'javascript', code } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['run_script']),
        request: {
          messages: [{ role: 'user', content: '运行 JavaScript' }], maxTokens: 64, credentials: { apiKey: 'key' },
          signal: runtime.chatCancels.register(requestId),
          tools: [{ name: 'run_script', description: 'Run a script', inputSchema: {
            type: 'object', properties: { language: { type: 'string' }, code: { type: 'string' } }, required: ['code']
          } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const runningAgent = runWeChatRemoteAgent(context)
      const runningResult = runningAgent.then((value) => ({ value }), (error: unknown) => ({ error }))
      await atDispatch
      await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('executed')
      if (termination === 'authorization-change') {
        const changed = readPolicyPackages(args.db)
        changed.wechat = 'strict'
        writePolicyPackages(args.db, changed)
        args.db.flushSave()
        runtime.policyAuthorizationChanges.publish('wechat')
      } else if (termination === 'revoke') {
        expect(runtime.toolRevocations.revokeToolForLane('wechat', 'run_script')).toBe(1)
      } else runtime.chatCancels.signalChatCancel(requestId)
      await vi.waitFor(() => expect(dispatchSignal.aborted).toBe(true))
      releaseDispatch()
      const result = await runningResult
      expect(result).toHaveProperty('error')
      expect(String((result as { error: unknown }).error)).toMatch(/failed after dispatch|unknown/i)
      expect(providerCalls).toBe(1)
      expect(runtime.executionAdmission.activeLeaseCount(requestId)).toBe(0)
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(requestId)
      expect(history.events.some((event) => event.kind === 'tool-call-started')).toBe(true)
      expect(history.events.some((event) => event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched')).toBe(false)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
      const sink = getSessionEventSink(workDir, session.id, session.createdAt)
      try {
        const events = await readSessionEvents(sink.eventsPath)
        expect(events.some((event) => event.type === 'tool_result' && !('diagnosticType' in event.payload))).toBe(false)
        expect(events.find((event) => event.type === 'turn_end')?.payload).toMatchObject({ reason: 'interrupted' })
      } finally { await sink.close() }
    } finally {
      releaseDispatch()
      runtime.chatCancels.clear(requestId)
      executeScript.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted preserves completed History when turn_end projection fails and repairs JSONL after process restart', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-terminal-recovery-'))
    const dbPath = path.join(workDir, 'history.db')
    let db = openDatabase(dbPath)
    const args = baseCtx(() => null, db)
    const session = createSession(db, { name: 'wechat-hosted-terminal-recovery', model: SUPPORTED_ANTHROPIC_MODEL })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-terminal-recovery', workDir, isSensitive: false })
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-terminal-recovery-fixture', stream: async function* () {
        yield { type: 'text-delta', text: 'completed WeChat turn' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set<string>(),
        request: { messages: [{ role: 'user', content: 'finish this WeChat task' }], maxTokens: 64, credentials: { apiKey: 'key' } },
        windowId: record.trace.windowId
      })).result
    })

    const append = SessionEventWriter.prototype.appendCritical
    let failTurnEnd = true
    const appendSpy = vi.spyOn(SessionEventWriter.prototype, 'appendCritical').mockImplementation(function (this: SessionEventWriter, event) {
      if (event.type === 'turn_end' && failTurnEnd) {
        failTurnEnd = false
        return Promise.reject(new Error('injected WeChat turn_end projection failure'))
      }
      return append.call(this, event)
    })
    let sink: ReturnType<typeof getSessionEventSink> | undefined
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: 'completed WeChat turn' })
      const history = new SqliteAgentHistory(getDbConnection(db))
      const canonical = await history.read(args.requestId)
      expect(canonical.events.at(-1)).toMatchObject({ kind: 'invocation-completed', payload: { status: 'completed' } })

      sink = getSessionEventSink(workDir, session.id, session.createdAt)
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'turn_end')).toHaveLength(0)
      await sink.close()
      sink = undefined
      appendSpy.mockRestore()
      db.close()
      db = openDatabase(dbPath)
      const reopenedHistory = new SqliteAgentHistory(getDbConnection(db))
      const recoveredSink = getSessionEventSink(workDir, session.id, session.createdAt)
      const repairErrors: unknown[] = []
      const recovery = {
        repairInvocationTerminal: (location: { workDir: string; sessionId: string; createdAt: number }, terminal: Record<string, unknown>) => {
          expect(location).toEqual({ workDir, sessionId: session.id, createdAt: session.createdAt })
          return ensureTurnEndEvent(recoveredSink, terminal.turnId as string, terminal.reason as string)
        },
        onInvocationTerminalRepairError: (error: unknown) => repairErrors.push(error)
      }
      await reopenedHistory.recoverInterruptedInvocations(recovery)
      await reopenedHistory.recoverInterruptedInvocations(recovery)
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

  it('WeChat Hosted handoff rejects legacy transcript drift against canonical session History', async () => {
    const ctx = baseCtx(() => null)
    const session = createSession(ctx.db, { name: 'wechat-history-cutover', model: SUPPORTED_ANTHROPIC_MODEL })
    const history = new SqliteAgentHistory(getDbConnection(ctx.db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'prior-wechat', turnId: 'prior-wechat-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-wechat-context', idempotencyKey: 'prior-wechat-context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'canonical WeChat prior' }] } },
      { invocationId: 'prior-wechat', turnId: 'prior-wechat-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-wechat-done', idempotencyKey: 'prior-wechat-done', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    let handoffError: unknown
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const accepted = (invocation as unknown as { acceptedTurn: ReturnType<typeof createAcceptedTurn> }).acceptedTurn
      updateMessageContent(ctx.db, accepted.currentUserMessageId, { content: 'current WeChat question' })
      const rawCallback = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<unknown> }).onHostedTurnHandoff
      const callback = (input: Record<string, unknown>) => rawCallback({
        ...input,
        currentUserMessageId: accepted.currentUserMessageId,
        requiredUserMessage: { id: accepted.currentUserMessageId, message: { role: 'user', content: 'current WeChat question' } }
      })
      try {
        await callback({
          authorizedToolNames: new Set(),
          request: { messages: [{ role: 'user', content: 'stale WeChat transcript' }, { role: 'user', content: 'current WeChat question' }], maxTokens: 64 },
          requiredUserMessage: { id: 'wechat-current-user', message: { role: 'user', content: 'current WeChat question' } }
        })
      } catch (error) { handoffError = error }
      return { ok: false, error: handoffError instanceof Error ? handoffError.message : 'handoff unexpectedly proceeded', content: [], stopReason: 'end_turn' }
    })

    const result = await runWeChatRemoteAgent({ ...ctx, sessionId: session.id })

    expect(result.ok).toBe(false)
    expect(handoffError).toMatchObject({ message: 'Canonical session History could not safely provide the Hosted transcript' })
  })

  it('WeChat Hosted tool execution records matching SDK ledger and SQLite History events', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-ledger-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'WeChat Hosted read ledger')
    const dbPath = path.join(workDir, 'history.db')
    let db = openDatabase(dbPath)
    const args = baseCtx(() => null, db)
    const session = createSession(args.db, { name: 'wechat-hosted-ledger', model: SUPPORTED_ANTHROPIC_MODEL })
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-answer-1' }
      ))
    } })
    const context = {
      ...args,
      sessionId: session.id,
      workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-ledger', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const configured = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!configured) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(configured.profile, { providerId: 'hosted-wechat-tool-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-read-1', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: 'hosted WeChat tool answer' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: 'read note from WeChat' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const sink = getSessionEventSink(workDir, session.id, session.createdAt)
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: 'hosted WeChat tool answer', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      const events = await readSessionEvents(sink.eventsPath)
      const expectedTurnEnd = events.find((event) => event.type === 'turn_end')
      expect(expectedTurnEnd?.payload).toMatchObject({ reason: 'completed', turnId: expect.any(String) })
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['tool_call', 'tool_result']))
      expect(events.find((event) => event.type === 'tool_result')?.payload).toMatchObject({
        toolUseId: 'wechat-read-1', result: { success: true, data: { content: 'WeChat Hosted read ledger', encoding: 'utf8', path: 'note.txt' } }
      })
      expect((events.find((event) => event.type === 'tool_result')?.payload as { stepId?: string }).stepId)
        .toBe((events.find((event) => event.type === 'tool_call')?.payload as { stepId?: string }).stepId)
      const canonical = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      const responseEnvelope = canonical.events.find((event) => event.kind === 'model-response-committed')
      const resultEnvelope = canonical.events.find((event) => event.kind === 'tool-call-finished')
      expect(resultEnvelope?.payload).toMatchObject({
        toolCallId: 'wechat-read-1', sessionLedger: { result: (events.find((event) => event.type === 'tool_result')?.payload as { result: unknown }).result }
      })
      expect((resultEnvelope?.payload as { sessionLedger?: { stepId?: string } }).sessionLedger?.stepId)
        .toBe((responseEnvelope?.payload as { sessionLedger?: { stepId?: string } }).sessionLedger?.stepId)

      // Simulate a process interruption between canonical History commit and JSONL projection.
      await sink.close()
      const projectionTypes = new Set(['request_header', 'request_context', 'request_usage', 'tool_call', 'tool_result'])
      const expectedProjections = events.filter((event) => projectionTypes.has(event.type)).map(({ type, payload }) => ({ type, payload }))
      const existingLines = (await fs.readFile(sink.eventsPath, 'utf8')).trim().split('\n')
      const withoutProjections = existingLines.filter((line) => !projectionTypes.has(JSON.parse(line).type) && JSON.parse(line).type !== 'turn_end')
      await fs.writeFile(sink.eventsPath, `${withoutProjections.join('\n')}\n`, 'utf8')
      const canonicalBeforeRecovery = canonical
      db.close()
      db = openDatabase(dbPath)
      const recoveredSink = getSessionEventSink(workDir, session.id, session.createdAt)
      const history = new SqliteAgentHistory(getDbConnection(db))
      const repairToolResult = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, repairEvent: Record<string, unknown>) =>
        ensureToolResultEvent(recoveredSink, repairEvent as never))
      const repairToolCall = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, proposal: Record<string, unknown>) =>
        ensureToolCallEvent(recoveredSink, proposal as never))
      const repairRequest = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, projection: Record<string, unknown>) =>
        ensureRequestProjectionEvents(recoveredSink, projection as never))
      const repairUsage = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, usage: Record<string, unknown>) =>
        ensureRequestUsageEvent(recoveredSink, usage as never))
      const repairFinalContext = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, context: Record<string, unknown>) =>
        ensureFinalRequestContextEvent(recoveredSink, context as never))
      const repairTerminal = vi.fn((_location: { workDir: string; sessionId: string; createdAt: number }, terminal: Record<string, unknown>) =>
        ensureTurnEndEvent(recoveredSink, String(terminal.turnId), String(terminal.reason)))
      const repairErrors: unknown[] = []
      const recoveryOptions = {
        repairToolLedger: repairToolResult, repairToolCallLedger: repairToolCall,
        repairModelRequestLedger: repairRequest, repairUsageLedger: repairUsage,
        repairFinalRequestContextLedger: repairFinalContext,
        repairInvocationTerminal: repairTerminal,
        onToolLedgerRepairError: (error: unknown) => repairErrors.push(error),
        onModelRequestLedgerRepairError: (error: unknown) => repairErrors.push(error)
      }
      await history.recoverInterruptedInvocations(recoveryOptions)
      await history.recoverInterruptedInvocations(recoveryOptions)
      expect(repairErrors).toEqual([])
      await expect(history.read(args.requestId)).resolves.toEqual(canonicalBeforeRecovery)
      expect(repairToolResult).toHaveBeenCalled()
      expect(repairToolCall).toHaveBeenCalled()
      expect(repairRequest).toHaveBeenCalled()
      expect(repairUsage).toHaveBeenCalled()
      expect(repairFinalContext).toHaveBeenCalled()
      expect(repairTerminal).toHaveBeenCalledWith(expect.objectContaining({ workDir, sessionId: session.id, createdAt: session.createdAt }), expect.objectContaining({ reason: 'completed' }))
      const repairedEvents = await readSessionEvents(recoveredSink.eventsPath)
      const actualProjections = repairedEvents.filter((event) => projectionTypes.has(event.type)).map(({ type, payload }) => ({ type, payload }))
      expect(actualProjections).toEqual(expectedProjections)
      expect(repairedEvents.filter((event) => event.type === 'turn_end')).toHaveLength(1)
      expect(repairedEvents.find((event) => event.type === 'turn_end')?.payload).toEqual(expectedTurnEnd?.payload)
      await recoveredSink.close()
    } finally {
      await sink.close()
      db.close()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted revocation before dispatch claim records not-dispatched and never enters read executor', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const originalAdmission = runtime.executionAdmission
    const originalRead = readFileExecutor.execute
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-read-claim-revoke-'))
    await fs.writeFile(path.join(workDir, 'note.txt'), 'must not read')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-read-claim-revoke', model: SUPPORTED_ANTHROPIC_MODEL })
    let imChannel!: ImChannel
    imChannel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => imChannel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-read-revoke-approval' }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-read-claim-revoke', workDir, isSensitive: false })
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
      if (!route) throw new Error('expected WeChat invocation route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-read-claim-revoke', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-read-claim-revoked', toolName: 'read_file', input: { path: 'note.txt' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '本次读取已被撤销，未执行。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 3 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      const runningTurn = handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: 'read note from WeChat' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } ]
        },
        windowId: record.trace.windowId
      })
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      expect(runtime.toolRevocations.revokeToolForLane('wechat', 'read_file')).toBe(1)
      releaseClaim()
      return (await runningTurn).result
    })

    try {
      // runToolChatSession is mocked in this caller test; mirror its production pre-handoff registration.
      runtime.toolRevocations.registerToolRevocationRequest(args.requestId, 'wechat', args.requestId)
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '本次读取已被撤销，未执行。' })
      expect(providerCalls).toBe(2)
      expect(executor).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-read-claim-revoked', reason: 'REVOKED'
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

  it('WeChat Hosted confirmation denial records a non-dispatch and never writes the proposed file', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-write-denied-'))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-write-denied', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'reject', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-reject-1' }
      ))
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-write-denied', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-write-denied-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-write-denied-1', toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'denied' } } as const
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
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '写入已拒绝。' })
      expect(providerCalls).toBe(2)
      await expect(fs.access(targetPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-write-denied-1', reason: expect.stringMatching(/CONFIRMATION|USER/)
      })
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId: 'wechat-write-denied-1' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'wechat-write-denied-1', approved: false, answerer: 'user', cause: 'user-denied' }) })
      ]))
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted rechecks a confirmed write against a target created while approval is pending', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-write-target-drift-'))
    const targetPath = path.join(workDir, 'approved-target.txt')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-write-target-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      void fs.writeFile(targetPath, 'created-during-approval').then(() => {
        channel.tryResolveFromInbound(
          { kind: 'approve', confirmId: pending.confirmId },
          { matchKey: pending.matchKey, messageId: 'wechat-target-drift-approved' }
        )
      })
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-target-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-target-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-write-target-drift', toolName: 'write_file', input: { path: 'approved-target.txt', content: 'must-not-overwrite' } } as const
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
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeWrite = vi.spyOn(writeFileExecutor, 'execute')
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '目标变化后已停止写入。' })
      expect(providerCalls).toBe(2)
      expect(executeWrite).not.toHaveBeenCalled()
      await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('created-during-approval')
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-write-target-drift', reason: 'FACTS_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeWrite.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted rechecks a confirmed sensitive read when the file identity changes during approval', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-read-identity-drift-'))
    const targetPath = path.join(workDir, '.env')
    await fs.writeFile(targetPath, 'SECRET=before')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-read-identity-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      void (async () => {
        await fs.rename(targetPath, `${targetPath}.approved`)
        await fs.writeFile(targetPath, 'SECRET=after')
        channel.tryResolveFromInbound(
          { kind: 'approve', confirmId: pending.confirmId },
          { matchKey: pending.matchKey, messageId: 'wechat-read-identity-drift-approved' }
        )
      })()
    } })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-read-identity-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-read-identity-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-read-identity-drift', toolName: 'read_file', input: { path: '.env' } } as const
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
          messages: [{ role: 'user', content: '读取环境配置' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeRead = vi.spyOn(readFileExecutor, 'execute')
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '确认期间文件身份发生变化，已停止读取。' })
      expect(providerCalls).toBe(2)
      expect(executeRead).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-read-identity-drift', reason: 'FACTS_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeRead.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted rechecks a confirmed write when its auto-approval threshold changes while waiting', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-write-config-drift-'))
    const targetPath = path.join(workDir, 'approved-target.txt')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-write-config-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let autoApproveMaxBytes = 1
    let customSensitivePrefixes: string[] = []
    const configContext = {
      ...args,
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, autoApproveMaxBytes }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, customSensitivePrefixes })
    }
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      autoApproveMaxBytes = 1_000
      customSensitivePrefixes = [targetPath]
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-config-drift-approved' }
      ))
    } })
    const context = {
      ...configContext, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-config-drift', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-config-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-write-config-drift', toolName: 'write_file', input: { path: 'approved-target.txt', content: 'must-not-use-stale-threshold' } } as const
          yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
          yield { type: 'finish', reason: 'tool-calls' } as const
          return
        }
        yield { type: 'text-delta', text: '配置变化后已停止写入。' } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 2 } as const
        yield { type: 'finish', reason: 'stop' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['write_file']),
        request: {
          messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeWrite = vi.spyOn(writeFileExecutor, 'execute')
    try {
      await expect(runWeChatRemoteAgent(context)).resolves.toMatchObject({ ok: true, summary: '配置变化后已停止写入。', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      expect(executeWrite).not.toHaveBeenCalled()
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-write-config-drift', reason: 'FACTS_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeWrite.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted rejects a browser call when remote browser authorization changes during confirmation', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-browser-config-drift-'))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-browser-config-drift', model: SUPPORTED_ANTHROPIC_MODEL })
    let browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, navigateRequiresConfirm: true }
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      getBrowserConfig: () => browserConfig,
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-browser-config-drift', workDir, isSensitive: false })
    let prompted!: () => void
    const didPrompt = new Promise<void>((resolve) => { prompted = resolve })
    let channel!: ImChannel
    channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: (pending) => {
      browserConfig = { ...browserConfig, allowRemoteSessions: false }
      prompted()
      queueMicrotask(() => channel.tryResolveFromInbound(
        { kind: 'approve', confirmId: pending.confirmId },
        { matchKey: pending.matchKey, messageId: 'wechat-browser-config-drift-approved' }
      ))
    } })
    context.remoteContext.imChannel = channel
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-browser-config-drift-fixture', stream: async function* () {
        providerCalls += 1
        if (providerCalls === 1) {
          yield { type: 'tool-call', toolCallId: 'wechat-browser-config-drift', toolName: 'browser', input: { action: 'act', instruction: 'click the submit button' } } as const
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
          messages: [{ role: 'user', content: '打开 example.com' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'browser', description: 'Browser action', inputSchema: { type: 'object', properties: { action: { type: 'string' }, instruction: { type: 'string' } }, required: ['action', 'instruction'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    const executeBrowser = vi.spyOn(browserExecutor, 'execute')
    try {
      const invocation = runWeChatRemoteAgent(context)
      await didPrompt
      await expect(invocation).resolves.toMatchObject({ ok: true, summary: '浏览器授权已变化，操作未执行。', pendingConfirm: false })
      expect(providerCalls).toBe(2)
      expect(executeBrowser).not.toHaveBeenCalled()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events.find((event) => event.kind === 'tool-call-not-dispatched')?.payload).toMatchObject({
        toolCallId: 'wechat-browser-config-drift', reason: 'BROWSER_PREPARED_POLICY_CHANGED'
      })
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      executeBrowser.mockRestore()
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat Hosted request cancellation while awaiting confirmation never dispatches the write', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-write-cancelled-'))
    const targetPath = path.join(workDir, 'must-not-exist.txt')
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-write-cancelled', model: SUPPORTED_ANTHROPIC_MODEL })
    const controller = new AbortController()
    let announcePrompt!: () => void
    const prompted = new Promise<void>((resolve) => { announcePrompt = resolve })
    const channel = new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: () => announcePrompt() })
    const context = {
      ...args, sessionId: session.id, workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, confirmPolicy: 'always' as const, imChannel: channel }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-write-cancelled', workDir, isSensitive: false })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-write-cancelled-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: 'wechat-write-cancelled-1', toolName: 'write_file', input: { path: 'must-not-exist.txt', content: 'cancelled' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['write_file']),
        request: { messages: [{ role: 'user', content: '写入这个文件' }], maxTokens: 64, credentials: { apiKey: 'key' }, signal: controller.signal,
          tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }] },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const invocation = runWeChatRemoteAgent(context)
      await prompted
      controller.abort()
      await expect(invocation).rejects.toThrow(/agent turn cancelled/i)
      expect(providerCalls).toBe(1)
      await expect(fs.access(targetPath)).rejects.toThrow()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(args.requestId)
      expect(history.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-waiting', payload: expect.objectContaining({ toolCallId: 'wechat-write-cancelled-1' }) }),
        expect.objectContaining({ kind: 'approval-resolved', payload: expect.objectContaining({ toolCallId: 'wechat-write-cancelled-1', approved: false }) }),
        expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'wechat-write-cancelled-1', reason: 'REQUEST_CANCELLED' }) }),
        expect.objectContaining({ kind: 'invocation-interrupted', payload: expect.objectContaining({ status: 'cancelled' }) })
      ]))
      expect(history.events.some((event) => event.kind === 'tool-call-started' || event.kind === 'tool-call-finished')).toBe(false)
    } finally {
      setDefaultAgentRuntime(previousRuntime)
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('WeChat production Hosted caller aborts a claimed read lease when its SQLite policy package changes', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createDesktopAgentRuntime()
    setDefaultAgentRuntime(runtime)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-hosted-policy-change-'))
    const args = baseCtx(() => null)
    const session = createSession(args.db, { name: 'wechat-hosted-policy-change', model: SUPPORTED_ANTHROPIC_MODEL })
    await fs.writeFile(path.join(workDir, 'note.txt'), 'read will be interrupted')
    const context = {
      ...args, sessionId: session.id, requestId: 'wechat-hosted-policy-version-update', workDir,
      workDirManager: { ...args.workDirManager, getActiveWorkDir: () => workDir },
      remoteContext: { ...args.remoteContext, imChannel: new ImChannel({ lane: 'wechat', timeoutMs: 1_000, sendPrompt: () => undefined }) }
    }
    mockResolveWorkDirForSession.mockReturnValue({ profileId: 'wechat-policy-change', workDir, isSensitive: false })
    let observedSignal: AbortSignal | undefined
    let markExecutorEntered!: () => void
    const executorEntered = new Promise<void>((resolve) => { markExecutorEntered = resolve })
    vi.spyOn(readFileExecutor, 'execute').mockImplementation(async (_input, execution) => {
      observedSignal = execution.signal
      markExecutorEntered()
      return await new Promise((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(new Error('read interrupted by policy change')), { once: true })
      })
    })
    let providerCalls = 0
    mockRunToolChatSession.mockImplementation(async (invocation: never, _ports: never, options: never) => {
      const record = invocation as unknown as { profile: { providerRouteId: string }; trace: { windowId?: string } }
      const route = runtime.modelProviders.getRoute(record.profile.providerRouteId)
      if (!route) throw new Error('expected WeChat invocation provider route')
      runtime.modelProviders.register(route.profile, { providerId: 'hosted-wechat-policy-change-fixture', stream: async function* () {
        providerCalls += 1
        yield { type: 'tool-call', toolCallId: 'wechat-policy-change-read', toolName: 'read_file', input: { path: 'note.txt' } } as const
        yield { type: 'usage', inputTokens: 2, outputTokens: 1 } as const
        yield { type: 'finish', reason: 'tool-calls' } as const
      } })
      const handoff = (options as unknown as { onHostedTurnHandoff: (input: unknown) => Promise<{ result: unknown }> }).onHostedTurnHandoff
      return (await handoff({
        authorizedToolNames: new Set(['read_file']),
        request: {
          messages: [{ role: 'user', content: '读取 note.txt' }], maxTokens: 64, credentials: { apiKey: 'key' },
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
        },
        windowId: record.trace.windowId
      })).result
    })

    try {
      const invocation = runWeChatRemoteAgent(context)
      await executorEntered
      expect(observedSignal?.aborted).toBe(false)
      const packages = readPolicyPackages(args.db)
      packages.wechat = 'strict'
      writePolicyPackages(args.db, packages)
      args.db.flushSave()
      runtime.policyAuthorizationChanges.publish('wechat')

      await expect(invocation).rejects.toThrow(/after dispatch|interrupted/i)
      expect(observedSignal?.aborted).toBe(true)
      expect(providerCalls).toBe(1)
      expect(readFileExecutor.execute).toHaveBeenCalledOnce()
      const history = await new SqliteAgentHistory(getDbConnection(args.db)).read(context.requestId)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted' } })
      expect(history.events.find((event) => event.kind === 'tool-call-started')?.payload).toMatchObject({ toolCallId: 'wechat-policy-change-read' })
    } finally {
      if (!observedSignal?.aborted) runtime.chatCancels.signalChatCancel(context.requestId)
      setDefaultAgentRuntime(previousRuntime)
      vi.restoreAllMocks()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

})
