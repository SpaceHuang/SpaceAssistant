import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FeishuOwnerBindController } from './feishuOwnerBind'
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
    content: 'bind me',
    createTime: '1',
    mentionsBot: false,
    ...overrides
  }
}

describe('RemoteCommandRouter bind-window race', () => {
  let owner: string | undefined
  let remoteEnabled: boolean
  let allowlist: string[] | undefined
  let ownerBind: FeishuOwnerBindController
  let auditAppend: ReturnType<typeof vi.fn>
  let processSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    owner = undefined
    remoteEnabled = true
    allowlist = undefined
    auditAppend = vi.fn().mockResolvedValue(undefined)
    mockReplyFeishuText.mockClear()
    mockRunFeishuRemoteAgent.mockClear()
    ownerBind = new FeishuOwnerBindController({
      getOwnerOpenId: () => owner,
      setOwnerOpenId: (id) => {
        owner = id
        allowlist = id ? [id] : undefined
      },
      setRemoteEnabled: (v) => {
        remoteEnabled = v
      }
    })
    ownerBind.startBindingWindow(60_000)
  })

  afterEach(() => {
    processSpy?.mockRestore()
    ownerBind.dispose()
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
      ownerBind,
      getAppConfig: () => ({
        defaultModel: 'm',
        maxParallelChatSessions: 3,
        workDirProfiles: [],
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

  it('concurrent bind: second sender does not enter Agent after first binds', async () => {
    const router = makeRouter()
    const first = router.handleInbound(p2p({ messageId: 'm1', senderOpenId: 'ou_first', content: 'hi' }))
    const second = router.handleInbound(
      p2p({ messageId: 'm2', senderOpenId: 'ou_second', content: 'hijack' })
    )
    await Promise.all([first, second])
    expect(owner).toBe('ou_first')
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('已绑定'))).toBe(true)
    expect(replies.some((t) => t.includes('不是已绑定'))).toBe(true)
  })

  it('bind window message never becomes Agent even if sender later is owner', async () => {
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm1', senderOpenId: 'ou_owner', content: 'bind' }))
    expect(owner).toBe('ou_owner')
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('timeout during audit await rejects and does not Agent', async () => {
    const router = makeRouter()
    auditAppend.mockImplementation(async () => {
      // Expire bind window while awaiting audit (Critical #1 timeout race).
      ownerBind.dispose()
      remoteEnabled = false
    })
    await router.handleInbound(p2p({ messageId: 'm-timeout', senderOpenId: 'ou_late', content: 'late' }))
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('尚未完成身份绑定'))).toBe(true)
  })
})
