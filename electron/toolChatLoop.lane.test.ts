import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockGetCachedMemoryContent = vi.fn(() => null)

let mcpSnapshotEntries: Map<string, unknown> = new Map()

const MCP_PROFILE = {
  id: 'server-1',
  name: 'GitHub',
  enabled: true,
  transport: 'stdio',
  timeoutSec: 60,
  auth: { mode: 'none', secretPresent: false },
  stdio: { command: 'node', args: ['server.js'], env: [] },
  enabledToolNames: ['create_issue'],
  status: 'connected',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z'
}

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: () => mockGetCachedMemoryContent() }
})


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
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return { ...actual, getRegisteredTool: vi.fn(() => undefined), getToolExecutor: vi.fn(() => undefined) }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved')
}))

// 与真实实现同语义：remoteContext=true（非 desktop lane）→ 空 snapshot
vi.mock('./mcp/mcpToolRegistry', () => ({
  buildSnapshotFromDb: vi.fn((_db: unknown, opts?: { remoteContext?: boolean }) =>
    opts?.remoteContext
      ? { entries: new Map(), budgetDropped: [] }
      : { entries: mcpSnapshotEntries, budgetDropped: [] }
  ),
  snapshotEntriesToAnthropicTools: vi.fn((entries: Array<{ mappedName: string; serverName: string; description: string; inputSchema: unknown }>) =>
    entries.map((e) => ({
      name: e.mappedName,
      description: `外部 MCP 服务「${e.serverName}」提供的工具`,
      input_schema: e.inputSchema
    }))
  )
}))

vi.mock('./mcp/mcpConfigStore', () => ({
  listProfiles: vi.fn(() => [MCP_PROFILE])
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getSession: vi.fn(() => undefined) }
})

import { runToolChatSession } from './toolChatLoop'
import { registerChatCancel } from './chatCancelRegistry'
import { assembleInvocation } from './runtime/invocationAssembler'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { createAgentRuntime } from './runtime/agentRuntime'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { TypedToolRegistry } from './tools/plannedToolRegistry'
import { createHostedTurnHandoff } from './runtime/hostedTurnHandoff'

/** P1：直调 Core 的测试适配——材料经装配器构造 Invocation + ports（断言不动，仅调用方式平移）。 */
function runAssembledSession(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}
import { createMemoryAppDb } from './database/testHelpers'

function makeMcpSnapshotEntry() {
  return {
    mappedName: 'mcp1_create_issue',
    serverId: 'server-1',
    serverName: 'GitHub',
    originalName: 'create_issue',
    description: 'create issue',
    inputSchema: { type: 'object', properties: {} }
  }
}

describe('runToolChatSession lane 穿透（偏差 21：MCP 仅 desktop lane 注入）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpSnapshotEntries = new Map([['mcp1_create_issue', makeMcpSnapshotEntry()]])
    mockGetCachedMemoryContent.mockReturnValue(null)
  })

  async function run(lane: 'desktop' | 'feishu' | 'wechat' | 'automation' = 'desktop', withTool = false) {
    const requestId = `req-lane-${lane}-${withTool ? 'tool' : 'visibility'}`
    const sessionId = `sess-lane-${lane}-${withTool ? 'tool' : 'visibility'}`
    const providerRouteId = `desktop-anthropic:mcp-visibility-${lane}-${withTool ? 'tool' : 'visibility'}`
    const previousRuntime = getDefaultAgentRuntime()
    const toolRegistry = new TypedToolRegistry()
    if (withTool) {
      const { defineDirectTool } = await import('./tools/plannedToolRegistry')
      toolRegistry.register(defineDirectTool({
        name: 'list_work_dirs', actionClass: 'read', parseInput: (raw) => raw as Record<string, never>,
        execute: async () => ({ success: true, data: 'file-content' })
      }))
    }
    const runtime = createAgentRuntime({ builtinRegistry: toolRegistry as never, toolRevocations: new ToolRevocationRegistry() })
    setDefaultAgentRuntime(runtime)
    const capturedTools: Array<Array<{ name?: string }>> = []
    const requestMessages: unknown[][] = []
    let providerTurn = 0
    runtime.modelProviders.register({
      routeId: providerRouteId, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
    }, { providerId: `mcp-visibility-${lane}-${withTool ? 'tool' : 'visibility'}`, async *stream(call) {
      capturedTools.push(call.request.tools ?? [])
      requestMessages.push([...call.request.messages])
      providerTurn += 1
      if (withTool && providerTurn === 1) {
        yield { type: 'tool-call', toolCallId: 'history-context-tool', toolName: 'list_work_dirs', input: {} }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text-delta', text: 'complete' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    } })
    try {
      const { invocation, ports, agentSdk } = assembleInvocation({
        requestId, sessionId, turnId: `turn-${requestId}`, lane,
        model: 'claude-sonnet-4-20250514', providerRouteId,
        messages: [{ id: 'input-user', role: 'user', content: 'persist me' }], currentUserMessageId: 'input-user',
        toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key',
        appDb: createMemoryAppDb('zh-CN') as unknown as AppDatabase,
        emitFactEvent: () => undefined, emitSessionEvent: async () => undefined
      } as never)
      ports.toolRevocations = undefined
      vi.mocked(registerChatCancel).mockReturnValue(new AbortController().signal as never)
      const hostedAgentSdk = {
        ...agentSdk,
        createHostedTurnRuntime: (input: Parameters<typeof agentSdk.createHostedTurnRuntime>[0]) =>
          agentSdk.createHostedTurnRuntime({
            ...input,
            registry: toolRegistry,
            confirmationAdapter: {
              cancel: () => undefined,
              publish: () => undefined,
              createChannel: () => ({
                request: async () => ({ kind: 'approved', cause: 'user-approved' }),
                cancel: () => undefined
              })
            } as never
          })
      }
      const handoff = createHostedTurnHandoff({
        agentSdk: hostedAgentSdk as never, history: ports.history!, invocationId: invocation.trace.requestId,
        turnId: invocation.trace.turnId, routeId: providerRouteId
      })
      const result = await runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff })
      const history = await ports.history!.read(requestId)
      return { result, history, tools: capturedTools.flatMap((tools) => tools.map((tool) => tool.name)), requestMessages }
    } finally {
      setDefaultAgentRuntime(previousRuntime)
    }
  }

  it('desktop lane：MCP 工具注入', async () => {
    const { tools } = await run('desktop')
    expect(tools).toContain('mcp1_create_issue')
  })

  it('automation lane：MCP 工具不注入（保持「远程与 automation 无 MCP」语义）', async () => {
    const { tools } = await run('automation')
    expect(tools).not.toContain('mcp1_create_issue')
  })

  it.each(['desktop', 'feishu', 'wechat', 'automation'] as const)('%s Hosted lane persists provider context and rebuilds its request from History', async (lane) => {
    const { result, history, requestMessages } = await run(lane, true)
    expect(result).toMatchObject({ ok: true })
    expect(history.events[0]).toMatchObject({
      kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', content: 'persist me' }], requiredUserMessage: { id: 'input-user' } }
    })
    expect(requestMessages[1]?.filter((message) => (message as { role?: string }).role !== 'system')).toEqual([
      { role: 'user', content: 'persist me' },
      { role: 'assistant', toolCalls: [{ id: 'history-context-tool', name: 'list_work_dirs', input: {} }] },
      expect.objectContaining({ role: 'tool', toolCallId: 'history-context-tool' })
    ])
    const toolOutcome = history.events.find(({ kind, payload }) =>
      (kind === 'tool-call-finished' || kind === 'tool-call-not-dispatched') &&
      (payload as { toolCallId?: string }).toolCallId === 'history-context-tool'
    )
    expect(toolOutcome).toBeDefined()
  })
})
