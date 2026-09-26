import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { getCurrentRemoteProgressSnapshot, clearRemoteProgressSession } from './remote/remoteProgressStore'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import { reduceAssistantFact } from '../src/shared/assistantFactAggregator'
import { buildAssistantActivityTimeline } from '../src/shared/assistantActivityTimeline'
import type { Message } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0
let capturedFacts: Array<Record<string, unknown>> = []
let capturedSessionEvents: Array<{ type: string; payload?: Record<string, unknown> }> = []

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
  const { defineDirectTool } = await import('./tools/plannedToolRegistry')
  const readFile = defineDirectTool({ name: 'read_file', parseInput: (raw) => raw, execute: async () => ({ success: true, data: 'ok' }) })
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

/** P1：直调 Core 的测试适配——材料经装配器构造 Invocation + ports（断言不动，仅调用方式平移）。 */
function runAssembledSession(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}
import { createMemoryAppDb } from './database/testHelpers'
import { computeReplaySurfaceFingerprint, projectReplaySurface, surfaceItemIdentities } from '../src/shared/surfaceReplay'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

function usagePayloads(
  sender: WebContents
): Array<{
  requestId: string
  sessionId: string
  usage: Record<string, number | undefined>
  projected?: boolean
}> {
  void sender
  return capturedFacts
    .filter((event) => event.type === 'usage-updated')
    .map((event) => ({
      requestId: 'req-usage-1',
      sessionId: 'sess-usage-1',
      usage: event.usage as Record<string, number | undefined>,
      ...(event.projected ? { projected: true } : {})
    }))
}

describe('runToolChatSession message_start usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts = []
    capturedSessionEvents = []
    mockGetCachedMemoryContent.mockReturnValue(null)
  })

  async function runSession(sender = makeSender(), options: {
    enableThinking?: boolean
    contextWindow?: number
    contextWindowTrusted?: boolean
    model?: string
    reasoningEffort?: 'off' | 'low' | 'medium' | 'high'
    messages?: Array<Record<string, unknown>>
    currentUserMessageId?: string
    remoteContext?: RemoteContext
    appendCompactionTransaction?: (...args: unknown[]) => Promise<void>
  } = {}) {
    return runAssembledSession({
      sender,
      requestId: 'req-usage-1',
      sessionId: 'sess-usage-1',
      model: options.model ?? 'claude-sonnet-4-20250514',
      contextWindow: options.contextWindow,
      contextWindowTrusted: options.contextWindowTrusted ?? options.contextWindow !== undefined,
      messages: options.messages ?? [{ role: 'user', content: 'hello' }],
      currentUserMessageId: options.currentUserMessageId,
      remoteContext: options.remoteContext,
      appendCompactionTransaction: options.appendCompactionTransaction,
      reasoningEffort: options.reasoningEffort,
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp/spaceassistant-userdata',
      getApiKey: async () => 'test-key',
      emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
      emitSessionEvent: async (event: { type: string; payload?: Record<string, unknown> }) => { capturedSessionEvents.push(event) },
      appDb: makeDb(),
      options: { enableThinking: options.enableThinking }
    })
  }

  it('silently overflowing streamed answer is discarded while both attempts usage facts remain', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {
          if (round === 0) {
            yield { type: 'message_start', message: { usage: { input_tokens: 150_000 } } }
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'discard me' } }
            yield { type: 'content_block_stop', index: 0 }
          }
        },
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: 'discard me' }], stop_reason: 'end_turn', usage: { input_tokens: 150_000, output_tokens: 3 } }
          : { content: [{ type: 'text', text: 'keep me' }], stop_reason: 'end_turn', usage: { input_tokens: 20_000, output_tokens: 2 } })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession(makeSender(), {
      contextWindow: 100_000,
      model: 'deepseek-v4-pro',
      currentUserMessageId: 'current',
      messages: [{ id: 'old', role: 'user', content: 'old context' }, { id: 'current', role: 'user', content: 'hello' }],
      appendCompactionTransaction: async () => undefined
    })
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'keep me' }] })
    expect(capturedSessionEvents.filter((event) => event.type === 'assistant_chunk')).toHaveLength(0)
    expect(capturedFacts.some((event) => event.type === 'content-delta' && event.text === 'discard me')).toBe(false)
    expect(capturedSessionEvents.filter((event) => event.type === 'request_usage')).toHaveLength(2)
    expect(capturedSessionEvents.find((event) => event.type === 'request_usage')?.payload).toMatchObject({ resultDisposition: 'discarded_overflow' })
  })

  it('publishes ordinary text deltas before the provider stream finishes', async () => {
    let releaseStream!: () => void
    let markDeltaSeen!: () => void
    const streamBlocked = new Promise<void>((resolve) => { releaseStream = resolve })
    const deltaSeen = new Promise<void>((resolve) => { markDeltaSeen = resolve })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10_000 } } }
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'live chunk' } }
            markDeltaSeen()
            await streamBlocked
            yield { type: 'content_block_stop', index: 0 }
            yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'read_file' } }
            yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/ignored"}' } }
            yield { type: 'content_block_stop', index: 1 }
            yield { type: 'message_delta', message_delta: { stop_reason: 'end_turn' } }
            yield { type: 'message_stop' }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'live chunk' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10_000, output_tokens: 2 }
          }))
        }))
      }
    })

    const run = runSession(makeSender(), { contextWindow: 200_000 })
    await deltaSeen
    expect(capturedFacts).toContainEqual({ type: 'content-delta', text: 'live chunk' })
    expect(capturedSessionEvents.some((event) => event.type === 'assistant_chunk')).toBe(false)
    releaseStream()
    await expect(run).resolves.toMatchObject({ ok: true })
    expect(capturedSessionEvents
      .filter((event) => event.type === 'assistant_chunk')
      .map((event) => ((event.payload?.delta as { type?: string } | undefined)?.type)))
      .toEqual(['usage', 'block_start', 'text_delta', 'block_end', 'block_start', 'tool_call_delta', 'block_end', 'finish', 'finish'])
  })

  it('retracts live text when final usage changes the attempt into a silent overflow', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {
          if (round === 0) {
            yield { type: 'message_start', message: { usage: { input_tokens: 90_000 } } }
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'discard me' } }
            yield { type: 'content_block_stop', index: 0 }
          }
        },
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: 'discard me' }], stop_reason: 'end_turn', usage: { input_tokens: 150_000, output_tokens: 2 } }
          : { content: [{ type: 'text', text: 'accepted answer' }], stop_reason: 'end_turn', usage: { input_tokens: 20_000, output_tokens: 2 } })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession(makeSender(), {
      contextWindow: 100_000,
      model: 'deepseek-v4-pro',
      currentUserMessageId: 'current',
      messages: [{ id: 'old', role: 'user', content: 'old context' }, { id: 'current', role: 'user', content: 'hello' }],
      appendCompactionTransaction: async () => undefined
    })
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'accepted answer' }] })
    expect(capturedFacts).toContainEqual({ type: 'content-delta', text: 'discard me' })
    expect(capturedFacts).toContainEqual({ type: 'preview-rollback' })
    expect(capturedSessionEvents
      .filter((event) => event.type === 'assistant_chunk')
      .some((event) => JSON.stringify(event.payload).includes('discard me'))).toBe(false)
  })

  it('does not discard a completed answer when an untrusted legacy fallback window is exceeded', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: '成功回答' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 300_001, output_tokens: 8 }
          }))
        }))
      }
    })
    const result = await runSession(makeSender(), {
      contextWindow: 200_000,
      contextWindowTrusted: false,
      model: 'vendor-large-model'
    })
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '成功回答' }] })
    expect(capturedFacts).not.toContainEqual({ type: 'preview-rollback' })
  })

  it('keeps max_tokens with missing output usage on the output-recovery path', async () => {
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = []
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn((params: { messages?: Array<{ role: string; content: unknown }> }) => {
          requests.push(params)
          const round = streamRound++
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => round === 0
              ? { content: [{ type: 'text', text: 'partial but valid' }], stop_reason: 'max_tokens', usage: { input_tokens: 99_500 } }
              : { content: [{ type: 'text', text: 'complete' }], stop_reason: 'end_turn', usage: { input_tokens: 12_000, output_tokens: 4 } })
          }
        })
      }
    })
    const result = await runSession(makeSender(), { contextWindow: 100_000, contextWindowTrusted: true })
    expect(result).toMatchObject({ ok: true })
    expect(requests).toHaveLength(2)
    expect(capturedSessionEvents.filter((event) => event.type === 'request_retry').map((event) => event.payload?.code))
      .toEqual(['model_output_token_limit'])
  })

  it('does not publish or execute tool calls from an overflowing attempt', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {
          if (round === 0) {
            yield { type: 'message_start', message: { usage: { input_tokens: 150_000 } } }
            yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'overflow-tool', name: 'read_file', input: { path: '/tmp/ignored' } } }
            yield { type: 'content_block_stop', index: 0 }
          }
        },
        finalMessage: vi.fn(async () => round === 0
          ? { content: [], stop_reason: 'end_turn', usage: { input_tokens: 150_000, output_tokens: 0 } }
          : { content: [{ type: 'text', text: 'accepted' }], stop_reason: 'end_turn', usage: { input_tokens: 20_000, output_tokens: 2 } })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession(makeSender(), {
      contextWindow: 100_000,
      model: 'deepseek-v4-pro',
      currentUserMessageId: 'current',
      messages: [{ id: 'old', role: 'user', content: 'old context' }, { id: 'current', role: 'user', content: 'hello' }],
      appendCompactionTransaction: async () => undefined
    })
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'accepted' }] })
    expect(capturedSessionEvents.filter((event) => event.type === 'tool_call')).toHaveLength(0)
    expect(capturedFacts.filter((event) => event.type === 'tool-use')).toHaveLength(0)
  })

  it('records available per-call usage when a later stream error makes the attempt fail', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 1234 } } }
            throw new Error('stream interrupted after usage')
          },
          finalMessage: vi.fn(async () => { throw new Error('stream interrupted after usage') })
        }))
      }
    })
    const result = await runSession()
    expect(result.ok).toBe(false)
    expect(capturedSessionEvents.filter((event) => event.type === 'request_usage')).toHaveLength(1)
    expect(capturedSessionEvents.find((event) => event.type === 'request_usage')?.payload).toMatchObject({
      requestId: 'req-usage-1:round:1',
      usage: { input_tokens: 1234 }
    })
  })

  it('updates the remote activity snapshot when a text block closes before finalMessage resolves', async () => {
    let releaseFinal!: () => void
    const waitingForFinal = new Promise<void>((resolve) => { releaseFinal = resolve })
    clearRemoteProgressSession('sess-usage-1')
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { usage: { input_tokens: 10 } } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第一段已完成' } }
        yield { type: 'content_block_stop', index: 0 }
        await waitingForFinal
      },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: '第一段已完成' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 4 } }))
    })) } })
    const resultPromise = runSession(makeSender(), {
      remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: 'read-only' },
      model: 'claude-sonnet-4-20250514'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getCurrentRemoteProgressSnapshot('sess-usage-1')).toMatchObject({ kind: 'text', label: '已生成一段回复，继续处理中', publishable: true })
    expect(getCurrentRemoteProgressSnapshot('sess-usage-1')?.label).not.toContain('第一段已完成')
    releaseFinal()
    await expect(resultPromise).resolves.toMatchObject({ ok: true })
  })

  it('同一响应中工具调用后的正文与思考在工具事实之后按源顺序提交', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {
          if (round === 0) {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '工具前A' } }
            yield { type: 'content_block_stop', index: 0 }
            yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'interleaved-tool', name: 'read_file', input: { path: 'a.txt' } } }
            yield { type: 'content_block_stop', index: 1 }
            yield { type: 'content_block_start', index: 2, content_block: { type: 'thinking' } }
            yield { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: '工具后思考' } }
            yield { type: 'content_block_stop', index: 2 }
            yield { type: 'content_block_start', index: 3, content_block: { type: 'text' } }
            yield { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '工具后B' } }
            yield { type: 'content_block_stop', index: 3 }
          } else {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '最终C' } }
            yield { type: 'content_block_stop', index: 0 }
          }
        },
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: '工具前A' }, { type: 'tool_use', id: 'interleaved-tool', name: 'read_file', input: { path: 'a.txt' } }, { type: 'thinking', thinking: '工具后思考' }, { type: 'text', text: '工具后B' }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 6 } }
          : { content: [{ type: 'text', text: '最终C' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 2 } })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })

    await runSession(makeSender(), { enableThinking: true })

    const timelineMessage: Message = { id: 'assistant', sessionId: 'sess-usage-1', role: 'assistant', content: '', timestamp: 0, status: 'streaming', schemaVersion: 1 }
    const replayed = capturedFacts.reduce((state, fact, index) => reduceAssistantFact(state, fact as AssistantFactEvent, { now: index + 1, createId: () => 'hint' }), timelineMessage)
    expect(buildAssistantActivityTimeline(replayed).map((item) => item.kind)).toEqual(['text', 'tool', 'thinking', 'text'])
    const textPositions = capturedFacts.flatMap((fact, index) => fact.type === 'content-delta' ? [index] : [])
    const toolPosition = capturedFacts.findIndex((fact) => fact.type === 'tool-use')
    expect(textPositions[0]).toBeLessThan(toolPosition)
    expect(textPositions[1]).toBeGreaterThan(toolPosition)
  })

  it('retracts provisional text and thinking when a context error retries the stream', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { usage: { input_tokens: 10 } } }
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: round === 0 ? 'discarded' : 'accepted' } }
          if (round === 0) throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' })
        },
        finalMessage: vi.fn(async () => ({
          content: [{ type: 'text', text: 'accepted' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 }
        }))
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession(makeSender(), {
      contextWindow: 100_000,
      contextWindowTrusted: true,
      messages: [{ id: 'old', role: 'user', content: 'old context' }, { id: 'current', role: 'user', content: 'hello' }],
      currentUserMessageId: 'current',
      appendCompactionTransaction: async () => undefined
    })
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'accepted' }] })
    expect(capturedFacts).toContainEqual({ type: 'preview-rollback' })
    expect(capturedFacts.filter((event) => event.type === 'content-delta').map((event) => event.text)).toEqual(['discarded', 'accepted'])
    expect(capturedSessionEvents.filter((event) => event.type === 'assistant_chunk')).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ delta: expect.objectContaining({ text: 'discarded' }) }) })
    ]))
  })

  it('在无工具 max_tokens 后继续请求，并以完整正文对账', async () => {
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = []
    const stream = vi.fn((params: { messages?: Array<{ role: string; content: unknown }> }) => {
      requests.push(params)
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: 'A' }, { type: 'thinking', thinking: 'cut' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }
          : { content: [{ type: 'text', text: 'B' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runSession()
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'AB' }] })
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]?.messages)).toContain('model_output_token_limit')
    expect(capturedFacts.filter((fact) => fact.type === 'source-completed')).toHaveLength(1)
    expect(capturedFacts).toContainEqual({ type: 'content-reconciled', text: 'AB' })
  })

  it('连续三次截断后失败且不发出完成事实', async () => {
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = []
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: vi.fn(async () => ({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }))
    }))
    stream.mockImplementation((params: { messages?: Array<{ role: string; content: unknown }> }) => {
      requests.push(params)
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => ({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }))
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runSession()
    expect(res).toMatchObject({ ok: false, error: 'model_output_token_limit_exhausted' })
    expect(stream).toHaveBeenCalledTimes(3)
    expect(requests[1]?.messages?.some((message) => message.role === 'assistant' && Array.isArray(message.content) && message.content.length === 0)).toBe(false)
    expect(capturedFacts.filter((fact) => fact.type === 'source-completed')).toHaveLength(0)
  })

  it('thinking-only 无签名截断不会在恢复请求中发送空 assistant', async () => {
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = []
    const stream = vi.fn((params: { messages?: Array<{ role: string; content: unknown }> }) => {
      requests.push(params)
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'thinking', thinking: 'cut' }], stop_reason: 'max_tokens' }
          : { content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })

    const result = await runSession(makeSender(), { enableThinking: true })

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'recovered' }] })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages?.some((message) => message.role === 'assistant' && Array.isArray(message.content) && message.content.length === 0)).toBe(false)
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ thinking: { type: 'adaptive' } })
  })

  it('截断的合法工具调用不执行，并发送失败结果收尾', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'tool_use', id: 'cut-tool', name: 'read_file', input: { path: 'x' } }], stop_reason: 'max_tokens' }
          : { content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runSession()
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'recovered' }] })
    expect(capturedFacts).toContainEqual(expect.objectContaining({ type: 'tool-result', id: 'cut-tool', result: expect.objectContaining({ success: false, error: 'model_output_token_limit' }) }))
  })

  it('截断后工具轮已展示的正文会并入最终恢复正文', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: 'A' }], stop_reason: 'max_tokens' }
          : round === 1
            ? { content: [{ type: 'text', text: 'B' }, { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} }], stop_reason: 'tool_use' }
            : { content: [{ type: 'text', text: 'C' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession()
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'ABC' }] })
    expect(capturedFacts).toContainEqual({ type: 'content-reconciled', text: 'ABC' })
  })

  it('正常工具轮正文在后续截断恢复后仍保留，并保持在工具卡之前', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {
          const text = round === 0 ? '工具前说明A' : round === 1 ? '截断正文B' : '恢复正文C'
          const index = round === 0 ? 0 : 0
          yield { type: 'content_block_start', index, content_block: { type: 'text' } }
          yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }
          yield { type: 'content_block_stop', index }
          if (round === 0) {
            yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'accepted-tool', name: 'read_file', input: { path: 'a.txt' } } }
            yield { type: 'content_block_stop', index: 1 }
          }
        },
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: '工具前说明A' }, { type: 'tool_use', id: 'accepted-tool', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } }
          : round === 1
            ? { content: [{ type: 'text', text: '截断正文B' }], stop_reason: 'max_tokens', usage: { input_tokens: 20, output_tokens: 3 } }
            : { content: [{ type: 'text', text: '恢复正文C' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 4 } })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })

    const result = await runSession()

    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: '工具前说明A截断正文B恢复正文C' }] })
    expect(capturedFacts).toContainEqual({ type: 'content-reconciled', text: '工具前说明A截断正文B恢复正文C' })
    const message: Message = { id: 'assistant', sessionId: 'sess-usage-1', role: 'assistant', content: '', timestamp: 0, status: 'streaming', schemaVersion: 1 }
    const replayed = capturedFacts.reduce((state, fact, index) => reduceAssistantFact(state, fact as AssistantFactEvent, { now: index + 1, createId: () => 'hint' }), message)
    expect(replayed.content).toBe('工具前说明A截断正文B恢复正文C')
    expect(buildAssistantActivityTimeline(replayed).map((item) => item.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('无正文的工具截断后仍保留后续普通工具轮正文', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'tool_use', id: 'cut-1', name: 'read_file', input: {} }], stop_reason: 'max_tokens' }
          : round === 1
            ? { content: [{ type: 'text', text: 'B' }, { type: 'tool_use', id: 'tool-2', name: 'read_file', input: {} }], stop_reason: 'tool_use' }
            : { content: [{ type: 'text', text: 'C' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession()
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'BC' }] })
    expect(capturedFacts).toContainEqual({ type: 'content-reconciled', text: 'BC' })
  })

  it('恢复最终轮 thinking-only 正常结束时保留兼容正文', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'text', text: 'A' }], stop_reason: 'max_tokens' }
          : { content: [{ type: 'thinking', thinking: 'B' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession()
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'AB' }] })
    expect(capturedFacts).toContainEqual({ type: 'content-reconciled', text: 'AB' })
  })

  it('空截断后最终 thinking-only 正文也会投影到返回内容', async () => {
    const stream = vi.fn(() => {
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [], stop_reason: 'max_tokens' }
          : { content: [{ type: 'thinking', thinking: 'B' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession()
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'B' }] })
    expect(capturedFacts).toContainEqual({ type: 'content-reconciled', text: 'B' })
  })

  it('截断工具调用缺失 ID 时丢弃该块并继续恢复', async () => {
    const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = []
    const stream = vi.fn((params: { messages?: Array<{ role: string; content: unknown }> }) => {
      requests.push(params)
      const round = streamRound++
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: vi.fn(async () => round === 0
          ? { content: [{ type: 'tool_use', id: '', name: 'read_file', input: {} }], stop_reason: 'max_tokens' }
          : { content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn' })
      }
    })
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const result = await runSession()
    expect(result).toMatchObject({ ok: true, content: [{ type: 'text', text: 'recovered' }] })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages?.some((message) => JSON.stringify(message.content).includes('tool_use'))).toBe(false)
  })

  it('Core-owned/non-compatible invocation never emits legacy usage IPC', async () => {
    const sender = makeSender()
    await runAssembledSession({
      sender,
      requestId: 'req-no-legacy-usage',
      sessionId: 'sess-no-legacy-usage',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      emitFactEvent: () => undefined, emitSessionEvent: async () => undefined,
      appDb: makeDb()
    })
    expect(usagePayloads(sender)).toEqual([])
  })

  it('在 provider 成功后调用 turn-boundary hook，并传递最终 surface', async () => {
    const boundary = vi.fn(async () => undefined)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })) } })
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-boundary-hook', sessionId: 'sess-boundary-hook',
      model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), onTurnBoundary: boundary
    })
    expect(res.ok).toBe(true)
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-boundary-hook', messages: expect.any(Array), surfaceSnapshot: expect.any(Object) }))
  })

  it('保留真实消息 id，使带 currentUserMessageId 的请求通过 provider preflight', async () => {
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    }))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-stable-id', sessionId: 'sess-stable-id', model: 'claude-sonnet-4-20250514',
      messages: [{ id: 'current-user-id', role: 'user', content: 'hello' }], currentUserMessageId: 'current-user-id',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb()
    })
    expect(res.ok).toBe(true)
    expect(stream).toHaveBeenCalled()
    expect(stream.mock.calls[0]?.[0]?.messages?.[0]).not.toHaveProperty('id')
  })

  it('把 Core 冻结的 Skill fragment 注入实际 provider 请求且位于当前输入之前', async () => {
    const stream = vi.fn((params: { messages?: unknown[] }) => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    }))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-skill-fragment', sessionId: 'sess-skill-fragment',
      model: 'claude-sonnet-4-20250514', messages: [{ id: 'current-user', role: 'user', content: 'current question' }], currentUserMessageId: 'current-user',
      skillFragments: ['## Skill: review\n\nreview instructions'],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb()
    })
    expect(res.ok).toBe(true)
    const messages = stream.mock.calls[0]?.[0]?.messages as Array<{ content?: unknown }> | undefined
    expect(messages?.[0]?.content).toBe('## Skill: review\n\nreview instructions')
    expect(messages?.[1]?.content).toEqual([{ type: 'text', text: 'current question', cache_control: { type: 'ephemeral' } }])
  })

  it('preflight 超预算时先提交恢复事务，再用恢复后的 surface 重试 provider', async () => {
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    }))
    const appendCompactionTransaction = vi.fn(async () => undefined)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-preflight-recovery', sessionId: 'sess-preflight-recovery',
      model: 'claude-sonnet-4-20250514', contextWindow: 40_000,
      messages: [
        { id: 'old-user', role: 'user', content: 'x'.repeat(120_000) },
        { id: 'current-user', role: 'user', content: '当前问题' }
      ], currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), appendCompactionTransaction
    })
    expect(res.ok).toBe(true)
    expect(appendCompactionTransaction).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(stream.mock.calls[0]?.[0]?.messages ?? [])).toContain('当前问题')
    expect(JSON.stringify(stream.mock.calls[0]?.[0]?.messages ?? [])).not.toContain('x'.repeat(12_000))
  })

  it('工具密集历史超窗时 reset 只保留当前 invoke 的消息', async () => {
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    }))
    const appendCompactionTransaction = vi.fn(async () => undefined)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const messages = [{ id: 'old-user', role: 'user' as const, content: 'old question' }]
    for (let i = 0; i < 5; i++) {
      messages.push({ id: `old-tool-${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `tool-${i}`, name: 'read', input: {} }] } as never)
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: 'x'.repeat(20_000) }] } as never)
    }
    messages.push({ id: 'current-user', role: 'user', content: 'current question' })
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-tool-history-recovery', sessionId: 'sess-tool-history-recovery',
      model: 'claude-sonnet-4-20250514', contextWindow: 40_000, messages, currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), appendCompactionTransaction
    })
    expect(res.ok).toBe(true)
    expect(appendCompactionTransaction).toHaveBeenCalledTimes(1)
    const sentMessages = stream.mock.calls[0]?.[0]?.messages as Array<{ id?: string; content?: unknown }> | undefined
    expect(sentMessages).toHaveLength(1)
    expect(JSON.stringify(sentMessages)).not.toContain('tool-0')
    expect(JSON.stringify(sentMessages)).toContain('current question')
  })

  it('overflow reset 为当前无正文工具轮保留正确 occurrence identity', async () => {
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    }))
    const appendCompactionTransaction = vi.fn(async () => undefined)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const messages = [
      { role: 'user' as const, content: 'old question' },
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'old-tool', name: 'read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'x'.repeat(120_000) }] },
      { id: 'current-user', role: 'user' as const, content: 'current question' },
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'current-tool', name: 'read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'current-tool', content: 'current result' }] }
    ]
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-empty-tool-identity', sessionId: 'sess-empty-tool-identity',
      model: 'claude-sonnet-4-20250514', contextWindow: 40_000, messages, currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), appendCompactionTransaction
    })
    expect(res.ok).toBe(true)
    const projected = projectReplaySurface(messages)
    const identities = surfaceItemIdentities(projected)
    const summary = appendCompactionTransaction.mock.calls[0]?.[1] as { shadowedRanges?: Array<{ start: string; end: string }> } | undefined
    expect(summary?.shadowedRanges).toEqual([{ start: identities[0], end: identities[1] }])
    expect(summary?.shadowedRanges).not.toContainEqual(expect.objectContaining({ start: identities[3], end: identities[3] }))
    const sentMessages = stream.mock.calls[0]?.[0]?.messages as Array<{ role?: string; content?: unknown }> | undefined
    expect(sentMessages).toHaveLength(3)
    expect(sentMessages?.[0]).toMatchObject({ role: 'user', content: 'current question' })
    expect(sentMessages?.[1]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_use', id: 'current-tool' })]))
    expect(sentMessages?.[2]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: 'current-tool', content: 'current result' })]))
  })

  it('工具中途超窗只为稳定当前 user 提交 replay 指纹，但 retry 仍保留完整工具轮', async () => {
    const appendCompactionTransaction = vi.fn(async () => undefined)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => {
      streamRound += 1
      if (streamRound === 2) throw new Error('maximum context length exceeded')
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
        finalMessage: vi.fn(async () => streamRound === 1
          ? { content: [{ type: 'tool_use', id: 'current-tool', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
          : { content: [{ type: 'text', text: 'answer after reset' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      }
    }) } })
    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) => name === 'read_file'
      ? { name, execute: async () => ({ success: true, data: 'tool result' }) }
      : undefined)
    const old = { id: 'old-user', role: 'user' as const, content: 'x'.repeat(2_000) }
    const current = { id: 'current-user', role: 'user' as const, content: 'current question' }
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-mid-reset', sessionId: 'sess-mid-reset',
      model: 'claude-sonnet-4-20250514', contextWindow: 40_000, messages: [old, current], currentUserMessageId: current.id,
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp/spaceassistant-userdata', getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), appendCompactionTransaction
    })
    expect(res.ok).toBe(true)
    expect(appendCompactionTransaction).toHaveBeenCalledTimes(1)
    const start = appendCompactionTransaction.mock.calls[0]?.[0] as { inputSurfaceFingerprint?: string } | undefined
    const summary = appendCompactionTransaction.mock.calls[0]?.[1] as { outputSurfaceFingerprint?: string; shadowedRanges?: unknown[] } | undefined
    expect(start?.inputSurfaceFingerprint).toBe(computeReplaySurfaceFingerprint('', [old, current]))
    expect(summary?.outputSurfaceFingerprint).toBe(computeReplaySurfaceFingerprint('', [current]))
    expect(summary?.shadowedRanges).toHaveLength(1)
    const retryMessages = mockCreateAnthropicClient.mock.results[0]?.value?.messages?.stream?.mock?.calls?.[2]?.[0]?.messages as Array<{ content?: unknown }> | undefined
    expect(JSON.stringify(retryMessages)).toContain('current-tool')
    expect(JSON.stringify(retryMessages)).toContain('tool result')
    expect(JSON.stringify(retryMessages)).not.toContain('x'.repeat(1_000))
  })

  it('turn-boundary snapshot includes the newly generated assistant content', async () => {
    const boundary = vi.fn(async () => undefined)
    const longReply = 'assistant reply '.repeat(5_000)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: longReply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })) } })
    const res = await runAssembledSession({
      sender: makeSender(), requestId: 'req-final-surface', sessionId: 'sess-final-surface',
      model: 'claude-sonnet-4-20250514', contextWindow: 100_000,
      messages: [{ id: 'current-user', role: 'user', content: 'hello' }], currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp/spaceassistant-userdata',
      getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), onTurnBoundary: boundary
    })
    expect(res.ok).toBe(true)
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({
      // 纯文本最终回复经 normalizeAssistantContentForHistoryParity 规范化为字符串（与历史重建同形，保证 turn 边界前缀连续）
      messages: expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: longReply.trim() })]),
      surfaceSnapshot: expect.objectContaining({ messageTokens: expect.any(Number) })
    }))
    const input = boundary.mock.calls[0]?.[0]
    expect(input?.surfaceSnapshot.messageTokens).toBeGreaterThan(1_000)
  })

  it('emits usage-updated fact on message_start before finalMessage', async () => {
    const sender = makeSender()
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 1500,
                  cache_read_input_tokens: 200
                }
              }
            }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1500, output_tokens: 42, cache_read_input_tokens: 200 }
          }))
        }))
      }
    }))

    const res = await runSession(sender)
    expect(res.ok).toBe(true)

    const sends = usagePayloads(sender)
    expect(sends.length).toBeGreaterThanOrEqual(2)
    const startSend = sends[0]
    expect(startSend?.sessionId).toBe('sess-usage-1')
    expect(startSend?.requestId).toBe('req-usage-1')
    expect(startSend?.usage.input_tokens).toBe(1500)
    expect(startSend?.usage.cache_read_input_tokens).toBe(200)
    const finalSend = sends.find((s) => s.usage.output_tokens === 42)
    expect(finalSend).toBeDefined()
  })

  it('Core sink 接管 usage fact 时不再发送 legacy usage event', async () => {
    const sender = makeSender()
    const facts: AssistantFactEvent[] = []
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { input_tokens: 10 } } }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2 }
          }))
        }))
      }
    }))

    const res = await runAssembledSession({
      sender,
      requestId: 'req-usage-core',
      sessionId: 'sess-usage-core',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      emitFactEvent: () => undefined, emitSessionEvent: async () => undefined,
      appDb: makeDb(),
      emitFactEvent: (event) => facts.push(event)
    })

    expect(res.ok).toBe(true)
    expect(facts.some((event) => event.type === 'usage-updated')).toBe(true)
    expect(usagePayloads(sender)).toHaveLength(0)
  })

  it('second loop round message_start reflects higher input_tokens', async () => {
    const sender = makeSender()
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => {
          streamRound += 1
          const round = streamRound
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message_start',
                message: {
                  usage: {
                    input_tokens: round === 1 ? 1000 : 2500
                  }
                }
              }
            },
            finalMessage: vi.fn(async () => {
              if (round === 1) {
                return {
                  content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 1000, output_tokens: 50 }
                }
              }
              return {
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 2500, output_tokens: 80 }
              }
            })
          }
        })
      }
    }))

    const res = await runSession(sender)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.usage?.input_tokens).toBe(2500)
    }

    const startSends = usagePayloads(sender).filter((s) => s.usage.input_tokens === 2500)
    expect(startSends.length).toBeGreaterThanOrEqual(1)
  })

  it('skips message_start usage push when input_tokens missing', async () => {
    const sender = makeSender()
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start', message: { usage: { output_tokens: 5 } } }
            yield { type: 'message_start' }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 900, output_tokens: 10 }
          }))
        }))
      }
    }))

    const res = await runSession(sender)
    expect(res.ok).toBe(true)

    const sends = usagePayloads(sender)
    expect(sends).toHaveLength(1)
    expect(sends[0]?.usage.input_tokens).toBe(900)
  })

  it('emits projected usage-updated fact after tool results without polluting return usage', async () => {
    const sender = makeSender()
    const largeToolResult = 'z'.repeat(350)
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => {
          streamRound += 1
          const round = streamRound
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message_start',
                message: { usage: { input_tokens: 1000 } }
              }
            },
            finalMessage: vi.fn(async () => {
              if (round === 1) {
                return {
                  content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 1000, output_tokens: 50 }
                }
              }
              return {
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 2500, output_tokens: 80 }
              }
            })
          }
        })
      }
    }))

    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) => {
      if (name === 'read_file') {
        return { name, execute: async () => ({ success: true, data: largeToolResult }) }
      }
      return undefined
    })

    const res = await runSession(sender)
    expect(res.ok).toBe(true)

    const projectedSend = usagePayloads(sender).find((s) => s.projected === true)
    expect(projectedSend).toBeDefined()
    expect(projectedSend!.usage.input_tokens).toBe(1100)
    if (res.ok) {
      expect(res.usage?.input_tokens).toBe(2500)
    }
  })

  it('returns unpolluted lastValidUsage when aborting after projected push', async () => {
    const sender = makeSender()
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message_start',
              message: { usage: { input_tokens: 1000 } }
            }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1000, output_tokens: 50 }
          }))
        }))
      }
    }))

    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) => {
      if (name === 'read_file') {
        return { name, execute: async () => ({ success: false, error: 'boom' }) }
      }
      return undefined
    })

    const res = await runSession(sender)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.usage?.input_tokens).toBe(1000)
    }

    const projectedSend = usagePayloads(sender).find((s) => s.projected === true)
    expect(projectedSend).toBeDefined()
    expect(projectedSend!.usage.input_tokens).toBeGreaterThan(1000)
  })
})
