import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { McpServerProfile } from '../src/shared/mcpTypes'

const mockLogAgentEvent = vi.fn()
const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const capturedStreamParams: Array<{ tools?: unknown[]; messages?: unknown[] }> = []
let streamRound = 0

let mcpSnapshotEntries: Map<string, unknown> = new Map()
let mockExecutorResult: { success: boolean; data?: unknown; error?: string } = { success: true, data: 'ok' }

let mockProfiles: McpServerProfile[] = []

const MCP_PROFILE: McpServerProfile = {
  id: 'server-1',
  name: 'GitHub',
  enabled: true,
  transport: 'stdio',
  timeoutSec: 60,
  auth: { mode: 'none', secretPresent: false },
  stdio: { command: 'node', args: ['server.js'], env: [] },
  enabledToolNames: ['create_issue'],
  toolConfirmPolicy: 'always',
  status: 'connected',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z'
}

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: (...args: unknown[]) => mockLogAgentEvent(...args),
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
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('./safeWebContentsSend', () => ({
  isWebContentsAlive: vi.fn(() => true),
  safeWebContentsSend: vi.fn()
}))

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  ChatCancelledError: class ChatCancelledError extends Error {}
}))

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./tools/builtinExecutors', () => ({
  getToolExecutor: vi.fn(() => undefined)
}))

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved')
}))

vi.mock('./mcp/mcpToolRegistry', () => ({
  buildSnapshotFromDb: vi.fn((_db, opts) =>
    opts?.remoteContext
      ? { entries: new Map(), budgetDropped: [] }
      : { entries: mcpSnapshotEntries, budgetDropped: [] }
  ),
  snapshotEntriesToAnthropicTools: vi.fn((entries) =>
    (entries as Array<{ mappedName: string; serverName: string; description: string; inputSchema: unknown }>).map(
      (e) => ({
        name: e.mappedName,
        description: `外部 MCP 服务「${e.serverName}」提供的工具`,
        input_schema: e.inputSchema
      })
    )
  )
}))

vi.mock('./mcp/mcpConnectionManager', () => ({
  McpConnectionManager: class {
    connect = vi.fn()
    disconnect = vi.fn(async () => undefined)
    shutdown = vi.fn(async () => undefined)
  }
}))

vi.mock('./mcp/mcpToolExecutor', () => ({
  createMcpToolExecutor: vi.fn(() => ({
    name: 'mcp-exec',
    execute: vi.fn(async () => mockExecutorResult)
  }))
}))

vi.mock('./mcp/mcpConfigStore', () => ({
  listProfiles: vi.fn(() => mockProfiles)
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { createMemoryAppDb } from './database/testHelpers'

function makeStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start' }
    },
    finalMessage: vi.fn(async () => {
      streamRound += 1
      if (streamRound === 1) {
        return {
          content: [{ type: 'tool_use', id: 'tu-mcp-1', name: 'mcp_github_create_issue_12345678', input: { title: 'x' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 8 }
      }
    })
  }
}

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

async function runSession(overrides: Record<string, unknown> = {}) {
  return runToolChatSession({
    sender: makeSender(),
    requestId: 'req-mcp',
    sessionId: 'sess-mcp',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'use mcp' }],
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: makeDb(),
    locale: 'zh-CN',
    ...overrides
  } as never)
}

function secondRoundToolResults(): Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }> {
  expect(capturedStreamParams.length).toBeGreaterThanOrEqual(2)
  const messages = capturedStreamParams[1]!.messages as Array<{ role: string; content: unknown }>
  const userWithResults = [...messages].reverse().find(
    (m) => m.role === 'user' && Array.isArray(m.content)
  )
  return (userWithResults?.content ?? []) as Array<{
    type: string
    tool_use_id: string
    content: string
    is_error?: boolean
  }>
}

describe('toolChatLoop MCP integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedStreamParams.length = 0
    mcpSnapshotEntries = new Map()
    mockProfiles = [MCP_PROFILE]
    mockExecutorResult = { success: true, data: 'ok' }
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { tools?: unknown[]; messages?: unknown[] }) => {
          capturedStreamParams.push(params)
          return makeStream()
        })
      }
    }))
  })

  it('injects enabled MCP tools into the first request tools param', async () => {
    mcpSnapshotEntries = new Map([
      [
        'mcp_github_create_issue_12345678',
        {
          serverId: 'server-1',
          serverName: 'GitHub',
          originalName: 'create_issue',
          mappedName: 'mcp_github_create_issue_12345678',
          description: 'creates an issue',
          inputSchema: { type: 'object' }
        }
      ]
    ])

    await runSession()

    const tools = capturedStreamParams[0]!.tools as Array<{ name: string; description: string }>
    expect(tools.some((t) => t.name === 'mcp_github_create_issue_12345678')).toBe(true)
    expect(tools.find((t) => t.name === 'mcp_github_create_issue_12345678')?.description).toContain('外部 MCP 服务')
  })

  it('does not inject MCP tools for remote IM sessions', async () => {
    mcpSnapshotEntries = new Map([
      [
        'mcp_github_create_issue_12345678',
        {
          serverId: 'server-1',
          serverName: 'GitHub',
          originalName: 'create_issue',
          mappedName: 'mcp_github_create_issue_12345678',
          description: 'creates an issue',
          inputSchema: { type: 'object' }
        }
      ]
    ])

    await runSession({
      remoteContext: {
        source: 'feishu',
        messageId: 'msg-1',
        confirmPolicy: 'always',
        originSessionId: 'sess-mcp'
      }
    })

    const tools = capturedStreamParams[0]!.tools as Array<{ name: string }>
    expect(tools.some((t) => t.name === 'mcp_github_create_issue_12345678')).toBe(false)
  })

  it('routes mapped MCP tool calls through the MCP executor', async () => {
    mcpSnapshotEntries = new Map([
      [
        'mcp_github_create_issue_12345678',
        {
          serverId: 'server-1',
          serverName: 'GitHub',
          originalName: 'create_issue',
          mappedName: 'mcp_github_create_issue_12345678',
          description: 'creates an issue',
          inputSchema: { type: 'object' }
        }
      ]
    ])
    mockExecutorResult = { success: true, data: { issueId: 1 } }

    const res = await runSession()
    expect(res.ok).toBe(true)

    const results = secondRoundToolResults()
    const block = results.find((b) => b.tool_use_id === 'tu-mcp-1')
    expect(block).toBeDefined()
    expect(JSON.stringify(block!.content)).toContain('issueId')
  })

  it('rejects forged mcp_ names with a safe message', async () => {
    // snapshot 为空：mcp_ 前缀命中伪造名分支
    const res = await runSession()
    expect(res.ok).toBe(true)

    const results = secondRoundToolResults()
    const block = results.find((b) => b.tool_use_id === 'tu-mcp-1')
    expect(block).toBeDefined()
    expect(block!.content).toContain('MCP 工具已变更或服务不可用')
    expect(block!.is_error).toBe(true)
  })

  it('sends mcp metadata with the confirm request and confirms by default', async () => {
    mcpSnapshotEntries = new Map([
      [
        'mcp_github_create_issue_12345678',
        {
          serverId: 'server-1',
          serverName: 'GitHub',
          originalName: 'create_issue',
          mappedName: 'mcp_github_create_issue_12345678',
          description: 'creates an issue',
          inputSchema: { type: 'object' }
        }
      ]
    ])
    const { safeWebContentsSend } = await import('./safeWebContentsSend')

    await runSession()

    const sends = (safeWebContentsSend as unknown as ReturnType<typeof vi.fn>).mock.calls
    const confirmSend = sends.find((call) => call[1] === 'tool:confirm-request')
    expect(confirmSend).toBeDefined()
    const payload = confirmSend![2] as { mcp?: { serverId: string; serverName: string; originalToolName: string } }
    expect(payload.mcp).toMatchObject({
      serverId: 'server-1',
      serverName: 'GitHub',
      originalToolName: 'create_issue'
    })
    expect(payload.mcp?.maskedArgs).toBeDefined()
  })
})
