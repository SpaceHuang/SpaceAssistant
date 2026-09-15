import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { appendMessage, createPersistedTurn, createSession, openDatabase, setConfigValue } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') },
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

vi.mock('./sessionEvents', () => ({
  getSessionEventSink: () => ({
    appendCritical: vi.fn(async (input: { type: string; payload: Record<string, unknown> }) => ({
      seq: 1,
      time: 1,
      type: input.type,
      payload: input.payload
    })),
    appendChunk: vi.fn(),
    waitForCapacity: vi.fn(async () => undefined),
    flush: vi.fn(async () => ({ committedEvents: 0, seq: 0, pendingEvents: 0, pendingBytes: 0 })),
    close: vi.fn(async () => ({ committedEvents: 0, seq: 0, pendingEvents: 0, pendingBytes: 0 })),
    eventsPath: '/tmp/events.jsonl',
    indexPath: '/tmp/events.index.json'
  })
}))

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: vi.fn(() => null) }
})

vi.mock('./safeWebContentsSend', () => ({ safeWebContentsSend: vi.fn() }))

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

describe('claudeStreamHandlers 模型绑定 fail-fast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
  })

  it('冻结模型已不可用时直接失败，不带默认 baseURL 发请求', async () => {
    const db = openDatabase(':memory:')
    // 模型列表里已没有该模型（会话/快照来自旧配置）
    setConfigValue(db, 'config.models', JSON.stringify([]))
    const session = createSession(db, { name: 'stale-model', model: 'claude-sonnet-4-20250514' })
    const user = appendMessage(db, {
      id: 'stale-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent'
    })
    const assistant = appendMessage(db, {
      id: 'stale-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming'
    })
    createPersistedTurn(db, {
      turnId: 'stale-turn', requestId: 'stale-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'stale-token',
      executionConfig: { lane: 'desktop', model: 'claude-sonnet-4-20250514', maxTokens: 2048, enableThinking: false }
    })

    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'legacy-key',
      getWorkDir: () => '/tmp',
      resolveWorkDirForSession: () => '/tmp',
      getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }),
      getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir: '/tmp' }),
      turnRuntime: { bindRequest: vi.fn() } as never
    })

    const result = await execute(makeSender(), {
      requestId: 'stale-request',
      turnId: 'stale-turn',
      turnStartToken: 'stale-token',
      sessionId: session.id,
      model: 'claude-sonnet-4-20250514'
    }) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('会话模型「claude-sonnet-4-20250514」当前不可用')
    // 不得带着 undefined baseURL 退回 SDK 默认端点
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    expect(mockRunToolChatSession).not.toHaveBeenCalled()
    db.close()
  })
})
