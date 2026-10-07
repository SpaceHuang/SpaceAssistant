/**
 * P1-2 / P1-3 验收（管家链路现行伤害修复）：
 *  - 拒绝理由回传：ConfirmOutcome.reason.summary 渲染进模型可见工具结果；
 *  - 计数口径分离：安全拒绝仍按既有阈值处理，普通执行失败交回模型且不按自然语言文本中止。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { ConfirmOutcome, ContentFacts, Decision, SecurityAuditEvent } from '../src/shared/confirmation/types'
import type { ToolCallGateResult } from './confirmation/toolCallGate'

const mockChannelOutcome = vi.fn((): ConfirmOutcome => ({ kind: 'approved', cause: 'user-approved' }))
const capturedAuditEvents: SecurityAuditEvent[] = []
const capturedStreamParams: Array<{ messages: unknown[] }> = []

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
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
  countVisibleTitleMessagesForSuggest: vi.fn(() => 0),
  reachedCumulativeMessagesForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(() => new AbortController().signal),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved' as const)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) =>
      name === 'write_file' ? { name, execute: async () => ({ success: true, data: 'written' }) } : undefined
    )
  }
})

vi.mock('./confirmation/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/audit')>()
  return {
    ...actual,
    getSecurityAuditLog: vi.fn(() => ({ record: (e: SecurityAuditEvent) => capturedAuditEvents.push(e) }))
  }
})

vi.mock('./confirmation/channels', () => ({
  channelFor: vi.fn(() => ({
    request: async (): Promise<ConfirmOutcome> => mockChannelOutcome(),
    cancel: vi.fn()
  }))
}))

const SAFETY_SUMMARY = '审批拒绝：该写操作超出安全边界，请改用只读方式或缩小范围'
const SR_SESSION = 'sess-safety-reject'

const SR_FACTS: ContentFacts = {
  toolName: 'write_file',
  actionClass: 'write',
  baseRiskLevel: 'medium',
  signals: [{ kind: 'path-target', path: 'out.txt', zone: 'workdir-normal' }],
  summary: { text: 'write_file out.txt' }
}

const SR_DECISION: Decision = {
  type: 'require-confirm',
  ruleId: 'automation-default-confirm',
  answerer: 'agent',
  riskLevel: 'medium',
  facts: SR_FACTS,
  memoryTiers: [],
  timeoutMs: null
}

vi.mock('./confirmation/toolCallGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/toolCallGate')>()
  return {
    ...actual,
    evaluateToolCallGate: vi.fn(async (): Promise<ToolCallGateResult> => ({
      decision: SR_DECISION,
      facts: SR_FACTS
    }))
  }
})

const mockCreateAnthropicClient = vi.fn()

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

import { runToolChatSession } from './toolChatLoop'
import { registerChatCancel } from './chatCancelRegistry'
import { assembleInvocation } from './testSupport/invocationAssembler'
import { createAgentRuntime } from './runtime/agentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { createHostedTurnHandoff } from './runtime/hostedTurnHandoff'
import { InvocationRuntime } from '../packages/agent-sdk/src/scheduler'
import { MemoryHistory } from '../packages/agent-sdk/src/history'

/** P1：直调 Core 的测试适配——材料经装配器构造 Invocation + ports（断言不动，仅调用方式平移）。 */
function runAssembledSession(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  // 该用例用 mock bare executor 覆盖旧 loop 行为，不代表 production runtime host。
  ports.toolRevocations = undefined
  return runToolChatSession(invocation, ports)
}
import { createMemoryAppDb } from './database/testHelpers'

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

/** 前_SAFE_ROUNDS 轮持续发起同一写操作，之后模型收敛为文本答复。 */
const SAFE_ROUNDS = 3
let streamRound = 0
function installStreamClient() {
  streamRound = 0
  capturedStreamParams.length = 0
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn((params: { messages: unknown[] }) => {
        capturedStreamParams.push({ messages: params.messages })
        const round =
          streamRound < SAFE_ROUNDS
            ? {
                content: [
                  {
                    type: 'tool_use',
                    id: `toolu-sr-${streamRound}`,
                    name: 'write_file',
                    input: { path: 'out.txt', content: 'x' }
                  }
                ],
                stop_reason: 'tool_use'
              }
            : {
                content: [{ type: 'text', text: '已完成：部分工作因安全拒绝未能执行' }],
                stop_reason: 'end_turn'
              }
        streamRound += 1
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => round)
        }
      })
    }
  })
}

function baseArgs(db: AppDatabase) {
  return {
    requestId: 'req-safety-reject',
    sessionId: SR_SESSION,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'http://localhost:9999',
    messages: [{ role: 'user' as const, content: 'please write' }],
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: db,
    historyForSession: () => new MemoryHistory(),
    emitFactEvent: () => undefined,
    emitSessionEvent: () => undefined
  } as Parameters<typeof runToolChatSession>[0]
}

describe('P1 安全拒绝理由回传与计数口径分离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    mockChannelOutcome.mockImplementation(() => ({
      kind: 'rejected',
      answererKind: 'agent',
      cause: 'agent-deny',
      reason: { summary: SAFETY_SUMMARY }
    }) satisfies ConfirmOutcome)
  })

  it('不同 session 的相同 requestId 可在同一 InvocationRuntime 中并发执行', async () => {
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createAgentRuntime({ invocationRuntime: new InvocationRuntime('shared-request-id-regression') })
    setDefaultAgentRuntime(runtime)
    const providerRouteId = 'desktop-anthropic:shared-request-id-regression'
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted: (() => void) | undefined
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'shared-request-id-regression', async *stream() {
      if (firstStarted) {
        const markStarted = firstStarted
        firstStarted = undefined
        markStarted()
        await firstBlocked
      }
      yield { type: 'text-delta' as const, text: 'answer' }
      yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish' as const, reason: 'stop' as const }
    } })

    const handoffFor = (assembled: ReturnType<typeof assembleInvocation>) => createHostedTurnHandoff({
      agentSdk: assembled.agentSdk as never, history: assembled.ports.history!,
      invocationId: assembled.invocation.trace.turnId!, turnId: assembled.invocation.trace.turnId!, routeId: providerRouteId
    })
    const first = assembleInvocation({ ...baseArgs(makeDb()), requestId: 'shared-request', sessionId: 'session-a', turnId: 'turn-a', providerRouteId } as never)
    const second = assembleInvocation({ ...baseArgs(makeDb()), requestId: 'shared-request', sessionId: 'session-b', turnId: 'turn-b', providerRouteId } as never)

    try {
      const firstRun = runToolChatSession(first.invocation, first.ports, { onHostedTurnHandoff: handoffFor(first) })
      await firstStartedPromise
      await expect(runToolChatSession(second.invocation, second.ports, { onHostedTurnHandoff: handoffFor(second) })).resolves.toMatchObject({ ok: true })
      expect(vi.mocked(registerChatCancel).mock.calls).toEqual([['turn-a'], ['turn-b']])
      releaseFirst()
      await expect(firstRun).resolves.toMatchObject({ ok: true })
    } finally {
      releaseFirst()
      setDefaultAgentRuntime(previousRuntime)
    }
  })

  it('连续 3 次同类安全拒绝不中止 Turn：模型在第 4 轮收敛并看到拒绝理由', async () => {
    const { defineDirectTool, TypedToolRegistry } = await import('./tools/plannedToolRegistry')
    const providerRouteId = 'desktop-anthropic:safety-reject-rounds'
    const runtime = getDefaultAgentRuntime()
    const execute = vi.fn(async () => ({ success: true, data: 'must not run' }))
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(defineDirectTool({
      name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, execute
    }))
    const providerCalls: Array<{ messages: unknown[] }> = []
    let providerTurn = 0
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'safety-reject-rounds', async *stream(call) {
      providerCalls.push({ messages: call.request.messages })
      providerTurn += 1
      if (providerTurn <= SAFE_ROUNDS) {
        yield { type: 'tool-call', toolCallId: `toolu-sr-${providerTurn}`, toolName: 'write_file', input: { path: 'out.txt', content: 'x' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: '已完成：部分工作因安全拒绝未能执行' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const materials = { ...baseArgs(makeDb()), providerRouteId }
    const assembled = assembleInvocation(materials as never)
    assembled.ports.toolRevocations = undefined
    vi.mocked(registerChatCancel).mockReturnValue(new AbortController().signal as never)
    const agentSdk = {
      ...assembled.agentSdk,
      createHostedTurnRuntime: (input: Parameters<typeof assembled.agentSdk.createHostedTurnRuntime>[0]) =>
        assembled.agentSdk.createHostedTurnRuntime({ ...input, registry: toolRegistry })
    }
    const handoff = createHostedTurnHandoff({
      agentSdk: agentSdk as never, history: assembled.ports.history!,
      invocationId: assembled.invocation.trace.requestId, turnId: assembled.invocation.trace.turnId,
      routeId: providerRouteId
    })
    const res = await runToolChatSession(assembled.invocation, assembled.ports, { onHostedTurnHandoff: handoff })
    expect(res.ok).toBe(true)
    // 第四次真实 Hosted provider request 发生，即前三次拒绝均作为工具结果交回模型。
    expect(providerCalls).toHaveLength(SAFE_ROUNDS + 1)
    // 理由回传：第 2 轮起模型可见的 tool_result 中携带 reason.summary 渲染文案（旧代码为固定「用户拒绝执行此工具」→ 红）
    const secondRoundMessages = providerCalls[1]!.messages
    const serialized = JSON.stringify(secondRoundMessages)
    expect(serialized).toContain(SAFETY_SUMMARY)
    expect(serialized).not.toContain('用户拒绝执行此工具')
    expect(execute).not.toHaveBeenCalled()
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
  })

  it('连续 5 次同类安全拒绝后按既有安全阈值终止 Turn', async () => {
    const { defineDirectTool, TypedToolRegistry } = await import('./tools/plannedToolRegistry')
    const providerRouteId = 'desktop-anthropic:safety-reject-threshold'
    const runtime = getDefaultAgentRuntime()
    const execute = vi.fn(async () => ({ success: true, data: 'must not run' }))
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(defineDirectTool({
      name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, execute
    }))
    let providerCalls = 0
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'safety-reject-threshold', async *stream() {
      providerCalls += 1
      if (providerCalls <= 5) {
        yield { type: 'tool-call', toolCallId: `toolu-safety-${providerCalls}`, toolName: 'write_file', input: { path: 'out.txt', content: 'x' } }
      } else {
        yield { type: 'text-delta', text: 'blocked' }
      }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: providerCalls <= 5 ? 'tool-calls' : 'stop' }
    } })
    const assembled = assembleInvocation({ ...baseArgs(makeDb()), providerRouteId } as never)
    assembled.ports.toolRevocations = undefined
    vi.mocked(registerChatCancel).mockReturnValue(new AbortController().signal as never)
    const agentSdk = {
      ...assembled.agentSdk,
      createHostedTurnRuntime: (input: Parameters<typeof assembled.agentSdk.createHostedTurnRuntime>[0]) =>
        assembled.agentSdk.createHostedTurnRuntime({ ...input, registry: toolRegistry })
    }
    const handoff = createHostedTurnHandoff({
      agentSdk: agentSdk as never, history: assembled.ports.history!,
      invocationId: assembled.invocation.trace.requestId, turnId: assembled.invocation.trace.turnId,
      routeId: providerRouteId
    })
    const result = await runToolChatSession(assembled.invocation, assembled.ports, { onHostedTurnHandoff: handoff })
    expect(providerCalls).toBe(6)
    expect(result.ok).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('Hosted 写工具在 recheck deny 时不会进入 executor', async () => {
    const { defineDirectTool, TypedToolRegistry } = await import('./tools/plannedToolRegistry')
    const { evaluateToolCallGate } = await import('./confirmation/toolCallGate')
    const execute = vi.fn(async () => ({ success: true, data: 'side effect' }))
    const registeredTool = defineDirectTool({
      name: 'write_file',
      actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string },
      execute
    })
    const previousRuntime = getDefaultAgentRuntime()
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(registeredTool)
    const runtime = createAgentRuntime({
      toolRevocations: new ToolRevocationRegistry(),
      builtinRegistry: toolRegistry as never
    })
    setDefaultAgentRuntime(runtime)
    const providerRouteId = 'desktop-anthropic:safety-recheck-deny'
    vi.mocked(evaluateToolCallGate).mockImplementation(async (args?: { phase?: string }): Promise<ToolCallGateResult> =>
      args?.phase === 'recheck'
        ? { decision: { type: 'deny', ruleId: 'recheck-deny', reason: 'policy changed' }, facts: SR_FACTS }
        : { decision: { type: 'auto-allow', ruleId: 'initial-allow', reason: 'initial allow' }, facts: SR_FACTS }
    )
    let providerTurn = 0
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'safety-recheck-deny', async *stream() {
      providerTurn += 1
      if (providerTurn === 1) {
        yield { type: 'tool-call', toolCallId: 'toolu-recheck-denied', toolName: 'write_file', input: { path: 'out.txt', content: 'x' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: 'blocked' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })

    try {
      const materials = { ...baseArgs(makeDb()), providerRouteId }
      const { invocation, ports, agentSdk } = assembleInvocation(materials as never)
      ports.toolRevocations = undefined
      vi.mocked(registerChatCancel).mockReturnValue(new AbortController().signal as never)
      const handoff = createHostedTurnHandoff({
        agentSdk: agentSdk as never, history: ports.history!, invocationId: invocation.trace.requestId,
        turnId: invocation.trace.turnId, routeId: providerRouteId
      })
      await expect(runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })).resolves.toMatchObject({ ok: true })
      expect(vi.mocked(evaluateToolCallGate).mock.calls.map(([gateArgs]) => gateArgs?.phase ?? 'initial')).toEqual(['initial', 'recheck'])
      expect(execute).not.toHaveBeenCalled()
      expect(providerTurn).toBe(2)
    } finally {
      vi.mocked(evaluateToolCallGate).mockImplementation(async (): Promise<ToolCallGateResult> => ({
        decision: SR_DECISION,
        facts: SR_FACTS
      }))
      setDefaultAgentRuntime(previousRuntime)
    }
  })

  it('普通同文执行错误交回模型，由模型轮次上限而非文本重复立即终止', async () => {
    mockChannelOutcome.mockImplementation(() => ({ kind: 'approved', cause: 'user-approved' }) satisfies ConfirmOutcome)
    const { defineDirectTool, TypedToolRegistry } = await import('./tools/plannedToolRegistry')
    const providerRouteId = 'desktop-anthropic:execution-error-threshold'
    const runtime = getDefaultAgentRuntime()
    const execute = vi.fn(async () => ({ success: false, error: 'EACCES: permission denied', userMessage: 'EACCES: permission denied' }))
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(defineDirectTool({
      name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string }, execute
    }))
    const providerCalls: unknown[] = []
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'execution-error-threshold', async *stream(call) {
      providerCalls.push(call)
      if (providerCalls.length <= 4) {
        yield { type: 'tool-call', toolCallId: `toolu-error-${providerCalls.length}`, toolName: 'write_file', input: { path: 'out.txt', content: 'x' } }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: 'done' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    const assembled = assembleInvocation({ ...baseArgs(makeDb()), providerRouteId } as never)
    assembled.ports.toolRevocations = undefined
    vi.mocked(registerChatCancel).mockReturnValue(new AbortController().signal as never)
    const agentSdk = {
      ...assembled.agentSdk,
      createHostedTurnRuntime: (input: Parameters<typeof assembled.agentSdk.createHostedTurnRuntime>[0]) =>
        assembled.agentSdk.createHostedTurnRuntime({ ...input, registry: toolRegistry })
    }
    const handoff = createHostedTurnHandoff({
      agentSdk: agentSdk as never, history: assembled.ports.history!,
      invocationId: assembled.invocation.trace.requestId, turnId: assembled.invocation.trace.turnId,
      routeId: providerRouteId
    })
    const result = await runToolChatSession(assembled.invocation, assembled.ports, { onHostedTurnHandoff: handoff })
    expect(providerCalls).toHaveLength(5)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(result.ok).toBe(true)
  })

  it('同一模型回合不同路径的错误均结算，Turn 不因第三个结果提前终止', async () => {
    mockChannelOutcome.mockImplementation(() => ({ kind: 'approved', cause: 'user-approved' }) satisfies ConfirmOutcome)
    const { defineDirectTool, TypedToolRegistry } = await import('./tools/plannedToolRegistry')
    const executions: string[] = []
    const toolRegistry = new TypedToolRegistry()
    toolRegistry.register(defineDirectTool({
      name: 'write_file', actionClass: 'write',
      parseInput: (raw) => raw as { path: string; content: string },
      execute: async (input) => {
        executions.push(input.path)
        return { success: false, error: 'EACCES: permission denied', userMessage: 'EACCES: permission denied' }
      }
    }))
    const providerRouteId = 'desktop-anthropic:same-turn-error-threshold'
    const previousRuntime = getDefaultAgentRuntime()
    const runtime = createAgentRuntime({ toolRevocations: new ToolRevocationRegistry(), builtinRegistry: toolRegistry as never, toolExecutionConcurrency: 1 })
    setDefaultAgentRuntime(runtime)
    let providerCalls = 0
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: 'same-turn-error-threshold', async *stream() {
      providerCalls += 1
      for (let index = 0; providerCalls === 1 && index < 4; index += 1) {
        yield { type: 'tool-call', toolCallId: `toolu-stop-${index}`, toolName: 'write_file', input: { path: `out-${index}.txt`, content: 'x' } }
      }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      if (providerCalls > 1) yield { type: 'text-delta', text: 'done' }
      yield { type: 'finish', reason: providerCalls === 1 ? 'tool-calls' : 'stop' }
    } })
    try {
      const materials = { ...baseArgs(makeDb()), providerRouteId, toolExecutionConcurrency: 1 }
      const { invocation, ports, agentSdk } = assembleInvocation(materials as never)
      ports.toolRevocations = undefined
      vi.mocked(registerChatCancel).mockReturnValue(new AbortController().signal as never)
      const handoff = createHostedTurnHandoff({
        agentSdk: agentSdk as never, history: ports.history!, invocationId: invocation.trace.requestId,
        turnId: invocation.trace.turnId, routeId: providerRouteId
      })
      const result = await runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })
      expect(providerCalls).toBe(2)
      expect(executions).toHaveLength(4)
      expect(result.ok).toBe(true)
    } finally {
      setDefaultAgentRuntime(previousRuntime)
    }
  })
})
