import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { resolveTestConnectionCredentials } from './llmServiceResolver'
import { fetchServiceModels } from './llmModelListFetcher'

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

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
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

describe('llm:fetch-service-models IPC handler', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
  })

  it('returns no-api-key when credentials cannot be resolved', async () => {
    vi.mocked(resolveTestConnectionCredentials).mockResolvedValue({
      apiKey: null,
      baseUrl: undefined,
      error: 'API Key 未配置'
    })
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('llm:fetch-service-models')!
    const result = await handler({}, { serviceId: 's1' })
    expect(result).toEqual({ ok: false, error: 'no-api-key' })
    expect(fetchServiceModels).not.toHaveBeenCalled()
  })

  it('classifies baseUrl validation failure as invalid-base-url, not network', async () => {
    vi.mocked(resolveTestConnectionCredentials).mockRejectedValue(new Error('Invalid baseUrl'))
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('llm:fetch-service-models')!
    const result = await handler({}, { serviceId: 's1', baseUrl: 'api.example.com/v1' })
    expect(result).toEqual({ ok: false, error: 'invalid-base-url' })
    expect(fetchServiceModels).not.toHaveBeenCalled()
  })

  it('passes resolved credentials to the fetcher and returns its result', async () => {
    vi.mocked(resolveTestConnectionCredentials).mockResolvedValue({
      apiKey: 'sk-real',
      baseUrl: 'https://api.kimi.com/coding'
    })
    vi.mocked(fetchServiceModels).mockResolvedValue({
      ok: true,
      models: [{ id: 'kimi-k2.7-code', displayName: undefined }],
      truncated: false
    })
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('llm:fetch-service-models')!
    const result = await handler({}, { serviceId: 's1' })
    expect(fetchServiceModels).toHaveBeenCalledWith({ baseUrl: 'https://api.kimi.com/coding', apiKey: 'sk-real' })
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'kimi-k2.7-code', displayName: undefined }],
      truncated: false
    })
  })

  it('passes through fetcher failure classification', async () => {
    vi.mocked(resolveTestConnectionCredentials).mockResolvedValue({ apiKey: 'k', baseUrl: undefined })
    vi.mocked(fetchServiceModels).mockResolvedValue({ ok: false, error: 'not-found', status: 404 })
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('llm:fetch-service-models')!
    const result = await handler({}, { serviceId: 's1' })
    expect(result).toEqual({ ok: false, error: 'not-found', status: 404 })
  })

  it('maps unexpected exceptions to network error', async () => {
    vi.mocked(resolveTestConnectionCredentials).mockRejectedValue(new Error('db boom'))
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, makeCtx())
    const handler = ipc.getHandler('llm:fetch-service-models')!
    const result = await handler({}, { serviceId: 's1' })
    expect(result).toEqual({ ok: false, error: 'network' })
  })
})
