import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { AppDatabase } from '../database'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { WeChatCommandRouter } from './weChatCommandRouter'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import { WeChatProcessedStore } from './weChatProcessedStore'
import { WeChatAuditLogger } from './weChatAuditLogger'
import { WeChatConfirmManager } from './weChatConfirmManager'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import { openDatabase, createSession } from '../database'
import {
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession,
  releaseRemoteSession
} from '../remote/remoteAgentRegistry'
import { REMOTE_SESSION_BUSY_MESSAGE } from '../remote/remoteSessionGuardMessages'

const mockRunAgent = vi.fn()
const mockResolveSession = vi.fn()

vi.mock('./weChatRemoteAgent', () => ({
  runWeChatRemoteAgent: (...args: unknown[]) => mockRunAgent(...args)
}))

vi.mock('./weChatSessionResolver', () => ({
  resolveWeChatSession: (...args: unknown[]) => mockResolveSession(...args)
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
  let db: ReturnType<typeof openDatabase>
  let sessionId: string
  let closeDb: () => void

  beforeEach(async () => {
    vi.clearAllMocks()
    resetRunningRemoteAgentRegistryForTests()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-router-'))
    processed = new WeChatProcessedStore(tmpDir)
    audit = new WeChatAuditLogger(tmpDir)
    reply = vi.fn(async () => undefined)
    mockRunAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const dbPath = path.join(tmpDir, 'test.db')
    db = openDatabase(dbPath)
    closeDb = () => db.close()
    const session = createSession(db, { name: 'WeChat Session' })
    sessionId = session.id
    mockResolveSession.mockResolvedValue({ sessionId, isNew: true })

    const mockWorkDirManager = {
      listProfiles: () => [],
      getActiveProfileId: () => 'p1',
      getActiveWorkDir: () => tmpDir,
      checkDirectoryWritable: () => ({ ok: true })
    }

    router = new WeChatCommandRouter({
      db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      confirmManager: new WeChatConfirmManager(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['wx-user@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: mockWorkDirManager as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: vi.fn() }) as never,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })
  })

  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
    closeDb?.()
    if (tmpDir && fsSync.existsSync(tmpDir)) {
      fsSync.rmSync(tmpDir, { recursive: true, force: true })
    }
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
      db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      confirmManager: new WeChatConfirmManager(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['allowed@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => null,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })
    await r2.handleSdkInbound(raw)
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('不是已绑定'))
  })

  it('rejects when allowlist is empty', async () => {
    const raw = makeIncomingMessage({ userId: 'anyone@test' })
    const r2 = new WeChatCommandRouter({
      db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      confirmManager: new WeChatConfirmManager(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: undefined
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => null,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })
    await r2.handleSdkInbound(raw)
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('不是已绑定'))
  })

  it('rejects second inbound when session is busy', async () => {
    tryClaimRemoteSession(sessionId, 'req-busy', 3)
    const raw2 = makeIncomingMessage({ text: 'second', raw: { ...makeIncomingMessage().raw, client_id: 'busy-2' } })
    await router.handleSdkInbound(raw2)

    expect(mockRunAgent).not.toHaveBeenCalled()
    // busy 拒绝经 sendWeChatRemoteOutbound 发出，会追加桌面会话引用后缀（供桌面端会话跟随解析）
    expect(reply).toHaveBeenCalledTimes(1)
    const sent = reply.mock.calls[0]![1] as string
    expect(sent).toContain(REMOTE_SESSION_BUSY_MESSAGE)
    expect(sent).toContain(`会话$${sessionId}$`)
    // Persist terminal claim state — must not leave a sticky `claimed` row.
    const entry = (
      processed as unknown as {
        data: { entries: Array<{ state: string; resultSummary?: string }> }
      }
    ).data.entries.find((e) => e.resultSummary === 'session_busy')
    expect(entry?.state).toBe('completed')
    expect(entry?.resultSummary).toBe('session_busy')
    releaseRemoteSession(sessionId, 'req-busy')
  })

  it('completion/audit stay on the origin session after a mid-run switch_session, while reply follows the switched session', async () => {
    const target = createSession(db, { name: 'Target' })
    const wcSend = vi.fn()
    mockRunAgent.mockImplementation(
      async ({ remoteContext }: { remoteContext: { outboundSessionId?: string; originSessionId?: string } }) => {
        expect(remoteContext.originSessionId).toBe(sessionId)
        remoteContext.outboundSessionId = target.id
        return { summary: 'done', pendingConfirm: false, ok: true }
      }
    )

    const r2 = new WeChatCommandRouter({
      db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: processed,
      confirmManager: new WeChatConfirmManager(),
      auditLogger: audit,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn: true,
        remoteSenderAllowlist: ['wx-user@test']
      }),
      getAppConfig: () => ({ defaultModel: 'm1', maxParallelChatSessions: 3 }),
      getWorkDir: () => tmpDir,
      workDirManager: {
        listProfiles: () => [],
        getActiveProfileId: () => 'p1',
        getActiveWorkDir: () => tmpDir,
        checkDirectoryWritable: () => ({ ok: true })
      } as never,
      getUserDataPath: () => tmpDir,
      getApiKey: async () => 'key',
      getBaseUrl: () => 'https://api.example.com',
      getMainWebContents: () => ({ send: wcSend }) as never,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })

    const raw = makeIncomingMessage({ text: 'switch then reply' })
    await r2.handleSdkInbound(raw)

    expect(wcSend).toHaveBeenCalledWith(
      'wechat:agent-done',
      expect.objectContaining({ sessionId })
    )
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`会话$${target.id}$`))
  })
})
