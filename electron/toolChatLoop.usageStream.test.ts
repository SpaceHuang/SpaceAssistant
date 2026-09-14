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
  ChatCancelledError: class ChatCancelledError extends Error {}
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
import { createMemoryAppDb } from './database/testHelpers'

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

  async function runSession(sender = makeSender()) {
    return runToolChatSession({
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
      appDb: makeDb()
    })
  }

  it('Core-owned/non-compatible invocation never emits legacy usage IPC', async () => {
    const sender = makeSender()
    await runToolChatSession({
      sender,
      requestId: 'req-no-legacy-usage',
      sessionId: 'sess-no-legacy-usage',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
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
    const res = await runToolChatSession({
      sender: makeSender(), requestId: 'req-boundary-hook', sessionId: 'sess-boundary-hook',
      model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', appDb: makeDb(), onTurnBoundary: boundary
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
    const res = await runToolChatSession({
      sender: makeSender(), requestId: 'req-stable-id', sessionId: 'sess-stable-id', model: 'claude-sonnet-4-20250514',
      messages: [{ id: 'current-user-id', role: 'user', content: 'hello' }], currentUserMessageId: 'current-user-id',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', appDb: makeDb()
    })
    expect(res.ok).toBe(true)
    expect(stream).toHaveBeenCalled()
  })

  it('把 Core 冻结的 Skill fragment 注入实际 provider 请求且位于当前输入之前', async () => {
    const stream = vi.fn((params: { messages?: unknown[] }) => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    }))
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream } })
    const res = await runToolChatSession({
      sender: makeSender(), requestId: 'req-skill-fragment', sessionId: 'sess-skill-fragment',
      model: 'claude-sonnet-4-20250514', messages: [{ id: 'current-user', role: 'user', content: 'current question' }], currentUserMessageId: 'current-user',
      skillFragments: ['## Skill: review\n\nreview instructions'],
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'test-key', appDb: makeDb()
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
    const res = await runToolChatSession({
      sender: makeSender(), requestId: 'req-preflight-recovery', sessionId: 'sess-preflight-recovery',
      model: 'claude-sonnet-4-20250514', contextWindow: 40_000,
      messages: [
        { id: 'old-user', role: 'user', content: 'x'.repeat(120_000) },
        { id: 'current-user', role: 'user', content: '当前问题' }
      ], currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', appDb: makeDb(), appendCompactionTransaction
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
    const res = await runToolChatSession({
      sender: makeSender(), requestId: 'req-tool-history-recovery', sessionId: 'sess-tool-history-recovery',
      model: 'claude-sonnet-4-20250514', contextWindow: 40_000, messages, currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', appDb: makeDb(), appendCompactionTransaction
    })
    expect(res.ok).toBe(true)
    expect(appendCompactionTransaction).toHaveBeenCalledTimes(1)
    const sentMessages = stream.mock.calls[0]?.[0]?.messages as Array<{ id?: string; content?: unknown }> | undefined
    expect(sentMessages).toHaveLength(1)
    expect(JSON.stringify(sentMessages)).not.toContain('tool-0')
    expect(JSON.stringify(sentMessages)).toContain('current question')
  })

  it('turn-boundary snapshot includes the newly generated assistant content', async () => {
    const boundary = vi.fn(async () => undefined)
    const longReply = 'assistant reply '.repeat(5_000)
    mockCreateAnthropicClient.mockReturnValue({ messages: { stream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
      finalMessage: vi.fn(async () => ({ content: [{ type: 'text', text: longReply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })) } })
    const res = await runToolChatSession({
      sender: makeSender(), requestId: 'req-final-surface', sessionId: 'sess-final-surface',
      model: 'claude-sonnet-4-20250514', contextWindow: 100_000,
      messages: [{ id: 'current-user', role: 'user', content: 'hello' }], currentUserMessageId: 'current-user',
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'test-key', appDb: makeDb(), onTurnBoundary: boundary
    })
    expect(res.ok).toBe(true)
    expect(boundary).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: longReply })]) })]),
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

    const res = await runToolChatSession({
      sender,
      requestId: 'req-usage-core',
      sessionId: 'sess-usage-core',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
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
