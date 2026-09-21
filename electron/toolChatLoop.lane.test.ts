import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()

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

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
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
import { assembleInvocation } from './runtime/invocationAssembler'

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

  async function run(lane?: 'desktop' | 'automation') {
    const capturedTools: Array<{ tools?: Array<{ name?: string }> }> = []
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn((params: { tools?: Array<{ name?: string }> }) => {
          capturedTools.push(params)
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => ({
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 }
            }))
          }
        })
      }
    })
    await runAssembledSession({
      requestId: 'req-lane-1',
      sessionId: 'sess-lane-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      appDb: createMemoryAppDb('zh-CN') as unknown as AppDatabase,
      emitFactEvent: () => undefined,
      emitSessionEvent: async () => undefined,
      ...(lane ? { lane } : {})
    } as never)
    return capturedTools.flatMap((c) => (c.tools ?? []).map((t) => t.name))
  }

  it('desktop lane：MCP 工具注入', async () => {
    const names = await run('desktop')
    expect(names).toContain('mcp1_create_issue')
  })

  it('automation lane：MCP 工具不注入（保持「远程与 automation 无 MCP」语义）', async () => {
    const names = await run('automation')
    expect(names).not.toContain('mcp1_create_issue')
  })
})
