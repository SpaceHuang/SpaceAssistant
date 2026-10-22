import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { registerAgentIpc } from './agentProtocolIpc'
import { readLatestRetrySourceAfterProjection } from './agentProtocolIpc'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

describe('chat:get-messages projection preparation', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('prepares a session before the outbound retry-source query reads message bodies', async () => {
    const events: string[] = []
    const result = await readLatestRetrySourceAfterProjection({
      sessionId: 'retry-session',
      ensureChatBodyV1: async ({ sessionId }) => { events.push(`ensure:${sessionId}`) },
      readLatestRetryTarget: (sessionId) => { events.push(`read:${sessionId}`); return { assistantMessageId: 'failed' } }
    })
    expect(result).toEqual({ assistantMessageId: 'failed' })
    expect(events).toEqual(['ensure:retry-session', 'read:retry-session'])
  })

  it('awaits chatBodyV1 preparation before rerunning the synchronous query', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries, readMessages: vi.fn((input: { sessionId: string; limit?: number; offset?: number }) => {
        events.push('select')
        return base.queries.readMessages(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(handlers.get('chat:get-messages')!(null, { sessionId: session.id })).resolves.toEqual([])
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('prepares chatBodyV1 before the API baseline selects its message window', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection API baseline IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries, readApiBaseline: vi.fn((input: { sessionId: string; limit?: number }) => {
        events.push('select')
        return base.queries.readApiBaseline(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-api-context-baseline')!(null, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('prepares chatBodyV1 before the paged synchronous query selects a page', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection page IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries, readChatPage: vi.fn((input: { sessionId: string; beforeSequence?: number | null; limit?: number }) => {
        events.push('select')
        return base.queries.readChatPage(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-message-page')!(null, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('prepares chatBodyV1 before the display page selects its source page', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection display page IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries, readChatPage: vi.fn((input: { sessionId: string; beforeSequence?: number | null; limit?: number }) => {
        events.push('select')
        return base.queries.readChatPage(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-display-message-page')!(null, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('prepares chatBodyV1 before the search corpus page selects its source page', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection search corpus IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries, readSearchCorpusPage: vi.fn((input: { sessionId: string; fromSequence?: number; pageSize?: number }) => {
        events.push('select')
        return base.queries.readSearchCorpusPage(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-search-corpus-page')!(null, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('prepares chatBodyV1 before retry context selects its message bodies', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection retry context IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries, readRetryTarget: vi.fn((input: { sessionId: string; failedAssistantMessageId: string }) => {
        events.push('select')
        return base.queries.readRetryTarget(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:resolve-retry-context')!(null, {
      sessionId: session.id, failedAssistantMessageId: 'missing'
    }))).resolves.toBeNull()
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })
})
