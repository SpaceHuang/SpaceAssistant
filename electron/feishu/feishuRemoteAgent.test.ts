import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import { AppDatabase, createSession, openDatabase, prepareTurnAtomically, setConfigValue } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { buildFeishuRemoteSystemAppendix } from '../../src/shared/feishuPrompts'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { acceptTurnContext } from '../database/acceptedTurnStorage'

const SUPPORTED_ANTHROPIC_MODEL = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')![0]

const mockRunToolChatSession = vi.fn()
const mockReadAppLocale = vi.fn<[], 'zh-CN' | 'en-US'>(() => 'en-US')
const mockGetMessages = vi.fn(() => [])
const mockResolveLlmCredentialsForModel = vi.fn()
const mockResolveLlmCredentialsForPair = vi.fn()

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('../appIpc', () => ({
  readAppLocale: (...args: unknown[]) => mockReadAppLocale(...args)
}))

vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>()
  return {
    ...actual,
    getMessages: (...args: unknown[]) => mockGetMessages(...args)
  }
})

vi.mock('../llmServiceResolver', () => ({
  resolveLlmCredentialsForModel: (...args: unknown[]) => mockResolveLlmCredentialsForModel(...args),
  resolveLlmCredentialsForPair: (...args: unknown[]) => mockResolveLlmCredentialsForPair(...args)
}))

vi.mock('./feishuCliLogger', () => ({
  logFeishuCliEvent: vi.fn()
}))

vi.mock('../remote/remoteProgressCoordinator', () => ({
  startRemoteProgressSession: vi.fn(),
  stopRemoteProgressSession: vi.fn()
}))

vi.mock('../remote/remoteProgressStore', () => ({
  clearRemoteProgressSession: vi.fn()
}))

vi.mock('../workDirManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workDirManager')>()
  return {
    ...actual,
    resolveWorkDirForSession: vi.fn(() => ({
      profileId: 'p1',
      workDir: '/tmp',
      isSensitive: false
    }))
  }
})

import { runFeishuRemoteAgent } from './feishuRemoteAgent'

function makeDb(): AppDatabase {
  const db = openDatabase(':memory:')
  setConfigValue(db, 'config.locale', 'en-US')
  return db
}

function makeWorkDirManager() {
  return {
    listProfiles: () => [],
    getActiveProfileId: () => 'p1',
    getActiveWorkDir: () => '/tmp',
    checkDirectoryWritable: () => ({ ok: true })
  }
}

function baseCtx(getMainWebContents: () => WebContents | null) {
  const db = makeDb()
  const modelId = 'feishu-test-model'
  setConfigValue(db, 'config.models', JSON.stringify([{ id: modelId, name: SUPPORTED_ANTHROPIC_MODEL, enabled: true, supportsThinking: true }]))
  const session = createSession(db, { name: 'feishu-test-session', model: SUPPORTED_ANTHROPIC_MODEL })
  prepareTurnAtomically(db, {
    user: { id: 'feishu-test-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' },
    assistant: { id: 'feishu-test-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
    turn: { turnId: 'feishu-test-turn', requestId: '00000000-0000-4000-8000-000000000001', sessionId: session.id, assistantMessageId: 'feishu-test-assistant', state: 'prepared', startToken: 'feishu-test-start' }
  })
  const acceptedTurn = createAcceptedTurn({
    turnId: 'feishu-test-turn', requestId: '00000000-0000-4000-8000-000000000001', sessionId: session.id, lane: 'feishu',
    startToken: 'feishu-test-start', currentUserMessageId: 'feishu-test-user', transcriptVersion: 0,
    config: { lane: 'feishu', model: SUPPORTED_ANTHROPIC_MODEL, llmServiceId: 'svc-1', thinkingEffort: 'low' }
  })
  acceptTurnContext(db, acceptedTurn)
  return {
    db,
    sessionStorage: createSqliteSessionStorage(db),
    sessionId: session.id,
    userMessage: 'hello',
    replyMessageId: 'msg-1',
    requestId: '00000000-0000-4000-8000-000000000001',
    turnId: acceptedTurn.turnId,
    acceptedTurn,
    feishuConfig: { remoteConfirmPolicy: 'always' as const, enabled: true },
    workDir: '/tmp',
    workDirManager: makeWorkDirManager(),
    userDataDir: '/tmp',
    getMainWebContents,
    getApiKey: async () => 'key',
    getBaseUrl: () => 'https://api.example.com',
    getModel: () => SUPPORTED_ANTHROPIC_MODEL,
    runner: {} as never,
    imChannel: {} as never,
    getToolsConfig: () => DEFAULT_TOOLS_CONFIG,
    remoteContext: { source: 'feishu' as const, messageId: 'msg-1', larkCliRunner: {} as never }
  }
}

describe('runFeishuRemoteAgent locale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadAppLocale.mockReturnValue('en-US')
    mockResolveLlmCredentialsForModel.mockResolvedValue({
      serviceId: 'svc-1',
      baseUrl: 'https://api.example.com',
      getApiKey: async () => 'key'
    })
    mockResolveLlmCredentialsForPair.mockImplementation(async (_db: AppDatabase, modelId: string, serviceId: string) => ({
      model: { id: modelId, name: SUPPORTED_ANTHROPIC_MODEL, enabled: true, supportsThinking: true },
      serviceId, providerModelName: SUPPORTED_ANTHROPIC_MODEL, baseUrl: 'https://api.example.com', getApiKey: async () => 'key'
    }))
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn'
    })
  })

  it('I8: invokes runToolChatSession with appDb and raw feishu appendix (locale injected in tool loop)', async () => {
    let capturedSystem: string | undefined
    mockRunToolChatSession.mockImplementation(async (invocation: { profile: { system?: string; locale?: unknown } }, ports: { legacy?: { appDb?: unknown } }) => {
      capturedSystem = invocation.profile.system
      expect(ports.legacy?.appDb).toBeDefined()
      expect(invocation.profile.locale).toBe('en-US')
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    const sender = { send: vi.fn() } as unknown as WebContents
    await runFeishuRemoteAgent(baseCtx(() => sender))

    expect(mockRunToolChatSession).toHaveBeenCalledTimes(1)
    expect(capturedSystem).toContain('feishu_remote_command')
  })

  it('I9: getMainWebContents null still invokes runToolChatSession with appDb', async () => {
    await runFeishuRemoteAgent(baseCtx(() => null))

    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ legacy: expect.objectContaining({ appDb: expect.anything() }) }),
      expect.objectContaining({ onHostedTurnHandoff: expect.any(Function) })
    )
  })

  it('I10: feishu appendix is passed as base system before locale injection in tool loop', async () => {
    const appendix = buildFeishuRemoteSystemAppendix({
      messageId: 'msg-1',
      confirmPolicy: 'always',
      browserRemoteHint: undefined
    })

    mockRunToolChatSession.mockImplementation(async (invocation: { profile: { system?: string } }) => {
      const finalWithLocale = `${invocation.profile.system ?? ''}\n\n<ui_locale_preference>\nEnglish\n</ui_locale_preference>`
      expect(finalWithLocale.indexOf(appendix.slice(0, 20))).toBeLessThan(
        finalWithLocale.indexOf('<ui_locale_preference>')
      )
      return { ok: true, content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }
    })

    await runFeishuRemoteAgent(baseCtx(() => null))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ system: appendix }) }),
      expect.anything(),
      expect.objectContaining({ onHostedTurnHandoff: expect.any(Function) })
    )
  })

  it('passes workDirManager and resolveWorkDir to runToolChatSession', async () => {
    await runFeishuRemoteAgent(baseCtx(() => null))
    expect(mockRunToolChatSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspace: expect.objectContaining({
          workDirManager: expect.anything(),
          resolveWorkDir: expect.any(Function)
        })
      }),
      expect.objectContaining({ onHostedTurnHandoff: expect.any(Function) })
    )
  })

})
