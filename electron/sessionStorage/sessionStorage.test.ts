import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, appendMessagesAtomically, createPersistedTurn, createSession, enqueueQueuedUserMessage, getPersistedTurn, getQueueInputReceipt, getSession } from '../database/operations'
import { getDbConnection } from '../database'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSqliteSessionStorage } from './sqliteSessionStorage'
import { TurnRuntime } from '../turnRuntime'
import { bindSessionStorageContextPort, createBoundSessionContextAdapter } from './contextPortRegistry'
import { buildToolChatMessagesFromSource } from '../chatMessageBuild'
import { computeReplaySurfaceFingerprint, projectReplaySurface, projectReplaySurfaceWithSources } from '../../src/shared/surfaceReplay'
import { computeCompactionSummaryHash } from '../../src/shared/compactionEvents'

describe('SQLite session storage public queries', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('binds the database at construction and preserves chat-page sequence semantics', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'public query', model: 'test' })
    appendMessagesAtomically(db, Array.from({ length: 24 }, (_, index) => ({
      id: `message-${index + 1}`,
      sessionId: session.id,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `body-${index + 1}`,
      timestamp: index + 1,
      status: index % 2 === 0 ? 'sent' as const : 'completed' as const
    })))

    const storage = createSqliteSessionStorage(db)
    const firstPage = storage.queries.readChatPage({ sessionId: session.id, limit: 20 })
    const previousPage = storage.queries.readChatPage({
      sessionId: session.id,
      beforeSequence: firstPage.oldestSequence,
      limit: 20
    })

    expect(firstPage.entries.map(({ message }) => message.id)).toEqual(Array.from({ length: 20 }, (_, i) => `message-${i + 5}`))
    expect(firstPage).toMatchObject({ oldestSequence: 4, hasMoreBefore: true })
    expect(previousPage.entries.map(({ message }) => message.id)).toEqual(['message-1', 'message-2', 'message-3', 'message-4'])
    expect(previousPage).toMatchObject({ oldestSequence: 0, hasMoreBefore: false })
    expect(storage.queries.readMessage({ sessionId: session.id, messageId: 'message-2' })?.content).toBe('body-2')
    expect(storage.queries.readMessage({ sessionId: 'another-session', messageId: 'message-2' })).toBeUndefined()
    expect(storage.queries.readMessages({ sessionId: session.id, limit: 2, offset: 1 }).map(({ id }) => id))
      .toEqual(['message-2', 'message-3'])
    expect(storage.queries.readMessageSequence({ sessionId: session.id, messageId: 'message-2' })).toBe(1)
    expect(storage.queries.readMessageSequence({ sessionId: session.id, messageId: 'missing' })).toBeNull()

    const route = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'message-24' })
    expect(route).toMatchObject({ userInput: 'body-24', hasVision: false })
    const boundedRoute = storage.queries.readRoutingInput({
      sessionId: session.id,
      boundarySequence: 19,
      limit: 3,
      excludeMessageIds: ['message-19']
    })
    expect(boundedRoute.recentMessages).toEqual([
      { role: 'user', content: 'body-17' },
      { role: 'assistant', content: 'body-18' },
      { role: 'assistant', content: 'body-20' }
    ])
    expect(storage.queries.isSelectionCurrent(session.id, route.fence)).toBe(true)
    expect(storage.queries.isSelectionCurrent('another-session', route.fence)).toBe(false)

    const otherSession = createSession(db, { name: 'other session', model: 'test' })
    appendMessagesAtomically(db, [{ id: 'foreign-user', sessionId: otherSession.id, role: 'user', content: 'foreign', timestamp: 30, status: 'sent' }])
    expect(() => storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'foreign-user' }))
      .toThrow('TURN_USER_MESSAGE_MISSING')
  })

  it('selects latest retry source through queries and preserves the unique failed assistant rule', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'latest retry target' })
    appendMessage(db, { id: 'retry-user', sessionId: session.id, role: 'user', content: 'retry me', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'retry-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 2, status: 'failed' })
    createPersistedTurn(db, { turnId: 'retry-turn', requestId: 'retry-invocation', sessionId: session.id, userMessageId: 'retry-user', assistantMessageId: 'retry-assistant', contextBoundarySequence: 0, state: 'failed', startToken: 'retry-token' })
    const storage = createSqliteSessionStorage(db)
    expect(storage.queries.readLatestRetryTarget(session.id)).toMatchObject({
      failedAssistant: { message: { id: 'retry-assistant' } },
      sourceInvocationId: 'retry-invocation',
      sourceTurnId: 'retry-turn'
    })
    expect(storage.queries.readRetryTarget({ sessionId: session.id, failedAssistantMessageId: 'retry-assistant' }))
      .toMatchObject({ sourceInvocationId: 'retry-invocation', sourceTurnId: 'retry-turn' })
    appendMessage(db, { id: 'retry-assistant-2', sessionId: session.id, role: 'assistant', content: 'another failure', timestamp: 3, status: 'failed' })
    expect(storage.queries.readLatestRetryTarget(session.id)).toBeNull()
  })

  it('provides the SDK ContextPort from the session storage factory', () => {
    db = createMemoryAppDb()
    const storage = createSqliteSessionStorage(db)
    expect(storage.contexts).toMatchObject({
      readCurrent: expect.any(Function),
      commitReplacement: expect.any(Function)
    })
  })

  it('reads the Hosted transcript checkpoint through SessionExecutionStore', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'hosted transcript port' })
    const storage = createSqliteSessionStorage(db)
    const initial = storage.execution.readHostedTranscript(session.id)

    expect(initial).toMatchObject({ sessionId: session.id, version: 0, status: 'ready', messages: [] })
    expect(storage.execution.readHostedTranscript(session.id)).toEqual(initial)
  })

  it('routes ContextPort operations by exact session scope and releases the binding', async () => {
    db = createMemoryAppDb()
    const storage = createSqliteSessionStorage(db)
    const scope = { kind: 'session' as const, sessionId: 'context-session' }
    const snapshot = { scope, frame: { items: [], system: '', windowId: 'w1', pendingTools: [] }, fence: { token: 'f1' } }
    const scopedPort = {
      readCurrent: async (requested: typeof scope) => {
        if (requested.sessionId !== scope.sessionId) throw new Error('CONTEXT_SCOPE_MISMATCH')
        return snapshot
      },
      commitReplacement: async () => ({ status: 'no-op' as const })
    }
    const unbind = bindSessionStorageContextPort(storage.contexts, scope, scopedPort)
    await expect(storage.contexts.readCurrent(scope)).resolves.toEqual(snapshot)
    await expect(storage.contexts.readCurrent({ kind: 'session', sessionId: 'other-session' })).rejects.toThrow('CONTEXT_SCOPE_NOT_BOUND')
    unbind()
    await expect(storage.contexts.readCurrent(scope)).rejects.toThrow('CONTEXT_SCOPE_NOT_BOUND')
  })

  it('resolves per-session workDir and ledger resources inside the SQLite context factory', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'factory-context-resources' })
    const getWorkDirForSession = vi.fn(() => '/tmp/spaceassistant-context-factory-test')
    const sink = { eventsPath: '/unused', appendCritical: vi.fn(), appendChunk: vi.fn(), waitForCapacity: vi.fn(), flush: vi.fn(), close: vi.fn(), indexPath: '/unused-index' }
    const getLedger = vi.fn(() => sink as never)
    const storage = createSqliteSessionStorage(db, { getWorkDirForSession, getUserDataDir: () => '/tmp', getSessionEventSink: getLedger, readCompactionReplay: async () => ({ committed: [] } as never) })
    const bound = await createBoundSessionContextAdapter(storage.contexts, { sessionId: session.id, isBusy: () => false })
    expect(getWorkDirForSession).toHaveBeenCalledWith(session.id)
    expect(getLedger).toHaveBeenCalledWith('/tmp/spaceassistant-context-factory-test', session.id, session.createdAt)
    expect(bound.adapter.port).toMatchObject({ readCurrent: expect.any(Function), commitReplacement: expect.any(Function) })
    expect(bound.messages).toEqual([])
  })

  it('rebuilds readCurrent from committed compaction shadow after recreating the session adapter', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'restart-context-shadow' })
    const sourceMessages = [
      { id: 'shadow-u1', sessionId: session.id, role: 'user' as const, content: 'old question '.repeat(40), timestamp: 1, status: 'sent' as const },
      { id: 'shadow-a1', sessionId: session.id, role: 'assistant' as const, content: 'old answer '.repeat(40), timestamp: 2, status: 'completed' as const },
      { id: 'shadow-u2', sessionId: session.id, role: 'user' as const, content: 'current question '.repeat(40), timestamp: 3, status: 'sent' as const },
      { id: 'shadow-a2', sessionId: session.id, role: 'assistant' as const, content: 'current answer '.repeat(40), timestamp: 4, status: 'completed' as const }
    ]
    appendMessagesAtomically(db, sourceMessages)
    const built = await buildToolChatMessagesFromSource({ userDataDir: '/tmp', workDir: '/tmp', sourceMessages, currentUserMessageId: 'shadow-u2', sessionId: session.id })
    const inputSurface = projectReplaySurface(built)
    const checkpointMessage = { id: 'restart-checkpoint', role: 'user' as const, content: JSON.stringify({ kind: 'context_checkpoint', task: 'old', decisions: 'keep', pending: 'continue' }) }
    const outputSurface = projectReplaySurface([checkpointMessage, ...inputSurface.slice(-2)])
    const candidate = { kind: 'summary', checkpointMessage, checkpointReplayIdentity: 'restart-checkpoint-identity', shadowedRanges: [{ start: 'shadow-u1', end: 'shadow-a1' }] }
    const compactionId = 'restart-compaction'
    const inputSurfaceFingerprint = computeReplaySurfaceFingerprint('', inputSurface)
    const outputSurfaceFingerprint = computeReplaySurfaceFingerprint('', outputSurface)
    const start = { seq: 1, type: 'compaction_start' as const, payload: { compactionId, windowId: 'window-before-restart', inputSurfaceFingerprint, surfaceBoundaryId: 'shadow-a2' } }
    const summary = { seq: 2, type: 'compaction_summary' as const, payload: { compactionId, windowId: 'window-before-restart', outputSurfaceFingerprint, summaryHash: computeCompactionSummaryHash(candidate), shadowedRanges: candidate.shadowedRanges, candidate } }
    const end = { seq: 3, type: 'compaction_end' as const, payload: { compactionId, windowId: 'window-before-restart', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint, outputSurfaceFingerprint, summaryHash: summary.payload.summaryHash } }
    const replay = { committed: [{ compactionId, start, summary, end }], rejected: [] }
    const sink = { eventsPath: '/unused', appendCritical: vi.fn(), appendChunk: vi.fn(), waitForCapacity: vi.fn(), flush: vi.fn(), close: vi.fn(), indexPath: '/unused-index' }
    const storage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => '/tmp', getUserDataDir: () => '/tmp',
      getSessionEventSink: () => sink as never, readCompactionReplay: async () => replay as never
    })

    const afterRestart = await createBoundSessionContextAdapter(storage.contexts, { sessionId: session.id, isBusy: () => false })
    const snapshot = await afterRestart.adapter.port.readCurrent({ kind: 'session', sessionId: session.id })

    expect(afterRestart.messages.map((message) => message.id)).toEqual(['restart-checkpoint', 'shadow-u2', 'shadow-a2'])
    expect(snapshot.frame.items.map((item) => item.message.id)).toEqual(['restart-checkpoint', 'shadow-u2', 'shadow-a2'])
    expect(snapshot.frame.items[0]?.replayIdentity).toBe('restart-checkpoint-identity')
    expect(snapshot.frame.windowId).toBe('window-before-restart')
  })

  it('exposes the full-history context token summary through SessionQueries', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'context-summary-query' })
    appendMessagesAtomically(db, [
      { id: 'summary-plain', sessionId: session.id, role: 'user', content: 'body omitted', timestamp: 1, status: 'sent' },
      { id: 'summary-image', sessionId: session.id, role: 'user', content: 'image body omitted', timestamp: 2, status: 'sent', attachments: [{ id: 'image', stagingKey: 'chat-attachments/summary/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 4096, width: 512, height: 512 }] },
      { id: 'summary-thinking', sessionId: session.id, role: 'assistant', content: 'assistant body omitted', timestamp: 3, status: 'completed', thinking: { content: 'private reasoning text', isVisible: true, startTime: 1, segments: [{ content: 'private reasoning text', startTime: 1, endTime: 2 }] } }
    ])

    const baseline = createSqliteSessionStorage(db).queries.readContextHistorySummaryBaseline(session.id)

    expect(baseline.sessionId).toBe(session.id)
    expect(baseline.entries.map(({ messageId }) => messageId)).toEqual(['summary-image', 'summary-thinking'])
    expect(baseline.entries[0]).toMatchObject({ role: 'user', imageTokens: expect.any(Number), sequence: 1 })
    expect(baseline.entries[1]).toMatchObject({ role: 'assistant', thinkingTokens: expect.any(Number), sequence: 2 })
    expect(baseline.entries.some((entry) => 'content' in entry)).toBe(false)
  })

  it('renames a session without replacing unrelated metadata', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'metadata boundary', model: 'test', metadata: { userNote: 'before' } })
    const storage = createSqliteSessionStorage(db)

    storage.commands.renameSession(session.id, 'renamed')

    expect(getSession(db, session.id)?.name).toBe('renamed')
    expect(getSession(db, session.id)?.metadata).toMatchObject({ userNote: 'before', titleUserCustom: true })
    expect(storage.commands.renameSession).toBeDefined()
    expect(storage.commands).not.toHaveProperty('updateSession')
  })

  it('edits message body through the restricted content command', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'content edit command', model: 'test' })
    const message = appendMessage(db, { id: 'content-edit', sessionId: session.id, role: 'user', content: 'before', timestamp: 1, status: 'sent' }).message
    const storage = createSqliteSessionStorage(db)

    await expect(storage.commands.editMessage({ sessionId: session.id, messageId: message.id, content: 'after' })).resolves.toBe(true)
    expect(storage.queries.readMessage({ sessionId: session.id, messageId: message.id })?.content).toBe('after')
    await expect(storage.commands.editMessage({ sessionId: session.id, messageId: 'missing-message', content: 'after' })).resolves.toBe(false)
    // @ts-expect-error metadata/state mutation is not part of the public body-edit command
    storage.commands.editMessage({ sessionId: session.id, messageId: message.id, content: 'after', status: 'failed' })
  })

  it('updates only terminal scrollback through the metadata command', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'scrollback command', model: 'test' })
    const originalCalls = [{
      id: 'shell-call', toolName: 'run_shell', input: { command: 'echo ok' }, status: 'completed' as const, riskLevel: 'medium' as const,
      result: { success: true, data: { output: 'ok' } }
    }]
    const message = appendMessage(db, { id: 'scrollback-message', sessionId: session.id, role: 'assistant', content: 'body', timestamp: 1, status: 'completed', toolCalls: originalCalls }).message
    const storage = createSqliteSessionStorage(db)
    const nextCalls = [{
      ...originalCalls[0]!,
      result: { ...originalCalls[0]!.result, data: { ...originalCalls[0]!.result.data, terminalScrollback: { cols: 80, rows: 24, plainText: 'output' } } }
    }]

    const updated = storage.commands.updateToolCallScrollback({ sessionId: session.id, messageId: message.id, toolCalls: nextCalls })

    expect(updated?.message.content).toBe('body')
    expect(updated?.message.toolCalls?.[0]).toMatchObject({ id: 'shell-call', status: 'completed', result: { data: { terminalScrollback: { cols: 80, rows: 24 } } } })
    expect(() => storage.commands.updateToolCallScrollback({
      sessionId: session.id,
      messageId: message.id,
      toolCalls: [{ ...nextCalls[0]!, status: 'failed' }]
    })).toThrow('TOOL_CALL_SCROLLBACK_PATCH_INVALID')
  })

  it('updates title lifecycle flags through a named command without exposing arbitrary metadata patches', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'title flags', model: 'test', metadata: { note: 'keep' } })
    const storage = createSqliteSessionStorage(db)

    storage.commands.updateTitleSuggestionState(session.id, { generated: true, backfillAttempted: true })
    expect(storage.queries.readSession(session.id)?.metadata).toMatchObject({ note: 'keep', titleGenerated: true, titleOpenBackfillAttempted: true })
    storage.commands.updateTitleSuggestionState(session.id, { generated: false, backfillAttempted: false })
    expect(storage.queries.readSession(session.id)?.metadata).toEqual({ note: 'keep' })
  })

  it('applies generated titles without setting the user-custom marker and rechecks eligibility', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'untitled', model: 'test', metadata: { note: 'keep' } })
    const commands = createSqliteSessionStorage(db).commands
    expect(commands.applyGeneratedTitle(session.id, 'generated title')?.metadata).toMatchObject({ note: 'keep', titleGenerated: true })
    expect(commands.applyGeneratedTitle(session.id, 'second title')).toBeUndefined()
    expect(createSqliteSessionStorage(db).queries.readSession(session.id)?.name).toBe('generated title')
  })

  it('advances remote activity metadata monotonically while preserving unrelated metadata', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'remote activity', model: 'test', metadata: { note: 'keep', remoteSessionLastActivityAt: 20 } })
    const commands = createSqliteSessionStorage(db).commands

    expect(commands.recordRemoteSessionActivity(session.id, 18)?.metadata).toMatchObject({ note: 'keep', remoteSessionLastActivityAt: 20 })
    expect(commands.recordRemoteSessionActivity(session.id, 24)?.metadata).toMatchObject({ note: 'keep', remoteSessionLastActivityAt: 24 })
  })

  it('records channel-specific remote identity details without replacing unrelated metadata', () => {
    db = createMemoryAppDb()
    const feishu = createSession(db, { name: 'feishu', model: 'test', metadata: { note: 'keep', source: 'feishu', feishuChatId: 'chat-1' } })
    const wechat = createSession(db, { name: 'wechat', model: 'test', metadata: { note: 'keep', source: 'wechat', wechatMeta: { userId: 'user-1', custom: true } } })
    const storage = createSqliteSessionStorage(db)

    storage.commands.recordRemoteSessionIdentity(feishu.id, { channel: 'feishu', messageId: 'fm-2' })
    storage.commands.recordRemoteSessionIdentity(wechat.id, { channel: 'wechat', userId: 'user-1', messageId: 'wm-2', contextToken: 'ctx-2' })
    expect(storage.queries.readSession(feishu.id)?.metadata).toMatchObject({ note: 'keep', feishuChatId: 'chat-1', feishuMessageId: 'fm-2' })
    expect(storage.queries.readSession(wechat.id)?.metadata).toMatchObject({ note: 'keep', wechatMeta: { userId: 'user-1', custom: true, lastMessageId: 'wm-2', lastContextToken: 'ctx-2' } })
  })

  it('creates sessions and enqueues input through named commands with receipt idempotency', () => {
    db = createMemoryAppDb()
    const storage = createSqliteSessionStorage(db)
    const session = storage.commands.createSession({ name: 'created through port', model: 'test', metadata: { source: 'unit' } })
    const input = { sessionId: session.id, requestId: 'queue-command-request', content: ' queued text ' }

    const first = storage.commands.enqueue(input)
    const duplicate = storage.commands.enqueue(input)

    expect(session).toMatchObject({ name: 'created through port', metadata: { source: 'unit' } })
    expect(first).toMatchObject({ duplicate: false, receipt: { state: 'queued', requestId: input.requestId }, persisted: { message: { content: 'queued text' } } })
    expect(duplicate).toMatchObject({ duplicate: true, receipt: first.receipt, persisted: first.persisted })
    expect(() => storage.commands.enqueue({ ...input, content: 'different payload' })).toThrow('QUEUE_REQUEST_FINGERPRINT_MISMATCH')
  })

  it('separates session settings from user metadata merge and preserves owned metadata keys', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'settings', model: 'before', metadata: { keep: true, sessionDirectoryGrants: [{ grantId: 'owned' }] } })
    const storage = createSqliteSessionStorage(db)

    const updatedSettings = storage.commands.updateSettings({ sessionId: session.id, model: 'after' })
    const updatedName = storage.commands.renameSession(session.id, 'renamed settings')
    const updatedMetadata = storage.commands.updateUserMetadata(session.id, {
      custom: 'value', titleUserCustom: false, sessionDirectoryGrants: []
    })

    expect(updatedSettings?.model).toBe('after')
    expect(updatedName?.name).toBe('renamed settings')
    expect(updatedMetadata).toMatchObject({ name: 'renamed settings', model: 'after', metadata: { keep: true, custom: 'value', titleUserCustom: true, sessionDirectoryGrants: [{ grantId: 'owned' }] } })
    expect(storage.commands).not.toHaveProperty('updateSession')
    expect(storage.commands).not.toHaveProperty('patchMessage')
  })

  it('updates directory grant metadata through a dedicated command while preserving other keys', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'directory metadata', model: 'test', metadata: { source: 'desktop', custom: 7 } })
    const storage = createSqliteSessionStorage(db)
    const grant = { grantId: 'grant-1', sessionId: session.id, path: '/tmp/grant', realPath: '/tmp/grant', identity: { dev: 1, ino: 2, mode: 3 }, createdAt: 4, source: 'user-selected-directory' as const }

    expect(storage.commands.updateDirectoryGrants(session.id, [grant])?.metadata).toEqual({ source: 'desktop', custom: 7, sessionDirectoryGrants: [grant] })
    expect(storage.commands.updateDirectoryGrants(session.id, [])?.metadata).toEqual({ source: 'desktop', custom: 7, sessionDirectoryGrants: [] })
  })

  it('appends a non-turn message through a named command and preserves its sequence result', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'non-turn append', model: 'test' })
    const storage = createSqliteSessionStorage(db)
    const message = { id: 'non-turn-message', sessionId: session.id, role: 'system' as const, content: 'hint', timestamp: 1, status: 'completed' as const }

    expect(storage.commands.appendNonTurnMessage(message)).toMatchObject({ message, sequence: 0 })
  })

  it('loads accepted context through the execution port and enforces turn ownership', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'accepted context', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'accepted-user', sessionId: session.id, role: 'user', content: 'accepted input', timestamp: 1, status: 'sent' },
      { id: 'accepted-assistant', sessionId: session.id, role: 'assistant', content: 'working', timestamp: 2, status: 'streaming' }
    ])
    createPersistedTurn(db, {
      turnId: 'accepted-turn', requestId: 'accepted-request', sessionId: session.id,
      assistantMessageId: 'accepted-assistant', userMessageId: 'accepted-user', state: 'executing', excludeMessageIds: []
    })
    const execution = createSqliteSessionStorage(db).execution

    expect(execution.loadAcceptedMessages({ sessionId: session.id, turnId: 'accepted-turn' }).map(({ id }) => id))
      .toEqual(['accepted-user'])
    expect(execution.readTurn({ sessionId: session.id, turnId: 'accepted-turn' })).toMatchObject({ sessionId: session.id, requestId: 'accepted-request' })
    expect(execution.readTurn({ sessionId: 'wrong-session', turnId: 'accepted-turn' })).toBeUndefined()
    expect(execution.readTurnByRequest({ sessionId: session.id, requestId: 'accepted-request' })).toMatchObject({ turnId: 'accepted-turn' })
    expect(execution.hasActiveTurn(session.id)).toBe(true)
    expect(execution.hasActiveTurn('wrong-session')).toBe(false)
    expect(() => execution.loadAcceptedMessages({ sessionId: 'wrong-session', turnId: 'accepted-turn' })).toThrow('TURN_NOT_FOUND')
  })

  it('accepts a prepared turn and reads its receipt and transcript state through execution', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'accepted receipt', model: 'test' })
    const user = appendMessage(db, { id: 'receipt-user', sessionId: session.id, role: 'user', content: 'accepted', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'receipt-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'receipt-turn', requestId: 'receipt-request', sessionId: session.id,
      assistantMessageId: 'receipt-assistant', userMessageId: user.message.id,
      contextBoundarySequence: user.sequence - 1, state: 'prepared', startToken: 'receipt-token'
    })
    const execution = createSqliteSessionStorage(db).execution

    const accepted = execution.acceptPrepared({
      prepared: { turnId: 'receipt-turn', requestId: 'receipt-request', sessionId: session.id, startToken: 'receipt-token', userMessage: { id: user.message.id } },
      lane: 'desktop', config: { lane: 'desktop', model: 'test' }
    })

    expect(execution.readAccepted({ sessionId: session.id, requestId: 'receipt-request' })).toEqual(accepted)
    expect(execution.readTranscriptState(session.id)).toMatchObject({ sessionId: session.id, status: 'ready', version: 0 })
  })

  it('owns execution claim lifecycle through named execution operations', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'execution claim', model: 'test' })
    const execution = createSqliteSessionStorage(db).execution
    const claim = execution.claimExecution({ sessionId: session.id, turnId: 'claim-turn', ownerId: 'claim-owner' })
    expect(claim).toEqual({ acquired: true, generation: 1 })
    if (!claim.acquired) throw new Error('expected execution claim')
    const lease = { sessionId: session.id, turnId: 'claim-turn', ownerId: 'claim-owner', generation: claim.generation }
    expect(execution.markExecutionStarted(lease)).toBe(true)
    expect(execution.releaseExecution(lease)).toBe(true)
    const uncertainClaim = execution.claimExecution({ sessionId: session.id, turnId: 'uncertain-turn', ownerId: 'uncertain-owner' })
    expect(uncertainClaim).toMatchObject({ acquired: true })
    if (!uncertainClaim.acquired) throw new Error('expected uncertain execution claim')
    expect(execution.markExecutionUncertain({ sessionId: session.id, turnId: 'uncertain-turn', ownerId: 'uncertain-owner', generation: uncertainClaim.generation })).toBe(true)
    expect(execution.readTranscriptState(session.id).status).toBe('commit_uncertain')
  })

  it('commits the trusted execution config only while the issued selection fence is current', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'config fence', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'config-user', sessionId: session.id, role: 'user', content: 'input', timestamp: 1, status: 'sent' },
      { id: 'config-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' }
    ])
    createPersistedTurn(db, {
      turnId: 'config-turn', requestId: 'config-request', sessionId: session.id,
      assistantMessageId: 'config-assistant', userMessageId: 'config-user', state: 'configuring', startToken: 'config-token'
    })
    const storage = createSqliteSessionStorage(db)
    const selection = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'config-user' })

    expect(storage.execution.commitExecutionConfig({
      ref: { sessionId: session.id, turnId: 'config-turn' },
      config: { lane: 'desktop', model: 'trusted-model' },
      intentFingerprint: 'trusted-intent',
      fence: selection.fence
    })).toBe(true)
    expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'config-turn' }))
      .toMatchObject({ state: 'prepared', executionConfig: { model: 'trusted-model' } })
  })

  it('does not commit execution config after the selected session messages change', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'stale config fence', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'stale-user', sessionId: session.id, role: 'user', content: 'input', timestamp: 1, status: 'sent' },
      { id: 'stale-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' }
    ])
    createPersistedTurn(db, {
      turnId: 'stale-turn', requestId: 'stale-request', sessionId: session.id,
      assistantMessageId: 'stale-assistant', userMessageId: 'stale-user', state: 'configuring', startToken: 'stale-token'
    })
    const storage = createSqliteSessionStorage(db)
    const selection = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'stale-user' })
    appendMessage(db, { id: 'changed-after-selection', sessionId: session.id, role: 'user', content: 'new input', timestamp: 3, status: 'sent' })

    expect(storage.execution.commitExecutionConfig({
      ref: { sessionId: session.id, turnId: 'stale-turn' },
      config: { lane: 'desktop', model: 'trusted-model' },
      intentFingerprint: 'trusted-intent',
      fence: selection.fence
    })).toBe(false)
    expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'stale-turn' })?.state).toBe('configuring')
  })

  it('fails a configuring turn through the execution port without overwriting another session', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'fail config', model: 'test' })
    appendMessage(db, { id: 'failed-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'failed-turn', requestId: 'failed-request', sessionId: session.id,
      assistantMessageId: 'failed-assistant', state: 'configuring', startToken: 'failed-token'
    })
    const execution = createSqliteSessionStorage(db).execution

    expect(execution.failConfiguring({
      ref: { sessionId: session.id, turnId: 'failed-turn' }, version: 1,
      error: { code: 'configuration-failed', message: 'invalid config' }
    })).toBe(true)
    expect(execution.failConfiguring({
      ref: { sessionId: 'other-session', turnId: 'failed-turn' }, version: 2,
      error: { code: 'configuration-failed', message: 'wrong owner' }
    })).toBe(false)
    expect(execution.readTurn({ sessionId: session.id, turnId: 'failed-turn' }))
      .toMatchObject({ state: 'terminal', outcome: 'failed', error: { code: 'configuration-failed' } })
  })

  it('atomically enqueues continuation text and its idempotency intent through execution storage', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation queue', model: 'test' })
    const storage = createSqliteSessionStorage(db)
    const enqueueContinuation = (storage.execution as unknown as {
      enqueueContinuation(input: {
        enqueue: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }
        intent: { payloadSha256: string; rawText: string; attachments?: Message['attachments']; intentKind: 'exact-continue' | 'follow-up'; route: string; source?: { invocationId: string; turnId: string; sequence?: number }; context?: Record<string, unknown> }
      }): { receipt: { requestId: string }; persisted: { message: Message; sequence: number }; duplicate: boolean }
    }).enqueueContinuation

    const accepted = enqueueContinuation({
      enqueue: { sessionId: session.id, requestId: 'continuation-queue-1', content: 'continue the task', attachments: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png' } as never] },
      intent: { payloadSha256: 'a'.repeat(64), rawText: 'continue the task', intentKind: 'follow-up', route: 'context-queue', source: { invocationId: 'source-invocation', turnId: 'source-turn', sequence: 9 }, context: { summary: 'source summary' } }
    })

    expect(accepted).toMatchObject({ duplicate: false, receipt: { requestId: 'continuation-queue-1' }, persisted: { message: { status: 'queued', content: 'continue the task', attachments: [{ id: 'image-1' }] } } })
    expect(getDbConnection(db).prepare('SELECT session_id,payload_sha256,raw_text,intent_kind,route,source_invocation_id,source_turn_id,source_sequence,target_id,status,continuation_context_json FROM continuation_intents WHERE request_id=?').get('continuation-queue-1'))
      .toEqual({ session_id: session.id, payload_sha256: 'a'.repeat(64), raw_text: 'continue the task', intent_kind: 'follow-up', route: 'context-queue', source_invocation_id: 'source-invocation', source_turn_id: 'source-turn', source_sequence: 9, target_id: accepted.persisted.message.id, status: 'queued', continuation_context_json: JSON.stringify({ summary: 'source summary' }) })

    expect(enqueueContinuation({
      enqueue: { sessionId: session.id, requestId: 'continuation-queue-1', content: 'continue the task', attachments: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png' } as never] },
      intent: { payloadSha256: 'a'.repeat(64), rawText: 'continue the task', intentKind: 'follow-up', route: 'context-queue' }
    })).toMatchObject({ duplicate: true, persisted: { message: { id: accepted.persisted.message.id } } })
    expect(() => enqueueContinuation({
      enqueue: { sessionId: session.id, requestId: 'continuation-queue-1', content: 'changed text' },
      intent: { payloadSha256: 'c'.repeat(64), rawText: 'changed text', intentKind: 'follow-up', route: 'ordinary-queue' }
    })).toThrow('CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT')

    getDbConnection(db).prepare("UPDATE continuation_intents SET status='accepted_turn',target_id='accepted-turn' WHERE request_id=?").run('continuation-queue-1')
    enqueueContinuation({
      enqueue: { sessionId: session.id, requestId: 'continuation-queue-1', content: 'continue the task', attachments: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png' } as never] },
      intent: { payloadSha256: 'a'.repeat(64), rawText: 'continue the task', intentKind: 'follow-up', route: 'context-queue' }
    })
    expect(getDbConnection(db).prepare('SELECT status,target_id FROM continuation_intents WHERE request_id=?').get('continuation-queue-1'))
      .toEqual({ status: 'accepted_turn', target_id: 'accepted-turn' })

    getDbConnection(db).exec(`CREATE TRIGGER reject_continuation_intent BEFORE INSERT ON continuation_intents BEGIN SELECT RAISE(ABORT, 'injected continuation intent failure'); END`)
    expect(() => enqueueContinuation({
      enqueue: { sessionId: session.id, requestId: 'continuation-queue-rollback', content: 'must roll back' },
      intent: { payloadSha256: 'b'.repeat(64), rawText: 'must roll back', intentKind: 'follow-up', route: 'context-queue' }
    })).toThrow('injected continuation intent failure')
    expect(getDbConnection(db).prepare('SELECT id FROM messages WHERE session_id=? AND content=?').get(session.id, 'must roll back')).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT request_id FROM queue_input_requests WHERE session_id=? AND request_id=?').get(session.id, 'continuation-queue-rollback')).toBeUndefined()
  })

  it('scopes injected SDK History reads to the owning session', async () => {
    db = createMemoryAppDb()
    const owner = createSession(db, { name: 'history owner', model: 'test' })
    const other = createSession(db, { name: 'other history scope', model: 'test' })
    const storage = createSqliteSessionStorage(db)
    expect(() => storage.execution.historyFor({ sessionId: '   ' })).toThrow('SESSION_SCOPE_REQUIRED')
    const ownerHistory = storage.execution.historyFor({ sessionId: owner.id })
    await ownerHistory.appendBatch([{
      invocationId: 'scoped-history-invocation', turnId: 'scoped-history-turn', sequence: 1, schemaVersion: 1,
      eventId: 'scoped-history-event', idempotencyKey: 'scoped-history-key', kind: 'session-input-committed', payload: { messageId: 'input' }
    }], 0)

    await expect(ownerHistory.read('scoped-history-invocation')).resolves.toMatchObject({ invocationId: 'scoped-history-invocation', version: 1 })
    await expect(storage.execution.historyFor({ sessionId: other.id }).read('scoped-history-invocation'))
      .rejects.toThrow('does not belong to session')
    await expect(ownerHistory.readLatestInvocationForSession(other.id)).rejects.toThrow('SESSION_SCOPE_MISMATCH')
    await expect(ownerHistory.readLatestInvocationForSession(owner.id)).resolves.toMatchObject({ kind: 'unavailable', invocationId: 'scoped-history-invocation' })
  })

  it('inspects failed continuation sources and preserves the session task boundary', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation sources', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'failed-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 1, status: 'failed' },
      { id: 'newer-user', sessionId: session.id, role: 'user', content: 'newer task', timestamp: 2, status: 'sent' }
    ])
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'failed-invocation', turnId: 'failed-turn', sequence: 1, schemaVersion: 1, eventId: 'failed-event-1', idempotencyKey: 'failed-key-1', kind: 'session-input-committed', payload: { requiredUserMessage: { message: { content: 'task' } } } },
      { invocationId: 'failed-invocation', turnId: 'failed-turn', sequence: 2, schemaVersion: 1, eventId: 'failed-event-2', idempotencyKey: 'failed-key-2', kind: 'invocation-failed', payload: { status: 'failed', message: 'failed' } }
    ], 0)
    const turn = getDbConnection(db).prepare('INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    turn.run('failed-turn', 'failed-invocation', session.id, 'failed-assistant', 'failed', 1, 1)

    const inspection = createSqliteSessionStorage(db).queries.continuationSources.inspect({ sessionId: session.id, activeTurnIds: [] })
    expect(inspection).toMatchObject({ kind: 'available', boundary: 'newer-input', failedCandidates: [] })
    if (inspection.kind === 'available') expect(inspection.fallback).toBeUndefined()
  })

  it('returns explicit selected candidates and treats a running latest invocation as superseding failed work', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation selection', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'candidate-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 1, status: 'failed' },
      { id: 'running-assistant', sessionId: session.id, role: 'assistant', content: 'running', timestamp: 2, status: 'streaming' }
    ])
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'failed-invocation-2', turnId: 'candidate-turn', sequence: 1, schemaVersion: 1, eventId: 'candidate-1', idempotencyKey: 'candidate-key-1', kind: 'invocation-context-committed', payload: { messages: [] } },
      { invocationId: 'failed-invocation-2', turnId: 'candidate-turn', sequence: 2, schemaVersion: 1, eventId: 'candidate-2', idempotencyKey: 'candidate-key-2', kind: 'invocation-failed', payload: { status: 'failed' } }
    ], 0)
    const insertTurn = getDbConnection(db).prepare('INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    insertTurn.run('candidate-turn', 'failed-invocation-2', session.id, 'candidate-assistant', 'terminal', 1, 1)
    const queries = createSqliteSessionStorage(db).queries
    const selected = queries.continuationSources.inspect({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'candidate-assistant' })
    expect(selected).toMatchObject({ kind: 'available', selected: { kind: 'found', candidate: { source: { invocationId: 'failed-invocation-2' } } } })
    await history.appendBatch([
      { invocationId: 'running-invocation', turnId: 'running-turn', sequence: 1, schemaVersion: 1, eventId: 'running-1', idempotencyKey: 'running-key-1', kind: 'invocation-context-committed', payload: { messages: [] } }
    ], 0)
    const running = queries.continuationSources.inspect({ sessionId: session.id, activeTurnIds: ['running-turn'] })
    expect(running).toMatchObject({ kind: 'available', boundary: 'running-turn-superseded', failedCandidates: [] })
  })

  it('returns the unique legacy fallback only when the latest user predates the failed assistant', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation fallback candidate', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'fallback-user', sessionId: session.id, role: 'user', content: 'task', timestamp: 1, status: 'sent' },
      { id: 'fallback-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 2, status: 'failed' }
    ])
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'fallback-invocation', turnId: 'fallback-turn', sequence: 1, schemaVersion: 1, eventId: 'fallback-context', idempotencyKey: 'fallback-context', kind: 'invocation-context-committed', payload: { messages: [{ id: 'fallback-user', role: 'user', content: 'task', timestamp: 1 }], requiredUserMessage: { id: 'fallback-user', message: { id: 'fallback-user', role: 'user', content: 'task', timestamp: 1 } } } },
      { invocationId: 'fallback-invocation', turnId: 'fallback-turn', sequence: 2, schemaVersion: 1, eventId: 'fallback-failed', idempotencyKey: 'fallback-failed', kind: 'invocation-failed', payload: { status: 'failed' } }
    ], 0)
    await history.appendBatch([
      { invocationId: 'newer-completed-invocation', turnId: 'newer-completed-turn', sequence: 1, schemaVersion: 1, eventId: 'newer-completed', idempotencyKey: 'newer-completed', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    getDbConnection(db).prepare('INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('fallback-turn', 'fallback-invocation', session.id, 'fallback-assistant', 'terminal', 1, 1)

    const queries = createSqliteSessionStorage(db).queries.continuationSources
    const inspection = queries.inspect({ sessionId: session.id, activeTurnIds: [] })
    expect(inspection).toMatchObject({ kind: 'available', fallback: { source: { invocationId: 'fallback-invocation', turnId: 'fallback-turn' }, assistantMessageId: 'fallback-assistant' } })
    expect(queries.inspect({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'fallback-assistant' }))
      .toMatchObject({ kind: 'available', selected: { kind: 'found', candidate: { source: { invocationId: 'fallback-invocation' } } }, selectedFallback: { source: { invocationId: 'fallback-invocation' } } })
  })

  it('keeps explicit assistant selection session-scoped and distinguishes completed work as not recoverable', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation explicit nonrecoverable', model: 'test' })
    const other = createSession(db, { name: 'continuation explicit other session', model: 'test' })
    appendMessage(db, { id: 'completed-assistant', sessionId: session.id, role: 'assistant', content: 'done', timestamp: 1, status: 'completed' })
    appendMessage(db, { id: 'other-assistant', sessionId: other.id, role: 'assistant', content: 'failed elsewhere', timestamp: 2, status: 'failed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'completed-invocation', turnId: 'completed-turn', sequence: 1, schemaVersion: 1, eventId: 'completed-event', idempotencyKey: 'completed-key', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    getDbConnection(db).prepare('INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('completed-turn', 'completed-invocation', session.id, 'completed-assistant', 'terminal', 1, 1)

    const queries = createSqliteSessionStorage(db).queries.continuationSources
    expect(queries.inspect({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'completed-assistant' }))
      .toMatchObject({ kind: 'available', selected: { kind: 'not-recoverable' } })
    expect(queries.inspect({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'other-assistant' }))
      .toMatchObject({ kind: 'available', selected: { kind: 'not-found' } })
  })

  it('marks a latest open History stream unavailable unless it belongs to a running turn', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'unavailable continuation', model: 'test' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'open-invocation', turnId: 'open-turn', sequence: 1, schemaVersion: 1, eventId: 'open-1', idempotencyKey: 'open-key-1', kind: 'invocation-context-committed', payload: { messages: [] } }
    ], 0)
    expect(createSqliteSessionStorage(db).queries.continuationSources.inspect({ sessionId: session.id, activeTurnIds: [] }))
      .toEqual({ kind: 'unavailable', reason: 'CONTINUATION_INTENT_HISTORY_UNAVAILABLE' })
  })

  it('treats a recovered interrupted invocation as a usable continuation source', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'interrupted continuation source', model: 'test' })
    appendMessage(db, { id: 'interrupted-assistant', sessionId: session.id, role: 'assistant', content: 'interrupted', timestamp: 1, status: 'failed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'interrupted-invocation', turnId: 'interrupted-turn', sequence: 1, schemaVersion: 1, eventId: 'interrupted-context', idempotencyKey: 'interrupted-context', kind: 'invocation-context-committed', payload: { messages: [] } },
      { invocationId: 'interrupted-invocation', turnId: 'interrupted-turn', sequence: 2, schemaVersion: 1, eventId: 'interrupted-terminal', idempotencyKey: 'interrupted-terminal', kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } }
    ], 0)
    getDbConnection(db).prepare('INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('interrupted-turn', 'interrupted-invocation', session.id, 'interrupted-assistant', 'terminal', 1, 1)

    expect(createSqliteSessionStorage(db).queries.continuationSources.inspect({ sessionId: session.id, activeTurnIds: [] }))
      .toMatchObject({ kind: 'available', failedCandidates: [{ source: { invocationId: 'interrupted-invocation', turnId: 'interrupted-turn', checkpointSequence: 1 } }] })
  })
})

describe('SQLite session storage execution boundary', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('prepares a turn atomically through the named execution method', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'execution prepare', model: 'test' })
    const storage = createSqliteSessionStorage(db)

    const prepared = storage.execution.prepareTurn({
      user: { id: 'execution-prepare-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' },
      assistant: { id: 'execution-prepare-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'execution-prepare-turn', requestId: 'execution-prepare-request', sessionId: session.id, assistantMessageId: 'execution-prepare-assistant', state: 'prepared' }
    })

    expect(prepared.user.message.id).toBe('execution-prepare-user')
    expect(prepared.assistant.message.id).toBe('execution-prepare-assistant')
    expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'execution-prepare-turn' }))
      .toMatchObject({ userMessageId: 'execution-prepare-user', assistantMessageId: 'execution-prepare-assistant', state: 'prepared' })
  })

  it('commits continuation acceptance with a prepared turn through the execution hook', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'execution prepare acceptance', model: 'test' })
    const storage = createSqliteSessionStorage(db)

    storage.execution.prepareTurn({
      user: { id: 'acceptance-user', sessionId: session.id, role: 'user', content: 'continue', timestamp: 1, status: 'sent' },
      assistant: { id: 'acceptance-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'acceptance-turn', requestId: 'acceptance-request', sessionId: session.id, assistantMessageId: 'acceptance-assistant', state: 'prepared' },
      acceptance: { payloadSha256: '1'.repeat(64), rawText: 'continue', kind: 'follow-up', route: 'context-turn', sourceInvocationId: 'source-invocation', sourceTurnId: 'source-turn', sourceSequence: 8 }
    })

    expect(storage.execution.readContinuationIntent({ requestId: 'acceptance-request', sessionId: session.id }))
      .toMatchObject({ payloadSha256: '1'.repeat(64), route: 'context-turn', targetId: 'acceptance-turn', status: 'accepted_turn' })
  })

  it('claims a queued turn atomically through the named execution method', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'execution claim', model: 'test' })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'execution-claim-request', content: 'queued question' })
    const storage = createSqliteSessionStorage(db)

    const claimed = storage.execution.claimQueuedTurn({
      sessionId: session.id, userMessageId: queued.persisted.message.id, turnId: 'execution-claim-turn',
      assistantMessageId: 'execution-claim-assistant', requestId: 'execution-claim-request', startToken: 'claim-token'
    })

    expect(claimed.user.message).toMatchObject({ id: queued.persisted.message.id, status: 'sent' })
    expect(claimed.assistant.message).toMatchObject({ id: 'execution-claim-assistant', status: 'streaming' })
    expect(getPersistedTurn(db, 'execution-claim-turn')).toMatchObject({ userMessageId: queued.persisted.message.id, state: 'prepared' })
    expect(getQueueInputReceipt(db, session.id, 'execution-claim-request')).toMatchObject({ state: 'claimed', turnId: 'execution-claim-turn' })
  })

  it('reads a continuation intent only through its session and request identity', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'execution continuation receipt', model: 'test' })
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,target_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('intent-request', session.id, 'a'.repeat(64), 'continue', '[]', 'follow-up', 'context-turn', 'target-turn', 'accepted_turn', 1, 1)
    const execution = createSqliteSessionStorage(db).execution

    expect(execution.readContinuationIntent({ requestId: 'intent-request', sessionId: session.id })).toEqual({
      requestId: 'intent-request', sessionId: session.id, payloadSha256: 'a'.repeat(64), route: 'context-turn',
      targetId: 'target-turn', status: 'accepted_turn'
    })
    expect(execution.readContinuationIntent({ requestId: 'intent-request', sessionId: 'other-session' })).toBeUndefined()
    expect(execution.readContinuationIntent({ requestId: 'missing-request', sessionId: session.id })).toBeUndefined()
  })

  it('resolves persisted continuation acceptance and fails closed on missing or mismatched targets', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'resolve continuation acceptance', model: 'test' })
    const execution = createSqliteSessionStorage(db).execution
    const conn = getDbConnection(db)
    const payloadSha256 = 'b'.repeat(64)
    conn.prepare(`INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,target_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('resolve-intent-request', session.id, payloadSha256, 'question', '[]', 'follow-up', 'ordinary-queue', 'queued-message', 'queued', 1, 1)
    const queued = appendMessage(db, { id: 'queued-message', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'queued' })

    expect(execution.resolveContinuationAcceptance({ requestId: 'resolve-intent-request', sessionId: session.id, payloadSha256 }))
      .toMatchObject({ kind: 'queued', message: { message: { id: queued.message.id, status: 'queued' }, sequence: queued.sequence } })
    expect(execution.resolveContinuationAcceptance({ requestId: 'resolve-intent-request', sessionId: session.id, payloadSha256: 'c'.repeat(64) }))
      .toMatchObject({ kind: 'unresolved', reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' })
    expect(execution.resolveContinuationAcceptance({ requestId: 'resolve-intent-request', sessionId: session.id, payloadSha256: 'd'.repeat(64) }))
      .toMatchObject({ kind: 'unresolved', reason: 'CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT' })

    conn.prepare("UPDATE continuation_intents SET target_id='missing-queued-message' WHERE request_id=?").run('resolve-intent-request')
    expect(execution.resolveContinuationAcceptance({ requestId: 'resolve-intent-request', sessionId: session.id, payloadSha256 }))
      .toMatchObject({ kind: 'unresolved', reason: 'CONTINUATION_INTENT_COMMIT_UNCERTAIN' })
  })

  it('ensures a continuation status message once with its deterministic identity', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'status message command', model: 'test' })
    const execution = createSqliteSessionStorage(db).execution

    const first = execution.ensureContinuationStatusMessage({ requestId: 'status-message-request', sessionId: session.id })
    const second = execution.ensureContinuationStatusMessage({ requestId: 'status-message-request', sessionId: session.id })

    expect(second).toEqual(first)
    expect(first.message).toMatchObject({ role: 'system', skillHints: [{ status: 'continuation-started' }] })
    expect(first.sequence).toBe(0)
  })

  it('records source-selection and explicit ordinary continuation states idempotently', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation selection commands', model: 'test' })
    const execution = createSqliteSessionStorage(db).execution
    const input = { requestId: 'selection-request', sessionId: session.id, text: '继续', payloadSha256: 'e'.repeat(64), intentKind: 'exact-continue' as const }

    expect(execution.requireContinuationSourceSelection(input)).toMatchObject({ status: 'needs_source_selection', route: 'needs-source-selection' })
    expect(execution.selectOrdinaryContinuation(input)).toMatchObject({ status: 'ordinary_fallback_pending', route: 'ordinary-selected' })
    expect(execution.readContinuationIntent({ requestId: input.requestId, sessionId: session.id })).toMatchObject({ status: 'ordinary_fallback_pending' })
    expect(execution.rejectContinuationIntent({ ...input, reason: 'CONTINUATION_SOURCE_STALE', status: 'rejected_retryable' }))
      .toMatchObject({ status: 'rejected_retryable', rejectionReason: 'CONTINUATION_SOURCE_STALE' })
  })

  it('exposes atomic continuation enqueue through the named acceptance method', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation enqueue named', model: 'test' })
    const execution = createSqliteSessionStorage(db).execution
    const payloadSha256 = 'f'.repeat(64)

    const queued = execution.enqueueAndRecordContinuation({
      enqueue: { sessionId: session.id, requestId: 'named-enqueue-request', content: 'continue' },
      intent: { payloadSha256, rawText: 'continue', intentKind: 'follow-up', route: 'ordinary-queue' }
    })

    expect(queued).toMatchObject({ duplicate: false, receipt: { requestId: 'named-enqueue-request', state: 'queued' }, persisted: { message: { status: 'queued', content: 'continue' } } })
    expect(execution.readContinuationIntent({ requestId: 'named-enqueue-request', sessionId: session.id })).toMatchObject({ payloadSha256, route: 'ordinary-queue', targetId: queued.persisted.message.id, status: 'queued' })
  })

  it('binds a started continuation turn and rejects a conflicting accepted target', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'bind started continuation', model: 'test' })
    const storage = createSqliteSessionStorage(db)
    const acceptance = { requestId: 'bind-request', sessionId: session.id, text: 'continue', payloadSha256: '2'.repeat(64), intentKind: 'follow-up' as const }
    storage.execution.requireContinuationSourceSelection(acceptance)
    appendMessage(db, { id: 'bind-user', sessionId: session.id, role: 'user', content: 'continue', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'bind-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'bind-turn', requestId: acceptance.requestId, sessionId: session.id, userMessageId: 'bind-user', assistantMessageId: 'bind-assistant', state: 'prepared' })

    expect(storage.execution.bindStartedContinuationTurn({ ...acceptance, route: 'context-turn', turnId: 'bind-turn', retrySource: { assistantMessageId: 'failed-assistant', invocationId: 'failed-invocation' } }))
      .toMatchObject({ status: 'accepted_turn', targetId: 'bind-turn' })
    expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'bind-turn' })).toMatchObject({ retryOfMessageId: 'failed-assistant', retryOfInvocationId: 'failed-invocation' })
    expect(() => storage.execution.bindStartedContinuationTurn({ ...acceptance, route: 'context-turn', turnId: 'different-turn' }))
      .toThrow('CONTINUATION_INTENT_TARGET_CONFLICT')
  })

  it('binds an exact continuation turn after prepare while preserving its turn target kind', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'bind exact continuation', model: 'test' })
    const storage = createSqliteSessionStorage(db)
    const payloadSha256 = '3'.repeat(64)
    storage.execution.prepareTurn({
      user: { id: 'exact-user', sessionId: session.id, role: 'user', content: '继续', timestamp: 1, status: 'sent' },
      assistant: { id: 'exact-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
      turn: { turnId: 'exact-turn', requestId: 'exact-request', sessionId: session.id, assistantMessageId: 'exact-assistant', state: 'prepared' },
      acceptance: { payloadSha256, rawText: '继续', kind: 'exact-continue', route: 'ordinary' }
    })

    expect(storage.execution.bindExactContinueTurn({ requestId: 'exact-request', sessionId: session.id, text: '继续', payloadSha256, turnId: 'exact-turn' }))
      .toMatchObject({ route: 'continuation', status: 'accepted_continuation', targetId: 'exact-turn' })
    expect(storage.execution.resolveContinuationAcceptance({ requestId: 'exact-request', sessionId: session.id, payloadSha256 }))
      .toMatchObject({ kind: 'turn', turn: { turnId: 'exact-turn' } })
  })

  it('repairs a missing prepared acceptance only for an existing matching turn', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'repair prepared acceptance', model: 'test' })
    const storage = createSqliteSessionStorage(db)
    appendMessage(db, { id: 'repair-user', sessionId: session.id, role: 'user', content: 'continue', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'repair-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
    createPersistedTurn(db, { turnId: 'repair-turn', requestId: 'repair-request', sessionId: session.id, userMessageId: 'repair-user', assistantMessageId: 'repair-assistant', state: 'prepared' })
    const input = { requestId: 'repair-request', sessionId: session.id, text: 'continue', payloadSha256: '4'.repeat(64), intentKind: 'follow-up' as const, route: 'context-turn', turnId: 'repair-turn' }

    expect(storage.execution.repairPreparedContinuationAcceptance(input)).toMatchObject({ status: 'accepted_turn', targetId: 'repair-turn' })
    expect(storage.execution.repairPreparedContinuationAcceptance(input)).toMatchObject({ status: 'accepted_turn', targetId: 'repair-turn' })
    expect(() => storage.execution.repairPreparedContinuationAcceptance({ ...input, turnId: 'missing-turn' })).toThrow('CONTINUATION_INTENT_COMMIT_UNCERTAIN')
  })

  it('creates, claims, and settles a validated continuation through the execution port', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation execution port', model: 'test' })
    const user = appendMessage(db, { id: 'port-source-user', sessionId: session.id, role: 'user', content: 'start', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'port-source-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 2, status: 'failed' })
    createPersistedTurn(db, { turnId: 'port-source-turn', requestId: 'port-source-invocation', sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id, state: 'terminal', outcome: 'failed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'port-source-invocation', turnId: 'port-source-turn', sequence: 1, schemaVersion: 1, eventId: 'port-context', idempotencyKey: 'port-context', kind: 'invocation-context-committed', payload: { messages: [{ id: user.message.id, role: 'user', content: 'start', timestamp: 1 }], requiredUserMessage: { id: user.message.id, message: { role: 'user', content: 'start', timestamp: 1 } } } },
      { invocationId: 'port-source-invocation', turnId: 'port-source-turn', sequence: 2, schemaVersion: 1, eventId: 'port-response', idempotencyKey: 'port-response', kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'done' } } },
      { invocationId: 'port-source-invocation', turnId: 'port-source-turn', sequence: 3, schemaVersion: 1, eventId: 'port-failed', idempotencyKey: 'port-failed', kind: 'invocation-failed', payload: { status: 'failed', message: 'failed' } }
    ], 0)
    const continuations = createSqliteSessionStorage(db).execution.continuations
    const input = { sessionId: session.id, sourceInvocationId: 'port-source-invocation', requestIdempotencyKey: 'port-continuation-request', createdBy: session.id, frozenConfig: { model: 'test' } }

    const record = continuations.createOrGet(input)
    expect(record).toMatchObject({ sourceInvocationId: input.sourceInvocationId, sourceTurnId: 'port-source-turn', requestIdempotencyKey: input.requestIdempotencyKey, status: 'pending' })
    expect(continuations.claim({ continuationId: record.continuationId, revalidatedFrozenConfig: input.frozenConfig })).toBe(true)
    expect(continuations.settle({ continuationId: record.continuationId, status: 'completed' })).toBe(true)
    expect(continuations.settleForTurn({ targetTurnId: record.targetTurnId, status: 'completed' })).toBe(false)
  })

  it('begins and finalizes a continuation acceptance with its status message atomically', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation finalize port', model: 'test' })
    appendMessage(db, { id: 'final-source-user', sessionId: session.id, role: 'user', content: 'start', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'final-source-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 2, status: 'failed' })
    createPersistedTurn(db, { turnId: 'source-turn', requestId: 'source-invocation', sessionId: session.id, userMessageId: 'final-source-user', assistantMessageId: 'final-source-assistant', state: 'terminal', outcome: 'failed' })
    const execution = createSqliteSessionStorage(db).execution
    const input = { requestId: 'finalize-request', sessionId: session.id, text: '继续', payloadSha256: '5'.repeat(64), intentKind: 'exact-continue' as const, source: { invocationId: 'source-invocation', turnId: 'source-turn', sessionId: session.id, checkpointSequence: 7, expectedHistoryVersion: 8 } }

    expect(execution.beginContinuationIntent(input)).toMatchObject({ status: 'starting_continuation', route: 'continuation' })
    getDbConnection(db).prepare(`INSERT INTO agent_continuations(continuation_id,source_invocation_id,source_turn_id,checkpoint_sequence,checkpoint_sha256,request_idempotency_key,created_by,frozen_config_json,frozen_config_sha256,target_invocation_id,target_turn_id,target_start_token,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('final-continuation', 'source-invocation', 'source-turn', 7, 'a'.repeat(64), input.requestId, session.id, '{}', 'b'.repeat(64), 'target-invocation', 'target-turn', 'target-token', 'running', 1, 1)

    const finalized = execution.finalizeContinuationAcceptance({ requestId: input.requestId, sessionId: session.id, payloadSha256: input.payloadSha256, continuationId: 'final-continuation' })
    expect(finalized.receipt).toMatchObject({ route: 'continuation', status: 'accepted_continuation', targetId: 'final-continuation' })
    expect(finalized.statusMessage.message).toMatchObject({ skillHints: [{ status: 'continuation-started' }] })
    expect(execution.resolveContinuationAcceptance({ requestId: input.requestId, sessionId: session.id, payloadSha256: input.payloadSha256 }))
      .toMatchObject({ kind: 'continuation', continuation: { continuationId: 'final-continuation', requestIdempotencyKey: input.requestId } })
  })

  it('prepares and claims a continuation from a freshly revalidated source checkpoint', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation launch port', model: 'test' })
    const user = appendMessage(db, { id: 'launch-source-user', sessionId: session.id, role: 'user', content: 'start', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'launch-source-assistant', sessionId: session.id, role: 'assistant', content: 'failed', timestamp: 2, status: 'failed' })
    createPersistedTurn(db, { turnId: 'launch-source-turn', requestId: 'launch-source-invocation', sessionId: session.id, userMessageId: user.message.id, assistantMessageId: assistant.message.id, state: 'terminal', outcome: 'failed' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'launch-source-invocation', turnId: 'launch-source-turn', sequence: 1, schemaVersion: 1, eventId: 'launch-context', idempotencyKey: 'launch-context', kind: 'invocation-context-committed', payload: { messages: [{ id: user.message.id, role: 'user', content: 'start', timestamp: 1 }], requiredUserMessage: { id: user.message.id, message: { role: 'user', content: 'start', timestamp: 1 } } } },
      { invocationId: 'launch-source-invocation', turnId: 'launch-source-turn', sequence: 2, schemaVersion: 1, eventId: 'launch-response', idempotencyKey: 'launch-response', kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'done' } } },
      { invocationId: 'launch-source-invocation', turnId: 'launch-source-turn', sequence: 3, schemaVersion: 1, eventId: 'launch-failed', idempotencyKey: 'launch-failed', kind: 'invocation-failed', payload: { status: 'failed', message: 'failed' } }
    ], 0)
    let runtime: TurnRuntime | undefined
    const storage = createSqliteSessionStorage(db, { getTurnRuntime: () => runtime! })
    runtime = new TurnRuntime({ storage: storage.execution.coordinator, deps: { now: () => 10, id: (() => { let id = 0; return () => `launch-${++id}` })() } })
    const snapshot = history.readSync('launch-source-invocation')
    const launch = await storage.execution.continuationLaunch.prepareAndClaim({
      payload: { requestId: 'launch-request', sessionId: session.id, text: '继续' },
      source: { sessionId: session.id, invocationId: snapshot.invocationId, turnId: 'launch-source-turn', checkpointSequence: 2, expectedHistoryVersion: snapshot.version },
      createdBy: session.id, frozenConfig: { model: 'test' }, executionConfig: { lane: 'desktop', model: 'test' },
      acceptance: { payloadSha256: '6'.repeat(64), rawText: '继续', intentKind: 'exact-continue', route: 'continuation' }
    })

    expect(launch.started).toBe(true)
    expect(launch.continuation).toMatchObject({ status: 'running', sourceInvocationId: snapshot.invocationId, checkpointSequence: 2 })
    expect(launch.turn).toMatchObject({ turnId: launch.continuation.targetTurnId, requestId: launch.continuation.targetInvocationId })
    expect(storage.execution.readContinuationIntent({ requestId: 'launch-request', sessionId: session.id })).toMatchObject({ status: 'accepted_continuation', targetId: launch.continuation.continuationId })
    await expect(storage.execution.continuationLaunch.prepareAndClaim({
      payload: { requestId: 'stale-launch-request', sessionId: session.id, text: '继续' },
      source: { sessionId: session.id, invocationId: snapshot.invocationId, turnId: 'launch-source-turn', checkpointSequence: 2, expectedHistoryVersion: snapshot.version - 1 },
      createdBy: session.id, frozenConfig: { model: 'test' }, executionConfig: { lane: 'desktop', model: 'test' },
      acceptance: { payloadSha256: '7'.repeat(64), rawText: '继续', intentKind: 'exact-continue', route: 'continuation' }
    })).rejects.toThrow('CONTINUATION_SOURCE_STALE')
    expect(getDbConnection(db).prepare('SELECT 1 FROM agent_continuations WHERE request_idempotency_key=?').get('stale-launch-request')).toBeUndefined()
  })
})
