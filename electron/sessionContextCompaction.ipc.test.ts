import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessagesAtomically, createPersistedTurn, createSession } from './database/operations'
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
vi.mock('./sessionContextSummary', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessionContextSummary')>(),
  summarizeSessionContext: vi.fn(async () => ({ task: 'prior task', completed: 'completed', decisions: 'keep decision', constraints: 'constraints', pending: 'continue', blockers: 'none', nextStep: 'continue' }))
}))
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
    let replayForStorage = { committed: [], rejected: [] } as unknown
    const baseStorage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => '/tmp', getUserDataDir: () => '/tmp',
      getSessionEventSink: () => sink as never, readCompactionReplay: async () => replayForStorage as never
    })
    await baseStorage.recovery.recover()
    await baseStorage.execution.historyFor({ sessionId: session.id }).appendBatch([{
      invocationId: 'invalid-compaction-sidecar', turnId: 'invalid-compaction-turn', sequence: 1, schemaVersion: 1,
      eventId: 'invalid-compaction-sidecar:event:1', idempotencyKey: 'invalid-compaction-sidecar:transcript-compacted:1',
      kind: 'transcript-compacted', payload: { compactionId: 'legacy-compaction-without-boundary', messages: [{ role: 'user', content: 'x' }],
        sessionLedger: { location: { workDir: '/tmp', sessionId: session.id, createdAt: session.createdAt }, start: { compactionId: 'legacy-compaction-without-boundary' } } }
    }], 0)
    const observedAvailability = baseStorage.availability.inspect(session.id)
    const healthyAvailability = { ...observedAvailability,
      globalFence: { state: 'ready' as const, source: { recoveryState: 'ready' as const } },
      content: { ...observedAvailability.content, state: 'readable' as const },
      execution: { ...observedAvailability.execution, state: 'ready' as const } }
    const inspectAvailability = vi.fn((_sessionId: string) => healthyAvailability)
    const projectionReadEvents: string[] = []
    const storage = {
      ...baseStorage,
      availability: { inspect: inspectAvailability },
      ensureChatBodyV1: vi.fn(async () => { projectionReadEvents.push('ensure') }),
      queries: { ...baseStorage.queries, readApiBaseline: vi.fn((input: { sessionId: string; limit?: number }) => {
        projectionReadEvents.push('select')
        return baseStorage.queries.readApiBaseline(input)
      }) }
    }
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

    const [result, competing] = await Promise.all([
      handlers.get('chat:compact-session-context')!({ sender: window.webContents }, { sessionId: session.id, requestId: 'ipc-compact-1' }),
      handlers.get('chat:compact-session-context')!({ sender: window.webContents }, { sessionId: session.id, requestId: 'ipc-compact-1-duplicate' })
    ])

    expect(result).toMatchObject({ status: 'committed', repairBranch: 'new-split', windowId: expect.any(String), outputSurfaceFingerprint: expect.any(String) })
    expect(competing).toEqual({ status: 'busy' })
    expect(projectionReadEvents[0]).toBe('ensure')
    expect(projectionReadEvents.indexOf('ensure')).toBeLessThan(projectionReadEvents.indexOf('select'))
    expect(resolveLlmCredentialsForModel).toHaveBeenCalledOnce()
    expect(summarizeSessionContext).toHaveBeenCalledOnce()
    expect(appendCompactionTransaction).toHaveBeenCalledOnce()
    expect(appendCompactionTransaction).toHaveBeenCalledWith(sink, expect.objectContaining({ reason: 'lost_compaction_repair', repairIdentity: expect.objectContaining({ branch: 'new-split' }) }), expect.objectContaining({ candidate: expect.objectContaining({ kind: 'summary' }) }))
    expect(storage.contexts).toMatchObject({ readCurrent: expect.any(Function), commitReplacement: expect.any(Function) })
    expect(inspectAvailability).toHaveBeenCalledWith(session.id)
    const startPayload = vi.mocked(appendCompactionTransaction).mock.calls[0]![1] as Record<string, unknown>
    const summaryPayload = vi.mocked(appendCompactionTransaction).mock.calls[0]![2] as Record<string, unknown>
    replayForStorage = { committed: [{ compactionId: (result as { compactionId: string }).compactionId,
      start: { seq: 1, type: 'compaction_start', payload: startPayload },
      summary: { seq: 2, type: 'compaction_summary', payload: summaryPayload },
      end: { seq: 3, type: 'compaction_end', payload: { compactionId: (result as { compactionId: string }).compactionId,
        status: 'committed', outputWindowId: (result as { windowId: string }).windowId,
        outputSurfaceFingerprint: (result as { outputSurfaceFingerprint: string }).outputSurfaceFingerprint } } }], rejected: [] }
    const retried = await handlers.get('chat:compact-session-context')!({ sender: window.webContents },
      { sessionId: session.id, requestId: 'ipc-compact-1' })
    expect(retried).toEqual(result)
    expect(summarizeSessionContext).toHaveBeenCalledOnce()
    expect(appendCompactionTransaction).toHaveBeenCalledOnce()
    inspectAvailability.mockReturnValue({ ...healthyAvailability,
      globalFence: { state: 'pending', source: { recoveryState: 'pending' } } })
    await expect(handlers.get('chat:compact-session-context')!({ sender: window.webContents },
      { sessionId: session.id, requestId: 'ipc-compact-recovery-pending' })).resolves.toEqual({ status: 'unavailable' })
    expect(summarizeSessionContext).toHaveBeenCalledOnce()
    await expect(handlers.get('chat:get-session-compaction-markers')!({ sender: window.webContents }, session.id)).resolves.toEqual([
      { compactionId: (result as { compactionId: string }).compactionId, windowId: (result as { windowId: string }).windowId,
        outputSurfaceFingerprint: (result as { outputSurfaceFingerprint: string }).outputSurfaceFingerprint }
    ])
  })


  it('routes the active turn busy check through SessionStorage execution', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'busy compaction', model: 'test-model' })
    appendMessagesAtomically(db, [{ id: 'busy-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' }])
    createPersistedTurn(db, { turnId: 'busy-turn', requestId: 'busy-request', sessionId: session.id, assistantMessageId: 'busy-assistant', state: 'executing' })
    const storageBase = createSqliteSessionStorage(db)
    const hasActiveTurn = vi.fn((sessionId: string) => storageBase.execution.hasActiveTurn(sessionId))
    const storage = { ...storageBase, execution: { ...storageBase.execution, hasActiveTurn } }
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

    await expect(handlers.get('chat:compact-session-context')!({ sender: window.webContents }, { sessionId: session.id, requestId: 'busy-compact' }))
      .resolves.toEqual({ status: 'busy' })
    expect(hasActiveTurn).toHaveBeenCalledWith(session.id)
    expect(summarizeSessionContext).not.toHaveBeenCalled()
  })

  it('returns no markers when a blocked ledger cannot safely supply compaction replay', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'blocked compaction markers', model: 'test-model', maxTokens: 2_000, fixedWorkDir: '/tmp' })
    const storage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => '/tmp', getUserDataDir: () => '/tmp', ensureSessionLedgerReady: async () => false
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

    await expect(handlers.get('chat:get-session-compaction-markers')!({ sender: window.webContents }, session.id))
      .resolves.toEqual([])
  })
})
