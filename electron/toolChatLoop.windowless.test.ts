import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { SessionEventInput } from './sessionEvents'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const mockConfirmOutcome = vi.fn(async () => 'approved' as const)
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []
const capturedSessionEvents: Array<Record<string, unknown>> = []
const capturedFileTreeEvents: Array<Record<string, unknown>> = []

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
    getToolExecutor: vi.fn((name: string) => (name === 'read_file' ? { name, execute: async () => ({ success: true, data: 'file-content' }) } : name === 'write_file' ? { name, execute: async () => ({ success: true, data: 'written' }) } : undefined))
  }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
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
import { createMemoryAppDb } from './database/testHelpers'
import { writePolicyPackages } from './confirmation/policyRulesRuntime'

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

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-windowless-1',
    sessionId: 'sess-windowless-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }],
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: makeDb(),
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async (event: Record<string, unknown>) => {
      capturedSessionEvents.push(event)
    },
    onFileTreeChanged: (event: Record<string, unknown>) => {
      capturedFileTreeEvents.push(event)
    },
    ...overrides
  }
}

describe('runToolChatSession 无窗口运行（偏差 1：事件出口取代 sender）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
    capturedFileTreeEvents.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockConfirmOutcome.mockResolvedValue('approved')
  })

  it('不传 sender：一次工具调用回合完整跑完并产出终文本', async () => {
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    const res = await runToolChatSession(baseArgs() as never)
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'done' }] })
    expect(capturedFacts.some((fact) => fact.type === 'tool-result')).toBe(true)
    expect(capturedFacts.some((fact) => fact.type === 'source-completed')).toBe(true)
  })

  it('出口必填：回合过程写入事件台账（request_header 与 tool_result）', async () => {
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-2', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    const res = await runToolChatSession(baseArgs() as never)
    expect(res.ok).toBe(true)
    expect(capturedSessionEvents.some((event) => event.type === 'request_header')).toBe(true)
    expect(capturedSessionEvents.some((event) => event.type === 'tool_result')).toBe(true)
  })

  it('确认超时 fail-closed：无回答者时工具被拒，回合继续收敛（strict 档 user 确认）', async () => {
    mockConfirmOutcome.mockResolvedValue('timeout')
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-3', name: 'write_file', input: { path: 'x.txt', content: 'v' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'give up' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    // P1：desktop standard 的 write_file 走「自动」快通道；确认超时语义取 strict 档（user 确认）
    const strictDb = makeDb()
    writePolicyPackages(strictDb, { desktop: 'strict', wechat: 'standard', feishu: 'standard', automation: 'standard' })
    const res = await runToolChatSession({ ...baseArgs(), appDb: strictDb } as never)
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'give up' }] })
    const failedResult = capturedFacts.find((fact) => fact.type === 'tool-result' && (fact as { id?: string }).id === 'tu-3') as { result?: { success?: boolean } } | undefined
    expect(failedResult?.result?.success).toBe(false)
  })

  it('标题建议出口化：调度参数不再含 sender，改传 onTitleGenerated 回调', async () => {
    const sessionTitleSuggest = await import('./sessionTitleSuggest')
    vi.mocked(sessionTitleSuggest.reachedCumulativeAssistantTurnsForTitleSuggest).mockReturnValue(true)
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-4', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    await runToolChatSession(baseArgs() as never)
    expect(sessionTitleSuggest.scheduleSessionTitleSuggestion).toHaveBeenCalledTimes(1)
    const callArgs = vi.mocked(sessionTitleSuggest.scheduleSessionTitleSuggestion).mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty('sender')
    expect(callArgs.onTitleGenerated).toBeTypeOf('function')
  })

  it('文件树出口化：write_file 成功后经 onFileTreeChanged 出口而非 webContents 直发', async () => {
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-5', name: 'write_file', input: { path: 'b.txt', content: 'v' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'written' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    const res = await runToolChatSession(baseArgs() as never)
    expect(res.ok).toBe(true)
    expect(capturedFileTreeEvents).toContainEqual({ kind: 'paths', relPaths: ['b.txt'] })
  })

  it('SessionEventInput 类型可用于出口参数（编译期契约）', () => {
    const event: SessionEventInput = { type: 'tool_result', payload: { turnId: 's', stepId: 'r', toolUseId: 't', result: { success: true } as never } }
    expect(event.type).toBe('tool_result')
  })
})
