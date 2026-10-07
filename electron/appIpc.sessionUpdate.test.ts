import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import { getMainWindow } from './windowRef'
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
const mockWithSpillRootFence = vi.hoisted(() => vi.fn(async (work: () => Promise<void>) => work()))

const WORK_DIR = path.resolve('/fake/workdir')

const mockGetSession = vi.fn()
const mockUpdateSession = vi.fn()
const mockCreateSession = vi.fn()
const mockDeleteSession = vi.fn()

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
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('./database', () => ({
  listSessions: vi.fn(() => []),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
  getMessages: vi.fn(() => []),
  appendMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  appendSearchHistory: vi.fn(),
  listSearchHistory: vi.fn(() => []),
  getDbConnection: vi.fn(() => ({})),
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicStreamPort: (client: { messages: { stream: (...args: unknown[]) => unknown } }) => ({ stream: (...args: unknown[]) => client.messages.stream(...args) }),
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

vi.mock('./storage/spillStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('./storage/spillStore')>(),
  createSpillStore: vi.fn(() => ({ withSpillRootFence: mockWithSpillRootFence }))
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

function mockSessionUpdatePreferences(db: AppIpcContext['db'], input: { sessionId: string; name?: string; metadataPatch?: Record<string, unknown>; [key: string]: unknown }): Session | undefined {
  const current = mockGetSession(input.sessionId) as Session | undefined
  if (!current) return undefined
  const name = input.name?.trim()
  const changed = name !== undefined && name !== '' && name !== current.name.trim()
  const { sessionId: _sessionId, name: _name, metadataPatch, ...settings } = input
  return mockUpdateSession(db, input.sessionId, {
    ...settings,
    ...(changed ? { name } : {}),
    ...(metadataPatch || changed ? { metadata: { ...current.metadata, ...metadataPatch, ...(changed ? { [SESSION_META_TITLE_USER_CUSTOM]: true } : {}) } } : {})
  }) as Session | undefined
}

function makeCtx(): AppIpcContext {
  return {
    db: {} as AppIpcContext['db'],
    sessionStorage: {
      queries: { readSession: (sessionId: string) => mockGetSession(sessionId) } as AppIpcContext['sessionStorage'] extends infer T ? T extends { queries: infer Q } ? Q : never : never,
      commands: {
        createSession: (input) => mockCreateSession({} as AppIpcContext['db'], input) as Session,
        renameSession: (sessionId: string, name: string) => mockSessionUpdatePreferences({} as AppIpcContext['db'], { sessionId, name }),
        updateSettings: (input: Parameters<NonNullable<AppIpcContext['sessionStorage']>['commands']['updateSettings']>[0]) => mockSessionUpdatePreferences({} as AppIpcContext['db'], input),
        updateUserMetadata: (sessionId, metadataPatch) => mockSessionUpdatePreferences({} as AppIpcContext['db'], { sessionId, metadataPatch }),
        updateDirectoryGrants: vi.fn(),
        deleteQueuedMessage: vi.fn(), editQueuedMessage: vi.fn(), reorderQueuedMessages: vi.fn(),
        deleteSession: (sessionId: string) => { mockDeleteSession({} as AppIpcContext['db'], sessionId, { flush: false }) },
        enqueue: vi.fn()
      },
      execution: {} as NonNullable<AppIpcContext['sessionStorage']>['execution']
    } as NonNullable<AppIpcContext['sessionStorage']>,
    backup: {
      schedule: vi.fn(),
      flush: vi.fn(),
      backupImmediate: vi.fn(),
      backupWithRetry: vi.fn(),
      deleteBackup: vi.fn(),
      deleteBackupWithRetry: vi.fn()
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

  it('does not allow session:create to inject directory grants through metadata', async () => {
    const session = stubSession()
    mockCreateSession.mockImplementation((_db, input) => ({ ...session, metadata: input.metadata }))
    ctx.backup.backupWithRetry = vi.fn().mockResolvedValue(undefined)
    const handler = ipc.getHandler('session:create')!

    await handler({}, { name: '新会话', metadata: { foo: 1, sessionDirectoryGrants: [{ id: 'forged' }] } })

    expect(mockCreateSession).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      metadata: { foo: 1 },
    }))
  })

  it('does not allow session:update to replace directory grants through metadata', async () => {
    const cur = stubSession({ metadata: { sessionDirectoryGrants: [{ id: 'trusted', path: '/allowed' }] } })
    mockGetSession.mockReturnValue(cur)
    mockUpdateSession.mockImplementation((_db, _id, patch) => ({ ...cur, ...patch }))
    const handler = ipc.getHandler('session:update')!

    await handler({}, { sessionId: 'session-1', metadata: { foo: 1, sessionDirectoryGrants: [{ id: 'forged' }] } })

    expect(mockUpdateSession).toHaveBeenCalledWith(ctx.db, 'session-1', expect.objectContaining({
      metadata: { foo: 1, sessionDirectoryGrants: [{ id: 'trusted', path: '/allowed' }] },
    }))
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

describe('session-scoped privileged IPC trust boundary', () => {
  let ipc: ReturnType<typeof mockIpcMain>
  let ctx: AppIpcContext

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = mockIpcMain()
    ctx = makeCtx()
    vi.mocked(getMainWindow).mockReturnValue({
      isDestroyed: () => false,
      webContents: { id: 1 }
    } as unknown as ReturnType<typeof getMainWindow>)
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
  })

  it('rejects directory grant mutation from a sender other than the main renderer', async () => {
    const handler = ipc.getHandler('session-directory-grants:add')!
    await expect(handler({ sender: { id: 2 } }, 'session-1')).resolves.toEqual({ status: 'forbidden' })
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('rejects context compaction from a sender other than the main renderer before reading session state', async () => {
    const handler = ipc.getHandler('chat:compact-session-context')!
    await expect(handler({ sender: { id: 2 } }, { sessionId: 'session-1', requestId: 'compact-1' }))
      .resolves.toEqual({ status: 'forbidden' })
    expect(mockGetSession).not.toHaveBeenCalled()
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

  it('returns before backup cleanup finishes', async () => {
    const session = stubSession()
    mockCreateSession.mockReturnValue(session)
    let release!: () => void
    const backupPending = new Promise<void>((resolve) => { release = resolve })
    ctx.backup.backupWithRetry = vi.fn(() => backupPending)
    const createHandler = ipc.getHandler('session:create')!

    const result = await createHandler({}, { name: '新会话' })

    expect(result).toEqual(session)
    expect(ctx.backup.backupWithRetry).toHaveBeenCalled()
    release()
  })

  it('returns before backup deletion finishes', async () => {
    const session = stubSession()
    mockGetSession.mockReturnValue(session)
    let release!: () => void
    const cleanupPending = new Promise<void>((resolve) => { release = resolve })
    ctx.backup.deleteBackupWithRetry = vi.fn(() => cleanupPending)
    const handler = ipc.getHandler('session:delete')!

    await handler({}, 'session-1')

    expect(mockDeleteSession).toHaveBeenCalledWith(ctx.db, 'session-1', { flush: false })
    expect(ctx.backup.deleteBackupWithRetry).toHaveBeenCalledWith(session, 3, expect.any(Function))
    release()
  })

  it('wakes source-truth spill collection only after the database deletion commits', async () => {
    const wake = vi.fn()
    ctx.wakeSourceTruthSpillGc = wake
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('session:delete')!
    const priorDeleteCalls = mockDeleteSession.mock.calls.length
    mockDeleteSession.mockImplementationOnce(() => { throw new Error('database delete rolled back') })
    await expect(handler({}, 'session-1')).rejects.toThrow('database delete rolled back')
    expect(wake).not.toHaveBeenCalled()
    expect(mockDeleteSession).toHaveBeenCalledTimes(priorDeleteCalls + 1)
    await handler({}, 'session-1')
    expect(mockDeleteSession).toHaveBeenCalledWith(ctx.db, 'session-1', { flush: false })
    expect(wake).toHaveBeenCalledTimes(1)
  })
})
