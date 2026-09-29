import { describe, expect, it, vi, beforeEach } from 'vitest'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let capturedFacts: Array<Record<string, unknown>> = []
let capturedSessionEvents: Array<{ type: string; payload?: Record<string, unknown> }> = []
// 每用例重建：registerChatCancel 返回其 signal，signalChatCancel 语义由测试直接 abort 模拟
let chatCancelController = new AbortController()

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

vi.mock('./chatCancelRegistry', () => {
  const ChatCancelledError = class ChatCancelledError extends Error {}
  return {
    ChatCancelledError,
    registerChatCancel: vi.fn(() => chatCancelController.signal),
    clearChatCancel: vi.fn(),
    // 与真实实现同语义：signal 已中止即抛 ChatCancelledError（循环体逐事件检查）
    throwIfChatCancelled: vi.fn((signal: AbortSignal) => {
      if (signal.aborted) throw new ChatCancelledError()
    }),
    ChatCancelRegistry: class ChatCancelRegistry {
      register = vi.fn(() => new AbortController().signal)
      signalChatCancel = vi.fn()
      clear = vi.fn()
      throwIfCancelled = vi.fn()
      cancelAllActiveChats = vi.fn()
    }
  }
})

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return { ...actual, getRegisteredTool: vi.fn(() => undefined), getToolExecutor: vi.fn() }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => ({ approved: true }))
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
import { createMemoryAppDb } from './database/testHelpers'
import { logAgentEvent } from './agentLogger/agentLogger'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

async function runSession() {
  const { invocation, ports } = assembleInvocation({
    sender: makeSender(),
    requestId: 'req-abort-1',
    sessionId: 'sess-abort-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }],
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp/spaceassistant-userdata',
    getApiKey: async () => 'test-key',
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async (event: { type: string; payload?: Record<string, unknown> }) => { capturedSessionEvents.push(event) },
    appDb: makeDb()
  } as never)
  return runToolChatSession(invocation, ports)
}

let inGapDeferred: { promise: Promise<void> } = { promise: Promise.resolve() }

/** 安装「产出 message_start 后挂起在事件间隔上」的 mock 流；返回 gap 兜底放行函数（绿态为 no-op）。 */
function installGapStream(): () => void {
  let markInGap!: () => void
  const inGap = new Promise<void>((resolve) => { markInGap = resolve })
  inGapDeferred = { promise: inGap }
  let releaseGap!: () => void
  const gapReleased = new Promise<void>((resolve) => { releaseGap = resolve })
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: 500 } } }
          markInGap()
          await new Promise<never>((_, reject) => {
            // SDK RequestOptions.signal 语义：abort 即刻在 fetch 层销毁连接，迭代器抛 APIUserAbortError
            options?.signal?.addEventListener('abort', () => reject(new APIUserAbortError()))
            gapReleased.then(() => reject(new Error('gap released by test')))
          })
        },
        finalMessage: vi.fn(async () => { throw new APIUserAbortError() })
      }))
    }
  })
  return releaseGap
}

describe('runToolChatSession LLM 流式请求硬中断（chat-abort-latency 方案 Phase 1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedFacts = []
    capturedSessionEvents = []
    mockGetCachedMemoryContent.mockReturnValue(null)
    chatCancelController = new AbortController()
  })

  it('契约：client.messages.stream 第二参数绑定当前 chatSignal', async () => {
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { usage: { input_tokens: 10 } } }
      },
      finalMessage: vi.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 }
      }))
    }))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })

    const res = await runSession()

    expect(res.ok).toBe(true)
    expect(stream).toHaveBeenCalledTimes(1)
    const options = stream.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
    expect(options?.signal).toBe(chatCancelController.signal)
  })

  it('流中段 signal abort：无需等待下一个事件即结算为 cancelled，且部分 usage 先落账', async () => {
    const releaseGap = installGapStream()
    const run = runSession()
    await inGapDeferred.promise
    chatCancelController.abort()

    // 中止必须即时生效：不等「下一个事件」放行，run 就应结算
    const settledWhileGapBlocked = await Promise.race([
      run.then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500))
    ])
    expect(settledWhileGapBlocked).toBe(true)
    await expect(run).resolves.toMatchObject({ ok: false, cancelled: true })

    // 评审 B1 回归钉：取消判定不得短路流式中段已产出的部分用量结算
    const usageEvents = capturedSessionEvents.filter((event) => event.type === 'request_usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]?.payload).toMatchObject({
      requestId: 'req-abort-1:round:1',
      usage: { input_tokens: 500 }
    })

    // 1b：abort 不得落入 llm.error 被结算为 failed
    const llmErrorCalls = vi.mocked(logAgentEvent).mock.calls.filter(([, event]) => event === 'llm.error')
    expect(llmErrorCalls).toHaveLength(0)

    releaseGap()
  })

  it('llm.cancel 审计：取消判定命中时打点（部分 usage 结算之后、重抛之前），字段含 abortToCatchMs', async () => {
    const releaseGap = installGapStream()
    const run = runSession()
    await inGapDeferred.promise
    chatCancelController.abort()

    await expect(run).resolves.toMatchObject({ ok: false, cancelled: true })

    // Phase 3：中止可观测——取消判定命中必须留痕
    const cancelCalls = vi.mocked(logAgentEvent).mock.calls.filter(([, event]) => event === 'llm.cancel')
    expect(cancelCalls).toHaveLength(1)
    expect(cancelCalls[0]?.[0]).toBe('warn')
    expect(cancelCalls[0]?.[2]).toMatchObject({
      requestId: 'req-abort-1',
      sessionId: 'sess-abort-1',
      loopRound: 1,
      abortToCatchMs: expect.any(Number)
    })

    releaseGap()
  })
})
