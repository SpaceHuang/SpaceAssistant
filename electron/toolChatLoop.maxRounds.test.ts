import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

/**
 * P0 特征化基线：钉住 maxToolLoopRounds 轮数上界的真跑行为（有界调用方契约）。
 * 循环每轮都返回 tool_use、永不收敛时，达到上界后终止循环并 fail-fast。
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []

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

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) => (name === 'read_file' ? { name, execute: async () => ({ success: true, data: 'file-content' }) } : undefined))
  }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved' as const)
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'

/** P1：直调 Core 的测试适配——材料经装配器构造 Invocation + ports（断言不动，仅调用方式平移）。 */
function runAssembledSession(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}
import { createMemoryAppDb } from './database/testHelpers'

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

/** 每轮都返回同一个 tool_use（read_file），永不给终文本 */
function makeInfiniteToolUseStream() {
  return {
    messages: {
      stream: vi.fn(() => {
        streamRound += 1
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'tool_use', id: `tu-${streamRound}`, name: 'read_file', input: { path: 'a.txt' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 }
          }))
        }
      })
    }
  }
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-maxrounds-1',
    sessionId: 'sess-maxrounds-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }],
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: makeDb(),
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async () => undefined,
    ...overrides
  }
}

describe('runToolChatSession maxToolLoopRounds 轮数上界（特征化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
  })

  it('达到上界后终止循环并 fail-fast，错误可区分、不执行更多工具轮', async () => {
    mockCreateAnthropicClient.mockReturnValue(makeInfiniteToolUseStream())
    const res = await runAssembledSession(baseArgs({ maxToolLoopRounds: 2 }) as never)
    expect(res).toMatchObject({ ok: false, error: 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED(2)' })
    // 第 3 轮起不再调用模型（上界 2 = 至多 2 轮工具执行，第 3 次流被拒绝）
    expect(streamRound).toBe(3)
  })

  it('上界内拿到终文本则正常收敛（上界不误伤正常回合）', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => {
          const round = streamRound
          streamRound += 1
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => (round === 0
              ? { content: [{ type: 'tool_use', id: 'tu-ok', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
              : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }))
          }
        })
      }
    })
    const res = await runAssembledSession(baseArgs({ maxToolLoopRounds: 2 }) as never)
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'done' }] })
  })

  it('未传上界时走默认行为（无上界短路，仅特征化默认路径存在）', async () => {
    mockCreateAnthropicClient.mockReturnValue(makeInfiniteToolUseStream())
    // 默认无上界：跑 5 轮仍在循环（此处只验证不因缺省参数报错，用小轮数脚本控制）
    const finite = {
      messages: {
        stream: vi.fn(() => {
          const round = streamRound
          streamRound += 1
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => (round < 3
              ? { content: [{ type: 'tool_use', id: `tu-d${round}`, name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
              : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 9 } }))
          }
        })
      }
    }
    mockCreateAnthropicClient.mockReturnValue(finite)
    const res = await runAssembledSession(baseArgs() as never)
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'done' }] })
    expect(streamRound).toBe(4)
  })
})
