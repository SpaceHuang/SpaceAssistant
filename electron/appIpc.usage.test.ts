import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'

const WORK_DIR = path.resolve('/fake/workdir')

const mockSetSessionUsage = vi.fn()
const mockGetSessionUsage = vi.fn()
const mockDeleteSessionUsage = vi.fn()

vi.mock('fs/promises', () => ({
  default: {},
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn()
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
  setSessionUsage: (...args: unknown[]) => mockSetSessionUsage(...args),
  getSessionUsage: (...args: unknown[]) => mockGetSessionUsage(...args),
  deleteSessionUsage: (...args: unknown[]) => mockDeleteSessionUsage(...args)
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
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
    getActiveWorkDir: () => WORK_DIR,
    getActiveProfileId: () => 'default',
    validateProfilesForSave: () => ({ valid: true }),
    validateProfileInput: () => ({ valid: true }),
    checkDirectoryWritable: () => ({ ok: true }),
    migrateFromLegacy: vi.fn(),
    persistProfiles: vi.fn()
  }
}

function makeCtx(dbOverrides: Partial<AppIpcContext['db']> = {}): AppIpcContext {
  return {
    db: { save: vi.fn(), ...dbOverrides } as AppIpcContext['db'],
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      deleteBackup: vi.fn()
    } as unknown as AppIpcContext['backup'],
    workDirManager: makeWorkDirManager(),
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

describe('usage IPC handlers', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('usage:set delegates to setSessionUsage', async () => {
    const usage = { input_tokens: 5000 }
    await ipc.getHandler('usage:set')?.(null, { sessionId: 's1', usage })
    expect(mockSetSessionUsage).toHaveBeenCalledWith(ctx.db, 's1', usage)
  })

  it('usage:get delegates to getSessionUsage', async () => {
    mockGetSessionUsage.mockReturnValue({ input_tokens: 100 })
    const result = await ipc.getHandler('usage:get')?.(null, 's1')
    expect(mockGetSessionUsage).toHaveBeenCalledWith(ctx.db, 's1')
    expect(result).toEqual({ input_tokens: 100 })
  })

  it('usage:delete delegates to deleteSessionUsage and saves', async () => {
    await ipc.getHandler('usage:delete')?.(null, 's1')
    expect(mockDeleteSessionUsage).toHaveBeenCalledWith(ctx.db, 's1')
    expect(ctx.db.save).toHaveBeenCalled()
  })
})
