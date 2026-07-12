import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from '../database'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { WeChatCommandRouter } from './weChatCommandRouter'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import { WeChatProcessedStore } from './weChatProcessedStore'
import { WeChatAuditLogger } from './weChatAuditLogger'
import { WeChatConfirmManager } from './weChatConfirmManager'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const mockRunAgent = vi.fn()
const mockResolveSession = vi.fn()
const mockCountRunning = vi.fn(() => 0)

vi.mock('./weChatRemoteAgent', () => ({
  runWeChatRemoteAgent: (...args: unknown[]) => mockRunAgent(...args)
}))

vi.mock('./weChatSessionResolver', () => ({
  resolveWeChatSession: (...args: unknown[]) => mockResolveSession(...args),
  touchWeChatSessionReply: vi.fn()
}))

vi.mock('../feishu/runningRemoteAgentRegistry', () => ({
  countRunningRemoteAgents: () => mockCountRunning()
}))

vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>()
  return {
    ...actual,
    appendMessage: vi.fn(),
    updateMessageContent: vi.fn()
  }
})

describe('WeChatCommandRouter', () => {
  let tmpDir: string
  let processed: WeChatProcessedStore
  let audit: WeChatAuditLogger
  let reply: ReturnType<typeof vi.fn>
  let router: WeChatCommandRouter

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-router-'))
    processed = new WeChatProcessedStore(tmpDir)
    audit = new WeChatAuditLogger(tmpDir)
    reply = vi.fn(async () => undefined)
    mockRunAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })
    mockResolveSession.mockResolvedValue({ sessionId: 'sess-1', isNew: true })

    const db = {
      data: { sessions: [], messages: [], configs: {} },
      save: vi.fn()
    } as unknown as AppDatabase

    router = new WeChatCommandRouter({
      db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      confirmManager: new WeChatConfirmManager(),
      auditLogger: audit,
      getWeChatConfig: () => ({ ...DEFAULT_WECHAT_CONFIG, remoteEnabled: true, loggedIn: true }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })
  })

  it('processes accepted text inbound', async () => {
    const raw = makeIncomingMessage({ text: 'list files' })
    await router.handleSdkInbound(raw)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalled()
  })

  it('deduplicates same messageId', async () => {
    const raw = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'dup-1' } })
    await router.handleSdkInbound(raw)
    await router.handleSdkInbound(raw)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
  })

  it('rejects allowlist sender', async () => {
    const raw = makeIncomingMessage({ userId: 'blocked@test' })
    const r2 = new WeChatCommandRouter({
      db: (router as unknown as { deps: { db: AppDatabase } }).deps.db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      confirmManager: new WeChatConfirmManager(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['allowed@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => null,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })
    await r2.handleSdkInbound(raw)
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('权限'))
  })
})
