import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { appendMessage, createPersistedTurn, createSession, openDatabase, setConfigValue, type AppDatabase } from './database'
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
import { safeWebContentsSend } from './safeWebContentsSend'

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

  function registerHandlers(db = makeDb('zh-CN')) {
    return registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'key',
      getWorkDir: () => '/tmp',
      resolveWorkDirForSession: () => '/session-workdir',
      getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }),
      getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir: '/tmp' })
    })
  }

  it('不再注册可绕过 Runtime 的 legacy create-with-tools 与 cancel IPC', () => {
    registerHandlers()
    expect(handlers.has('claude-chat-create-with-tools')).toBe(false)
    expect(handlers.has('claude-chat-cancel')).toBe(false)
  })

  it('execute 忽略 renderer 伪造配置并使用 turn 冻结快照', async () => {
    const db = makeDb('zh-CN')
    const session = createSession(db, { name: 'frozen-execution', model: 'trusted-model', maxTokens: 2048 })
    const user = appendMessage(db, { id: 'frozen-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'frozen-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'frozen-turn', requestId: 'frozen-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'frozen-token',
      executionConfig: { lane: 'desktop', model: 'trusted-model', baseUrl: 'https://trusted.example.com', system: 'trusted system', maxTokens: 2048, enableThinking: false, locale: 'zh-CN' }
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'key', getWorkDir: () => '/tmp', resolveWorkDirForSession: () => '/tmp', getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir: '/tmp' }), turnRuntime: { bindRequest: vi.fn() } as never
    })

    await execute(makeSender(), {
      requestId: 'frozen-request', turnId: 'frozen-turn', turnStartToken: 'frozen-token', sessionId: session.id,
      model: 'forged-model', baseUrl: 'https://evil.example.com', llmServiceId: 'evil-service', system: 'evil system',
      options: { maxTokens: 9999, enableThinking: true }, locale: 'en-US'
    })

    expect(mockRunToolChatSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'trusted-model', baseUrl: 'https://trusted.example.com', system: 'trusted system',
      options: { maxTokens: 2048, enableThinking: false }, locale: 'zh-CN'
    }))
    db.close()
  })

  it('无执行快照的 legacy turn 只能恢复查看，不能用当前配置重新执行', async () => {
    const db = makeDb('zh-CN')
    const session = createSession(db, { name: 'legacy-read-only', model: 'current-model' })
    const user = appendMessage(db, { id: 'legacy-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'legacy-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'legacy-turn', requestId: 'legacy-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'legacy-token'
    })
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'key', getWorkDir: () => '/tmp', resolveWorkDirForSession: () => '/tmp', getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }), getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir: '/tmp' }), turnRuntime: { bindRequest: vi.fn() } as never
    })

    await expect(execute(makeSender(), {
      requestId: 'legacy-request', turnId: 'legacy-turn', turnStartToken: 'legacy-token', sessionId: session.id,
      model: 'current-model'
    })).resolves.toEqual({ ok: false, error: 'TURN_LEGACY_EXECUTION_CONFIG_UNAVAILABLE' })
    expect(mockRunToolChatSession).not.toHaveBeenCalled()
    db.close()
  })
})
