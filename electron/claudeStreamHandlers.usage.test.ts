import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en-US') },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

const mockRunToolChatSession = vi.fn()
const mockCreateAnthropicClient = vi.fn()

vi.mock('./toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return {
    ...actual,
    getCachedMemoryContent: vi.fn(() => null)
  }
})

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  clearChatCancel: vi.fn(),
  signalChatCancel: vi.fn(),
  CHAT_CANCELLED_MESSAGE: 'cancelled'
}))

import { ipcMain } from 'electron'
import { registerClaudeStreamHandlers } from './claudeStreamHandlers'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function makeDb(): AppDatabase {
  return {
    data: {
      configs: { 'config.locale': { value: 'zh-CN', createdAt: 0, updatedAt: 0 } },
      sessions: [],
      messages: []
    },
    save: vi.fn()
  } as unknown as AppDatabase
}

function registerHandlers() {
  registerClaudeStreamHandlers(ipcMain, {
    getApiKey: async () => 'key',
    getWorkDir: () => '/tmp',
    getUserDataPath: () => '/tmp',
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
    getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
    getWikiConfig: () => ({ enabled: false }),
    getAppDatabase: () => makeDb(),
    getBrowserDetectContext: () => ({ workDir: '/tmp' })
  })
}

const VALID_REQUEST_ID = '00000000-0000-4000-8000-000000000001'

function usageCalls(sender: WebContents) {
  const send = sender.send as ReturnType<typeof vi.fn>
  return send.mock.calls.filter(([channel]) => channel === 'claude-chat-usage')
}

function doneCalls(sender: WebContents) {
  const send = sender.send as ReturnType<typeof vi.fn>
  return send.mock.calls.filter(([channel]) => channel === 'claude-chat-done')
}

describe('claudeStreamHandlers usage streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn'
    })
  })

  it('send-stream emits claude-chat-usage on message_start with sessionId', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message_start',
              message: { usage: { input_tokens: 3200, cache_read_input_tokens: 100 } }
            }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3200, output_tokens: 120, cache_read_input_tokens: 100 }
          }))
        }))
      }
    })

    registerHandlers()
    const sender = makeSender()
    const handler = handlers.get('claude-chat-send-stream')
    await handler!({ sender } as never, {
      requestId: VALID_REQUEST_ID,
      sessionId: 'sess-stream-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }]
    })

    await vi.waitUntil(() => usageCalls(sender).length >= 2, { timeout: 2000 })

    const calls = usageCalls(sender)
    expect(calls[0]?.[1]).toMatchObject({
      requestId: VALID_REQUEST_ID,
      sessionId: 'sess-stream-1',
      usage: { input_tokens: 3200, cache_read_input_tokens: 100 }
    })
  })

  it('send-stream still emits claude-chat-done with usage after finalMessage', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'message_start',
              message: { usage: { input_tokens: 1000 } }
            }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1000, output_tokens: 50 }
          }))
        }))
      }
    })

    registerHandlers()
    const sender = makeSender()
    const handler = handlers.get('claude-chat-send-stream')
    await handler!({ sender } as never, {
      requestId: VALID_REQUEST_ID,
      sessionId: 'sess-stream-2',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }]
    })

    await vi.waitUntil(() => doneCalls(sender).length >= 1, { timeout: 2000 })

    expect(doneCalls(sender)[0]?.[1]).toMatchObject({
      requestId: VALID_REQUEST_ID,
      usage: { input_tokens: 1000, output_tokens: 50 }
    })
  })

  it('send-stream without message_start usage only emits usage at finalMessage', async () => {
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start' }
          },
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 777, output_tokens: 33 }
          }))
        }))
      }
    })

    registerHandlers()
    const sender = makeSender()
    const handler = handlers.get('claude-chat-send-stream')
    await handler!({ sender } as never, {
      requestId: VALID_REQUEST_ID,
      sessionId: 'sess-stream-3',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }]
    })

    await vi.waitUntil(() => usageCalls(sender).length >= 1, { timeout: 2000 })

    const calls = usageCalls(sender)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toMatchObject({
      sessionId: 'sess-stream-3',
      usage: { input_tokens: 777, output_tokens: 33 }
    })
  })
})
