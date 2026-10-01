import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { LlmKeyAccessError } from './llmServiceResolver'

/**
 * P1 Invocation 契约（形状测试）：AgentInvocation / AgentHostPorts / 装配器键位平移
 * 与 events 出口对象化（含 notify 取代 floatingNotificationManager 直传）。
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const mockConfirmOutcome = vi.fn(async () => 'approved' as const)
const mockChatCancelState = vi.hoisted(() => ({ controller: undefined as AbortController | undefined }))
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []
const capturedSessionEvents: Array<Record<string, unknown>> = []

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return {
    ...actual,
    getCachedMemoryContent: () => mockGetCachedMemoryContent()
  }
})

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => {
    const controller = new AbortController()
    mockChatCancelState.controller = controller
    return controller.signal
  }),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  ChatCancelledError: class ChatCancelledError extends Error {},
  // A2(偏差 18):runtime 工厂经本模块取类构造实例
  ChatCancelRegistry: class ChatCancelRegistry {
    register = vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    signalChatCancel = vi.fn()
    clear = vi.fn()
    throwIfCancelled = vi.fn()
    cancelAllActiveChats = vi.fn()
  }
}))

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) => (name === 'read_file'
      ? { name, execute: async () => ({ success: true, data: 'file-content' }) }
      : name === 'write_file'
        ? { name, execute: async () => ({ success: true, data: 'written' }) }
        : undefined))
  }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(async () => mockConfirmOutcome()),
  waitForToolConfirm: vi.fn(async () => mockConfirmOutcome())
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation, type AgentInvocationMaterials } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'
import { resetEffortMemoForTests } from './effortFallback'
import { logAgentEvent } from './agentLogger/agentLogger'
import { MemoryHistory } from '../packages/agent-sdk/src/history'
import { getDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createHostedTurnHandoff } from './runtime/hostedTurnHandoff'
import { defineDirectTool, TypedToolRegistry } from './tools/plannedToolRegistry'
import { HostedTurnFinalizedError } from './runtime/hostedTurnFinalization'
import { throwIfChatCancelled, ChatCancelledError } from './chatCancelRegistry'

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

function makeStreamRounds(rounds: Array<{ content: unknown[]; stop_reason: string; usage?: Record<string, number> }>) {
  return {
    messages: {
      stream: vi.fn(() => {
        const round = rounds[Math.min(streamRound, rounds.length - 1)]
        streamRound += 1
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => round)
        }
      })
    }
  }
}

function baseMaterials(overrides: Partial<AgentInvocationMaterials> = {}): AgentInvocationMaterials {
  return {
    requestId: 'req-invocation-1',
    sessionId: 'sess-invocation-1',
    turnId: 'turn-invocation-1',
    windowId: 'win-1',
    llmServiceId: 'svc-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }] as never,
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: makeDb(),
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async (event: Record<string, unknown>) => {
      capturedSessionEvents.push(event)
    },
    ...overrides
  }
}

async function run(materials: AgentInvocationMaterials) {
  const { invocation, ports } = assembleInvocation(materials)
  // Legacy executor fakes in these tests intentionally model a pre-runtime test host.
  ports.toolRevocations = undefined
  return runToolChatSession(invocation, ports)
}

describe('assembleInvocation 键位平移（P1 契约形状）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(throwIfChatCancelled).mockImplementation(() => undefined)
    streamRound = 0
    mockChatCancelState.controller = undefined
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
  })

  it('trace / session / profile / limits / safety / additionalContext / driverContext 落位', () => {
    const materials = baseMaterials({
      lane: 'automation',
      internalConfirmExemption: 'approval-agent',
      maxToolLoopRounds: 3,
      approvalTaskDigest: 'task-digest-x',
      historyFacts: [{ id: 'f1', sessionId: 'sess-invocation-1', role: 'user', text: 't', tokens: 1 }] as never,
      remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: 'always' } as never,
      system: 'sys',
      providerRouteId: 'desktop-anthropic:route-snapshot-1',
      locale: 'zh-CN',
      skillFragments: ['frag'],
      baseUrl: 'https://relay.example.com'
    })
    const { invocation, ports } = assembleInvocation(materials)

    expect(invocation.trace).toEqual({ requestId: 'req-invocation-1', turnId: 'turn-invocation-1', windowId: 'win-1' })
    expect(invocation.session).toEqual({ sessionId: 'sess-invocation-1' })
    expect(invocation.profile.model).toBe('claude-sonnet-4-20250514')
    expect(invocation.profile.providerRouteId).toBe('desktop-anthropic:route-snapshot-1')
    expect(invocation.profile.llmServiceId).toBe('svc-1')
    // P4：网络目标出契约，归 ports.credentials.networkTarget
    expect(ports.credentials.networkTarget?.baseUrl).toBe('https://relay.example.com')
    expect(invocation.profile.system).toBe('sys')
    expect(invocation.profile.locale).toBe('zh-CN')
    expect(invocation.profile.lane).toBe('automation')
    expect(invocation.profile.tools.toolsConfig).toBe(DEFAULT_TOOLS_CONFIG)
    expect(invocation.limits.maxToolRounds).toBe(3)
    expect(invocation.safety.recursionGuard).toBe('approval-agent')
    expect(invocation.additionalContext['approval.taskDigest']).toBe('task-digest-x')
    expect(invocation.additionalContext['facts.history']).toEqual([{ id: 'f1', sessionId: 'sess-invocation-1', role: 'user', text: 't', tokens: 1 }])
    expect(invocation.driverContext).toMatchObject({ source: 'feishu', messageId: 'm1' })
    // 端口落位：workspace / credentials 接口方法 / legacy 过渡（N1 声明的 P2 前豁免）
    // R1：workDir 是装配期快照 rootPath 的投影（规范化后可能与材料字面值不同）
    expect(ports.workspace.workDir).toBe(ports.workspace.snapshot().rootPath)
    expect(ports.workspace.snapshot().revision).toBe(0)
    expect(ports.workspace.userDataDir).toBe('/tmp')
    expect(typeof ports.credentials.resolveApiKey).toBe('function')
    expect(ports.legacy?.appDb).toBe(materials.appDb)
  })

  it('messages 区块携带伴随元数据（currentUserMessageId / assistantMessageId / hasImageAttachments）', () => {
    const { invocation } = assembleInvocation(baseMaterials({
      currentUserMessageId: 'u1',
      assistantMessageId: 'a1',
      hasImageAttachments: true
    }))
    expect(invocation.messages.list).toEqual([{ role: 'user', content: 'hello' }])
    expect(invocation.messages.currentUserMessageId).toBe('u1')
    expect(invocation.messages.assistantMessageId).toBe('a1')
    expect(invocation.messages.hasImageAttachments).toBe(true)
  })

  it('floatingNotificationManager 不进契约：装配器包装为 events.notify 实现', () => {
    const calls: Array<Record<string, unknown>> = []
    const manager = {
      onConfirmRequest: (entry: Record<string, unknown>) => calls.push({ kind: 'confirm-request', ...entry }),
      onToolResult: (requestId: string, toolUseId: string) => calls.push({ kind: 'tool-result', requestId, toolUseId }),
      onAllCancelledForRequest: (requestId: string) => calls.push({ kind: 'request-all-cancelled', requestId })
    }
    const { invocation } = assembleInvocation(baseMaterials({ floatingNotificationManager: manager as never }))
    expect((invocation as Record<string, unknown>).floatingNotificationManager).toBeUndefined()
    expect(invocation.events.notify).toBeTypeOf('function')

    invocation.events.notify?.({ kind: 'confirm-request', requestId: 'r', sessionId: 's', sessionName: 'n', toolUseId: 't', toolName: 'run_shell', input: { command: 'ls' } })
    invocation.events.notify?.({ kind: 'tool-result', requestId: 'r', toolUseId: 't' })
    invocation.events.notify?.({ kind: 'request-all-cancelled', requestId: 'r' })
    expect(calls).toEqual([
      { kind: 'confirm-request', requestId: 'r', sessionId: 's', sessionName: 'n', toolUseId: 't', toolName: 'run_shell', input: { command: 'ls' }, createdAt: expect.any(Number) },
      { kind: 'tool-result', requestId: 'r', toolUseId: 't' },
      { kind: 'request-all-cancelled', requestId: 'r' }
    ])
  })

  it('不传 manager 时 notify 为 no-op 缺省（全 no-op 出口语义）', () => {
    const { invocation } = assembleInvocation(baseMaterials())
    expect(() => invocation.events.notify?.({ kind: 'tool-result', requestId: 'r', toolUseId: 't' })).not.toThrow()
  })
})

describe('runToolChatSession(invocation, ports) 行为等价（P1）', () => {
  it('feeds SDK provider tool calls into the existing guarded tool scheduler and sends their result on the next turn', async () => {
    const providerRouteId = 'desktop-anthropic:test-tool-route'
    const runtime = getDefaultAgentRuntime()
    let providerTurns = 0
    const providerCalls: Array<{ route: Record<string, unknown>; request: Record<string, unknown> }> = []
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, {
      providerId: 'test-sdk-tool-provider',
      async *stream(call) {
        providerCalls.push(call)
        providerTurns += 1
        if (providerTurns === 1) {
          yield { type: 'tool-call', toolCallId: 'sdk-read-1', toolName: 'read_file', input: { path: 'a.txt' } }
          yield { type: 'usage', inputTokens: 5, outputTokens: 3 }
          yield { type: 'finish', reason: 'tool-calls' }
        } else {
          yield { type: 'text-delta', text: 'read complete' }
          yield { type: 'usage', inputTokens: 8, outputTokens: 2 }
          yield { type: 'finish', reason: 'stop' }
        }
      }
    })
    const assembled = assembleInvocation(baseMaterials({ providerRouteId }))
    const { invocation, ports } = assembled
    ports.toolRevocations = undefined
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(defineDirectTool({
      name: 'read_file', actionClass: 'read', parseInput: (raw) => raw as { path: string },
      execute: async () => ({ success: true, data: 'file-content' })
    }))
    const agentSdk = {
      ...assembled.agentSdk,
      createHostedTurnRuntime: (input: Parameters<typeof assembled.agentSdk.createHostedTurnRuntime>[0]) =>
        assembled.agentSdk.createHostedTurnRuntime({ ...input, registry: toolRegistry })
    }
    const handoff = createHostedTurnHandoff({
      agentSdk: agentSdk as never, history: ports.history!, invocationId: invocation.trace.turnId,
      turnId: invocation.trace.turnId, routeId: providerRouteId, recoverProviderAttempt: assembled.agentSdk.recoverProviderAttempt
    })

    await expect(runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })).resolves.toMatchObject({ ok: true })
    expect(providerCalls).toHaveLength(2)
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    expect(capturedFacts.some((event) => event.type === 'tool-result' && event.id === 'sdk-read-1')).toBe(true)
    expect(capturedFacts.some((event) => event.type === 'content-delta' && event.text === 'read complete')).toBe(true)
    expect((providerCalls[1] as { request: { messages: Array<{ role: string; toolCallId?: string }> } }).request.messages.some((message) => message.role === 'tool' && message.toolCallId === 'sdk-read-1')).toBe(true)
    const requestHeaders = capturedSessionEvents.filter((event) => event.type === 'request_header').map((event) => event.payload as Record<string, any>)
    expect(requestHeaders).toHaveLength(2)
    expect(requestHeaders[0]).toMatchObject({ toolExecutionCheckpoint: { completedToolUseIds: [] } })
    expect(requestHeaders[1]).toMatchObject({ toolExecutionCheckpoint: { completedToolUseIds: ['sdk-read-1'] } })
    expect(requestHeaders[1]?.system).toBeUndefined()
    expect(requestHeaders[1]?.tools).toBeUndefined()
    expect(requestHeaders[1]?.surfaceSnapshot).toMatchObject({
      systemFingerprint: requestHeaders[0]?.surfaceSnapshot.systemFingerprint,
      toolsFingerprint: requestHeaders[0]?.surfaceSnapshot.toolsFingerprint
    })
  })

  it('uses the invocation-owned SDK provider route and does not construct the legacy Anthropic client', async () => {
    const providerRouteId = 'desktop-anthropic:test-invocation-route'
    const runtime = getDefaultAgentRuntime()
    const providerCalls: unknown[] = []
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, {
      providerId: 'test-sdk-provider',
      async *stream(call) {
        providerCalls.push(call)
        yield { type: 'text-delta', text: 'SDK route answer' }
        yield { type: 'usage', inputTokens: 7, outputTokens: 3 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const assembled = assembleInvocation(baseMaterials({ providerRouteId }))
    const { invocation, ports } = assembled
    ports.toolRevocations = undefined
    const history = new MemoryHistory()
    ports.history = history
    const handoff = createHostedTurnHandoff({
      agentSdk: assembled.agentSdk as never, history, invocationId: invocation.trace.turnId,
      turnId: invocation.trace.turnId, routeId: providerRouteId, recoverProviderAttempt: assembled.agentSdk.recoverProviderAttempt
    })

    await expect(runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })).resolves.toMatchObject({ ok: true })
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    expect(capturedFacts.some((event) => event.type === 'content-delta' && event.text === 'SDK route answer')).toBe(true)
    const committed = (await history.read(invocation.trace.turnId)).events.find(({ kind }) => kind === 'model-response-committed')
    expect(committed?.payload).toMatchObject({ requestSnapshot: { route: { routeId: providerRouteId, modelId: 'claude-sonnet-4-20250514' }, request: { maxTokens: expect.any(Number), messages: expect.any(Array) } } })
    expect(JSON.stringify(committed?.payload)).not.toContain('apiKey')
    const requestLog = vi.mocked(logAgentEvent).mock.calls.find((call) => call[1] === 'llm.request')
    expect(requestLog?.[2]).toMatchObject({
      requestId: invocation.trace.requestId, turnId: invocation.trace.turnId, lane: 'desktop'
    })
    expect(requestLog?.[2]).not.toHaveProperty('messages')
    expect(requestLog?.[2]).not.toHaveProperty('system')
    expect(JSON.stringify(requestLog?.[2])).not.toContain('hello')
    const snapshot = (committed?.payload as { requestSnapshot: { route: unknown; request: Record<string, unknown> } }).requestSnapshot
    const { credentials: _credentials, signal: _signal, ...persistableRequest } = providerCalls[0]!.request as { credentials?: unknown; signal?: unknown }
    expect(snapshot.route).toEqual(providerCalls[0]!.route)
    expect(snapshot.request).toEqual(persistableRequest)
  })

  it('retries an SDK route without thinking effort when upstream rejects output_config', async () => {
    const providerRouteId = 'desktop-anthropic:test-effort-fallback-route'
    const runtime = getDefaultAgentRuntime()
    const providerCalls: Array<{ request: { thinking?: { effort?: string } } }> = []
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, {
      providerId: 'test-sdk-effort-fallback-provider',
      async *stream(call) {
        providerCalls.push(call as typeof providerCalls[number])
        if (providerCalls.length === 1) {
          throw Object.assign(new Error('400 output_config rejected'), { status: 400 })
        }
        yield { type: 'text-delta', text: 'effort fallback answer' }
        yield { type: 'usage', inputTokens: 4, outputTokens: 2 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const assembled = assembleInvocation(baseMaterials({ providerRouteId, effort: 'high' }))
    const { invocation, ports } = assembled
    ports.toolRevocations = undefined
    const handoff = createHostedTurnHandoff({
      agentSdk: assembled.agentSdk as never, history: ports.history!, invocationId: invocation.trace.turnId,
      turnId: invocation.trace.turnId, routeId: providerRouteId, recoverProviderAttempt: assembled.agentSdk.recoverProviderAttempt
    })

    await expect(runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })).resolves.toMatchObject({ ok: true })
    expect(providerCalls).toHaveLength(2)
    expect(providerCalls[0].request.thinking?.effort).toBe('high')
    expect(providerCalls[1].request.thinking?.effort).toBeUndefined()
    expect(capturedSessionEvents).toContainEqual(expect.objectContaining({ type: 'request_retry', payload: expect.objectContaining({ code: 'effort_unsupported' }) }))
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
  })

  it('Desktop Hosted preserves the configured tool round limit and writes the over-limit proposal to History', async () => {
    const providerRouteId = 'desktop-anthropic:test-tool-round-limit'
    const runtime = getDefaultAgentRuntime()
    let providerTurns = 0
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'test-sdk-round-limit-provider', async *stream() {
      providerTurns += 1
      yield { type: 'tool-call', toolCallId: `limit-${providerTurns}`, toolName: 'read_file', input: { path: 'a.txt' } }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'tool-calls' }
    } })
    const assembled = assembleInvocation(baseMaterials({ providerRouteId, maxToolLoopRounds: 2 }))
    const { invocation, ports } = assembled
    ports.toolRevocations = undefined
    const execute = vi.fn(async () => ({ success: true, data: 'file-content' }))
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(defineDirectTool({ name: 'read_file', actionClass: 'read', parseInput: (raw) => raw as { path: string }, execute }))
    const agentSdk = { ...assembled.agentSdk, createHostedTurnRuntime: (input: Parameters<typeof assembled.agentSdk.createHostedTurnRuntime>[0]) => assembled.agentSdk.createHostedTurnRuntime({ ...input, registry: toolRegistry }) }
    const handoff = createHostedTurnHandoff({ agentSdk: agentSdk as never, history: ports.history!, invocationId: invocation.trace.turnId, turnId: invocation.trace.turnId, routeId: providerRouteId, maxToolRounds: invocation.limits.maxToolRounds })

    await expect(runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })).resolves.toMatchObject({ ok: false, error: 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED(2)' })
    expect(providerTurns).toBe(3)
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await ports.history!.read(invocation.trace.turnId)).events).toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ toolCallId: 'limit-3', reason: 'tool_loop_max_rounds_exceeded' }) }))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockConfirmOutcome.mockResolvedValue('approved')
  })

  it('fails before Hosted handoff and records a failed terminal when API credentials are missing', async () => {
    const failedHistory = new MemoryHistory()
    const failed = assembleInvocation(baseMaterials({ getApiKey: async () => null }))
    failed.ports.history = failedHistory
    failed.ports.toolRevocations = undefined
    const handoff = vi.fn()
    await expect(runToolChatSession(failed.invocation, failed.ports, { onHostedTurnHandoff: handoff })).resolves.toMatchObject({ ok: false, error: 'API key not configured' })
    expect(handoff).not.toHaveBeenCalled()
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    await expect(failedHistory.read('turn-invocation-1')).resolves.toMatchObject({
      events: [expect.objectContaining({ kind: 'invocation-failed', payload: { status: 'failed' } })]
    })
  })

  it('stops before provider dispatch when secure storage refuses the key read', async () => {
    const failed = assembleInvocation(baseMaterials({
      getApiKey: async () => { throw new LlmKeyAccessError('LLM_KEY_ACCESS_DENIED', 'service-1', 'Service') }
    }))
    failed.ports.toolRevocations = undefined
    const handoff = vi.fn()
    await expect(runToolChatSession(failed.invocation, failed.ports, { onHostedTurnHandoff: handoff })).rejects.toThrow('LLM_KEY_ACCESS_DENIED')
    expect(handoff).not.toHaveBeenCalled()
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
  })

  it('fails closed before provider dispatch when asked to reuse a terminal invocation History stream', async () => {
    const provider = makeStreamRounds([
      { content: [{ type: 'text', text: 'must not execute' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    ])
    mockCreateAnthropicClient.mockReturnValue(provider)
    const assembled = assembleInvocation(baseMaterials())
    const history = new MemoryHistory()
    assembled.ports.history = history
    await history.appendBatch([
      { invocationId: 'req-invocation-1', turnId: 'turn-invocation-1', sequence: 1, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'hello' }] } },
      { invocationId: 'req-invocation-1', turnId: 'turn-invocation-1', sequence: 2, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)

    await expect(runToolChatSession(assembled.invocation, assembled.ports)).rejects.toThrow('INVOCATION_HISTORY_STREAM_ALREADY_TERMINAL')
    expect(provider.messages.stream).not.toHaveBeenCalled()
    await expect(history.read('req-invocation-1')).resolves.toMatchObject({
      version: 2,
      events: [expect.objectContaining({ kind: 'invocation-context-committed' }), expect.objectContaining({ kind: 'invocation-completed' })]
    })
  })

  it('在发送首个 provider 请求前把 canonical request 交给 Hosted turn 并跳过 legacy model/tool loop', async () => {
    const provider = makeStreamRounds([
      { content: [{ type: 'text', text: 'legacy must not run' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
    ])
    mockCreateAnthropicClient.mockReturnValue(provider)
    const assembled = assembleInvocation(baseMaterials())
    const history = assembled.ports.history!
    const summary = vi.fn()
    assembled.ports.usage = { recordTurnSummary: summary }
    const handoffResult = { ok: true as const, content: [{ type: 'text', text: 'hosted result' }], stopReason: 'end_turn' }
    const handoff = vi.fn(async (input: { request: { messages: unknown[] }; authorizedToolNames: ReadonlySet<string>; windowId?: string }) => {
      expect(capturedSessionEvents.some((event) => event.type === 'request_header')).toBe(false)
      expect(capturedSessionEvents.some((event) => event.type === 'request_context')).toBe(false)
      const snapshot = await history.read(assembled.invocation.trace.requestId)
      await history.appendBatch([{
        invocationId: assembled.invocation.trace.requestId, turnId: assembled.invocation.trace.turnId,
        sequence: snapshot.version + 1, schemaVersion: snapshot.schemaVersion,
        eventId: `${assembled.invocation.trace.requestId}:hosted-terminal`,
        idempotencyKey: `${assembled.invocation.trace.requestId}:hosted-terminal`,
        kind: 'invocation-completed' as const, payload: { status: 'completed' }
      }], snapshot.version)
      return {
        result: handoffResult,
        finalization: {
          outcome: 'completed' as const,
          usage: {
            modelTurns: 1,
            initialMessageCount: input.request.messages.length,
            messages: [...input.request.messages, { role: 'assistant', content: 'hosted result' }] as never
          }
        }
      }
    })

    const result = await runToolChatSession(assembled.invocation, assembled.ports, { onHostedTurnHandoff: handoff })

    expect(result).toBe(handoffResult)
    expect(handoff).toHaveBeenCalledOnce()
    expect(handoff.mock.calls[0]?.[0]).not.toHaveProperty('initialResponse')
    expect(handoff.mock.calls[0]?.[0].windowId).toBe(assembled.invocation.trace.windowId)
    expect(handoff.mock.calls[0]?.[0].authorizedToolNames).toBeInstanceOf(Set)
    expect([...handoff.mock.calls[0]![0].authorizedToolNames]).toEqual(expect.arrayContaining(['read_file', 'write_file']))
    expect(handoff.mock.calls[0]?.[0].request.messages.some((message: { role?: string }) => message.role === 'user')).toBe(true)
    expect(handoff.mock.calls[0]?.[0].request.credentials).toEqual({ apiKey: 'test-key' })
    expect(provider.messages.stream).not.toHaveBeenCalled()
    const { events } = await history.read(assembled.invocation.trace.requestId)
    expect(events.filter((event) => event.kind === 'invocation-completed')).toHaveLength(1)
    expect(summary).toHaveBeenCalledWith(expect.objectContaining({ counts: expect.objectContaining({ stepCount: 1, toolCallCount: 0 }) }))
  })

  it('在 Hosted 首请求前向 Host 传递当前冻结的授权工具集合，且只 handoff 一次', async () => {
    const providerRouteId = 'desktop-anthropic:hosted-first-request'
    const runtime = getDefaultAgentRuntime()
    const providerStream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, text: 'hosted answer' }
      yield { type: 'usage' as const, inputTokens: 3, outputTokens: 2 }
      yield { type: 'finish' as const, reason: 'stop' as const }
    })
    runtime.modelProviders.register({ routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514' }, { providerId: 'hosted-first-request', stream: providerStream })
    const assembled = assembleInvocation(baseMaterials({ providerRouteId }))
    const { invocation, ports } = assembled
    ports.toolRevocations = undefined
    let callCount = 0
    const handoff = vi.fn(async (input: { request: { messages: unknown[] }; authorizedToolNames: ReadonlySet<string> }) => {
      callCount += 1
      expect(input.request.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'hello' })]))
      expect(input.authorizedToolNames).toBeInstanceOf(Set)
      return createHostedTurnHandoff({
        agentSdk: assembled.agentSdk as never,
        history: ports.history!, invocationId: invocation.trace.turnId, turnId: invocation.trace.turnId, routeId: providerRouteId
      })(input as never)
    })

    const result = await runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })

    expect(result).toMatchObject({ ok: true })
    expect(handoff).toHaveBeenCalledOnce()
    expect(callCount).toBe(1)
    expect(providerStream).toHaveBeenCalledTimes(1)
    const history = await ports.history!.read(invocation.trace.turnId)
    expect(history.events.map(({ kind }) => kind)).toContain('invocation-completed')
    expect(history.events.some(({ kind }) => kind === 'model-response-committed')).toBe(true)
  })

  it('向生产调用方保留 Hosted finalized outcome，避免把 interrupted 折叠成普通失败', async () => {
    const providerRouteId = 'desktop-anthropic:hosted-interrupted-error'
    const runtime = getDefaultAgentRuntime()
    runtime.modelProviders.register({ routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514' }, { providerId: 'hosted-interrupted-error', stream: async function* () {
      yield { type: 'finish', reason: 'stop' } as const
    } })
    const assembled = assembleInvocation(baseMaterials({ providerRouteId }))
    const finalized = new HostedTurnFinalizedError(new Error('provider outcome unknown'), 'interrupted')

    await expect(runToolChatSession(assembled.invocation, assembled.ports, {
      onHostedTurnHandoff: async () => { throw finalized }
    })).rejects.toBe(finalized)
  })

  it('Hosted 路由缺失冻结的 current user 时失败关闭，不能回退到 legacy provider', async () => {
    const provider = makeStreamRounds([
      { content: [{ type: 'text', text: 'legacy fallback must not run' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
    ])
    mockCreateAnthropicClient.mockReturnValue(provider)
    const assembled = assembleInvocation(baseMaterials({ currentUserMessageId: 'message-0' }))
    const handoff = vi.fn()

    await expect(runToolChatSession(assembled.invocation, assembled.ports, { onHostedTurnHandoff: handoff }))
      .rejects.toThrow('HOSTED_REQUIRED_USER_NOT_IN_REQUEST')

    expect(handoff).not.toHaveBeenCalled()
    expect(provider.messages.stream).not.toHaveBeenCalled()
  })

  it.each([
    ['with a provider route', 'desktop-anthropic:missing-hosted-handoff'],
    ['without a provider route', undefined]
  ] as const)('requires Hosted handoff %s and never enters the legacy provider loop', async (_label, providerRouteId) => {
    const assembled = assembleInvocation(baseMaterials(providerRouteId ? { providerRouteId } : {}))
    const history = new MemoryHistory()
    assembled.ports.history = history

    await expect(runToolChatSession(assembled.invocation, assembled.ports))
      .rejects.toThrow('HOSTED_HANDOFF_REQUIRED')
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    await expect(history.read('turn-invocation-1')).resolves.toMatchObject({
      events: [expect.objectContaining({ kind: 'invocation-failed', payload: { status: 'failed' } })]
    })
  })

  it('Hosted callback is configured but returns no result: fail closed without legacy provider fallback', async () => {
    const provider = makeStreamRounds([
      { content: [{ type: 'text', text: 'legacy fallback must not run' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
    ])
    mockCreateAnthropicClient.mockReturnValue(provider)
    const assembled = assembleInvocation(baseMaterials())

    await expect(runToolChatSession(assembled.invocation, assembled.ports, {
      onHostedTurnHandoff: async () => undefined
    })).rejects.toThrow('HOSTED_TURN_HANDOFF_MISSING_RESULT')

    expect(provider.messages.stream).not.toHaveBeenCalled()
  })

  it.each(['desktop', 'feishu', 'wechat', 'automation'] as const)(
    'Hosted Runtime composition failure stops the %s lane without legacy provider fallback', async (lane) => {
      const provider = makeStreamRounds([
        { content: [{ type: 'text', text: 'legacy fallback must not run' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
      mockCreateAnthropicClient.mockReturnValue(provider)
      const providerRouteId = `hosted-unavailable:${lane}`
      let hostedProviderCalls = 0
      getDefaultAgentRuntime().modelProviders.register({
        routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model'
      }, { providerId: `unavailable-${lane}`, stream: async function* () {
        hostedProviderCalls += 1
        yield { type: 'text-delta' as const, text: 'SDK provider fallback must not run' }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' as const }
      } })
      const assembled = assembleInvocation(baseMaterials({ lane, providerRouteId }))
      const failure = new Error('Hosted Runtime composition unavailable')
      const handoff = createHostedTurnHandoff({
        agentSdk: { createHostedTurnRuntime: vi.fn(() => { throw failure }) },
        history: assembled.ports.history!,
        invocationId: assembled.invocation.trace.turnId,
        turnId: assembled.invocation.trace.turnId,
        routeId: providerRouteId
      })

      await expect(runToolChatSession(assembled.invocation, assembled.ports, { onHostedTurnHandoff: handoff }))
        .rejects.toThrow('Hosted Runtime composition unavailable')

      expect(provider.messages.stream).not.toHaveBeenCalled()
      expect(hostedProviderCalls).toBe(0)
      expect(getDefaultAgentRuntime().modelProviders.getRoute(providerRouteId)?.providerId).toBe(`unavailable-${lane}`)
      const history = await assembled.ports.history!.read(assembled.invocation.trace.turnId)
      expect(history.events.at(-1)).toMatchObject({ kind: 'invocation-failed', payload: { status: 'failed' } })
      expect(history.events.some((event) => event.kind === 'invocation-completed')).toBe(false)
    }
  )


})

/** 模拟「首轮 output_config 被上游 400 拒绝、去强度后重试成功」的客户端 */
function makeEffortRejectionClient(rounds: Array<{ content: unknown[]; stop_reason: string }>) {
  const calls: Array<Record<string, unknown>> = []
  let call = 0
  return {
    calls,
    messages: {
      stream: vi.fn((params: Record<string, unknown>) => {
        call += 1
        calls.push(params)
        if (call === 1) {
          const rejection = Object.assign(new Error('output_config: Extra inputs are not permitted'), { status: 400 })
          return {
            // AsyncIterator 在首轮迭代时抛 400（for await 捕获路径）
            async *[Symbol.asyncIterator]() {
              throw rejection
            },
            finalMessage: vi.fn(async () => {
              throw rejection
            })
          }
        }
        const round = rounds[Math.min(call - 2, rounds.length - 1)]
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => round)
        }
      })
    }
  }
}

describe('thinking effort 档位与上游降级（§7.3 / §7.4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
    resetEffortMemoForTests()
  })

  it('Hosted output_config fallback memo skips effort on the next invocation before SDK request preparation', async () => {
    const providerRouteId = `hosted-effort-memo-${Date.now()}`
    const runtime = getDefaultAgentRuntime()
    const requests: Array<{ thinking?: { effort?: string } }> = []
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, {
      providerId: 'hosted-effort-memo-provider',
      async *stream(call) {
        requests.push(call.request as { thinking?: { effort?: string } })
        if (requests.length === 1) throw Object.assign(new Error('400 output_config rejected'), { status: 400 })
        yield { type: 'text-delta', text: 'Hosted effort fallback' }
        yield { type: 'usage', inputTokens: 4, outputTokens: 2 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const hostedHistories = new Map<string, HistoryEvent[]>()

    const runHostedInvocation = async (requestId: string) => {
      const { invocation, ports, agentSdk } = assembleInvocation(baseMaterials({
        requestId, sessionId: `session-${requestId}`, turnId: `turn-${requestId}`, providerRouteId,
        effort: 'high', llmServiceId: 'svc-hosted-effort-memo',
        sessionEventLocation: { workDir: '/workspace', sessionId: `session-${requestId}`, createdAt: 1000 }
      }))
      if (!ports.history) throw new Error('expected invocation History')
      const result = await runToolChatSession(invocation, ports, {
        onHostedTurnHandoff: createHostedTurnHandoff({
          agentSdk, history: ports.history, invocationId: `turn-${requestId}`, turnId: `turn-${requestId}`, routeId: providerRouteId,
          recoverProviderAttempt: agentSdk.recoverProviderAttempt
        })
      })
      hostedHistories.set(requestId, (await ports.history.read(`turn-${requestId}`)).events)
      return result
    }

    await expect(runHostedInvocation('req-hosted-effort-first')).resolves.toMatchObject({ ok: true })
    await expect(runHostedInvocation('req-hosted-effort-second')).resolves.toMatchObject({ ok: true })

    expect(requests).toHaveLength(3)
    expect(requests[0]?.thinking?.effort).toBe('high')
    expect(requests[1]?.thinking?.effort).toBeUndefined()
    expect(requests[2]?.thinking?.effort).toBeUndefined()
    const firstEvents = hostedHistories.get('req-hosted-effort-first') ?? []
    const retryIndex = firstEvents.findIndex((event) => event.kind === 'provider-retry-scheduled')
    const retryRequestIndex = firstEvents.findIndex((event) => event.kind === 'model-request-started' && event.payload.attempt === 2)
    const retry = firstEvents[retryIndex]
    expect(retry?.payload).toMatchObject({
      requestId: 'turn-req-hosted-effort-first:round:1', code: 'effort_unsupported',
      sessionLedger: { requestRetry: { requestId: 'turn-req-hosted-effort-first:round:1', code: 'effort_unsupported', attempt: 1 } }
    })
    expect(retryIndex).toBeGreaterThan(-1)
    expect(retryRequestIndex).toBeGreaterThan(retryIndex)
    expect(capturedSessionEvents).toContainEqual(expect.objectContaining({
      type: 'request_retry', payload: expect.objectContaining({ requestId: 'turn-req-hosted-effort-first:round:1', code: 'effort_unsupported' })
    }))
    expect(hostedHistories.get('req-hosted-effort-second')?.some((event) => event.kind === 'provider-retry-scheduled')).toBe(false)
    expect(vi.mocked(logAgentEvent).mock.calls.filter((call) => call[1] === 'llm.effort.unsupported_memoized')).toHaveLength(1)
  })

})
