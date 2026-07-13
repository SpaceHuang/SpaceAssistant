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
})
