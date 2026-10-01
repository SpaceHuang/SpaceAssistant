import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { McpToolSnapshot } from './mcp/mcpToolRegistry'
import type { ToolExecutor } from './tools/types'

/**
 * MCP 工具延迟加载（Phase 1）端到端：装配接线 / FR3 授权面 / 检索往返 / 兜底直调观测（AD10/B4）。
 * provider 用真实 modelProviders 注册的测试 provider；工具分发走真实 builtinRegistry（tool_search）。
 */

const mockChatCancelState = vi.hoisted(() => ({ controller: undefined as AbortController | undefined }))
const capturedFacts: Array<Record<string, unknown>> = []
const capturedSessionEvents: Array<Record<string, unknown>> = []

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: () => null }
})

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: () => ({ stream: () => undefined }),
  createAnthropicClient: vi.fn()
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

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(async () => 'approved' as const),
  waitForToolConfirm: vi.fn(async () => 'approved' as const)
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getSession: vi.fn(() => undefined) }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation, type AgentInvocationMaterials } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'
import { logAgentEvent } from './agentLogger/agentLogger'
import { MemoryHistory } from '../packages/agent-sdk/src/history'
import { createAgentRuntime } from './runtime/agentRuntime'
import { getDefaultAgentRuntime, resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from './tools/builtinExecutors'
import { ConfirmIdSpace } from './remote/confirmId'
import { ChatCancelRegistry } from './chatCancelRegistry'
import { McpConcurrencyGate } from './mcp/mcpToolExecutor'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { createHostedTurnHandoff } from './runtime/hostedTurnHandoff'
import { throwIfChatCancelled } from './chatCancelRegistry'
import type { ModelProviderRegistry } from '../packages/agent-sdk/src/model'
import type { McpConnectionManager } from './mcp/mcpConnectionManager'

const MCP_TOOL = 'mcp_docs_search_1'

function makeSnapshot(): McpToolSnapshot {
  return {
    entries: new Map([[
      MCP_TOOL,
      { serverId: 'srvDocs', serverName: 'Docs', originalName: 'search', mappedName: MCP_TOOL, description: 'Search docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
    ]]),
    budgetDropped: []
  }
}

function makeMcpPorts(snapshot: McpToolSnapshot) {
  const executor: ToolExecutor = {
    name: MCP_TOOL,
    execute: vi.fn(async () => ({ success: true, data: { result: 'doc-hit' } }))
  }
  return {
    executor,
    ports: {
      snapshot,
      resolveExecutor: vi.fn((name: string, _manager: McpConnectionManager) => name === MCP_TOOL ? executor : undefined),
      executorDatabase: createMemoryAppDb('zh-CN')
    }
  }
}

function baseMaterials(overrides: Partial<AgentInvocationMaterials> = {}): AgentInvocationMaterials {
  return {
    requestId: 'req-deferred-1',
    sessionId: 'sess-deferred-1',
    turnId: 'turn-deferred-1',
    llmServiceId: 'svc-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }] as never,
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: createMemoryAppDb('zh-CN'),
    sessionEventLocation: { workDir: '/tmp', sessionId: 'sess-deferred-1', createdAt: 1234 },
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async (event: Record<string, unknown>) => { capturedSessionEvents.push(event) },
    ...overrides
  }
}

type ProviderCall = { route: Record<string, unknown>; request: { messages: Array<Record<string, unknown>>; tools: Array<{ name: string }> } }

function systemOf(call: ProviderCall): string {
  return call.request.messages
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content ?? ''))
    .join('\n')
}

function registerProvider(routeId: string, rounds: Array<{ calls: Array<{ toolName: string; input: Record<string, unknown> }> }>): { providerCalls: ProviderCall[] } {
  const runtime = getDefaultAgentRuntime()
  const providerCalls: ProviderCall[] = []
  let turn = 0
  runtime.modelProviders.register({    routeId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
    adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
  }, {
    providerId: 'deferred-test-provider',
    async *stream(call) {
      providerCalls.push(call as never)
      const round = rounds[Math.min(turn, rounds.length - 1)]
      turn += 1
      for (const callSpec of round.calls) {
        yield { type: 'tool-call', toolCallId: `tc-${turn}-${callSpec.toolName}`, toolName: callSpec.toolName, input: callSpec.input }
      }
      yield { type: 'usage', inputTokens: 5, outputTokens: 3 }
      yield { type: 'finish', reason: round.calls.length > 0 ? 'tool-calls' : 'stop' }
    }
  })
  return { providerCalls }
}

async function runWith(materials: AgentInvocationMaterials, mcpPorts: ReturnType<typeof makeMcpPorts>['ports']) {
  const assembled = assembleInvocation(materials)
  const { invocation, ports } = assembled
  ports.toolRevocations = undefined
  ports.mcp = mcpPorts
  const handoff = createHostedTurnHandoff({
    agentSdk: assembled.agentSdk as never, history: ports.history!, invocationId: invocation.trace.turnId,
    turnId: invocation.trace.turnId, routeId: materials.providerRouteId!, recoverProviderAttempt: assembled.agentSdk.recoverProviderAttempt
  })
  const result = await runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })
  return { result, history: ports.history! }
}

describe('MCP 工具延迟加载（Phase 1 装配接线）', () => {
  beforeAll(() => {
    // 本文件需要真实 builtinRegistry（tool_search 执行 + MCP hosted 注册表枚举）
    resetDefaultAgentRuntimeForTests()
    setDefaultAgentRuntime(createAgentRuntime({
      confirmIds: new ConfirmIdSpace(),
      chatCancels: new ChatCancelRegistry(),
      toolRevocations: new ToolRevocationRegistry(),
      mcpGate: new McpConcurrencyGate(),
      builtinRegistry: createBuiltinToolRegistry()
    }))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(throwIfChatCancelled).mockImplementation(() => undefined)
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
  })

  it('always 档：检索→调用往返成功，tools 不含延迟名而 system 含索引区块（FR1/FR2/FR3/10.1.3/10.1.4）', async () => {
    const routeId = 'route-deferred-roundtrip'
    const { providerCalls } = registerProvider(routeId, [
      { calls: [{ toolName: 'tool_search', input: { query: 'search' } }] },
      { calls: [{ toolName: MCP_TOOL, input: { query: 'x' } }] },
      { calls: [] }
    ])
    const { executor, ports: mcpPorts } = makeMcpPorts(makeSnapshot())
    const { result } = await runWith(baseMaterials({
      providerRouteId: routeId,
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'always' }
    }), mcpPorts)

    expect(result.ok).toBe(true)
    // FR2：延迟模式广告面 = 内置（含 tool_search）+ 无 MCP 工具
    const firstTools = providerCalls[0]!.request.tools.map((t) => t.name)
    expect(firstTools).toContain('tool_search')
    expect(firstTools).not.toContain(MCP_TOOL)
    // FR1：system 含索引区块（头部计数）与 FR7 约定 hint
    const system = systemOf(providerCalls[0]!)
    expect(system).toContain('MCP 工具索引')
    expect(system).toContain('共 1 个工具')
    expect(system).toContain('tool_search')
    // 检索→调用往返：tool_search 结果已回传下一轮（canonical tool 消息，含完整 schema 返回体）
    expect(executor.execute).toHaveBeenCalledOnce()
    const round2Messages = providerCalls[1]!.request.messages
    const toolResultText = JSON.stringify(round2Messages.filter((m) => m.role === 'tool'))
    expect(toolResultText).toContain('input_schema')
    expect(toolResultText).toContain(MCP_TOOL)
  })

  it('兜底直调：执行成功、deferredUnsurfaced 落事件面与持久化面、wire 面结果块不含自定义字段（D2/AD10/B4/10.1.5）', async () => {
    const routeId = 'route-deferred-fallback'
    const { providerCalls } = registerProvider(routeId, [
      { calls: [{ toolName: MCP_TOOL, input: { query: 'x' } }] },
      { calls: [] }
    ])
    const { executor, ports: mcpPorts } = makeMcpPorts(makeSnapshot())
    const { result, history } = await runWith(baseMaterials({
      providerRouteId: routeId,
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'always' }
    }), mcpPorts)

    expect(result.ok).toBe(true)
    // D2 透明兜底：延迟工具未检索直接调用，走正常分发执行成功
    expect(executor.execute).toHaveBeenCalledOnce()
    // AD10 事件面：agentLogger 记录 deferred_unsurfaced
    expect(logAgentEvent).toHaveBeenCalledWith('info', 'tool.deferred_unsurfaced', expect.objectContaining({
      toolName: MCP_TOOL
    }))
    // B4：发给 provider 的 wire 面工具结果块不含 deferredUnsurfaced 自定义字段
    const round2Messages = JSON.stringify(providerCalls[1]!.request.messages)
    expect(round2Messages).not.toContain('deferredUnsurfaced')
    // AD10 持久化面：tool-call-finished 的 sessionLedger.result 携带 deferredUnsurfaced
    const snapshot = await history.read('turn-deferred-1')
    const finished = snapshot.events.find((event) => event.kind === 'tool-call-finished')
    expect(finished).toBeDefined()
    const ledger = (finished!.payload as { sessionLedger?: { result?: Record<string, unknown> } }).sessionLedger
    expect(ledger?.result?.deferredUnsurfaced).toBe(true)
  })

  it('off 档（默认）：现状路径——MCP 工具全量注入广告面（10.1.1）', async () => {
    const routeId = 'route-deferred-off'
    const { providerCalls } = registerProvider(routeId, [{ calls: [] }])
    const { ports: mcpPorts } = makeMcpPorts(makeSnapshot())
    await runWith(baseMaterials({ providerRouteId: routeId }), mcpPorts)

    const tools = providerCalls[0]!.request.tools.map((t) => t.name)
    expect(tools).toContain(MCP_TOOL)
    expect(tools).not.toContain('tool_search')
    const system = systemOf(providerCalls[0]!)
    expect(system).not.toContain('MCP 工具索引')
  })

  it('auto 档小快照：eager 等价路径（FR5）', async () => {
    const routeId = 'route-deferred-auto-eager'
    const { providerCalls } = registerProvider(routeId, [{ calls: [] }])
    const { ports: mcpPorts } = makeMcpPorts(makeSnapshot())
    await runWith(baseMaterials({
      providerRouteId: routeId,
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'auto' }
    }), mcpPorts)

    const tools = providerCalls[0]!.request.tools.map((t) => t.name)
    expect(tools).toContain(MCP_TOOL)
    expect(tools).not.toContain('tool_search')
  })

  it('auto 档超阈值快照：整体转延迟（FR5/D8）', async () => {
    const routeId = 'route-deferred-auto-deferred'
    const { providerCalls } = registerProvider(routeId, [{ calls: [] }])
    const snapshot = makeSnapshot()
    const bigEntry = { ...snapshot.entries.get(MCP_TOOL)!, inputSchema: { type: 'object', properties: { pad: { type: 'string', const: 'x'.repeat(17 * 1024) } } } }
    snapshot.entries.set(MCP_TOOL, bigEntry as never)
    const { ports: mcpPorts } = makeMcpPorts(snapshot)
    await runWith(baseMaterials({
      providerRouteId: routeId,
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'auto' }
    }), mcpPorts)

    const tools = providerCalls[0]!.request.tools.map((t) => t.name)
    expect(tools).not.toContain(MCP_TOOL)
    expect(tools).toContain('tool_search')
  })

  it('被裁工具被拒：文案区分「预算未注入」而非「服务不可用」（FR12②/10.1.14）', async () => {
    const routeId = 'route-deferred-budget-denied'
    const droppedTool = 'mcp_docs_trimmed_9'
    const { providerCalls } = registerProvider(routeId, [
      { calls: [{ toolName: droppedTool, input: {} }] },
      { calls: [] }
    ])
    const { ports: mcpPorts } = makeMcpPorts(makeSnapshot())
    mcpPorts.snapshot.budgetDropped = [{ mappedName: droppedTool, reason: 'bytes' }]
    await runWith(baseMaterials({ providerRouteId: routeId }), mcpPorts)

    const round2Messages = JSON.stringify(providerCalls[1]!.request.messages)
    expect(round2Messages).toContain('预算')
    expect(round2Messages).not.toContain('服务不可用')
  })

  it('幻觉工具名被拒：文案为「服务不可用/已变更」口径（FR12②）', async () => {
    const routeId = 'route-deferred-ghost-denied'
    const { providerCalls } = registerProvider(routeId, [
      { calls: [{ toolName: 'mcp_ghost_never_existed', input: {} }] },
      { calls: [] }
    ])
    const { ports: mcpPorts } = makeMcpPorts(makeSnapshot())
    await runWith(baseMaterials({ providerRouteId: routeId }), mcpPorts)

    const round2Messages = JSON.stringify(providerCalls[1]!.request.messages)
    expect(round2Messages).toContain('不可用')
    expect(round2Messages).not.toContain('预算')
  })
})
