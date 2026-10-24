import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers } from './appIpc'
import type { AppIpcContext } from './appIpc'
import { listSearchHistory } from './database/operations'
import * as sessionTranscriptProjection from './sessionStorage/infrastructure/sqlite/sessionTranscriptProjection'
import { createSqliteSessionStorage } from './sessionStorage/sqliteSessionStorage'
import { createMemoryAppDb } from './database/testHelpers'

const openDbs: Array<ReturnType<typeof createMemoryAppDb>> = []

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
  searchMessages: vi.fn(() => []),
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

function makeCtx(): AppIpcContext {
  const db = createMemoryAppDb()
  openDbs.push(db)
  return {
    db,
    sessionStorage: createSqliteSessionStorage(db),
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

describe('search:execute IPC handler', () => {
  let ipc: ReturnType<typeof mockIpcMain>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.readdir.mockResolvedValue([])
    mockFs.readFile.mockResolvedValue('')
    vi.spyOn(sessionTranscriptProjection, 'searchProjectedMessages').mockReturnValue([])
    ipc = mockIpcMain()
  })

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close()
  })

  it('returns empty array for blank query', async () => {
    const ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('search:execute')!
    const results = await handler({}, '   ')
    expect(results).toEqual([])
    expect(listSearchHistory(ctx.db)).toEqual([])
  })

  it('returns session results with sessionId and messageId', async () => {
    vi.spyOn(sessionTranscriptProjection, 'searchProjectedMessages').mockReturnValue([
      {
        messageId: 'm1',
        sessionId: 's1',
        content: '如何优化 React 渲染性能',
        sessionName: '性能讨论'
      }
    ])
    const ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)
    const handler = ipc.getHandler('search:execute')!
    const results = await handler({}, 'React')
    expect(listSearchHistory(ctx.db)).toEqual(['React'])
    expect(sessionTranscriptProjection.searchProjectedMessages).toHaveBeenCalledWith(ctx.db, 'React', 'default', 50)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'msg:m1',
      type: 'session',
      title: '性能讨论',
      sessionId: 's1',
      messageId: 'm1',
      preview: '如何优化 React 渲染性能'
    })
  })

  it('prepares each provisional result session then reruns the complete cross-session search', async () => {
    const ctx = makeCtx()
    const db = createMemoryAppDb()
    ctx.db = db
    const base = createSqliteSessionStorage(ctx.db)
    const events: string[] = []
    const hits = [
      { messageId: 'm1', sessionId: 's1', content: 'hit one', sessionName: 'one', requiresProjectionPreparation: true },
      { messageId: 'm2', sessionId: 's1', content: 'hit two', sessionName: 'one', requiresProjectionPreparation: true },
      { messageId: 'm3', sessionId: 's2', content: 'hit three', sessionName: 'two', requiresProjectionPreparation: true },
      { messageId: 'm4', sessionId: 'legacy', content: 'legacy hit', sessionName: 'legacy' }
    ]
    ctx.sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async ({ sessionId }: { sessionId: string }) => { events.push(`ensure:${sessionId}`); return { sessionId } }),
      queries: { ...base.queries,
        listCanonicalSearchSessions: vi.fn(() => ['s1', 's2']),
        searchMessages: vi.fn(() => { events.push('sync-search'); return hits }),
        searchPreparedMessages: vi.fn(async ({ preparedBySession }: { preparedBySession: ReadonlyMap<string, unknown> }) => {
          events.push(`prepared-search:${[...preparedBySession.keys()].join(',')}`)
          return hits
        })
      }
    }
    try {
      registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

      const results = await ipc.getHandler('search:execute')!({}, 'needle')

      expect(events).toEqual(['ensure:s1', 'ensure:s2', 'prepared-search:s1,s2'])
      expect(results).toHaveLength(4)
    } finally { db.close() }
  })

  it('falls back to the History reader when prepared search is unavailable', async () => {
    const ctx = makeCtx()
    const base = ctx.sessionStorage!
    const hit = { messageId: 'history-hit', sessionId: 'canonical', content: 'needle from History', sessionName: 'canonical' }
    ctx.sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => undefined),
      queries: { ...base.queries,
        listCanonicalSearchSessions: vi.fn(() => ['canonical']),
        searchMessages: vi.fn(() => [hit]),
        searchPreparedMessages: vi.fn()
      }
    }
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const results = await ipc.getHandler('search:execute')!({}, 'needle')

    expect(ctx.sessionStorage.queries.searchPreparedMessages).not.toHaveBeenCalled()
    expect(ctx.sessionStorage.queries.searchMessages).toHaveBeenCalledWith({ query: 'needle', activeProfileId: 'default', limit: 50 })
    expect(results).toMatchObject([{ messageId: 'history-hit', preview: 'needle from History' }])
  })

  it('returns file results with path', async () => {
    const ctx = makeCtx()
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    mockFs.readdir.mockResolvedValue([
      { name: 'perf.ts', isDirectory: () => false, isFile: () => true }
    ])
    mockFs.readFile.mockResolvedValue('export function memoize<T>(fn: T): T { return fn }')

    const handler = ipc.getHandler('search:execute')!
    const results = await handler({}, 'memoize')
    const fileHit = results.find((r: { type: string }) => r.type === 'file')
    expect(fileHit).toMatchObject({
      type: 'file',
      title: expect.stringContaining('perf.ts'),
      path: expect.stringContaining('perf.ts')
    })
  })
})
