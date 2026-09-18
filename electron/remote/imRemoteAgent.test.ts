import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../src/shared/remoteProgressTypes'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'

const mockRunToolChatSession = vi.fn()
const mockResolveLlmCredentialsForModel = vi.fn()
const mockGetMessages = vi.fn(() => [])
const mockStartRemoteProgressSession = vi.fn()
const mockStopRemoteProgressSession = vi.fn()
const mockClearRemoteProgressSession = vi.fn()
const mockResolveWorkDirForSession = vi.fn(() => ({
  profileId: 'p1',
  workDir: '/tmp',
  isSensitive: false
}))

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('../llmServiceResolver', () => ({
  resolveLlmCredentialsForModel: (...args: unknown[]) => mockResolveLlmCredentialsForModel(...args)
}))

vi.mock('../database', () => ({
  getMessages: (...args: unknown[]) => mockGetMessages(...args)
}))

vi.mock('../appIpc', () => ({
  readAppLocale: () => 'zh-CN'
}))

vi.mock('./remoteProgressCoordinator', () => ({
  startRemoteProgressSession: (...args: unknown[]) => mockStartRemoteProgressSession(...args),
  stopRemoteProgressSession: (...args: unknown[]) => mockStopRemoteProgressSession(...args)
}))

vi.mock('./remoteProgressStore', () => ({
  clearRemoteProgressSession: (...args: unknown[]) => mockClearRemoteProgressSession(...args)
}))

vi.mock('../workDirManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workDirManager')>()
  return {
    ...actual,
    resolveWorkDirForSession: (...args: unknown[]) => mockResolveWorkDirForSession(...args)
  }
})

import { runImRemoteAgent } from './imRemoteAgent'

function makeDb(): AppDatabase {
  return { data: { configs: {}, sessions: [], messages: [] }, save: vi.fn() } as unknown as AppDatabase
}

function makeWorkDirManager() {
  return {
    listProfiles: () => [],
    getActiveProfileId: () => 'p1',
    getActiveWorkDir: () => '/tmp',
    checkDirectoryWritable: () => ({ ok: true })
  }
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  const adapter = { channel: 'feishu' as const, reply: vi.fn() }
  return {
    db: makeDb(),
    sessionId: 'sess-1',
    requestId: '00000000-0000-4000-8000-000000000001',
    workDir: '/tmp',
    workDirManager: makeWorkDirManager(),
    userDataDir: '/tmp',
    getMainWebContents: () => null as WebContents | null,
    getApiKey: async () => 'fallback-key',
    getBaseUrl: () => 'https://fallback.example.com',
    getModel: () => 'claude-sonnet-4-20250514',
    remoteContext: { source: 'feishu' as const, messageId: 'm1', confirmPolicy: 'always' as const },
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    createProgressAdapter: () => adapter,
    buildSystemAppendix: () => 'appendix',
    progressDefaults: DEFAULT_REMOTE_PROGRESS_CONFIG,
    progressConfig: {},
    ...overrides
  }
}

describe('runImRemoteAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveWorkDirForSession.mockReturnValue({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: false
    })
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: 'svc-1',
      baseUrl: 'https://creds.example.com',
      getApiKey: async () => 'creds-key'
    })
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('uses service apiKey and baseUrl when credentials resolve', async () => {
    let captured: { baseUrl?: string; getApiKey?: () => Promise<string | null> } = {}
    mockRunToolChatSession.mockImplementation(async (args: typeof captured) => {
      captured = args
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs())

    expect(mockResolveLlmCredentialsForModel).toHaveBeenCalledWith(
      expect.anything(),
      'claude-sonnet-4-20250514',
      {}
    )
    expect(captured.baseUrl).toBe('https://creds.example.com')
    expect(await captured.getApiKey?.()).toBe('creds-key')
  })

  it('用量统计的 llmServiceId 取实际解析出的 creds.serviceId，而非会话冻结配置（DIM3，评审 P1-2）', async () => {
    let captured: { llmServiceId?: string; turnId?: string } = {}
    mockRunToolChatSession.mockImplementation(async (args: typeof captured) => {
      captured = args
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    // 会话配置指向 svc-stale，但 resolver 实际解析到 svc-1（远程 resolver 未带 serviceId，可能回落默认服务）
    await runImRemoteAgent({ ...baseArgs(), llmServiceId: 'svc-stale', turnId: 'turn-remote-1' })

    expect(captured.llmServiceId).toBe('svc-1')
    expect(captured.turnId).toBe('turn-remote-1')
  })

  it('falls back to getApiKey when credentials resolve with error', async () => {
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: '',
      baseUrl: undefined,
      getApiKey: async () => null,
      error: '当前无可用服务支持模型「x」'
    })
    let captured: { getApiKey?: () => Promise<string | null>; baseUrl?: string } = {}
    mockRunToolChatSession.mockImplementation(async (args: typeof captured) => {
      captured = args
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs())

    expect(await captured.getApiKey?.()).toBe('fallback-key')
    expect(captured.baseUrl).toBe('https://fallback.example.com')
  })

  it('blocks sensitive workdir and still stops progress session', async () => {
    mockResolveWorkDirForSession.mockReturnValue({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: true
    })
    const logSensitiveBlocked = vi.fn()
    const onFinally = vi.fn()

    const result = await runImRemoteAgent(baseArgs({ logSensitiveBlocked, onFinally }))

    expect(result).toEqual({
      summary: SENSITIVE_WORKDIR_ERROR,
      pendingConfirm: false,
      ok: false
    })
    expect(mockRunToolChatSession).not.toHaveBeenCalled()
    expect(logSensitiveBlocked).toHaveBeenCalledOnce()
    expect(mockStartRemoteProgressSession).toHaveBeenCalledOnce()
    expect(mockStopRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(mockClearRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(onFinally).toHaveBeenCalledOnce()
  })

  it('starts and stops progress session on success', async () => {
    const onFinally = vi.fn()
    const result = await runImRemoteAgent(baseArgs({ onFinally }))
    expect(result.ok).toBe(true)
    expect(mockStartRemoteProgressSession).toHaveBeenCalledOnce()
    expect(mockStopRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(mockClearRemoteProgressSession).toHaveBeenCalledWith('sess-1')
    expect(onFinally).toHaveBeenCalledOnce()
  })

  it('保留 tool loop 的 cancelled outcome 供上层 Runtime 映射 source-cancelled', async () => {
    mockRunToolChatSession.mockResolvedValue({ ok: false, error: '用户取消执行', cancelled: true })
    const result = await runImRemoteAgent(baseArgs())
    expect(result).toMatchObject({ ok: false, pendingConfirm: false, outcome: 'cancelled' })
  })
})

describe('调用方契约特征化（P0：入参 → Core args 平移）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveWorkDirForSession.mockReturnValue({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: false
    })
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: 'svc-1',
      baseUrl: 'https://creds.example.com',
      getApiKey: async () => 'creds-key'
    })
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('remoteContext 与事件出口接线平移给 Core；emitFactEvent 透传、emitSessionEvent 为 no-op 出口', async () => {
    const emitFactEvent = vi.fn()
    let captured: Record<string, unknown> = {}
    mockRunToolChatSession.mockImplementation(async (args: Record<string, unknown>) => {
      captured = args
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runImRemoteAgent(baseArgs({ emitFactEvent }))

    // lane 推导基础：remoteContext 原样平移（Core 内据此推导 im lane）
    expect(captured.remoteContext).toMatchObject({ source: 'feishu', messageId: 'm1', confirmPolicy: 'always' })
    // 事件出口：fact 出口透传调用方实现；session 台账出口为显式 no-op（远程无窗口）
    expect(captured.emitFactEvent).toBe(emitFactEvent)
    expect(captured.emitSessionEvent).toBeTypeOf('function')
    await (captured.emitSessionEvent as (e: unknown) => Promise<void>)({ type: 'request_header' })
    // Core 输入：会话锚点与消息装载
    expect(captured.sessionId).toBe('sess-1')
    expect(captured.appDb).toBeTypeOf('object')
  })
})
