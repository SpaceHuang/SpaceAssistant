import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessagesAtomically, createSession } from './database/operations'
import { createMemoryAppDb } from './database/testHelpers'
import { createSqliteSessionStorage } from './sessionStorage/sqliteSessionStorage'
import { registerSessionIpc } from './ipc/sessionIpc'
import { getMainWindow } from './windowRef'
import { resolveLlmCredentialsForModel, readStoredModels } from './llmServiceResolver'
import { summarizeSessionContext } from './sessionContextSummary'
import { appendCompactionTransaction } from './sessionEvents'

vi.mock('./windowRef', () => ({ getMainWindow: vi.fn() }))
vi.mock('./llmServiceResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('./llmServiceResolver')>(),
  resolveLlmCredentialsForModel: vi.fn(async () => ({ getApiKey: async () => 'test-key' })),
  readStoredModels: vi.fn(() => [{ id: 'test-model', name: 'test-model', maximumContext: 12_000, maximumContextSource: 'user' }])
}))
vi.mock('./sessionContextSummary', () => ({ summarizeSessionContext: vi.fn(async () => ({ task: 'prior task', decisions: 'keep decision', pending: 'continue' })) }))
vi.mock('./sessionEvents', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessionEvents')>(),
  getSessionEventSink: vi.fn(() => ({ eventsPath: '/tmp/session-context-ipc', indexPath: '/tmp/session-context-ipc-index', appendCritical: vi.fn(), appendChunk: vi.fn(), waitForCapacity: vi.fn(), flush: vi.fn(), close: vi.fn() })),
  readCompactionReplay: vi.fn(async () => ({ committed: [], rejected: [] })),
  appendCompactionTransaction: vi.fn(async () => undefined)
}))

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

describe('manual context compaction IPC ContextPort integration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined; vi.clearAllMocks() })

  it('commits a trusted renderer request through the session ContextPort and ledger transaction owner', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'manual compaction', model: 'test-model', maxTokens: 2_000 })
    appendMessagesAtomically(db, [
      { id: 'ipc-u1', sessionId: session.id, role: 'user', content: 'Earlier user context '.repeat(120), timestamp: 1, status: 'sent' },
      { id: 'ipc-a1', sessionId: session.id, role: 'assistant', content: 'Earlier assistant context '.repeat(120), timestamp: 2, status: 'completed' },
      { id: 'ipc-u2', sessionId: session.id, role: 'user', content: 'Current user context '.repeat(120), timestamp: 3, status: 'sent' },
      { id: 'ipc-a2', sessionId: session.id, role: 'assistant', content: 'Current assistant context '.repeat(120), timestamp: 4, status: 'completed' }
    ])
    const sink = { eventsPath: '/tmp/session-context-ipc', indexPath: '/tmp/session-context-ipc-index', appendCritical: vi.fn(), appendChunk: vi.fn(), waitForCapacity: vi.fn(), flush: vi.fn(), close: vi.fn() }
    const storage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => '/tmp', getUserDataDir: () => '/tmp',
      getSessionEventSink: () => sink as never, readCompactionReplay: async () => ({ committed: [], rejected: [] } as never)
    })
    const handlers = new Map<string, Handler>()
    const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
    const window = { isDestroyed: () => false, webContents: { id: 7 } }
    vi.mocked(getMainWindow).mockReturnValue(window as never)
    registerSessionIpc(ipc as never, {
      db, sessionStorage: storage, backup: {} as never,
      workDirManager: { listProfiles: () => [], getActiveProfileId: () => 'default', getActiveWorkDir: () => '/tmp' } as never,
      getWorkDir: () => '/tmp', setWorkDir: () => undefined, getUserDataPath: () => '/tmp',
      getApiKey: async () => null, setApiKey: async () => undefined, getBrowserDetectContext: () => ({ isPackaged: false, appPath: '/tmp', devRoot: '/tmp' })
    })

    const result = await handlers.get('chat:compact-session-context')!({ sender: window.webContents }, { sessionId: session.id, requestId: 'ipc-compact-1' })

    expect(result).toMatchObject({ status: 'committed', windowId: expect.any(String), outputSurfaceFingerprint: expect.any(String) })
    expect(resolveLlmCredentialsForModel).toHaveBeenCalledOnce()
    expect(summarizeSessionContext).toHaveBeenCalledOnce()
    expect(appendCompactionTransaction).toHaveBeenCalledOnce()
    expect(appendCompactionTransaction).toHaveBeenCalledWith(sink, expect.objectContaining({ reason: 'user_compact' }), expect.objectContaining({ candidate: expect.objectContaining({ kind: 'summary' }) }))
    expect(storage.contexts).toMatchObject({ readCurrent: expect.any(Function), commitReplacement: expect.any(Function) })
  })
})
