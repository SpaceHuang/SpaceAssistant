import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0
let capturedFacts: Array<Record<string, unknown>> = []

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
    mockGetCachedMemoryContent.mockReturnValue(null)
  })

  async function runSession(sender = makeSender(), options: { enableThinking?: boolean } = {}) {
    return runAssembledSession({
      sender,
      requestId: 'req-usage-1',
      sessionId: 'sess-usage-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
      emitSessionEvent: async () => undefined,
      appDb: makeDb(),
      options
    })
  }

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
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', emitFactEvent: () => undefined, emitSessionEvent: async () => undefined, appDb: makeDb(), appendCompactionTransaction
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
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
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
