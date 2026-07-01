import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockLogAgentEvent = vi.fn()
const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const capturedStreamParams: Array<{ system?: string }> = []
let streamRound = 0

function makeMockStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start' }
    },
    finalMessage: vi.fn(async () => {
      streamRound += 1
      if (streamRound === 1) {
        return {
          content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 8 }
      }
    })
  }
}

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: (...args: unknown[]) => mockLogAgentEvent(...args),
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

vi.mock('./safeWebContentsSend', () => ({
  isWebContentsAlive: vi.fn(() => true),
  safeWebContentsSend: vi.fn()
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

function makeDb(locale: 'zh-CN' | 'en-US' = 'zh-CN'): AppDatabase {
  return createMemoryAppDb(locale)
}

describe('runToolChatSession locale injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedStreamParams.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { system?: string }) => {
          capturedStreamParams.push(params)
          return makeMockStream()
        })
      }
    }))
  })

  async function runSession(overrides: Partial<Parameters<typeof runToolChatSession>[0]> = {}) {
    return runToolChatSession({
      sender: makeSender(),
      requestId: 'req-1',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'test-key',
      appDb: makeDb('zh-CN'),
      ...overrides
    })
  }

  it('I1: locale zh-CN injects Chinese ui_locale_preference into API system', async () => {
    streamRound = 1
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { system?: string }) => {
          capturedStreamParams.push(params)
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start' }
            },
            finalMessage: vi.fn(async () => ({
              content: [{ type: 'text', text: '你好' }],
              stop_reason: 'end_turn'
            }))
          }
        })
      }
    }))

    const res = await runSession({ locale: 'zh-CN' })
    expect(res.ok).toBe(true)
    const system = capturedStreamParams[0]?.system ?? ''
    expect(system).toContain('<ui_locale_preference>')
    expect(system).toContain('Simplified Chinese')
  })

  it('I2: locale en-US injects English ui_locale_preference into API system', async () => {
    streamRound = 1
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { system?: string }) => {
          capturedStreamParams.push(params)
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start' }
            },
            finalMessage: vi.fn(async () => ({
              content: [{ type: 'text', text: 'hello' }],
              stop_reason: 'end_turn'
            }))
          }
        })
      }
    }))

    const res = await runSession({ locale: 'en-US' })
    expect(res.ok).toBe(true)
    const system = capturedStreamParams[0]?.system ?? ''
    expect(system).toContain('<ui_locale_preference>')
    expect(system).toContain('English (en-US)')
  })

  it('I3: missing locale falls back to readAppLocale from appDb', async () => {
    streamRound = 1
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { system?: string }) => {
          capturedStreamParams.push(params)
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start' }
            },
            finalMessage: vi.fn(async () => ({
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn'
            }))
          }
        })
      }
    }))

    const res = await runSession({ locale: undefined, appDb: makeDb('zh-CN') })
    expect(res.ok).toBe(true)
    expect(capturedStreamParams[0]?.system).toContain('Simplified Chinese')
  })

  it('I4: each loop round system includes locale hint', async () => {
    const res = await runSession({ locale: 'en-US' })
    expect(res.ok).toBe(true)
    expect(capturedStreamParams.length).toBeGreaterThanOrEqual(2)
    for (const params of capturedStreamParams) {
      expect(params.system).toContain('<ui_locale_preference>')
      expect(params.system).toContain('English (en-US)')
    }
  })

  it('I5: projectMemoryEnabled false still injects locale hint', async () => {
    streamRound = 1
    mockGetCachedMemoryContent.mockReturnValue('# memory')
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn((params: { system?: string }) => {
          capturedStreamParams.push(params)
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start' }
            },
            finalMessage: vi.fn(async () => ({
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn'
            }))
          }
        })
      }
    }))

    const res = await runSession({ locale: 'zh-CN', projectMemoryEnabled: false })
    expect(res.ok).toBe(true)
    const system = capturedStreamParams[0]?.system ?? ''
    expect(system).toContain('<ui_locale_preference>')
    expect(system).not.toContain('<project_memory>')
  })
})
