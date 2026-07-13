import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { SESSION_META_TITLE_USER_CUSTOM } from './sessionTitleSuggest'
import type { Session } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE } from '../src/shared/domainTypes'
import { ErrorCodes } from '../src/shared/errorCodes'
import {
  REMOTE_SESSION_BUSY_MESSAGE,
  REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE
} from './remote/remoteSessionGuardMessages'

const mockIsRemoteAgentRunning = vi.fn(() => false)

const WORK_DIR = path.resolve('/fake/workdir')

const mockGetSession = vi.fn()
const mockUpdateSession = vi.fn()

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
  getSession: (...args: unknown[]) => mockGetSession(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  deleteSession: vi.fn(),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => [])
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: vi.fn()
}))

vi.mock('./claudeRequestGuards', () => ({
  assertValidOptionalAnthropicBaseUrl: vi.fn()
}))

vi.mock('./remote/remoteAgentRegistry', () => ({
  isRemoteAgentRunning: (...args: unknown[]) => mockIsRemoteAgentRunning(...args)
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

function makeCtx(): AppIpcContext {
  return {
    db: {} as AppIpcContext['db'],
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

describe('session:update IPC', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('sets titleUserCustom when name actually changes', async () => {
    const cur = stubSession({ name: '会话 1' })
    mockGetSession.mockReturnValue(cur)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({
      ...cur,
      ...patch,
      metadata: patch.metadata ?? cur.metadata
    }))

    const handler = ipc.getHandler('session:update')!
    await handler({}, { sessionId: 'session-1', name: '新标题' })

    expect(mockUpdateSession).toHaveBeenCalledWith(
      ctx.db,
      'session-1',
      expect.objectContaining({
        name: '新标题',
        metadata: expect.objectContaining({
          [SESSION_META_TITLE_USER_CUSTOM]: true
        })
      })
    )
  })

  it('does not set titleUserCustom when trimmed name equals current', async () => {
    const cur = stubSession({ name: '会话 1' })
    mockGetSession.mockReturnValue(cur)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({
      ...cur,
      ...patch
    }))

    const handler = ipc.getHandler('session:update')!
    await handler({}, { sessionId: 'session-1', name: '  会话 1  ' })

    expect(mockUpdateSession).toHaveBeenCalledWith(ctx.db, 'session-1', {})
  })

  it('does not set titleUserCustom when only skillsState is updated', async () => {
    const cur = stubSession()
    mockGetSession.mockReturnValue(cur)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({
      ...cur,
      ...patch
    }))

    const handler = ipc.getHandler('session:update')!
    await handler({}, {
      sessionId: 'session-1',
      skillsState: { manualActivated: ['x'], manualDisabled: [] }
    })

    const patch = mockUpdateSession.mock.calls[0][2] as Record<string, unknown>
    expect(patch.metadata).toBeUndefined()
    expect(patch.name).toBeUndefined()
  })

  it('does not set titleUserCustom when only metadata patch is applied', async () => {
    const cur = stubSession()
    mockGetSession.mockReturnValue(cur)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({
      ...cur,
      ...patch
    }))

    const handler = ipc.getHandler('session:update')!
    await handler({}, { sessionId: 'session-1', metadata: { foo: 1 } })

    const patch = mockUpdateSession.mock.calls[0][2] as Record<string, unknown>
    expect((patch.metadata as Record<string, unknown>).foo).toBe(1)
    expect((patch.metadata as Record<string, unknown>)[SESSION_META_TITLE_USER_CUSTOM]).toBeUndefined()
  })

  it('does not write name or titleUserCustom for whitespace-only name', async () => {
    const cur = stubSession({ name: '会话 1' })
    mockGetSession.mockReturnValue(cur)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({
      ...cur,
      ...patch
    }))

    const handler = ipc.getHandler('session:update')!
    await handler({}, { sessionId: 'session-1', name: '   ' })

    expect(mockUpdateSession).toHaveBeenCalledWith(ctx.db, 'session-1', {})
  })

  it('rejects workDirProfileId change when session is busy', async () => {
    const cur = stubSession({ workDirProfileId: 'p1' })
    mockGetSession.mockReturnValue(cur)
    mockIsRemoteAgentRunning.mockReturnValue(true)

    const handler = ipc.getHandler('session:update')!
    await expect(
      handler({}, { sessionId: 'session-1', workDirProfileId: 'p2' })
    ).rejects.toThrow(`${ErrorCodes.REMOTE_WORKDIR_SWITCH_BUSY}: ${REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE}`)
    expect(mockUpdateSession).not.toHaveBeenCalled()
  })

  it('allows workDirProfileId change when session is not busy', async () => {
    const cur = stubSession({ workDirProfileId: 'p1' })
    mockGetSession.mockReturnValue(cur)
    mockIsRemoteAgentRunning.mockReturnValue(false)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({ ...cur, ...patch }))

    const handler = ipc.getHandler('session:update')!
    await handler({}, { sessionId: 'session-1', workDirProfileId: 'p2' })

    expect(mockUpdateSession).toHaveBeenCalledWith(
      ctx.db,
      'session-1',
      expect.objectContaining({ workDirProfileId: 'p2' })
    )
  })
})

describe('session:delete IPC busy guard', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRemoteAgentRunning.mockReturnValue(false)
    ipc = mockIpcMain()
    ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('rejects delete when remote agent is running', async () => {
    mockGetSession.mockReturnValue(stubSession())
    mockIsRemoteAgentRunning.mockReturnValue(true)

    const handler = ipc.getHandler('session:delete')!
    await expect(handler({}, 'session-1')).rejects.toThrow(
      `${ErrorCodes.REMOTE_SESSION_BUSY}: ${REMOTE_SESSION_BUSY_MESSAGE}`
    )
  })
})
