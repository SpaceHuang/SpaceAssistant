import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import { WeChatCommandRouter } from './weChatCommandRouter'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { openDatabase, createSession } from '../database'
import {
  listArtifactDecisionCandidates,
  registerArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  waitForArtifactDecisionResponse
} from '../artifacts/artifactDecisionBridge'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { resetRunningRemoteAgentRegistryForTests } from '../remote/remoteAgentRegistry'

const mockRunAgent = vi.fn()
const mockResolveSession = vi.fn()

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
        registry.invalidate('wechat', 'owner_cleared')
      }
      return candidates
    }
  }
})

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

vi.mock('./weChatCliLogger', () => ({
  logWeChatCliEvent: vi.fn()
}))

describe('WeChatCommandRouter artifact decision inbound', () => {
  let tmpDir: string
  let reply: ReturnType<typeof vi.fn>
  let auditAppend: ReturnType<typeof vi.fn>
  let tryClaim: ReturnType<typeof vi.fn>
  let markCompleted: ReturnType<typeof vi.fn>
  let tryResolveConfirm: ReturnType<typeof vi.fn>
  let allowlist: string[]
  let loggedIn: boolean
  let rateLimitPerMinute: number
  let claimSeq: number
  let closeDb: (() => void) | undefined
  let sessionId: string

  const overwriteOptions = [
    { key: 'overwrite', label: '覆盖' },
    { key: 'rename', label: '改名', requiresInput: 'rename' as const },
    { key: 'change-directory', label: '改目录', requiresInput: 'directory' as const },
    { key: 'cancel', label: '取消' }
  ]

  beforeEach(async () => {
    vi.clearAllMocks()
    resetRunningRemoteAgentRegistryForTests()
    resetArtifactDecisionBridgeForTests()
    remoteAuthorizationRegistry.invalidate('wechat', 'manual')
    revokeHooks.invalidateOnListCandidates = false
    allowlist = ['wx-user@test']
    loggedIn = true
    rateLimitPerMinute = 60
    claimSeq = 0
    reply = vi.fn(async () => undefined)
    auditAppend = vi.fn(async () => undefined)
    tryClaim = vi.fn(async () => {
      claimSeq += 1
      return { ok: true, claimId: `claim-${claimSeq}` }
    })
    markCompleted = vi.fn(async () => true)
    tryResolveConfirm = vi.fn(() => false)
    mockRunAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-ad-'))
    const db = openDatabase(path.join(tmpDir, 'test.db'))
    closeDb = () => db.close()
    sessionId = createSession(db, { name: 'WeChat Session' }).id
    mockResolveSession.mockResolvedValue({ sessionId, isNew: true })
  })

  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
    resetArtifactDecisionBridgeForTests()
    closeDb?.()
    if (tmpDir && fsSync.existsSync(tmpDir)) {
      fsSync.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeRouter() {
    const db = openDatabase(path.join(tmpDir, `r-${claimSeq}.db`))
    const prevClose = closeDb
    closeDb = () => {
      db.close()
      prevClose?.()
    }
    return new WeChatCommandRouter({
      db,
      botService: {
        getBot: () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() }),
        getRawBot: () => null
      } as never,
      processedStore: {
        has: vi.fn().mockResolvedValue(false),
        mark: vi.fn().mockResolvedValue(undefined),
        tryClaim,
        markExecuting: vi.fn().mockResolvedValue(true),
        markCompleted
      } as never,
      confirmManager: { tryResolveFromInbound: tryResolveConfirm } as never,
      auditLogger: {
        append: auditAppend
      } as never,
      getWeChatConfig: () => ({
        ...DEFAULT_WECHAT_CONFIG,
        enabled: true,
        remoteEnabled: true,
        loggedIn,
        remoteSenderAllowlist: allowlist,
        remoteRateLimitPerMinute: rateLimitPerMinute
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
      getMainWebContents: () => ({ send: vi.fn() }) as never,
      getModel: () => 'm1',
      getToolsConfig: () => ({ confirmMode: 'diff', deniedTools: [] }) as never
    })
  }

  function registerWeChatCandidate() {
    const request = registerArtifactDecisionRequest(
      {
        requestId: 'req-wx-1',
        sessionId: 'session-wx-1',
        toolUseId: 'tool-wx-1',
        attempt: 1,
        kind: 'overwrite',
        options: overwriteOptions
      },
      {
        source: 'wechat',
        authOwner: 'wx-user@test',
        privateChatTarget: 'wx-user@test',
        originSessionId: 'session-wx-1',
        requestId: 'req-wx-1'
      }
    )
    const waitPromise = waitForArtifactDecisionResponse(request.requestId, request.toolUseId)
    return { request, waitPromise }
  }

  it('runs ConfirmManager before artifact decision handling', async () => {
    tryResolveConfirm.mockReturnValue(true)
    registerWeChatCandidate()
    const router = makeRouter()
    const raw = makeIncomingMessage({ text: '1', raw: { client_id: 'c-confirm' } as never })
    await router.handleSdkInbound(raw)
    expect(tryResolveConfirm).toHaveBeenCalled()
    expect(tryClaim).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('rejects non-owner before claim', async () => {
    registerWeChatCandidate()
    const router = makeRouter()
    const raw = makeIncomingMessage({
      userId: 'wx-intruder',
      text: '1',
      raw: { from_user_id: 'wx-intruder', client_id: 'c-intruder' } as never
    })
    await router.handleSdkInbound(raw)
    expect(tryClaim).not.toHaveBeenCalled()
    expect(
      listArtifactDecisionCandidates({
        source: 'wechat',
        authOwner: 'wx-user@test',
        privateChatTarget: 'wx-user@test'
      })
    ).toHaveLength(1)
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('does not claim when rate limited', async () => {
    registerWeChatCandidate()
    rateLimitPerMinute = 1
    const router = makeRouter()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: 'hello', raw: { client_id: 'c-rl-1' } as never })
    )
    tryClaim.mockClear()
    mockRunAgent.mockClear()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: '1', raw: { client_id: 'c-rl-2' } as never })
    )
    expect(tryClaim).not.toHaveBeenCalled()
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('claims once and completes artifact_decision_resolved without Agent', async () => {
    const { waitPromise } = registerWeChatCandidate()
    const router = makeRouter()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: '4', raw: { client_id: 'c-resolve' } as never })
    )
    expect(tryClaim).toHaveBeenCalledTimes(1)
    expect(markCompleted).toHaveBeenCalledWith(
      expect.any(String),
      'claim-1',
      'artifact_decision_resolved'
    )
    expect(mockRunAgent).not.toHaveBeenCalled()
    await expect(waitPromise).resolves.toMatchObject({ choice: 'cancel' })
    expect(reply.mock.calls.some((c) => String(c[1]).includes('已提交'))).toBe(true)
  })

  it('reuses claim for ordinary commands when not a decision', async () => {
    registerWeChatCandidate()
    const router = makeRouter()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: 'please list files', raw: { client_id: 'c-plain' } as never })
    )
    expect(tryClaim).toHaveBeenCalledTimes(1)
    expect(mockRunAgent).toHaveBeenCalled()
    expect(
      markCompleted.mock.calls.some((c) => String(c[2]).startsWith('artifact_decision_'))
    ).toBe(false)
  })

  it('consumes unknown UUID without Agent', async () => {
    const router = makeRouter()
    const id = '22222222-2222-4222-8222-222222222222'
    await router.handleSdkInbound(
      makeIncomingMessage({ text: `${id} 1`, raw: { client_id: 'c-unknown' } as never })
    )
    expect(markCompleted).toHaveBeenCalledWith(
      expect.any(String),
      'claim-1',
      'artifact_decision_unknown_decision_id'
    )
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('lets zero-candidate digits continue as ordinary commands', async () => {
    const router = makeRouter()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: '1', raw: { client_id: 'c-digit' } as never })
    )
    expect(tryClaim).toHaveBeenCalledTimes(1)
    expect(mockRunAgent).toHaveBeenCalled()
  })

  it('authorization revoked after list keeps pending and completes handled claim', async () => {
    const { waitPromise } = registerWeChatCandidate()
    let settled = false
    void waitPromise.then(() => {
      settled = true
    })
    revokeHooks.invalidateOnListCandidates = true
    const router = makeRouter()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: '4', raw: { client_id: 'c-revoke' } as never })
    )
    expect(settled).toBe(false)
    expect(
      listArtifactDecisionCandidates({
        source: 'wechat',
        authOwner: 'wx-user@test',
        privateChatTarget: 'wx-user@test'
      })
    ).toHaveLength(1)
    expect(markCompleted).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'artifact_decision_authorization_revoked'
    )
    expect(mockRunAgent).not.toHaveBeenCalled()
    expect(reply.mock.calls.some((c) => String(c[1]).includes('授权已失效'))).toBe(true)
  })

  it('cross-channel feishu owner cannot be submitted via wechat identity', async () => {
    registerArtifactDecisionRequest(
      {
        requestId: 'req-fs',
        sessionId: 's-fs',
        toolUseId: 't-fs',
        attempt: 1,
        kind: 'overwrite',
        options: overwriteOptions
      },
      {
        source: 'feishu',
        authOwner: 'wx-user@test',
        privateChatTarget: 'wx-user@test',
        originSessionId: 's-fs',
        requestId: 'req-fs'
      }
    )
    const router = makeRouter()
    await router.handleSdkInbound(
      makeIncomingMessage({ text: '4', raw: { client_id: 'c-cross' } as never })
    )
    // No wechat candidates → ordinary command path
    expect(mockRunAgent).toHaveBeenCalled()
    expect(
      markCompleted.mock.calls.some((c) => String(c[2]).startsWith('artifact_decision_'))
    ).toBe(false)
  })

  it('completes claim as resolved when decision audit rejects after submit', async () => {
    const { waitPromise } = registerWeChatCandidate()
    auditAppend.mockImplementation(async (entry: { type?: string }) => {
      if (String(entry.type).includes('artifact_decision.resolved')) {
        throw new Error('audit disk full')
      }
    })
    const router = makeRouter()
    await expect(
      router.handleSdkInbound(
        makeIncomingMessage({ text: '4', raw: { client_id: 'c-audit-fail' } as never })
      )
    ).resolves.toBeUndefined()
    expect(markCompleted).toHaveBeenCalledWith(
      expect.any(String),
      'claim-1',
      'artifact_decision_resolved'
    )
    expect(reply.mock.calls.some((c) => String(c[1]).includes('已提交'))).toBe(true)
    await expect(waitPromise).resolves.toMatchObject({ choice: 'cancel' })
    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it('completes claim as resolved when success reply rejects after submit', async () => {
    const { waitPromise } = registerWeChatCandidate()
    reply.mockRejectedValue(new Error('im reply failed'))
    const router = makeRouter()
    await expect(
      router.handleSdkInbound(
        makeIncomingMessage({ text: '4', raw: { client_id: 'c-reply-fail' } as never })
      )
    ).resolves.toBeUndefined()
    expect(markCompleted).toHaveBeenCalledWith(
      expect.any(String),
      'claim-1',
      'artifact_decision_resolved'
    )
    await expect(waitPromise).resolves.toMatchObject({ choice: 'cancel' })
    expect(mockRunAgent).not.toHaveBeenCalled()
  })
})
