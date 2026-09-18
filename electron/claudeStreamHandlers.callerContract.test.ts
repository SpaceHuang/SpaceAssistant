import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { appendMessage, createPersistedTurn, createSession, openDatabase, setConfigValue, type AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

/**
 * P0 特征化基线（桌面调用方）：桌面 execute → runToolChatSession 入参契约。
 * 断言只写值语义（出口接线、会话锚点、冻结快照透传），P1 契约平移后仅调整访问路径。
 */

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
const mockGetSessionEventSink = vi.fn()
const mockReadCompactionMarkers = vi.fn(async () => [])
const mockReadCompactionReplay = vi.fn(async () => ({ committed: [], rejected: [] }))
const mockReadSessionEvents = vi.fn(async () => [])

vi.mock('./toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('./sessionEvents', () => ({
  getSessionEventSink: (...args: unknown[]) => mockGetSessionEventSink(...args),
  readCompactionMarkers: (...args: unknown[]) => mockReadCompactionMarkers(...args),
  readCompactionReplay: (...args: unknown[]) => mockReadCompactionReplay(...args),
  readSessionEvents: (...args: unknown[]) => mockReadSessionEvents(...args)
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

function makeEventSink() {
  return {
    appendCritical: vi.fn(async (input: { type: string; payload: Record<string, unknown> }) => ({ seq: 1, time: 1, type: input.type, payload: input.payload })),
    appendChunk: vi.fn(),
    waitForCapacity: vi.fn(async () => undefined),
    flush: vi.fn(async () => ({ committedEvents: 0, seq: 0, pendingEvents: 0, pendingBytes: 0 })),
    close: vi.fn(async () => ({ committedEvents: 0, seq: 0, pendingEvents: 0, pendingBytes: 0 })),
    eventsPath: '/tmp/events.jsonl',
    indexPath: '/tmp/events.index.json'
  }
}

function makeDb(): AppDatabase {
  const db = openDatabase(':memory:')
  setConfigValue(db, 'config.locale', 'zh-CN')
  return db
}

function seedTrustedModel(db: AppDatabase): void {
  setConfigValue(db, 'config.models', JSON.stringify([
    { id: 'trusted', name: 'trusted-model', maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: false, isVision: false, enabled: true }
  ]))
  setConfigValue(db, 'config.llmServices', JSON.stringify([
    { id: 'svc-trusted', name: 'Trusted', baseUrl: 'https://trusted.example.com', supportedModelIds: ['trusted'], createdAt: '1', updatedAt: '1' }
  ]))
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['svc-trusted']))
  setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ 'svc-trusted': 'enc:sk-test' }))
}

describe('claudeStreamHandlers 桌面调用方契约（P0 特征化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    mockGetSessionEventSink.mockReturnValue(makeEventSink())
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn'
    })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn'
          }))
        }))
      }
    })
  })

  it('execute → Core args：出口接线 + 会话锚点 + appDb 注入 + lane 缺省（desktop）', async () => {
    const db = makeDb()
    seedTrustedModel(db)
    const session = createSession(db, { name: 'caller-contract', model: 'trusted-model', maxTokens: 2048 })
    const user = appendMessage(db, { id: 'cc-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'cc-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'cc-turn', requestId: 'cc-request', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence, state: 'prepared', startToken: 'cc-token',
      executionConfig: { lane: 'desktop', model: 'trusted-model', baseUrl: 'https://trusted.example.com', system: 'sys', maxTokens: 2048, enableThinking: false, locale: 'zh-CN' }
    })
    const notifyMainWindow = vi.fn()
    const floatingNotificationManager = { onConfirmRequest: vi.fn() }
    const execute = registerClaudeStreamHandlers(ipcMain, {
      getApiKey: async () => 'key',
      getWorkDir: () => '/tmp',
      resolveWorkDirForSession: () => '/tmp',
      getUserDataPath: () => '/tmp',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
      getBrowserConfig: () => ({ enabled: false, allowRemoteSessions: false }),
      getShellConfig: () => ({ enabled: false, shellDefaultTimeoutSec: 300, maxInlineOutputBytes: 1024, rules: [] }),
      getWikiConfig: () => ({ enabled: false }),
      getAppDatabase: () => db,
      getBrowserDetectContext: () => ({ workDir: '/tmp' }),
      turnRuntime: { bindRequest: vi.fn() } as never,
      notifyMainWindow,
      floatingNotificationManager: floatingNotificationManager as never
    })

    await execute(makeSender(), {
      requestId: 'cc-request', turnId: 'cc-turn', turnStartToken: 'cc-token', sessionId: session.id
    })

    expect(mockRunToolChatSession).toHaveBeenCalledTimes(1)
    const args = mockRunToolChatSession.mock.calls[0]![0] as Record<string, unknown>

    // 会话锚点与请求追踪
    expect(args.sessionId).toBe(session.id)
    expect(args.requestId).toBe('cc-request')
    expect(args.turnId).toBe('cc-turn')
    // 宿主数据库注入（P1 平移为 ports.legacy.appDb，P2 收口为端口）
    expect(args.appDb).toBe(db)
    // 桌面调用方不显式声明 lane（Core 缺省 desktop）
    expect(args.lane).toBeUndefined()
    // 事件出口接线：fact / session 双出口 + 标题 / 文件树出口接 notifyMainWindow
    expect(args.emitFactEvent).toBeTypeOf('function')
    expect(args.emitSessionEvent).toBeTypeOf('function')
    expect(args.onTitleGenerated).toBeTypeOf('function')
    expect(args.onFileTreeChanged).toBeTypeOf('function')
    // 浮动通知宿主对象直传（§5.5 待出口化——P1 收口的偏差 1 尾巴）
    expect(args.floatingNotificationManager).toBe(floatingNotificationManager)
    // 冻结快照值语义
    expect(args.locale).toBe('zh-CN')
    expect(args.currentUserMessageId).toBe('cc-user')
    ;(args.onFileTreeChanged as (e: unknown) => void)({ kind: 'paths', relPaths: ['a.txt'] })
    expect(notifyMainWindow).toHaveBeenCalledWith('file:tree-changed', { kind: 'paths', relPaths: ['a.txt'] })
    db.close()
  })
})
