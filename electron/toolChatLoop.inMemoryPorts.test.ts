import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

/**
 * SDK 级验收（A4，偏差 20）：`createAgentRuntime` 装配 + 内存端口，**不启动 Electron、不碰 SQLite**，
 * 跑完「带工具调用的回合 + 一次确认（批准）+ 一次拒绝」，断言结果四态与事件台账。
 * CI 以独立 step 常驻回归（ci.yml test job）。
 * 边界说明：回合执行引擎（toolChatLoop 执行闭包，实测 442 文件）物理切分属基线 §13 完整 P5，
 * 本测试仍从宿主闭包消费（vi.mock 隔离 electron 本体）；「import 闭包零 electron」子项待切分后达标。
 * （runShellRegisteredTool 的 plan 超时为存量环境问题，与此无关。）
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const mockConfirmOutcome = vi.fn(async () => 'approved' as const)
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []
const capturedSessionEvents: Array<Record<string, unknown>> = []

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

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
  signalChatCancel: vi.fn(),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  cancelAllActiveChats: vi.fn(),
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
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => mockConfirmOutcome())
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    // 内存端口场景承诺「不碰 SQLite」：getSession 现读返回 undefined（等价空库宿主）
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'

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

/** 内存端口材料：不传 appDb（装配器走显式默认材料分支，不构造任何 SQLite 端口实现）。 */
function inMemoryMaterials(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-inmem-1',
    sessionId: 'sess-inmem-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }],
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp/spaceassistant-test-userdata',
    getApiKey: async () => 'test-key',
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async (event: Record<string, unknown>) => {
      capturedSessionEvents.push(event)
    },
    ...overrides
  }
}

async function runInMemory(materials: Record<string, unknown>) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}

describe('runToolChatSession 内存端口完整回合（P2 §2.4 标准 2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockConfirmOutcome.mockResolvedValue('approved')
  })

  it('带工具调用 + 一次批准确认 + 一次拒绝：回合完整收敛，全程无库', async () => {
    // 轮次编排：read_file（默认规则 auto-allow，直接执行）→ write_file（require-confirm → 批准执行）
    // → write_file（require-confirm → 拒绝，工具不执行）→ 终文本
    mockConfirmOutcome
      .mockResolvedValueOnce('approved' as never)
      .mockResolvedValueOnce('denied' as never)
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'tool_use', id: 'tu-write-ok', name: 'write_file', input: { path: 'ok.txt', content: 'v' } }], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 5 } },
        { content: [{ type: 'tool_use', id: 'tu-write-deny', name: 'write_file', input: { path: 'no.txt', content: 'v' } }], stop_reason: 'tool_use', usage: { input_tokens: 14, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done with approval and denial' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )

    // P1：无库宿主缺省 standard → write_file 走「自动」；批准确认/拒绝交互显式声明 strict 档
    const res = await runInMemory(inMemoryMaterials({ policyLanePackage: 'strict' }))
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'done with approval and denial' }] })

    const factOf = (id: string) => capturedFacts.find((f) => f.type === 'tool-result' && (f as { id?: string }).id === id) as { result?: { success?: boolean; notExecuted?: boolean } } | undefined
    // 1. 带工具调用的回合：read_file 默认规则直接放行并执行成功
    expect(factOf('tu-read')?.result?.success).toBe(true)
    // 2. 一次确认（批准）：write_file 经确认通道批准后执行成功
    expect(factOf('tu-write-ok')?.result?.success).toBe(true)
    // 3. 一次拒绝：确认被拒 → 工具不执行（notExecuted），回合继续收敛
    const deniedFact = factOf('tu-write-deny')
    expect(deniedFact?.result?.notExecuted === true || deniedFact?.result?.success === false).toBe(true)
    // 事件台账与事实出口全程工作（内存端口下出口照常）
    expect(capturedSessionEvents.some((e) => e.type === 'request_header')).toBe(true)
    expect(capturedFacts.some((f) => f.type === 'source-completed')).toBe(true)
  })

  it('内存端口的默认门控材料语义等价默认规则集（无库宿主的显式默认，非静默回退）', async () => {
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-r', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    const res = await runInMemory(inMemoryMaterials())
    expect(res).toMatchObject({ ok: true })
    // 默认规则：桌面 read_file auto-allow，无需确认
    expect(mockConfirmOutcome).not.toHaveBeenCalled()
  })
})
