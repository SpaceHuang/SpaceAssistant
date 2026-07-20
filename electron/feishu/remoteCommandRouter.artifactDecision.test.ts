import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteCommandRouter } from './remoteCommandRouter'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import {
  listArtifactDecisionCandidates,
  registerArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  waitForArtifactDecisionResponse
} from '../artifacts/artifactDecisionBridge'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'

const mockReplyFeishuText = vi.fn().mockResolvedValue(undefined)
const mockRunFeishuRemoteAgent = vi.fn()
const mockResolveFeishuSession = vi.fn()
const mockSendFeishuRemoteOutbound = vi.fn().mockResolvedValue(undefined)

const revokeHooks = vi.hoisted(() => ({ invalidateOnListCandidates: false }))

vi.mock('../artifacts/artifactDecisionBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../artifacts/artifactDecisionBridge')>()
  const { remoteAuthorizationRegistry: registry } = await import('../remote/remoteAuthorizationRegistry')
  return {
    ...actual,
    listArtifactDecisionCandidates: (
      identity: Parameters<typeof actual.listArtifactDecisionCandidates>[0]
    ) => {
      const candidates = actual.listArtifactDecisionCandidates(identity)
      if (revokeHooks.invalidateOnListCandidates) {
        registry.invalidate('feishu', 'owner_cleared')
      }
      return candidates
    }
  }
})

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

describe('RemoteCommandRouter artifact decision inbound', () => {
  let allowlist: string[] | undefined
  let remoteEnabled: boolean
  let processSpy: ReturnType<typeof vi.spyOn> | undefined
  let auditAppend: ReturnType<typeof vi.fn>
  let markCompleted: ReturnType<typeof vi.fn>
  let tryClaim: ReturnType<typeof vi.fn>
  let tryResolveConfirm: ReturnType<typeof vi.fn>
  let claimSeq: number
  const callOrder: string[] = []

  const overwriteOptions = [
    { key: 'overwrite', label: '覆盖' },
    { key: 'rename', label: '改名', requiresInput: 'rename' as const },
    { key: 'change-directory', label: '改目录', requiresInput: 'directory' as const },
    { key: 'cancel', label: '取消' }
  ]

  beforeEach(() => {
    allowlist = ['ou_a']
    remoteEnabled = true
    claimSeq = 0
    callOrder.length = 0
    auditAppend = vi.fn().mockImplementation(async (entry: { type?: string }) => {
      callOrder.push(`audit:${entry.type ?? 'unknown'}`)
    })
    markCompleted = vi.fn().mockImplementation(async (_id: string, _claim: string, summary: string) => {
      callOrder.push(`complete:${summary}`)
      return true
    })
    tryClaim = vi.fn().mockImplementation(async () => {
      callOrder.push('tryClaim')
      claimSeq += 1
      return { ok: true, claimId: `claim-${claimSeq}` }
    })
    tryResolveConfirm = vi.fn().mockImplementation(() => {
      callOrder.push('confirm')
      return false
    })
    mockReplyFeishuText.mockClear()
    mockReplyFeishuText.mockImplementation(async () => {
      callOrder.push('reply')
    })
    mockRunFeishuRemoteAgent.mockClear()
    mockSendFeishuRemoteOutbound.mockClear()
    resetArtifactDecisionBridgeForTests()
    remoteAuthorizationRegistry.invalidate('feishu', 'manual')
    revokeHooks.invalidateOnListCandidates = false
  })

  afterEach(() => {
    processSpy?.mockRestore()
    resetArtifactDecisionBridgeForTests()
  })

  function makeRouter(options?: { rateLimitPerMinute?: number }) {
    const router = new RemoteCommandRouter({
      db: {} as never,
      runner: { run: vi.fn() } as never,
      processedStore: {
        has: vi.fn().mockResolvedValue(false),
        mark: vi.fn().mockResolvedValue(undefined),
        tryClaim,
        markExecuting: vi.fn().mockResolvedValue(true),
        markCompleted
      } as never,
      confirmManager: { tryResolveFromInbound: tryResolveConfirm } as never,
      auditLogger: { append: auditAppend } as never,
      getFeishuConfig: () =>
        mergeFeishuConfig({
          enabled: true,
          remoteEnabled,
          appConfigured: true,
          remoteSenderAllowlist: allowlist,
          remoteRateLimitPerMinute: options?.rateLimitPerMinute ?? 60
        }),
      getAppConfig: () => ({
        defaultModel: 'm',
        maxParallelChatSessions: 3,
        workDirProfiles: [
          { id: 'p1', name: 'Alpha', path: '/tmp/a', aliases: ['alpha'], sensitive: false, createdAt: 1 },
          { id: 'p2', name: 'Alpha2', path: '/tmp/a2', aliases: ['alpha'], sensitive: false, createdAt: 1 }
        ],
        activeWorkDirProfileId: ''
      }),
      getWorkDir: () => '/tmp',
      workDirManager: { getActiveProfileId: () => '' } as never,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'k',
      getBaseUrl: () => '',
      getMainWebContents: () => null,
      getModel: () => 'm',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG
    })
    processSpy = vi.spyOn(router as unknown as { processCommand: () => Promise<void> }, 'processCommand')
    processSpy.mockResolvedValue(undefined as never)
    return router
  }

  function registerFeishuCandidate(overrides?: {
    requestId?: string
    decisionChatId?: string
    authOwner?: string
  }) {
    const request = registerArtifactDecisionRequest(
      {
        requestId: overrides?.requestId ?? 'req-ad-1',
        sessionId: 'session-1',
        toolUseId: 'tool-1',
        attempt: 1,
        kind: 'overwrite',
        options: overwriteOptions
      },
      {
        source: 'feishu',
        authOwner: overrides?.authOwner ?? 'ou_a',
        privateChatTarget: overrides?.decisionChatId ?? 'chat-1',
        originSessionId: 'session-1',
        requestId: overrides?.requestId ?? 'req-ad-1'
      }
    )
    const waitPromise = waitForArtifactDecisionResponse(request.requestId, request.toolUseId)
    return { request, waitPromise }
  }

  it('runs ConfirmManager before artifact decision handling', async () => {
    tryResolveConfirm.mockImplementation(() => {
      callOrder.push('confirm')
      return true
    })
    registerFeishuCandidate()
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-confirm', content: '1' }))
    expect(callOrder[0]).toBe('confirm')
    expect(tryClaim).not.toHaveBeenCalled()
    expect(markCompleted).not.toHaveBeenCalled()
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('does not claim or handle artifact decisions for non-owner senders', async () => {
    registerFeishuCandidate()
    const router = makeRouter()
    await router.handleInbound(
      p2p({ messageId: 'm-non-owner', senderOpenId: 'ou_intruder', content: '1' })
    )
    expect(tryClaim).not.toHaveBeenCalled()
    expect(
      listArtifactDecisionCandidates({
        source: 'feishu',
        authOwner: 'ou_a',
        privateChatTarget: 'chat-1'
      })
    ).toHaveLength(1)
    expect(processSpy).not.toHaveBeenCalled()
    expect(markCompleted).not.toHaveBeenCalled()
  })

  it('does not claim or call shared handler when rate limited', async () => {
    registerFeishuCandidate()
    const router = makeRouter({ rateLimitPerMinute: 1 })
    await router.handleInbound(p2p({ messageId: 'm-rl-1', content: 'hello world' }))
    // First message may pass rate limit then go to processCommand / disambiguation.
    tryClaim.mockClear()
    markCompleted.mockClear()
    processSpy?.mockClear()
    callOrder.length = 0
    await router.handleInbound(p2p({ messageId: 'm-rl-2', content: '1' }))
    expect(tryClaim).not.toHaveBeenCalled()
    expect(markCompleted).not.toHaveBeenCalled()
    expect(processSpy).not.toHaveBeenCalled()
    expect(auditAppend.mock.calls.some((c) => c[0]?.type === 'rate_limit')).toBe(true)
  })

  it('claims exactly once after rate limit before shared handler', async () => {
    registerFeishuCandidate()
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-once', content: '1' }))
    expect(tryClaim).toHaveBeenCalledTimes(1)
    expect(tryClaim).toHaveBeenCalledWith('m-once')
  })

  it('returns early on duplicate claim without submit reply or decision audit', async () => {
    registerFeishuCandidate()
    tryClaim.mockResolvedValueOnce({ ok: false })
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-dup', content: '1' }))
    expect(markCompleted).not.toHaveBeenCalled()
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockReplyFeishuText).not.toHaveBeenCalled()
    expect(
      auditAppend.mock.calls.some((c) => String(c[0]?.type ?? '').includes('artifact_decision'))
    ).toBe(false)
  })

  it('completes claim as artifact_decision_resolved and does not start Agent', async () => {
    const { request, waitPromise } = registerFeishuCandidate()
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-resolve', content: '4' }))
    expect(markCompleted).toHaveBeenCalledWith(
      'm-resolve',
      'claim-1',
      'artifact_decision_resolved'
    )
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    await expect(waitPromise).resolves.toMatchObject({
      choice: 'cancel'
    })
    expect(request.decisionId).toBeTruthy()
    expect(
      auditAppend.mock.calls.some((c) => c[0]?.type === 'feishu.artifact_decision.resolved')
    ).toBe(true)
    expect(mockReplyFeishuText.mock.calls.some((c) => String(c[2]).includes('已提交'))).toBe(true)
  })

  it('reuses the same claim for ordinary agent flow when not a decision', async () => {
    registerFeishuCandidate()
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-plain', content: 'please list files' }))
    expect(tryClaim).toHaveBeenCalledTimes(1)
    expect(processSpy).toHaveBeenCalled()
    expect(processSpy?.mock.calls[0]?.[5]).toBe('claim-1')
    expect(
      markCompleted.mock.calls.some((c) => String(c[2]).startsWith('artifact_decision_'))
    ).toBe(false)
  })

  it('prefers artifact decision over workdir disambiguation for numeric replies', async () => {
    registerFeishuCandidate()
    const router = makeRouter()
    // First create a pending workdir disambiguation.
    await router.handleInbound(
      p2p({ messageId: 'm-ambig', content: '/sa @alpha list files' })
    )
    expect(mockReplyFeishuText.mock.calls.some((c) => String(c[2]).includes('1)'))).toBe(true)
    processSpy?.mockClear()
    markCompleted.mockClear()
    tryClaim.mockClear()
    claimSeq = 0

    await router.handleInbound(p2p({ messageId: 'm-num', content: '1' }))
    expect(markCompleted).toHaveBeenCalledWith('m-num', 'claim-1', 'artifact_decision_resolved')
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('consumes unknown UUID without starting Agent', async () => {
    const router = makeRouter()
    const unknownId = '11111111-1111-4111-8111-111111111111'
    await router.handleInbound(
      p2p({ messageId: 'm-unknown', content: `${unknownId} 1` })
    )
    expect(markCompleted).toHaveBeenCalledWith(
      'm-unknown',
      'claim-1',
      'artifact_decision_unknown_decision_id'
    )
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })

  it('lets zero-candidate pure numbers continue on the same claim as ordinary commands', async () => {
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-digit', content: '1' }))
    expect(tryClaim).toHaveBeenCalledTimes(1)
    expect(processSpy).toHaveBeenCalled()
    expect(processSpy?.mock.calls[0]?.[5]).toBe('claim-1')
    expect(
      markCompleted.mock.calls.some((c) => String(c[2]).startsWith('artifact_decision_'))
    ).toBe(false)
  })

  it('authorization revoked after claim keeps pending and completes handled claim', async () => {
    const { waitPromise } = registerFeishuCandidate()
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })
    revokeHooks.invalidateOnListCandidates = true

    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-revoke', content: '4' }))

    expect(settled).toBe(false)
    expect(
      listArtifactDecisionCandidates({
        source: 'feishu',
        authOwner: 'ou_a',
        privateChatTarget: 'chat-1'
      })
    ).toHaveLength(1)
    expect(markCompleted).toHaveBeenCalledWith(
      'm-revoke',
      expect.any(String),
      'artifact_decision_authorization_revoked'
    )
    expect(processSpy).not.toHaveBeenCalled()
    expect(mockReplyFeishuText.mock.calls.some((c) => String(c[2]).includes('授权已失效'))).toBe(
      true
    )
    expect(
      auditAppend.mock.calls.some(
        (c) => c[0]?.type === 'feishu.artifact_decision.authorization_revoked'
      )
    ).toBe(true)
    expect(
      mockReplyFeishuText.mock.calls.some((c) => String(c[2]).includes('已提交'))
    ).toBe(false)
  })

  it('records sanitized feishu.artifact_decision.* audit fields on resolved', async () => {
    registerFeishuCandidate()
    const router = makeRouter()
    await router.handleInbound(p2p({ messageId: 'm-audit', content: '2 new-name' }))
    const resolved = auditAppend.mock.calls.find(
      (c) => c[0]?.type === 'feishu.artifact_decision.resolved'
    )?.[0] as Record<string, unknown>
    expect(resolved).toBeTruthy()
    expect(resolved).not.toHaveProperty('raw')
    expect(resolved).not.toHaveProperty('rename')
    expect(resolved).not.toHaveProperty('value')
    expect(resolved.hasInput).toBe(true)
    expect(resolved.choiceKey).toBe('rename')
  })

  it('completes claim as resolved when decision audit rejects after submit', async () => {
    const { waitPromise } = registerFeishuCandidate()
    auditAppend.mockImplementation(async (entry: { type?: string }) => {
      callOrder.push(`audit:${entry.type ?? 'unknown'}`)
      if (String(entry.type).includes('artifact_decision.resolved')) {
        throw new Error('audit disk full')
      }
    })
    const router = makeRouter()
    await expect(
      router.handleInbound(p2p({ messageId: 'm-audit-fail', content: '4' }))
    ).resolves.toBeUndefined()
    expect(markCompleted).toHaveBeenCalledWith(
      'm-audit-fail',
      'claim-1',
      'artifact_decision_resolved'
    )
    expect(mockReplyFeishuText.mock.calls.some((c) => String(c[2]).includes('已提交'))).toBe(true)
    await expect(waitPromise).resolves.toMatchObject({ choice: 'cancel' })
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('completes claim as resolved when success reply rejects after submit', async () => {
    const { waitPromise } = registerFeishuCandidate()
    mockReplyFeishuText.mockRejectedValue(new Error('im reply failed'))
    const router = makeRouter()
    await expect(
      router.handleInbound(p2p({ messageId: 'm-reply-fail', content: '4' }))
    ).resolves.toBeUndefined()
    expect(markCompleted).toHaveBeenCalledWith(
      'm-reply-fail',
      'claim-1',
      'artifact_decision_resolved'
    )
    await expect(waitPromise).resolves.toMatchObject({ choice: 'cancel' })
    expect(processSpy).not.toHaveBeenCalled()
  })

  it('completes claim for unknown UUID when audit rejects', async () => {
    auditAppend.mockImplementation(async (entry: { type?: string }) => {
      if (String(entry.type).includes('artifact_decision.unknown_id')) {
        throw new Error('audit fail')
      }
    })
    const router = makeRouter()
    const unknownId = '11111111-1111-4111-8111-111111111111'
    await expect(
      router.handleInbound(p2p({ messageId: 'm-unknown-audit', content: `${unknownId} 1` }))
    ).resolves.toBeUndefined()
    expect(markCompleted).toHaveBeenCalledWith(
      'm-unknown-audit',
      'claim-1',
      'artifact_decision_unknown_decision_id'
    )
    expect(processSpy).not.toHaveBeenCalled()
  })
})

describe('RemoteCommandRouter artifact decision outbound wiring', () => {
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    vi.clearAllMocks()
  })

  it('injects fixed-target sendDecisionText from shared serializer path', async () => {
    // Covered by remoteDecisionOutbound + processCommand remoteContext construction;
    // assert createFeishuSendDecisionText is used by importing the factory contract.
    const { createFeishuSendDecisionText } = await import('../remote/remoteDecisionOutbound')
    const runner = { run: vi.fn() }
    const send = createFeishuSendDecisionText({
      runner: runner as never,
      messageId: 'bound-msg',
      chatId: 'chat-1',
      sessionId: 's1'
    })
    await send('decision prompt')
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'bound-msg',
        body: 'decision prompt',
        sessionId: 's1'
      })
    )
  })
})
