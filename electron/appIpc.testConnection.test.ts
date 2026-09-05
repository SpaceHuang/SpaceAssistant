import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { getConfigValue } from './database'
import { createAnthropicClient } from './anthropicClientFactory'
import { resolveTestConnectionCredentials } from './llmServiceResolver'

const WORK_DIR = path.resolve('/fake/workdir')

const mockFs = vi.hoisted(() => ({
  writeFile: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  mkdir: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  rm: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  rename: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  stat: vi.fn<() => Promise<import('fs').Stats>>().mockResolvedValue({ isDirectory: () => true } as unknown as import('fs').Stats),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
  unlink: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('fs/promises', () => ({
  default: mockFs,
  ...mockFs
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => []),
  searchMessages: vi.fn(() => [])
}))

const messagesCreate = vi.fn().mockResolvedValue({})
vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn(() => ({ messages: { create: messagesCreate } }))
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn((u?: string) => u)
}))

vi.mock('./windowRef', () => ({
  getMainWindow: vi.fn()
}))

vi.mock('./llmModelListFetcher', () => ({
  fetchServiceModels: vi.fn()
}))

vi.mock('./llmServiceResolver', async (importActual) => ({
  ...(await importActual<typeof import('./llmServiceResolver')>()),
  resolveTestConnectionCredentials: vi.fn()
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

function makeCtx(): AppIpcContext {
  return {
    db: { save: vi.fn(), flushSave: vi.fn(), close: vi.fn() } as AppIpcContext['db'],
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      deleteBackup: vi.fn()
    } as unknown as AppIpcContext['backup'],
    workDirManager: {
      listProfiles: () => [],
      addProfile: vi.fn(),
      updateProfile: vi.fn(),
      removeProfile: vi.fn(),
      switchProfile: vi.fn(),
      getActiveProfile: () => undefined,
      getActiveWorkDir: () => WORK_DIR,
      getActiveProfileId: () => 'default',
      validateProfilesForSave: () => ({ valid: true }),
      validateProfileInput: () => ({ valid: true }),
      checkDirectoryWritable: () => ({ ok: true }),
      migrateFromLegacy: vi.fn(),
      persistProfiles: vi.fn()
    } as unknown as AppIpcContext['workDirManager'],
    getWorkDir: () => WORK_DIR,
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

function makeModel(id: string, name: string) {
  return {
    id,
    name,
    maximumContext: 200000,
    maxTokens: 64000,
    isDefault: false,
    isFast: false,
    isVision: false,
    enabled: true
  }
}

describe('config:test-connection IPC handler', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    messagesCreate.mockResolvedValue({})
    vi.mocked(resolveTestConnectionCredentials).mockResolvedValue({ apiKey: 'sk', baseUrl: undefined })
    // DB 中服务已保存；models 是「拉取前」的旧目录
    vi.mocked(getConfigValue).mockImplementation((_db: unknown, key: string) => {
      if (key === 'config.llmServices') {
        return JSON.stringify([{ id: 's1', name: 'Vol', baseUrl: '', supportedModelIds: ['old1'] }])
      }
      if (key === 'config.models') {
        return JSON.stringify([makeModel('old1', 'deepseek-v4-pro')])
      }
      return undefined
    })
    ipc = mockIpcMain()
  })

  it('uses DB catalog when draft models are not provided', async () => {
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('config:test-connection')!
    const result = (await handler({}, { serviceId: 's1' })) as { success: boolean }
    expect(result.success).toBe(true)
    expect(messagesCreate.mock.calls[0]![0]).toMatchObject({ model: 'deepseek-v4-pro' })
  })

  it('prefers draft models catalog so freshly fetched models are testable before save', async () => {
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('config:test-connection')!
    const draftModels = [makeModel('old1', 'deepseek-v4-pro'), makeModel('new1', 'kimi-k2.7-code')]
    const result = (await handler(
      {},
      { serviceId: 's1', models: draftModels, supportedModelIds: ['new1'] }
    )) as { success: boolean }
    expect(result.success).toBe(true)
    expect(messagesCreate.mock.calls[0]![0]).toMatchObject({ model: 'kimi-k2.7-code' })
  })

  it('reports NO_ENABLED_MODEL when draft catalog has no supported enabled model', async () => {
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('config:test-connection')!
    const result = (await handler(
      {},
      { serviceId: 's1', models: [], supportedModelIds: ['new1'] }
    )) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(messagesCreate).not.toHaveBeenCalled()
  })
})
