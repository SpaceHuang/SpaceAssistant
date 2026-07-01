import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { openDatabase, setConfigValue, type AppDatabase } from './database'
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
const capturedStreamSystems: (string | undefined)[] = []

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

vi.mock('./safeWebContentsSend', () => ({
  safeWebContentsSend: vi.fn()
}))

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

function makeDb(locale: 'zh-CN' | 'en-US' = 'en-US'): AppDatabase {
  const db = openDatabase(':memory:')
  setConfigValue(db, 'config.locale', locale)
  return db
}

describe('claudeStreamHandlers locale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    capturedStreamSystems.length = 0

    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn'
    })

    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn((params: { system?: string }) => {
          capturedStreamSystems.push(params.system)
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'hi' }
              }
            },
            finalMessage: vi.fn(async () => ({
              content: [{ type: 'text', text: 'hi' }],
              stop_reason: 'end_turn'
            }))
          }
        })
      }
    })
  })

  function registerHandlers() {
    registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'key',
      getWorkDir: () => '/tmp',
      resolveWorkDirForSession: () => '/session-workdir',
      getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }),
      getAppDatabase: () => makeDb('zh-CN'),
      getBrowserDetectContext: () => ({ workDir: '/tmp' })
    })
  }

  it('I6: send-stream with locale en-US includes English locale hint in system', async () => {
    registerHandlers()
    const sender = makeSender()
    const handler = handlers.get('claude-chat-send-stream')
    expect(handler).toBeDefined()

    await handler!({ sender } as never, {
      requestId: '00000000-0000-4000-8000-000000000001',
      sessionId: 'sess-locale-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      locale: 'en-US'
    })

    await new Promise((r) => setTimeout(r, 100))
    expect(capturedStreamSystems.length).toBeGreaterThan(0)
    expect(capturedStreamSystems[0]).toContain('English (en-US)')
    expect(capturedStreamSystems[0]).toContain('<ui_locale_preference>')
  })

  it('I7: create-with-tools passes payload.locale to runToolChatSession', async () => {
    registerHandlers()
    const sender = makeSender()
    const handler = handlers.get('claude-chat-create-with-tools')
    expect(handler).toBeDefined()

    await handler!({ sender } as never, {
      requestId: '00000000-0000-4000-8000-000000000002',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } }],
      locale: 'en-US'
    })

    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'en-US', workDir: '/session-workdir' })
    )
  })
})
