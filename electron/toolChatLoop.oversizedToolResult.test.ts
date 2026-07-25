import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import {
  OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX,
  formatOversizedToolResultPlaceholder
} from '../src/shared/oversizedToolResult'
import { MAX_TOOL_RESULT_CONTENT_CHARS } from '../src/shared/toolResultLimits'

const mockLogAgentEvent = vi.fn()
const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const capturedStreamParams: Array<{ messages?: unknown[] }> = []
let streamRound = 0
let executorResult: { success: boolean; data?: unknown; error?: string } = {
  success: true,
  data: 'ok'
}

function makeMockStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start' }
    },
    finalMessage: vi.fn(async () => {
      streamRound += 1
      if (streamRound === 1) {
        return {
          content: [{ type: 'tool_use', id: 'tu-oversize', name: 'read_file', input: { path: 'a.txt' } }],
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
  getToolExecutor: vi.fn((name: string) => {
    if (name === 'read_file') {
      return {
        name: 'read_file',
        execute: vi.fn(async () => executorResult)
      }
    }
    return undefined
  })
}))

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => ({ approved: true }))
}))

vi.mock('./tools/toolUserErrors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/toolUserErrors')>()
  return {
    ...actual,
    // Keep raw oversized errors so gate-3 compaction can be asserted on is_error path
    sanitizeToolErrorString: (message: string) => message,
    toToolUserError: (err: unknown) => (err instanceof Error ? err.message : String(err))
  }
})

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { createMemoryAppDb } from './database/testHelpers'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

describe('toolChatLoop oversized tool_result gate 3', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedStreamParams.length = 0
    executorResult = { success: true, data: 'ok' }
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { messages?: unknown[] }) => {
          capturedStreamParams.push(params)
          return makeMockStream()
        })
      }
    }))
  })

  async function runSession() {
    return runToolChatSession({
      sender: makeSender(),
      requestId: 'req-over',
      sessionId: 'sess-over',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'read big' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      appDb: makeDb(),
      locale: 'zh-CN'
    })
  }

  function secondRoundToolResults(): Array<{
    type: string
    tool_use_id: string
    content: string
    is_error?: boolean
  }> {
    expect(capturedStreamParams.length).toBeGreaterThanOrEqual(2)
    const messages = capturedStreamParams[1]!.messages as Array<{
      role: string
      content: unknown
    }>
    const userWithResults = [...messages].reverse().find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result')
    )
    expect(userWithResults).toBeDefined()
    return userWithResults!.content as Array<{
      type: string
      tool_use_id: string
      content: string
      is_error?: boolean
    }>
  }

  it('B7: compresses oversized success tool_result before next stream round', async () => {
    const oversized = 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 20)
    executorResult = { success: true, data: oversized }

    const res = await runSession()
    expect(res.ok).toBe(true)

    const results = secondRoundToolResults()
    const block = results.find((b) => b.tool_use_id === 'tu-oversize')
    expect(block).toBeDefined()
    expect(block!.content).toBe(
      formatOversizedToolResultPlaceholder(oversized.length, MAX_TOOL_RESULT_CONTENT_CHARS)
    )
    expect(block!.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
    expect(block!.is_error).toBeUndefined()
    expect(mockLogAgentEvent).toHaveBeenCalledWith(
      'warn',
      'tool.result.oversized.compacted',
      expect.objectContaining({
        requestId: 'req-over',
        sessionId: 'sess-over',
        toolUseId: 'tu-oversize',
        originalLength: oversized.length
      })
    )
  })

  it('B7: compresses oversized error tool_result while keeping is_error', async () => {
    const oversized = 'e'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS + 7)
    executorResult = { success: false, error: oversized }

    const res = await runSession()
    expect(res.ok).toBe(true)

    const results = secondRoundToolResults()
    const block = results.find((b) => b.tool_use_id === 'tu-oversize')
    expect(block).toBeDefined()
    expect(block!.is_error).toBe(true)
    expect(block!.content.startsWith(OVERSIZED_TOOL_RESULT_PLACEHOLDER_PREFIX)).toBe(true)
    expect(block!.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CONTENT_CHARS)
  })
})
