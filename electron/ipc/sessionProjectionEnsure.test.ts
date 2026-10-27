import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { registerAgentIpc } from './agentProtocolIpc'
import { readLatestRetrySourceAfterProjection } from './agentProtocolIpc'
import { createSessionTurnRuntime, createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

describe('chat:get-messages projection preparation', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  let turnRuntime: ReturnType<typeof createSessionTurnRuntime> | undefined
  const ipcEvent = { processId: 1, sender: {} }
  afterEach(() => { db?.close(); db = undefined; turnRuntime = undefined })

  it('prepares a session before the outbound retry-source query reads message bodies', async () => {
    const events: string[] = []
    const result = await readLatestRetrySourceAfterProjection({
      sessionId: 'retry-session',
      ensureChatBodyV1: async ({ sessionId }) => { events.push(`ensure:${sessionId}`); return 'prepared-view' },
      readPreparedRetryTarget: async ({ sessionId, prepared }) => { events.push(`prepared:${sessionId}:${prepared}`); return { assistantMessageId: 'prepared-failed' } },
      readLatestRetryTarget: (sessionId) => { events.push(`read:${sessionId}`); return { assistantMessageId: 'failed' } }
    })
    expect(result).toEqual({ assistantMessageId: 'prepared-failed' })
    expect(events).toEqual(['ensure:retry-session', 'prepared:retry-session:prepared-view'])
  })

  it('awaits chatBodyV1 preparation before rerunning the synchronous query', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
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
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(handlers.get('chat:get-messages')!(null, { sessionId: session.id })).resolves.toEqual([])
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('uses the prepared cache selection for chat:get-messages when available', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'prepared messages IPC', model: 'test' })
    const events: string[] = []
    const prepared = { sessionId: session.id, sourceIdentityJson: 'source' }
    const messages = [{ id: 'prepared-message', sessionId: session.id, role: 'assistant', content: 'cache body', timestamp: 1 }]
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure'); return prepared }),
      queries: { ...base.queries,
        readPreparedMessages: vi.fn(async (input: { sessionId: string; prepared?: unknown }) => {
          events.push('prepared-read')
          expect(input).toMatchObject({ sessionId: session.id, prepared })
          return messages as never
        }),
        readMessages: vi.fn(() => { events.push('authority-read'); return [] }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(handlers.get('chat:get-messages')!(null, { sessionId: session.id })).resolves.toBe(messages)
    expect(events).toEqual(['ensure', 'prepared-read'])
  })

  it('prepares chatBodyV1 before the API baseline selects its message window', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection API baseline IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
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
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-api-context-baseline')!(null, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('uses the prepared cache baseline for chat:get-api-context-baseline when available', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'prepared API baseline IPC', model: 'test' })
    const events: string[] = []
    const prepared = { sessionId: session.id, sourceIdentityJson: 'source' }
    const baseline = { sessionId: session.id, entries: [{ sequence: 7,
      message: { id: 'prepared-api-message', sessionId: session.id, role: 'assistant', content: 'cache body', timestamp: 1 } }] }
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure'); return prepared }),
      queries: { ...base.queries,
        readPreparedApiBaseline: vi.fn(async (input: { sessionId: string; limit?: number; prepared?: unknown }) => {
          events.push('prepared-read')
          expect(input).toMatchObject({ sessionId: session.id, prepared })
          return baseline as never
        }),
        readApiBaseline: vi.fn(() => { events.push('authority-read'); return { sessionId: session.id, entries: [] } }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(handlers.get('chat:get-api-context-baseline')!(null, { sessionId: session.id })).resolves.toBe(baseline)
    expect(events).toEqual(['ensure', 'prepared-read'])
  })

  it('prepares chatBodyV1 before the paged synchronous query selects a page', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection page IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
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
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-message-page')!(ipcEvent, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('keeps chat:get-message-page readable when projection preparation is deferred', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection page fallback IPC', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure'); throw new Error('PROJECTION_PREPARATION_DEFERRED_LARGE') }),
      queries: { ...base.queries, readChatPage: vi.fn((input: { sessionId: string; beforeSequence?: number | null; limit?: number }) => {
        events.push('authoritative-read')
        return base.queries.readChatPage(input)
      }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(handlers.get('chat:get-message-page')!(ipcEvent, { sessionId: session.id })).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'authoritative-read'])
  })

  it('prepares chatBodyV1 before the display page selects its source page', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection display page IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
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
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
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
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries,
        readPreparedSearchCorpusPage: vi.fn(async (input: { sessionId: string; fromSequence: number; pageSize?: number; prepared?: unknown }) => {
          events.push('prepared-select')
          expect(input.prepared).toBeUndefined()
          return undefined
        }),
        readSearchCorpusPage: vi.fn((input: { sessionId: string; fromSequence?: number; pageSize?: number }) => {
          events.push('authority-select')
          return base.queries.readSearchCorpusPage(input)
        }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:get-search-corpus-page')!(null, { sessionId: session.id }))).resolves.toMatchObject({ entries: [] })
    expect(events).toEqual(['ensure', 'prepared-select', 'authority-select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })

  it('prepares chatBodyV1 before retry context selects its message bodies', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection retry context IPC ensure', model: 'test' })
    const events: string[] = []
    const base = createSqliteSessionStorage(db)
    turnRuntime = createSessionTurnRuntime(base, { deps: { now: Date.now, id: () => 'test-turn' } })
    const sessionStorage = {
      ...base,
      ensureChatBodyV1: vi.fn(async () => { events.push('ensure') }),
      queries: { ...base.queries,
        readPreparedRetryTarget: vi.fn(async () => { events.push('prepared-select'); return undefined }),
        readRetryTarget: vi.fn((input: { sessionId: string; failedAssistantMessageId: string }) => {
          events.push('select')
          return base.queries.readRetryTarget(input)
        }) },
    }
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerAgentIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, {
      db, sessionStorage, turnRuntime, backup: { schedule: vi.fn() } as never, workDirManager: {} as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => 'test-key', setApiKey: async () => undefined, getBrowserDetectContext: () => ({ workDir: '/tmp' }) as never,
    })

    await expect(Promise.resolve(handlers.get('chat:resolve-retry-context')!(null, {
      sessionId: session.id, failedAssistantMessageId: 'missing'
    }))).resolves.toBeNull()
    expect(events).toEqual(['ensure', 'prepared-select', 'select'])
    expect(sessionStorage.ensureChatBodyV1).toHaveBeenCalledWith({ sessionId: session.id })
  })
})
