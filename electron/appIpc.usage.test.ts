import { afterAll, describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers as registerAppIpcHandlersRaw } from './appIpc'
import { withSessionRuntime } from './testSupport/sessionStorageComposition'
import type { AppIpcContext } from './appIpc'

import { createMemoryAppDb } from './database/testHelpers'

const TEST_DB = createMemoryAppDb()
afterAll(() => TEST_DB.close())

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
  setSessionUsage: (...args: unknown[]) => mockSetSessionUsage(...args),
  getSessionUsage: (...args: unknown[]) => mockGetSessionUsage(...args),
  deleteSessionUsage: (...args: unknown[]) => mockDeleteSessionUsage(...args),
  getDbConnection: vi.fn(() => ({})),
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
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
    db: Object.assign(TEST_DB, { save: vi.fn(), ...dbOverrides }),
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

const registerAppIpcHandlers: typeof registerAppIpcHandlersRaw = (ipc, ctx) =>
  registerAppIpcHandlersRaw(ipc, withSessionRuntime(ctx))

describe('usage IPC handlers', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('usage:set stores a session usage snapshot readable through usage:get', async () => {
    const usage = { input_tokens: 5000 }
    await ipc.getHandler('usage:set')?.(null, { sessionId: 's1', usage })
    expect(ipc.getHandler('usage:get')?.(null, 's1')).toEqual(usage)
  })

  it('usage:get returns undefined when the session has no usage snapshot', async () => {
    expect(ipc.getHandler('usage:get')?.(null, 'missing-session')).toBeUndefined()
  })

  it('usage:delete removes a snapshot and saves', async () => {
    const usage = { input_tokens: 5000 }
    await ipc.getHandler('usage:set')?.(null, { sessionId: 's1', usage })
    vi.mocked(ctx.db.save).mockClear()
    await ipc.getHandler('usage:delete')?.(null, 's1')
    expect(ctx.db.save).toHaveBeenCalled()
    expect(ipc.getHandler('usage:get')?.(null, 's1')).toBeUndefined()
  })
})
