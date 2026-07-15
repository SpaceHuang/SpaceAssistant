import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RemoteCommandRouter } from './remoteCommandRouter'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'

const mockReplyFeishuText = vi.fn().mockResolvedValue(undefined)
const mockRunFeishuRemoteAgent = vi.fn()

vi.mock('./feishuReply', () => ({
  replyFeishuText: (...args: unknown[]) => mockReplyFeishuText(...args)
}))

vi.mock('./feishuRemoteAgent', () => ({
  runFeishuRemoteAgent: (...args: unknown[]) => mockRunFeishuRemoteAgent(...args)
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

describe('RemoteCommandRouter workdir disambiguation identity', () => {
  let allowlist: string[] | undefined
  let remoteEnabled: boolean
  let processSpy: ReturnType<typeof vi.spyOn> | undefined
  let auditAppend: ReturnType<typeof vi.fn>

  const profiles = [
    { id: 'p1', name: 'Alpha', path: '/tmp/a', aliases: ['alpha'], sensitive: false, createdAt: 1 },
    { id: 'p2', name: 'Alpha2', path: '/tmp/a2', aliases: ['alpha'], sensitive: false, createdAt: 1 }
  ]

  beforeEach(() => {
    allowlist = ['ou_a']
    remoteEnabled = true
    auditAppend = vi.fn().mockResolvedValue(undefined)
    mockReplyFeishuText.mockClear()
    mockRunFeishuRemoteAgent.mockClear()
  })

  afterEach(() => {
    processSpy?.mockRestore()
  })

  function makeRouter() {
    const router = new RemoteCommandRouter({
      db: {} as never,
      runner: { run: vi.fn() } as never,
      processedStore: {
        has: vi.fn().mockResolvedValue(false),
        mark: vi.fn().mockResolvedValue(undefined)
      } as never,
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
    router.clearPendingDisambiguation()
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
    router.clearPendingDisambiguation()
    processSpy?.mockClear()
    processSpy?.mockResolvedValue(undefined as never)
    await router.handleInbound(p2p({ messageId: 'm-late', senderOpenId: 'ou_a', content: '1' }))
    // Pending gone: "1" is a new command, not a choice over the original ambiguous message.
    expect(processSpy).toHaveBeenCalled()
    const userMessage = processSpy?.mock.calls[0]?.[4]
    expect(userMessage).toBe('1')
    expect(userMessage).not.toContain('@alpha')
  })
})
