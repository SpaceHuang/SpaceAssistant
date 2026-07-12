import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSession, openDatabase, createSession } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { RemoteCommandRouter } from './remoteCommandRouter'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import {
  REMOTE_PARALLEL_FULL_MESSAGE,
  REMOTE_SESSION_BUSY_MESSAGE
} from '../remote/remoteSessionGuardMessages'
import {
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession,
  releaseRemoteSession
} from './runningRemoteAgentRegistry'
import * as workDirBinding from '../workDirBinding'

const mockRunFeishuRemoteAgent = vi.fn()
const mockResolveFeishuSession = vi.fn()
const mockSendFeishuRemoteOutbound = vi.fn()
const mockShouldAcceptInbound = vi.fn()

vi.mock('./feishuRemoteAgent', () => ({
  runFeishuRemoteAgent: (...args: unknown[]) => mockRunFeishuRemoteAgent(...args)
}))

vi.mock('./feishuSessionResolver', () => ({
  resolveFeishuSession: (...args: unknown[]) => mockResolveFeishuSession(...args)
}))

vi.mock('./feishuRemoteOutbound', () => ({
  sendFeishuRemoteOutbound: (...args: unknown[]) => mockSendFeishuRemoteOutbound(...args)
}))

vi.mock('./feishuInboundParser', () => ({
  shouldAcceptInbound: (...args: unknown[]) => mockShouldAcceptInbound(...args)
}))

vi.mock('./feishuCliLogger', () => ({
  logFeishuCliEvent: vi.fn()
}))

vi.mock('../remote/remoteProgressStore', () => ({
  clearRemoteProgressSession: vi.fn()
}))

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-frr-'))
}

function makeInbound(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    senderOpenId: 'user-1',
    content: 'hello',
    ...overrides
  }
}

describe('RemoteCommandRouter workdir binding', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  beforeEach(() => {
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
    resetRunningRemoteAgentRegistryForTests()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function makeRouter(
    db: ReturnType<typeof openDatabase>,
    manager: ReturnType<typeof createWorkDirManager>,
    options?: { maxParallel?: number; tryResolveConfirm?: boolean }
  ) {
    const auditAppend = vi.fn().mockResolvedValue(undefined)
    const processedStore = {
      has: vi.fn().mockResolvedValue(false),
      mark: vi.fn().mockResolvedValue(undefined)
    }
    const router = new RemoteCommandRouter({
      db,
      runner: { run: vi.fn() } as never,
      processedStore: processedStore as never,
      confirmManager: {
        tryResolveFromInbound: () => options?.tryResolveConfirm ?? false
      } as never,
      auditLogger: { append: auditAppend } as never,
      getFeishuConfig: () => mergeFeishuConfig({ enabled: true, remoteEnabled: true, appConfigured: true }),
      getAppConfig: () => ({
        defaultModel: 'claude-sonnet-4-20250514',
        maxParallelChatSessions: options?.maxParallel ?? 3,
        workDirProfiles: manager.listProfiles(),
        activeWorkDirProfileId: manager.getActiveProfileId()
      }),
      getWorkDir: () => manager.getActiveWorkDir(),
      workDirManager: manager,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'key',
      getBaseUrl: () => '',
      getMainWebContents: () => null,
      getModel: () => 'claude-sonnet-4-20250514',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG
    })
    return { router, auditAppend }
  }

  function setupDbAndManager() {
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
    return { db, manager, dirA }
  }

  it('persists workDirProfileId when inbound command resolves @profile', async () => {
    const { db, manager, dirA } = setupDbAndManager()
    const dirB = tempDir()
    dirs.push(dirB)
    const a = manager.addProfile({ name: 'Alpha', path: dirA, aliases: ['alpha'] })
    manager.addProfile({ name: 'Beta', path: dirB })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '/sa @alpha list files' })
    const session = createSession(db, { name: 'Feishu Session' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ content: '/sa @alpha list files', messageId: 'msg-1' }))

    const updated = getSession(db, session.id)
    expect(updated?.workDirProfileId).toBe(a.profile!.id)
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: dirA,
        workDirManager: manager
      })
    )
  })

  it('rejects sensitive profile on inbound', async () => {
    const { db, manager, dirA } = setupDbAndManager()
    manager.addProfile({ name: 'Secret', path: dirA, aliases: ['secret'], sensitive: true })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: '/sa @secret hi' })

    const { router } = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'msg-2', content: '/sa @secret hi' }))

    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-2',
        body: '该项目为敏感项目，不允许远程访问'
      })
    )
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })
})

describe('RemoteCommandRouter busy guard', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  beforeEach(() => {
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
    mockSendFeishuRemoteOutbound.mockResolvedValue(undefined)
    resetRunningRemoteAgentRegistryForTests()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function makeRouter(
    db: ReturnType<typeof openDatabase>,
    manager: ReturnType<typeof createWorkDirManager>,
    options?: { maxParallel?: number; tryResolveConfirm?: boolean }
  ) {
    const processedStore = {
      has: vi.fn().mockResolvedValue(false),
      mark: vi.fn().mockResolvedValue(undefined)
    }
    return new RemoteCommandRouter({
      db,
      runner: { run: vi.fn() } as never,
      processedStore: processedStore as never,
      confirmManager: {
        tryResolveFromInbound: () => options?.tryResolveConfirm ?? false
      } as never,
      auditLogger: { append: vi.fn().mockResolvedValue(undefined) } as never,
      getFeishuConfig: () => mergeFeishuConfig({ enabled: true, remoteEnabled: true, appConfigured: true }),
      getAppConfig: () => ({
        defaultModel: 'claude-sonnet-4-20250514',
        maxParallelChatSessions: options?.maxParallel ?? 3,
        workDirProfiles: manager.listProfiles(),
        activeWorkDirProfileId: manager.getActiveProfileId()
      }),
      getWorkDir: () => manager.getActiveWorkDir(),
      workDirManager: manager,
      getUserDataPath: () => '/tmp',
      getApiKey: async () => 'key',
      getBaseUrl: () => '',
      getMainWebContents: () => null,
      getModel: () => 'claude-sonnet-4-20250514',
      getToolsConfig: () => DEFAULT_TOOLS_CONFIG
    })
  }

  function setup() {
    const dir = tempDir()
    dirs.push(dir)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dir,
      setWorkDir: () => undefined
    })
    return { db, manager, dir }
  }

  it('rejects second inbound when session is busy', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'S1' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    tryClaimRemoteSession(session.id, 3)
    const router = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'm2' }))

    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'm2',
        body: REMOTE_SESSION_BUSY_MESSAGE,
        sessionId: session.id
      })
    )
    releaseRemoteSession(session.id)
  })

  it('TOCTOU: concurrent inbounds for same session start only one agent', async () => {
    const { db, manager } = setup()
    const session = createSession(db, { name: 'S1' })
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const router = makeRouter(db, manager)
    await Promise.all([
      router.handleInbound(makeInbound({ messageId: 'm1' })),
      router.handleInbound(makeInbound({ messageId: 'm2' }))
    ])

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
  })

  it('allows confirm resolution without claiming session', async () => {
    const { db, manager } = setup()
    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'Y' })
    const router = makeRouter(db, manager, { tryResolveConfirm: true })
    await router.handleInbound(makeInbound({ content: 'Y', messageId: 'confirm-1' }))
    expect(mockResolveFeishuSession).not.toHaveBeenCalled()
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()
  })

  it('releases claim when bind fails so retry can succeed', async () => {
    const { db, manager, dir } = setup()
    const good = manager.addProfile({ name: 'Good', path: dir, aliases: ['good'] })

    const session = createSession(db, { name: 'S1' })
    mockShouldAcceptInbound
      .mockReturnValueOnce({ accept: true, userMessage: '/sa @good hi' })
      .mockReturnValueOnce({ accept: true, userMessage: '/sa @good retry' })
    mockResolveFeishuSession.mockResolvedValue({ sessionId: session.id, isNew: false })
    mockRunFeishuRemoteAgent.mockResolvedValue({ summary: 'ok', pendingConfirm: false, ok: true })

    const bindSpy = vi.spyOn(workDirBinding, 'bindSessionWorkDir')
    bindSpy.mockResolvedValueOnce({ success: false, error: 'bind failed' })
    bindSpy.mockImplementationOnce(async (...args) => {
      bindSpy.mockRestore()
      return workDirBinding.bindSessionWorkDir(...args)
    })

    const router = makeRouter(db, manager)
    await router.handleInbound(makeInbound({ messageId: 'bind-fail', content: '/sa @good hi' }))
    expect(mockRunFeishuRemoteAgent).not.toHaveBeenCalled()

    await router.handleInbound(makeInbound({ messageId: 'bind-ok', content: '/sa @good retry' }))
    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(1)
    expect(getSession(db, session.id)?.workDirProfileId).toBe(good.profile!.id)
  })

  it('global parallel cap: only maxParallel agents start', async () => {
    const { db, manager } = setup()
    const s1 = createSession(db, { name: 'S1' })
    const s2 = createSession(db, { name: 'S2' })
    const s3 = createSession(db, { name: 'S3' })

    mockShouldAcceptInbound.mockReturnValue({ accept: true, userMessage: 'hello' })
    mockResolveFeishuSession
      .mockResolvedValueOnce({ sessionId: s1.id, isNew: false })
      .mockResolvedValueOnce({ sessionId: s2.id, isNew: false })
      .mockResolvedValueOnce({ sessionId: s3.id, isNew: false })

    const releases: Array<() => void> = []
    mockRunFeishuRemoteAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ summary: 'ok', pendingConfirm: false, ok: true }))
        })
    )

    const router = makeRouter(db, manager, { maxParallel: 2 })
    void router.handleInbound(makeInbound({ messageId: 'p1' }))
    void router.handleInbound(makeInbound({ messageId: 'p2' }))
    await vi.waitFor(() => expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(2))
    await router.handleInbound(makeInbound({ messageId: 'p3' }))

    expect(mockRunFeishuRemoteAgent).toHaveBeenCalledTimes(2)
    expect(mockSendFeishuRemoteOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'p3',
        body: REMOTE_PARALLEL_FULL_MESSAGE,
        sessionId: s3.id
      })
    )

    releases.forEach((r) => r())
  })
})
