import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { registerAppIpcHandlers as registerAppIpcHandlersRaw } from './appIpc'
import { withSessionRuntime } from './testSupport/sessionStorageComposition'
import type { AppIpcContext } from './appIpc'

import { appendMessage, createSession, listSearchHistory } from './database/operations'
import { getDbConnection } from './database/sqliteStore'
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

const registerAppIpcHandlers: typeof registerAppIpcHandlersRaw = (ipc, ctx) =>
  registerAppIpcHandlersRaw(ipc, withSessionRuntime(ctx))

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

  it('prepares canonical sessions lazily as the global result window reaches them', async () => {
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
        searchMessages: vi.fn(() => { events.push('sync-search'); return hits }),
        searchPreparedMessages: vi.fn(async ({ prepareSession }: { prepareSession: (sessionId: string) => Promise<unknown> }) => {
          await prepareSession('s1')
          await prepareSession('s2')
          events.push('prepared-search:s1,s2')
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

  it('does not prepare a broken canonical session outside the IPC result limit', async () => {
    const ctx = makeCtx()
    const db = createMemoryAppDb()
    ctx.db = db
    const base = createSqliteSessionStorage(db)
    const legacy = createSession(db, { name: 'legacy result page' })
    for (let index = 0; index < 50; index += 1) {
      appendMessage(db, { id: `legacy-hit-${index}`, sessionId: legacy.id, role: 'user', content: 'needle',
        timestamp: 1000 - index, status: 'sent' })
    }
    const broken = createSession(db, { name: 'outside result page' })
    appendMessage(db, { id: 'broken-after-limit', sessionId: broken.id, role: 'user', content: '', timestamp: 1, status: 'sent' })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(broken.id)
    conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id='broken-after-limit'").run()
    const ensureChatBodyV1 = vi.fn(async () => undefined)
    ctx.sessionStorage = { ...base, ensureChatBodyV1 }
    try {
      registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

      const results = await ipc.getHandler('search:execute')!({}, 'needle')

      expect(results.filter((result: { id: string }) => result.id.startsWith('msg:'))).toHaveLength(50)
      expect(ensureChatBodyV1).not.toHaveBeenCalled()
    } finally { db.close() }
  })

  it('falls back to the History reader when prepared search is unavailable', async () => {
    const ctx = makeCtx()
    const base = ctx.sessionStorage!
    const hit = { messageId: 'history-hit', sessionId: 'canonical', content: 'needle from History', sessionName: 'canonical' }
    const ensureChatBodyV1 = vi.fn(async () => undefined)
    ctx.sessionStorage = {
      ...base,
      ensureChatBodyV1,
      queries: { ...base.queries,
        searchMessages: vi.fn(() => [hit]),
        searchPreparedMessages: vi.fn(async ({ prepareSession }: { prepareSession: (sessionId: string) => Promise<unknown> }) => {
          if (!await prepareSession('canonical')) throw new Error('PREPARED_SEARCH_UNAVAILABLE')
          return []
        })
      }
    }
    registerAppIpcHandlers(ipc as unknown as import('electron').IpcMain, ctx)

    const results = await ipc.getHandler('search:execute')!({}, 'needle')

    expect(ctx.sessionStorage.queries.searchPreparedMessages).toHaveBeenCalledTimes(1)
    expect(ensureChatBodyV1).toHaveBeenCalledExactlyOnceWith({ sessionId: 'canonical' })
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
