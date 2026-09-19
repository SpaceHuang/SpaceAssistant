import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import type { Session } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE } from '../src/shared/domainTypes'

const mockGetSession = vi.fn()
const mockUpdateSession = vi.fn()
const mockGetConfigValue = vi.fn()
const mockSetConfigValue = vi.fn()

vi.mock('fs/promises', () => ({
  default: { mkdir: vi.fn().mockResolvedValue(undefined) },
  writeFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => []) },
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
  setConfigValue: (...args: unknown[]) => mockSetConfigValue(...args),
  deleteConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => [])
}))

vi.mock('./llmServiceResolver', () => ({
  LLM_SERVICE_CONFIG_KEYS: {
    llmServices: 'config.llmServices',
    activeLlmServiceId: 'config.activeLlmServiceId',
    activeLlmServiceIds: 'config.activeLlmServiceIds',
    preferredLanguageModelId: 'config.preferredLanguageModelId',
    preferredFastLanguageModelId: 'config.preferredFastLanguageModelId',
    preferredVisionModelId: 'config.preferredVisionModelId',
    llmServiceKeys: 'secrets.llmServiceKeys',
    baseUrl: 'config.baseUrl'
  },
  readStoredModels: vi.fn(() => []),
  readLlmServices: vi.fn(() => []),
  readActiveLlmServiceIds: vi.fn(() => []),
  readActiveLlmServiceId: vi.fn(() => undefined),
  resolveLlmCredentialsForModel: vi.fn(async () => ({ error: 'no-service' })),
  persistLlmServices: vi.fn(),
  migrateLegacyLlmServicesIfNeeded: vi.fn(),
  migrateMultiServiceModelConfig: vi.fn(() => ({ models: [], services: [], activeLlmServiceIds: [], activeLlmServiceId: '', preferredLanguageModelId: '' }))
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

vi.mock('./remote/remoteAgentRegistry', () => ({
  isRemoteAgentRunning: vi.fn(() => false)
}))

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn()
}))

const mockIpcMain = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    getHandler: (channel: string) => handlers.get(channel)
  }
}

function makeWorkDirManager(): AppIpcContext['workDirManager'] {
  return {
    listProfiles: () => [],
    addProfile: vi.fn().mockReturnValue({ success: true }),
    updateProfile: vi.fn().mockReturnValue({ success: true }),
    removeProfile: vi.fn().mockReturnValue({ success: true }),
    switchProfile: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    getActiveProfile: () => undefined,
    getActiveWorkDir: () => path.resolve('/fake/workdir'),
    getActiveProfileId: () => 'default',
    validateProfilesForSave: () => ({ valid: true }),
    validateProfileInput: () => ({ valid: true }),
    checkDirectoryWritable: () => ({ ok: true }),
    migrateFromLegacy: vi.fn(),
    persistProfiles: vi.fn()
  }
}

function makeCtx(): AppIpcContext {
  return {
    db: { flushSave: vi.fn(), save: vi.fn() } as unknown as AppIpcContext['db'],
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      backupWithRetry: vi.fn(),
      deleteBackup: vi.fn(),
      deleteBackupWithRetry: vi.fn()
    } as unknown as AppIpcContext['backup'],
    workDirManager: makeWorkDirManager(),
    getWorkDir: () => path.resolve('/fake/workdir'),
    setWorkDir: vi.fn(),
    getUserDataPath: () => '/fake/userdata',
    getApiKey: vi.fn().mockResolvedValue(null),
    setApiKey: vi.fn(),
    getBrowserDetectContext: () => ({
      isPackaged: false,
      appPath: '/fake/app',
      devRoot: '/fake/project'
    })
  }
}

function stubSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: '会话 1',
    preview: '',
    model: 'claude',
    temperature: 0.7,
    maxTokens: 4096,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    skillsState: { ...DEFAULT_SESSION_SKILLS_STATE },
    metadata: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...overrides
  }
}

describe('thinkingEffort IPC 接线（§6.3 白名单 / §8.4 校验）', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  describe('session:update', () => {
    it('档位随 payload 进 updateSession patch（白名单漏改会静默无效，§10.4 验收）', async () => {
      const cur = stubSession()
      mockGetSession.mockReturnValue(cur)
      mockUpdateSession.mockImplementation((_db, _id, patch) => ({ ...cur, ...patch }))

      const handler = ipc.getHandler('session:update')!
      await handler({}, { sessionId: 'session-1', thinkingEffort: 'low' })

      expect(mockUpdateSession).toHaveBeenCalledWith(
        ctx.db,
        'session-1',
        expect.objectContaining({ thinkingEffort: 'low' })
      )
    })

    it('null 清除覆盖（选择「默认」= 回到继承）', async () => {
      const cur = stubSession({ thinkingEffort: 'high' })
      mockGetSession.mockReturnValue(cur)
      mockUpdateSession.mockImplementation((_db, _id, patch) => ({ ...cur, ...patch }))

      const handler = ipc.getHandler('session:update')!
      await handler({}, { sessionId: 'session-1', thinkingEffort: null })

      expect(mockUpdateSession).toHaveBeenCalledWith(
        ctx.db,
        'session-1',
        expect.objectContaining({ thinkingEffort: null })
      )
    })

    it('非法档位被拒绝（§8.4：非法值拒绝并提示），不触达 updateSession', async () => {
      const cur = stubSession()
      mockGetSession.mockReturnValue(cur)

      const handler = ipc.getHandler('session:update')!
      await expect(handler({}, { sessionId: 'session-1', thinkingEffort: 'xhigh' })).rejects.toThrow()
      await expect(handler({}, { sessionId: 'session-1', thinkingEffort: 'max' })).rejects.toThrow()
      expect(mockUpdateSession).not.toHaveBeenCalled()
    })

    it('payload 不带档位时不写该字段（其他字段更新不受影响）', async () => {
      const cur = stubSession()
      mockGetSession.mockReturnValue(cur)
      mockUpdateSession.mockImplementation((_db, _id, patch) => ({ ...cur, ...patch }))

      const handler = ipc.getHandler('session:update')!
      await handler({}, { sessionId: 'session-1', model: 'new-model' })

      const patch = mockUpdateSession.mock.calls[0][2] as Record<string, unknown>
      expect(patch).not.toHaveProperty('thinkingEffort')
    })
  })

  describe('config:set', () => {
    it('合法档位写入 config.thinkingEffort，不写旧布尔（迁移后 thinkingEnabled 只读）', async () => {
      const handler = ipc.getHandler('config:set')!
      await handler({}, { thinkingEffort: 'high' })

      const effortWrites = mockSetConfigValue.mock.calls.filter((c) => c[1] === 'config.thinkingEffort')
      expect(effortWrites).toHaveLength(1)
      expect(effortWrites[0][2]).toBe('high')
      expect(mockSetConfigValue.mock.calls.some((c) => c[1] === 'config.thinkingEnabled')).toBe(false)
    })

    it('非法档位被拒绝并提示（§8.4 净新增校验；thinkingEnabled 曾被 String() 静默强转）', async () => {
      const handler = ipc.getHandler('config:set')!
      await expect(handler({}, { thinkingEffort: 'max' })).rejects.toThrow()
      await expect(handler({}, { thinkingEffort: 42 })).rejects.toThrow()
      expect(mockSetConfigValue.mock.calls.some((c) => c[1] === 'config.thinkingEffort')).toBe(false)
    })

    it('payload 不带档位时不写该键', async () => {
      const handler = ipc.getHandler('config:set')!
      await handler({}, { locale: 'zh-CN' })
      expect(mockSetConfigValue.mock.calls.some((c) => c[1] === 'config.thinkingEffort')).toBe(false)
    })
  })

  describe('config:get', () => {
    it('组装 AppConfig 时带 thinkingEffort：新键缺失由旧布尔推导（读兜底，不落库）', async () => {
      mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
        if (key === 'config.thinkingEnabled') return 'false'
        if (key === 'config.tools') return JSON.stringify({ enabled: true, deniedTools: [] })
        return undefined
      })

      const handler = ipc.getHandler('config:get')!
      const cfg = await handler({}, {}) as { thinkingEffort?: string; thinkingEnabled?: boolean }

      expect(cfg.thinkingEffort).toBe('off')
      // 读兜底不落库：config:get 不得写 config.thinkingEffort（避免读路径副作用与双写窗口，§8.1 C4）
      expect(mockSetConfigValue.mock.calls.some((c) => c[1] === 'config.thinkingEffort')).toBe(false)
    })

    it('新键合法时优先于旧布尔（旧键只读镜像）', async () => {
      mockGetConfigValue.mockImplementation((_db: unknown, key: string) => {
        if (key === 'config.thinkingEnabled') return 'false'
        if (key === 'config.thinkingEffort') return 'high'
        if (key === 'config.tools') return JSON.stringify({ enabled: true, deniedTools: [] })
        return undefined
      })

      const handler = ipc.getHandler('config:get')!
      const cfg = await handler({}, {}) as { thinkingEffort?: string }

      expect(cfg.thinkingEffort).toBe('high')
    })
  })
})
