import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockCreateAnthropicClient = vi.fn()
let streamRound = 0

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: vi.fn(() => null) }
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
  const { defineDirectTool } = await import('./tools/plannedToolRegistry')
  defineDirectTool({ name: 'read_file', parseInput: (raw) => raw, execute: async () => ({ success: true, data: 'ok' }) })
  return { ...actual, getRegisteredTool: vi.fn(() => undefined), getToolExecutor: vi.fn() }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

let confirmOutcome: { approved: boolean } | { approved: false; outcome: 'rejected' | 'timeout'; rejectReason?: string } = { approved: true }
vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => confirmOutcome)
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getSession: vi.fn(() => undefined) }
})

import { runToolChatSession } from './toolChatLoop'
import { createMemoryAppDb } from './database/testHelpers'
import { getUsageStepFactsForTurn, getUsageTurnFact } from './database/operations'
import type { AppDatabase } from './database'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

/** 构造多轮 provider 响应：rounds 依次给出每轮 finalMessage。 */
function streamWithRounds(rounds: Array<Record<string, unknown>>): void {
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn(() => {
        const round = streamRound++
        const payload = rounds[Math.min(round, rounds.length - 1)]
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
          },
          finalMessage: vi.fn(async () => payload)
        }
      })
    }
  })
}

describe('runToolChatSession 用量统计收口（usage_step_facts / usage_turn_facts）', () => {
  let db: AppDatabase

  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    confirmOutcome = { approved: true }
    db = createMemoryAppDb('zh-CN')
  })

  function runSession(overrides: Record<string, unknown> = {}) {
    return runToolChatSession({
      sender: makeSender(),
      requestId: 'req-stats-1',
      sessionId: 'sess-stats-1',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      emitFactEvent: () => undefined,
      emitSessionEvent: () => undefined,
      appDb: db,
      ...overrides
    } as never)
  }

  it('T7：一个 Turn 内 3 次 LLM 调用 + 2 次成功工具调用 → step=3、tool=2、error=0、skipped=0、completed', async () => {
    streamWithRounds([
      { content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 } },
      { content: [{ type: 'tool_use', id: 'tu-2', name: 'read_file', input: { path: 'b' } }], stop_reason: 'tool_use', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 80 } },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 160 } }
    ])
    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) =>
      name === 'read_file' ? { name, execute: async () => ({ success: true, data: 'ok' }) } : undefined
    )

    const res = await runSession({ turnId: 'turn-real-1', llmServiceId: 'svc-a' })
    expect(res.ok).toBe(true)

    const turn = getUsageTurnFact(db, 'turn-real-1')
    expect(turn).toMatchObject({
      turnId: 'turn-real-1',
      sessionId: 'sess-stats-1',
      stepCount: 3,
      toolCallCount: 2,
      toolErrorCount: 0,
      toolSkippedCount: 0,
      outcome: 'completed',
      model: 'deepseek-v4-pro',
      llmServiceId: 'svc-a'
    })

    const steps = getUsageStepFactsForTurn(db, 'sess-stats-1', 'turn-real-1')
    expect(steps).toHaveLength(3)
    const totalInput = steps.reduce((sum, s) => sum + s.inputTokens, 0)
    // additive 归一化逐轮求和：(100+0) + (200+80) + (400+160)
    expect(totalInput).toBe(940)
    expect(steps.reduce((sum, s) => sum + s.outputTokens, 0)).toBe(60)
    db.close()
  })

  it('工具执行失败计入 tool_error_count（不计入 skipped）', async () => {
    streamWithRounds([
      { content: [{ type: 'tool_use', id: 'tu-err', name: 'read_file', input: { path: 'a' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 } },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 20 } }
    ])
    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) =>
      name === 'read_file' ? { name, execute: async () => ({ success: false, error: 'boom' }) } : undefined
    )

    await runSession({ turnId: 'turn-err-1' })
    expect(getUsageTurnFact(db, 'turn-err-1')).toMatchObject({
      toolCallCount: 1,
      toolErrorCount: 1,
      toolSkippedCount: 0,
      outcome: 'completed'
    })
    db.close()
  })

  it('用户拒绝工具确认：终态已落（计数在出口标记 notExecuted 后归入 skipped —— Phase 3 验证）', async () => {
    streamWithRounds([
      { content: [{ type: 'tool_use', id: 'tu-rej', name: 'read_file', input: { path: 'a' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 } },
      { content: [{ type: 'text', text: 'ok, skipped' }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 20 } }
    ])
    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) =>
      name === 'read_file' ? { name, execute: async () => ({ success: true, data: 'ok' }) } : undefined
    )
    confirmOutcome = { approved: false, outcome: 'rejected' }

    await runSession({ turnId: 'turn-rej-1' })
    // Phase 2 仅验证终态计入 tool_call_count（计数基准 = tool_result 终态）；
    // 拒绝归入 skipped 而非 error 的分类标记由 Phase 3（15 处出口穷举）落地后在此断言。
    expect(getUsageTurnFact(db, 'turn-rej-1')).toMatchObject({
      toolCallCount: 1,
      outcome: 'completed'
    })
    db.close()
  })

  it('provider 失败的 Turn：outcome=failed，已发生的 step 事实保留', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => {
          throw new Error('provider exploded')
        })
      }
    })
    const res = await runSession({ turnId: 'turn-fail-1' })
    expect(res.ok).toBe(false)
    const turn = getUsageTurnFact(db, 'turn-fail-1')
    expect(turn).toMatchObject({ outcome: 'failed', stepCount: 0, toolCallCount: 0 })
    db.close()
  })

  it('不传 turnId 时回退 sessionId 占位（兼容现状，桌面包装层覆写不受影响）', async () => {
    streamWithRounds([
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }
    ])
    await runSession()
    expect(getUsageTurnFact(db, 'sess-stats-1')).toMatchObject({ outcome: 'completed', stepCount: 1 })
    db.close()
  })
})
