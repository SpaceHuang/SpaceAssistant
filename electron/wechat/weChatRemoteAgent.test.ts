import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'

const mockRunToolChatSession = vi.fn()
const mockGetMessages = vi.fn(() => [])

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('../database', () => ({
  getMessages: (...args: unknown[]) => mockGetMessages(...args)
}))

vi.mock('../appIpc', () => ({
  readAppLocale: () => 'zh-CN'
}))

vi.mock('../remote/remoteProgressCoordinator', () => ({
  startRemoteProgressSession: vi.fn(),
  stopRemoteProgressSession: vi.fn()
}))

vi.mock('../remote/remoteProgressStore', () => ({
  clearRemoteProgressSession: vi.fn()
}))

vi.mock('../feishu/runningRemoteAgentRegistry', () => ({
  registerRunningRemoteAgent: vi.fn(),
  unregisterRunningRemoteAgent: vi.fn()
}))

import { runWeChatRemoteAgent } from './weChatRemoteAgent'

function makeDb(): AppDatabase {
  return {
    data: { configs: {}, sessions: [], messages: [] },
    save: vi.fn()
  } as unknown as AppDatabase
}

function baseCtx(getMainWebContents: () => WebContents | null) {
  return {
    db: makeDb(),
    sessionId: 'sess-1',
    userMessage: 'hello',
    replyMessageId: 'msg-1',
    requestId: '00000000-0000-4000-8000-000000000001',
    wechatConfig: { ...DEFAULT_WECHAT_CONFIG, remoteTypingEnabled: false, remoteProgressHeartbeatSec: 0 },
    workDir: '/tmp',
    userDataDir: '/tmp',
    getMainWebContents,
    getApiKey: async () => 'key',
    getBaseUrl: () => 'https://api.example.com',
    getModel: () => 'claude-sonnet-4-20250514',
    botService: { getBot: () => null } as never,
    confirmManager: {} as never,
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    remoteContext: {
      source: 'wechat' as const,
      messageId: 'msg-1',
      userId: 'wx-user@test',
      contextToken: 'ctx'
    },
    inboundRaw: makeIncomingMessage(),
    userId: 'wx-user@test'
  }
}

describe('runWeChatRemoteAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('invokes runToolChatSession with wechat appendix', async () => {
    let capturedSystem: string | undefined
    mockRunToolChatSession.mockImplementation(async (args: { system?: string }) => {
      capturedSystem = args.system
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    const sender = { send: vi.fn() } as unknown as WebContents
    const result = await runWeChatRemoteAgent(baseCtx(() => sender))

    expect(mockRunToolChatSession).toHaveBeenCalledTimes(1)
    expect(capturedSystem).toContain('wechat_remote_command')
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('ok')
  })

  it('works when main webContents is null', async () => {
    await runWeChatRemoteAgent(baseCtx(() => null))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ appDb: expect.anything() })
    )
  })
})
