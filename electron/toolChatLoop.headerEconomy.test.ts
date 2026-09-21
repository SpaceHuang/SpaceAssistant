import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

/**
 * P0-1 双面埋点 + P1-3(b)(c) header 体积治理的集成回归
 * （agent-context-token-cost-optimization-plan §5.2 / §7.2 断言 7–10）：
 * 驱动真实 tool loop 两个请求轮，捕获 request_header 事件，断言——
 * 1. 首个请求写全量 system/tools + 全量 completedToolUseIds，并携带双面埋点字段；
 * 2. 第二个请求（指纹未变）省略 system/tools、checkpoint 只写增量；
 * 3. surfaceSnapshot（指纹/token 计数）在去重后逐字段不变（读取侧等价）。
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0
const capturedSessionEvents: Array<{ type: string; payload: Record<string, unknown> }> = []

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

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
  ChatCancelledError: class ChatCancelledError extends Error {}
}))

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(() => new AbortController().signal),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved' as const)
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getSession: vi.fn(() => undefined) }
})

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getToolExecutor: vi.fn((name: string) => {
      if (name === 'read_file') return actual.readFileExecutor
      return undefined
    })
  }
})

vi.mock('./tools/writeFileAutoApproval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tools/writeFileAutoApproval')>()),
  evaluateFileToolAutoApproval: vi.fn(async () => ({ approve: true as const }))
}))

vi.mock('./safeWebContentsSend', () => ({
  isWebContentsAlive: vi.fn(() => true),
  safeWebContentsSend: vi.fn()
}))

import { runToolChatSession, clearSessionToolResources } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
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

function requestHeaderEvents(): Array<Record<string, unknown>> {
  return capturedSessionEvents.filter((e) => e.type === 'request_header').map((e) => e.payload)
}

describe('P0-1 + P1-3(b)(c)：request_header 埋点与去重（集成）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedSessionEvents.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
  })

  it('两个请求轮：首见全量 → 后续去重 + checkpoint 增量 + 双面埋点齐备', async () => {
    mockCreateAnthropicClient.mockReturnValue(makeStreamRounds([
      { content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 6 } }
    ]))
    const { invocation, ports } = assembleInvocation({
      requestId: 'req-header-economy',
      sessionId: 'sess-header-economy',
      model: 'claude-sonnet-4-20250514',
      messages: [{ id: 'u1', role: 'user', content: 'read a.txt' }],
      currentUserMessageId: 'u1',
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
      workDir: '.',
      userDataDir: '.',
      getApiKey: async () => 'test-key',
      appDb: createMemoryAppDb('zh-CN'),
      emitFactEvent: () => undefined,
      emitSessionEvent: async (event) => {
        capturedSessionEvents.push(event as { type: string; payload: Record<string, unknown> })
      }
    } as never)
    const res = (await runToolChatSession(invocation as never, ports as never)) as { ok: boolean; error?: string }
    expect(res.ok, res.error).toBe(true)

    const headers = requestHeaderEvents()
    expect(headers.length).toBe(2)

    const first = headers[0] as {
      system?: string
      tools?: unknown[]
      toolExecutionCheckpoint: { completedToolUseIds: string[] }
      messagePrefixStats?: Record<string, unknown>
      cacheBreakpoints?: Record<string, unknown>
      surfaceSnapshot: Record<string, unknown>
    }
    // 首见：写全量
    expect(typeof first.system).toBe('string')
    expect(Array.isArray(first.tools)).toBe(true)
    // 首轮无 prev → checkpoint 增量 = 全量
    expect(first.toolExecutionCheckpoint.completedToolUseIds).toEqual([])
    // P0-1 双面埋点字段齐备
    expect(first.messagePrefixStats).toMatchObject({ divergedReason: null, prevItemCount: null })
    expect(first.cacheBreakpoints).toMatchObject({ positions: ['system', 'msg:0'], prevPositions: null, moved: false })

    const second = headers[1] as typeof first & { cacheBreakpoints: { positions: string[]; prevPositions: string[] | null; moved: boolean } }
    // P1-3(b)：指纹未变 → system/tools 省略，指纹引用仍在
    expect(second.system).toBeUndefined()
    expect(second.tools).toBeUndefined()
    expect(second.surfaceSnapshot.systemFingerprint).toBe(first.surfaceSnapshot.systemFingerprint)
    expect(second.surfaceSnapshot.toolsFingerprint).toBe(first.surfaceSnapshot.toolsFingerprint)
    expect(second.surfaceSnapshot.systemTokens).toBe(first.surfaceSnapshot.systemTokens)
    expect(second.surfaceSnapshot.toolsTokens).toBe(first.surfaceSnapshot.toolsTokens)
    // P1-3(c)：checkpoint 增量——本轮新增 tu-1（上一请求无）
    expect(second.toolExecutionCheckpoint.completedToolUseIds).toEqual(['tu-1'])
    // P0-1 messages 面：第二请求相对第一请求为纯追加（user/tool_result/assistant 追加）
    expect(second.messagePrefixStats).toMatchObject({ divergedReason: 'appended' })
    // P0-1 wire 面：round:2 末条为 tool_result 数组 → 仅 system 断点，位置相对首请求变化
    expect(second.cacheBreakpoints.positions).toEqual(['system'])
    expect(second.cacheBreakpoints.prevPositions).toEqual(['system', 'msg:0'])
    expect(second.cacheBreakpoints.moved).toBe(true)

    clearSessionToolResources('sess-header-economy')
  })

  it('makeSender 仅为类型占位', () => {
    expect(makeSender()).toBeTruthy()
  })
})
