import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RemoteCommandRouter } from './remoteCommandRouter'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { CLAIM_LEASE_MS, ImProcessedStore } from '../remote/imProcessedStore'
import { getSession, openDatabase, createSession } from '../database'
import { createWorkDirManager } from '../workDirManager'

const mockReplyFeishuText = vi.fn().mockResolvedValue(undefined)
const mockRunFeishuRemoteAgent = vi.fn()
const mockResolveFeishuSession = vi.fn()
const mockSendFeishuRemoteOutbound = vi.fn().mockResolvedValue(undefined)

vi.mock('./feishuReply', () => ({
  replyFeishuText: (...args: unknown[]) => mockReplyFeishuText(...args)
}))

vi.mock('./feishuRemoteAgent', () => ({
  runFeishuRemoteAgent: (...args: unknown[]) => mockRunFeishuRemoteAgent(...args)
}))

vi.mock('./feishuSessionResolver', () => ({
  resolveFeishuSession: (...args: unknown[]) => mockResolveFeishuSession(...args)
}))

vi.mock('./feishuRemoteOutbound', () => ({
  sendFeishuRemoteOutbound: (...args: unknown[]) => mockSendFeishuRemoteOutbound(...args)
}))

vi.mock('./feishuCliLogger', () => ({
  logFeishuCliEvent: vi.fn()
}))

vi.mock('../remote/remoteProgressStore', () => ({
  clearRemoteProgressSession: vi.fn()
}))

function p2p(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderOpenId: 'ou_a',
    content: 'hello',
    createTime: '1',
    mentionsBot: false,
    ...overrides
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-disambig-'))
}

describe('RemoteCommandRouter workdir disambiguation identity', () => {
  let allowlist: string[] | undefined
  let remoteEnabled: boolean
  let processSpy: ReturnType<typeof vi.spyOn> | undefined
  let auditAppend: ReturnType<typeof vi.fn>
  let markCompleted: ReturnType<typeof vi.fn>
  let markExecuting: ReturnType<typeof vi.fn>
  let tryClaim: ReturnType<typeof vi.fn>

  const profiles = [
    { id: 'p1', name: 'Alpha', path: '/tmp/a', aliases: ['alpha'], sensitive: false, createdAt: 1 },
    { id: 'p2', name: 'Alpha2', path: '/tmp/a2', aliases: ['alpha'], sensitive: false, createdAt: 1 }
  ]

  beforeEach(() => {
    allowlist = ['ou_a']
    remoteEnabled = true
    auditAppend = vi.fn().mockResolvedValue(undefined)
    markCompleted = vi.fn().mockResolvedValue(true)
    markExecuting = vi.fn().mockResolvedValue(true)
    tryClaim = vi.fn().mockResolvedValue({ ok: true, claimId: 'claim-1' })
    mockReplyFeishuText.mockClear()
    mockRunFeishuRemoteAgent.mockClear()
    mockSendFeishuRemoteOutbound.mockClear()
  })

  afterEach(() => {
    processSpy?.mockRestore()
    vi.useRealTimers()
  })

  function makeRouter(overrides?: { processedStore?: Record<string, unknown> }) {
    const router = new RemoteCommandRouter({
      db: {} as never,
      runner: { run: vi.fn() } as never,
      processedStore: (overrides?.processedStore ?? {
        has: vi.fn().mockResolvedValue(false),
        mark: vi.fn().mockResolvedValue(undefined),
        tryClaim,
        markExecuting,
        markCompleted
      }) as never,
      confirmManager: { tryResolveFromInbound: () => false } as never,
      auditLogger: { append: auditAppend } as never,
      getFeishuConfig: () =>
        mergeFeishuConfig({
          enabled: true,
          remoteEnabled,
          appConfigured: true,
          remoteSenderAllowlist: allowlist
        }),
      getAppConfig: () => ({
        defaultModel: 'm',
        maxParallelChatSessions: 3,
        workDirProfiles: profiles,
        activeWorkDirProfileId: ''
      }),
      getWorkDir: () => '/tmp',
      workDirManager: {} as never,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'k',
      getBaseUrl: () => '',
      getMainWebContents: () => null,
      getModel: () => 'm',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG
    })
    processSpy = vi.spyOn(router as unknown as { processCommand: () => Promise<void> }, 'processCommand')
    return router
  }

  it('owner A creates pending then after rebind to B, A reply "1" must not Agent', async () => {
    const router = makeRouter()
    await router.handleInbound(
      p2p({
        messageId: 'm-ambig',
        senderOpenId: 'ou_a',
        content: '/sa @alpha list files'
      })
    )
    expect(mockReplyFeishuText.mock.calls.some((c) => String(c[2]).includes('1)'))).toBe(true)
    expect(processSpy).not.toHaveBeenCalled()

    // Rebind: clear A's pending + switch owner to B
    await router.clearPendingDisambiguation()
    expect(markCompleted).toHaveBeenCalledWith('m-ambig', 'claim-1', 'disambiguation_cleared')
    allowlist = ['ou_b']

    await router.handleInbound(
      p2p({
        messageId: 'm-choice',
        senderOpenId: 'ou_a',
        content: '1'
      })
    )
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('不是已绑定'))).toBe(true)
  })

  it('non-owner cannot consume pending even if chatId matches', async () => {
    const router = makeRouter()
    await router.handleInbound(
      p2p({
        messageId: 'm-ambig2',
        senderOpenId: 'ou_a',
        content: '/sa @alpha list files'
      })
    )
    processSpy?.mockClear()
    mockReplyFeishuText.mockClear()

    await router.handleInbound(
      p2p({
        messageId: 'm-intruder',
        senderOpenId: 'ou_intruder',
        content: '1'
      })
    )
    expect(processSpy).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('不是已绑定'))).toBe(true)
  })

  it('clearPendingDisambiguation drops stale choice without executing original cmd', async () => {
    const router = makeRouter()
    await router.handleInbound(
      p2p({
        messageId: 'm-ambig3',
        senderOpenId: 'ou_a',
        content: '/sa @alpha list files'
      })
    )
    await router.clearPendingDisambiguation()
    expect(markCompleted).toHaveBeenCalledWith('m-ambig3', 'claim-1', 'disambiguation_cleared')
    processSpy?.mockClear()
    processSpy?.mockResolvedValue(undefined as never)
    tryClaim.mockResolvedValueOnce({ ok: true, claimId: 'claim-late' })
    await router.handleInbound(p2p({ messageId: 'm-late', senderOpenId: 'ou_a', content: '1' }))
    // Pending gone: "1" is a new command, not a choice over the original ambiguous message.
    expect(processSpy).toHaveBeenCalled()
    const userMessage = processSpy?.mock.calls[0]?.[4]
    expect(userMessage).toBe('1')
    expect(userMessage).not.toContain('@alpha')
  })

  it('selection arrives after clearing pending must not reuse original claim', async () => {
    const router = makeRouter()
    await router.handleInbound(
      p2p({
        messageId: 'm-ambig-clear',
        senderOpenId: 'ou_a',
        content: '/sa @alpha list files'
      })
    )
    await router.clearPendingDisambiguation()
    expect(markCompleted).toHaveBeenCalledWith(
      'm-ambig-clear',
      'claim-1',
      'disambiguation_cleared'
    )
    processSpy?.mockClear()
    processSpy?.mockResolvedValue(undefined as never)
    tryClaim.mockResolvedValueOnce({ ok: true, claimId: 'claim-new' })

    await router.handleInbound(
      p2p({ messageId: 'm-choice-late', senderOpenId: 'ou_a', content: '1' })
    )

    expect(processSpy).toHaveBeenCalled()
    const call = processSpy?.mock.calls[0]
    expect(call?.[0]).toMatchObject({ messageId: 'm-choice-late', content: '1' })
    expect(call?.[5]).toBe('claim-new')
    expect(call?.[4]).toBe('1')
  })

  it('after disambiguation TTL the original claim is finalized so a later reclaim cannot revive it', async () => {
    vi.useFakeTimers()
    const dir = tempDir()
    const store = new ImProcessedStore({
      channel: 'feishu',
      userDataDir: dir,
      logEvent: vi.fn()
    })
    const router = makeRouter({
      processedStore: {
        has: (id: string) => store.has(id),
        mark: (...args: unknown[]) => (store.mark as (...a: unknown[]) => Promise<void>)(...args),
        tryClaim: (id: string, now?: number) => store.tryClaim(id, now),
        markExecuting: (id: string, claimId: string, now?: number) =>
          store.markExecuting(id, claimId, now),
        markCompleted: (id: string, claimId: string, summary: string, now?: number) =>
          store.markCompleted(id, claimId, summary, now)
      }
    })

    await router.handleInbound(
      p2p({
        messageId: 'm-ambig-ttl',
        senderOpenId: 'ou_a',
        content: '/sa @alpha list files'
      })
    )
    expect(processSpy).not.toHaveBeenCalled()

    // TTL is under claim lease; fire timeout finalizer.
    await vi.advanceTimersByTimeAsync(CLAIM_LEASE_MS)

    processSpy?.mockClear()
    processSpy?.mockResolvedValue(undefined as never)

    // Original message claim is completed — another tryClaim must be rejected as duplicate.
    const reclaim = await store.tryClaim('m-ambig-ttl', Date.now() + CLAIM_LEASE_MS + 1)
    expect(reclaim.ok).toBe(false)

    await router.handleInbound(
      p2p({ messageId: 'm-choice-after-ttl', senderOpenId: 'ou_a', content: '1' })
    )
    // Pending gone: "1" is a new inbound, not the original ambiguous command.
    expect(processSpy).toHaveBeenCalled()
    const call = processSpy?.mock.calls[0]
    expect(call?.[0]).toMatchObject({ messageId: 'm-choice-after-ttl' })
    expect(call?.[4]).toBe('1')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('RemoteCommandRouter markExecuting gate', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    vi.clearAllMocks()
    mockRunFeishuRemoteAgent.mockReset()
    mockResolveFeishuSession.mockReset()
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('does not start Agent when markExecuting returns false', async () => {
    const dirA = tempDir()
    dirs.push(dirA)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    let workDir = dirA
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => workDir,
      setWorkDir: (d) => {
        workDir = d
      }
    })
    manager.addProfile({ name: 'Alpha', path: dirA, aliases: ['alpha'] })

    const session = createSession(db, { name: 'Feishu Session' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const auditAppend = vi.fn().mockResolvedValue(undefined)
    const markExecuting = vi.fn().mockResolvedValue(false)
    const markCompleted = vi.fn().mockResolvedValue(true)
    const router = new RemoteCommandRouter({
      db,
      runner: { run: vi.fn() } as never,
      processedStore: {
        has: vi.fn().mockResolvedValue(false),
        mark: vi.fn().mockResolvedValue(undefined),
        tryClaim: vi.fn().mockResolvedValue({ ok: true, claimId: 'claim-lost' }),
        markExecuting,
        markCompleted
      } as never,
      confirmManager: { tryResolveFromInbound: () => false } as never,
      auditLogger: { append: auditAppend } as never,
      getFeishuConfig: () =>
        mergeFeishuConfig({
          enabled: true,
          remoteEnabled: true,
          appConfigured: true,
          remoteSenderAllowlist: ['ou_a']
        }),
      getAppConfig: () => ({
        defaultModel: 'm',
        maxParallelChatSessions: 3,
        workDirProfiles: manager.listProfiles(),
        activeWorkDirProfileId: manager.getActiveProfileId()
      }),
      getWorkDir: () => manager.getActiveWorkDir(),
      workDirManager: manager,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'k',
      getBaseUrl: () => '',
      getMainWebContents: () => null,
      getModel: () => 'm',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG
    })

    await router.handleInbound(
      p2p({
        messageId: 'm-lost-claim',
        senderOpenId: 'ou_a',
        content: '/sa @alpha list files'
      })
    )

    expect(markExecuting).toHaveBeenCalledWith('m-lost-claim', 'claim-lost')
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_start_rejected',
        messageId: 'm-lost-claim',
        reason: 'processed_claim_lost'
      })
    )
    expect(markCompleted).toHaveBeenCalledWith('m-lost-claim', 'claim-lost', 'processed_claim_lost')
    expect(getSession(db, session.id)?.workDirProfileId).toBeDefined()
  })
})
