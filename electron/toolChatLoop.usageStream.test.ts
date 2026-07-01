import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0

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

vi.mock('./tools/builtinExecutors', () => ({
  getToolExecutor: vi.fn((name: string) => {
    if (name === 'read_file') {
      return {
        name: 'read_file',
        execute: vi.fn(async () => ({ success: true, data: 'ok' }))
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
  const send = sender.send as ReturnType<typeof vi.fn>
  return send.mock.calls
    .filter(([channel]) => channel === 'claude-chat-usage')
    .map(([, payload]) => payload as {
      requestId: string
      sessionId: string
      usage: Record<string, number | undefined>
      projected?: boolean
    })
}

describe('runToolChatSession message_start usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
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
      appDb: makeDb()
    })
  }

  it('emits claude-chat-usage on message_start before finalMessage', async () => {
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

  it('emits projected claude-chat-usage after tool results without polluting return usage', async () => {
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
        return {
          name: 'read_file',
          execute: vi.fn(async () => ({ success: true, data: largeToolResult }))
        }
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
        return {
          name: 'read_file',
          execute: vi.fn(async () => ({ success: false, error: 'boom' }))
        }
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
