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
    content: 'hello',
    createTime: '1',
    mentionsBot: false,
    ...overrides
  }
}

describe('RemoteCommandRouter pairing-code bind', () => {
  let owner: string | undefined
  let remoteEnabled: boolean
  let allowlist: string[] | undefined
  let ownerBind: FeishuOwnerBindController
  let auditAppend: ReturnType<typeof vi.fn>
  let processSpy: ReturnType<typeof vi.spyOn> | undefined
  let bindCode: string

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
    bindCode = ownerBind.startBindingWindow(60_000)
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

  it('valid pairing code binds and never enters Agent', async () => {
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm1', senderOpenId: 'ou_owner', content: `绑定 ${bindCode}` }))
    expect(owner).toBe('ou_owner')
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('已绑定'))).toBe(true)
  })

  it('non-protocol message in bind window does not bind and does not enter Agent', async () => {
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm1', senderOpenId: 'ou_x', content: 'do something' }))
    expect(owner).toBeUndefined()
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })

  it('wrong code does not bind and does not enter Agent', async () => {
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm1', senderOpenId: 'ou_x', content: '绑定 WRONGXXX' }))
    expect(owner).toBeUndefined()
    expect(processSpy).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('配对码错误'))).toBe(true)
  })

  it('concurrent bind: exactly one sender wins, other does not enter Agent', async () => {
    const router = makeRouter()
    const first = router.handleInbound(
      p2p({ messageId: 'm1', senderOpenId: 'ou_first', content: `绑定 ${bindCode}` })
    )
    const second = router.handleInbound(
      p2p({ messageId: 'm2', senderOpenId: 'ou_second', content: `绑定 ${bindCode}` })
    )
    await Promise.all([first, second])
    expect(owner).toBe('ou_first')
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    const replies = mockReplyFeishuText.mock.calls.map((c) => String(c[2]))
    expect(replies.some((t) => t.includes('已绑定'))).toBe(true)
  })

  it('bind window expiring during audit await rejects and does not Agent', async () => {
    const router = makeRouter()
    auditAppend.mockImplementation(async () => {
      ownerBind.dispose()
      remoteEnabled = false
    })
    await router.handleInbound(p2p({ messageId: 'm-timeout', senderOpenId: 'ou_late', content: `绑定 ${bindCode}` }))
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(owner).toBeUndefined()
  })
})
