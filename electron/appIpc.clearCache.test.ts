import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'

const WORK_DIR = path.resolve('/fake/workdir')

const mockCacheClear = vi.fn(() => 1)
const mockCacheClearAll = vi.fn(() => 5)
const mockRevokeKey = vi.fn(() => ({ shellRemoved: 1, trustedDomainsRemoved: 0, actTrustedDomainsRemoved: 0 }))
const mockRevokeAll = vi.fn(() => ({ shellRemoved: 2, trustedDomainsRemoved: 1, actTrustedDomainsRemoved: 1 }))

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
  setSessionUsage: vi.fn(),
  getSessionUsage: vi.fn(),
  deleteSessionUsage: vi.fn(),
  getDbConnection: vi.fn(() => ({}))
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

vi.mock('./confirmation/sqliteDecisionCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/sqliteDecisionCache')>()
  return {
    ...actual,
    SqliteDecisionCache: class {
      clear = mockCacheClear
      clearAll = mockCacheClearAll
      list = vi.fn(() => [])
    }
  }
})

vi.mock('./confirmation/legacyTrustRevocation', () => ({
  revokeLegacyTrustForCacheKey: (...args: unknown[]) => mockRevokeKey(...args),
  revokeAllLegacyTrust: (...args: unknown[]) => mockRevokeAll(...args)
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

function makeCtx(): AppIpcContext {
  return {
    db: { save: vi.fn(), flushSave: vi.fn() } as unknown as AppIpcContext['db'],
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

describe('security:clear-cache 联动撤销旧信任存储（B6/B7）', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  const invoke = (payload?: Record<string, unknown>) =>
    ipc.getHandler('security:clear-cache')?.(null, payload) as Promise<{ ok: boolean; cleared: number }>

  it('单键清除时联动撤销该键对应的旧库信任', async () => {
    const key = { kind: 'shell-command', verb: 'git status', level: 'exact' }
    const r = await invoke({ key })
    expect(mockCacheClear).toHaveBeenCalledWith(key)
    expect(mockRevokeKey).toHaveBeenCalledWith(ctx.db, key)
    expect(mockRevokeAll).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('全部清除时联动清空 shell 信任与浏览器域名信任', async () => {
    const r = await invoke(undefined)
    expect(mockCacheClearAll).toHaveBeenCalled()
    expect(mockRevokeAll).toHaveBeenCalledWith(ctx.db)
    expect(mockRevokeKey).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })
})
