import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { appendMessage, appendMessagesAtomically, createPersistedTurn, createSession, enqueueQueuedUserMessage, enqueueQueuedUserMessageInScope, getPersistedTurn, getQueueInputReceipt, getSession, setConfigValue, updateMessageContent, updatePersistedTurnState } from '../database/operations'
import { getDbConnection, openDatabase } from '../database'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { runInTransaction } from '../database/transaction'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { createSessionTurnRuntime, createSqliteSessionStorage } from './sqliteSessionStorage'
import { encodeChatBodyV1 } from './domain/projectionSpec'
import { TurnRuntime } from '../turnRuntime'
import { bindSessionStorageContextPort, createBoundSessionContextAdapter } from './contextPortRegistry'
import { buildToolChatMessagesFromSource } from '../chatMessageBuild'
import { computeReplaySurfaceFingerprint, projectReplaySurface, projectReplaySurfaceWithSources } from '../../src/shared/surfaceReplay'
import { computeCompactionSummaryHash } from '../../src/shared/compactionEvents'
import { getProjectedMessages, readSessionTranscriptProjection } from './infrastructure/sqlite/sessionTranscriptProjection'
import * as sessionTranscriptProjection from './infrastructure/sqlite/sessionTranscriptProjection'
import { drainCanonicalLedgerProjectionOutbox, enqueueCanonicalLedgerProjectionTargetInTransaction, listPendingCanonicalLedgerProjectionTargets } from '../sessionLedgerOutbox'
import { getSessionEventSink, readSessionEvents, resolveSessionEventPaths } from '../sessionEvents'
import { ensureSessionLedgerReady } from '../sessionLedgerLifecycle'
import { createProductionSessionLedgerLifecycleDependencies } from '../runtime/sessionLedgerLifecycleProduction'
import { projectCanonicalSessionLedgerTarget } from '../runtime/sessionLedgerOutboxProjector'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { compactSessionContext } from '../sessionContextCompaction'

describe('SQLite session storage public queries', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('keeps raw TurnStorage private to host composition', () => {
    db = createMemoryAppDb()
    const storage = createSqliteSessionStorage(db)

    expect('coordinator' in storage.execution).toBe(false)
  })

  it('reads persisted turn state by request through the public query port', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'turn status query' })
    appendMessage(db, { id: 'turn-status-assistant', sessionId: session.id, role: 'assistant', content: 'done', timestamp: 1, status: 'completed' })
    createPersistedTurn(db, { turnId: 'turn-status-turn', requestId: 'turn-status-request', sessionId: session.id,
      assistantMessageId: 'turn-status-assistant', state: 'terminal', outcome: 'completed' })
    const storage = createSqliteSessionStorage(db)

    expect(storage.queries.readTurnByRequest({ sessionId: session.id, requestId: 'turn-status-request' }))
      .toMatchObject({ turnId: 'turn-status-turn', sessionId: session.id, requestId: 'turn-status-request', state: 'terminal', outcome: 'completed' })
    expect(storage.queries.readTurnByRequest({ sessionId: session.id, requestId: 'missing' })).toBeUndefined()
  })

  it('counts queued user messages from the message index without loading transcript bodies', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'queued count query' })
    appendMessage(db, { id: 'queued-count-user', sessionId: session.id, role: 'user', content: 'queued', timestamp: 1, status: 'queued' })
    appendMessage(db, { id: 'queued-count-assistant', sessionId: session.id, role: 'assistant', content: 'ignored', timestamp: 2, status: 'queued' })
    appendMessage(db, { id: 'queued-count-sent', sessionId: session.id, role: 'user', content: 'sent', timestamp: 3, status: 'sent' })
    const storage = createSqliteSessionStorage(db)
    const transcriptRead = vi.spyOn(sessionTranscriptProjection, 'getProjectedMessages').mockImplementation(() => {
      throw new Error('QUEUE_COUNT_MUST_NOT_READ_TRANSCRIPT_BODIES')
    })
    const countQueuedMessages = (storage.queries as unknown as { countQueuedMessages?: (sessionId: string) => number }).countQueuedMessages

    expect(countQueuedMessages).toBeTypeOf('function')
    expect(countQueuedMessages?.(session.id)).toBe(1)
    expect(transcriptRead).not.toHaveBeenCalled()
    transcriptRead.mockRestore()
  })

  it('reads request header and context facts from canonical History when the JSONL ledger is absent', async () => {
    const temp = createTempDatabase('session-context-meter-canonical-')
    const workDir = path.join(path.dirname(temp.dbPath), 'context-meter-ledger')
    fs.mkdirSync(workDir, { recursive: true })
    try {
      db = temp.db
      const session = createSession(db, { name: 'canonical ContextMeter facts' })
      const storage = createSqliteSessionStorage(db, { getWorkDirForSession: () => workDir })
      const requestId = 'context-meter-request-1'
      const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
      const requestHeader = { schemaVersion: 1, requestId, attempt: 1, turnId: 'context-meter-turn', modelTurn: 1,
        surfaceSnapshot: { schemaVersion: 1, fingerprint: 'surface-one', systemFingerprint: 'system-one', toolsFingerprint: 'tools-one', surfaceTokens: 100, systemTokens: 10, toolsTokens: 10, messageTokens: 80 } }
      const requestContext = { schemaVersion: 1, requestId, attempt: 1, contextWindow: { tokens: 120_000 }, provider: 'test-provider', model: 'test-model',
        budget: { estimatorVersion: 'estimate-v1', serializationVersion: 'serialization-v1' } }
      const history = storage.execution.historyFor({ sessionId: session.id })
      await history.appendBatch([{
        invocationId: 'context-meter-invocation', turnId: 'context-meter-turn', sequence: 1, schemaVersion: 1,
        eventId: 'context-meter-request-start', idempotencyKey: 'context-meter-request-start', kind: 'model-request-started',
        payload: { requestId, modelTurn: 1, attempt: 1, sessionLedger: { location, requestHeader, requestContext } }
      }], 0)
      const retryPayload = { requestId: 'context-meter-request-1', attempt: 2, turnId: 'context-meter-turn', stepId: 'context-meter-invocation', code: 'provider_context_overflow', backoffMs: 0 }
      await history.appendBatch([{
        invocationId: 'context-meter-retry', turnId: 'context-meter-turn', sequence: 1, schemaVersion: 1,
        eventId: 'context-meter-retry-event', idempotencyKey: 'context-meter-retry-event', kind: 'provider-retry-scheduled',
        payload: { requestId, modelTurn: 1, retryAttempt: 2, code: 'provider_context_overflow', sessionLedger: { location, requestRetry: retryPayload } }
      }], 0)
      const discardedUsage = { schemaVersion: 1, requestId: 'context-meter-request-1', turnId: 'context-meter-turn', usage: { input_tokens: 110, output_tokens: 8 }, source: 'api' }
      const finalRequestId = 'context-meter-request-2'
      const finalContext = { schemaVersion: 1, requestId: finalRequestId, attempt: 1, contextWindow: { tokens: 120_000 }, provider: 'test-provider', model: 'test-model',
        budget: { estimatorVersion: 'estimate-v1', serializationVersion: 'serialization-v1' } }
      const finalUsage = { schemaVersion: 1, requestId: finalRequestId, turnId: 'context-meter-turn', usage: { input_tokens: 90, output_tokens: 12 }, source: 'api' }
      await history.appendBatch([
        { invocationId: 'context-meter-usage', turnId: 'context-meter-turn', sequence: 1, schemaVersion: 1,
          eventId: 'context-meter-discarded-usage', idempotencyKey: 'context-meter-discarded-usage', kind: 'model-attempt-discarded',
          payload: { modelTurn: 1, attempt: 1, reasonCode: 'CONTEXT_OVERFLOW', sessionLedger: { location, requestUsage: discardedUsage } } },
        { invocationId: 'context-meter-usage', turnId: 'context-meter-turn', sequence: 2, schemaVersion: 1,
          eventId: 'context-meter-final-response', idempotencyKey: 'context-meter-final-response', kind: 'model-response-committed',
          payload: { modelTurn: 1, attempt: 2, message: { role: 'assistant', content: 'done' }, sessionLedger: { location,
            requestUsage: finalUsage, requestContext: finalContext } } }
      ], 0)

      const events = await storage.readContextMeterEvents({ sessionId: session.id, workDir })
      expect(events.map(({ type, payload }) => ({ type, payload }))).toEqual([
        { type: 'request_header', payload: requestHeader },
        { type: 'request_context', payload: requestContext },
        { type: 'request_retry', payload: retryPayload },
        { type: 'request_usage', payload: discardedUsage },
        { type: 'request_usage', payload: finalUsage },
        { type: 'request_context', payload: { ...finalContext, projectionStage: 'final' } }
      ])
      expect(events.map(({ seq }) => seq)).toEqual([...events.map(({ seq }) => seq)].sort((left, right) => left - right))
    } finally {
      db?.close()
      db = undefined
      temp.cleanup()
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it.each(['returns false', 'throws'] as const)('reads canonical context meter facts when the session ledger readiness gate %s', async (failureMode) => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'blocked canonical context meter' })
    const workDir = '/tmp/blocked-canonical-context-meter'
    const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
    const requestHeader = { schemaVersion: 1, requestId: 'blocked-meter-request', attempt: 1,
      surfaceSnapshot: { schemaVersion: 1, fingerprint: 'surface', systemFingerprint: 'system', toolsFingerprint: 'tools', surfaceTokens: 1, systemTokens: 0, toolsTokens: 0, messageTokens: 1 } }
    const requestContext = { schemaVersion: 1, requestId: 'blocked-meter-request', attempt: 1, contextWindow: { tokens: 10_000 },
      provider: 'test-provider', model: 'test-model', budget: { estimatorVersion: 'v1', serializationVersion: 'v1' } }
    const storage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => workDir,
      ensureSessionLedgerReady: failureMode === 'returns false' ? async () => false : async () => { throw new Error('injected readiness failure') },
      getSessionEventSink: () => { throw new Error('blocked ledger must not be opened') }
    })
    await storage.execution.historyFor({ sessionId: session.id }).appendBatch([{
      invocationId: 'blocked-meter-invocation', turnId: 'blocked-meter-turn', sequence: 1, schemaVersion: 1,
      eventId: 'blocked-meter-event', idempotencyKey: 'blocked-meter-event', kind: 'model-request-started',
      payload: { requestId: requestHeader.requestId, modelTurn: 1, attempt: 1,
        sessionLedger: { location, requestHeader, requestContext } }
    }], 0)

    await expect(storage.readContextMeterEvents({ sessionId: session.id, workDir })).resolves.toEqual([
      expect.objectContaining({ type: 'request_header', payload: requestHeader }),
      expect.objectContaining({ type: 'request_context', payload: requestContext })
    ])
  })

  it('preserves the ordered JSONL ContextMeter stream while it still contains legacy-only request facts', async () => {
    const temp = createTempDatabase('session-context-meter-mixed-')
    const workDir = path.join(path.dirname(temp.dbPath), 'context-meter-mixed-ledger')
    fs.mkdirSync(workDir, { recursive: true })
    let sink: ReturnType<typeof getSessionEventSink> | undefined
    try {
      db = temp.db
      const session = createSession(db, { name: 'mixed ContextMeter facts' })
      sink = getSessionEventSink(workDir, session.id, session.createdAt)
      const legacyHeader = { schemaVersion: 1, requestId: 'legacy-meter-request', attempt: 1, surfaceSnapshot: { schemaVersion: 1 } }
      const legacyContext = { schemaVersion: 1, requestId: 'legacy-meter-request', attempt: 1, contextWindow: { tokens: 10_000 }, budget: { estimatorVersion: 'v1', serializationVersion: 'v1' } }
      await sink.appendCritical({ type: 'request_header', payload: legacyHeader })
      await sink.appendCritical({ type: 'request_context', payload: legacyContext })
      const storage = createSqliteSessionStorage(db, {
        getWorkDirForSession: () => workDir, getSessionEventSink: () => sink!
      })
      const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
      const canonicalHeader = { schemaVersion: 1, requestId: 'canonical-meter-request', attempt: 1, surfaceSnapshot: { schemaVersion: 1 } }
      const canonicalContext = { schemaVersion: 1, requestId: 'canonical-meter-request', attempt: 1, contextWindow: { tokens: 10_000 }, budget: { estimatorVersion: 'v1', serializationVersion: 'v1' } }
      await storage.execution.historyFor({ sessionId: session.id }).appendBatch([{
        invocationId: 'canonical-meter-invocation', turnId: 'canonical-meter-turn', sequence: 1, schemaVersion: 1,
        eventId: 'canonical-meter-start', idempotencyKey: 'canonical-meter-start', kind: 'model-request-started',
        payload: { requestId: canonicalHeader.requestId, modelTurn: 1, attempt: 1, sessionLedger: { location, requestHeader: canonicalHeader, requestContext: canonicalContext } }
      }], 0)
      await sink.appendCritical({ type: 'request_header', payload: canonicalHeader })
      await sink.appendCritical({ type: 'request_context', payload: canonicalContext })

      const events = await storage.readContextMeterEvents({ sessionId: session.id, workDir })
      expect(events.map(({ type, payload }) => ({ type, payload }))).toEqual([
        { type: 'request_header', payload: legacyHeader }, { type: 'request_context', payload: legacyContext },
        { type: 'request_header', payload: canonicalHeader }, { type: 'request_context', payload: canonicalContext }
      ])
    } finally {
      await sink?.close()
      db?.close()
      db = undefined
      temp.cleanup()
      fs.rmSync(workDir, { recursive: true, force: true })
    }
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
    expect(storage.queries.readMessageSkeleton({ sessionId: session.id, messageId: 'message-2' })).toEqual({
      id: 'message-2', sessionId: session.id, role: 'assistant', timestamp: 2, status: 'completed', sequence: 1
    })
    expect(storage.queries.readMessageSkeleton({ sessionId: 'another-session', messageId: 'message-2' })).toBeUndefined()
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

  it('keeps chat-body digest narrow while conservatively invalidating the route selection fence for every non-body field', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'body digest and fence', model: 'test' })
    appendMessage(db, { id: 'fence-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const storage = createSqliteSessionStorage(db)
    const patches: Array<{ field: string; patch: Parameters<typeof updateMessageContent>[2] }> = [
      { field: 'attachments', patch: { attachments: [{ id: 'fence-attachment', fileName: 'note.txt', mimeType: 'text/plain', byteLength: 4, stagingKey: 'stage/note.txt' }] } },
      { field: 'imagesDeliveredToApi', patch: { imagesDeliveredToApi: true } },
      { field: 'toolUse', patch: { toolUse: { id: 'fence-use', toolName: 'read_file', toolType: 'builtin', parameters: {}, status: 'completed', timestamp: 1 } } },
      { field: 'toolCalls', patch: { toolCalls: [{ id: 'fence-call', toolName: 'read_file', input: {}, status: 'completed' }] } },
      { field: 'thinking', patch: { thinking: { content: 'changed metadata', isVisible: true } } },
      { field: 'contentSegments', patch: { contentSegments: [{ type: 'text', text: 'metadata segment' }] } },
      { field: 'skillHints', patch: { skillHints: [{ id: 'fence-hint', text: 'hint', shownAt: 1 }] } },
      { field: 'schemaVersion', patch: { schemaVersion: 2 } },
      { field: 'status', patch: { status: 'failed' } }
    ]

    for (const { field, patch } of patches) {
      const selected = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'fence-user' })
      const before = storage.queries.readMessage({ sessionId: session.id, messageId: 'fence-user' })!
      const beforeDigest = encodeChatBodyV1([before])
      expect(storage.queries.isSelectionCurrent(session.id, selected.fence), field).toBe(true)
      expect(updateMessageContent(db, 'fence-user', patch), field).not.toBeNull()
      const after = storage.queries.readMessage({ sessionId: session.id, messageId: 'fence-user' })!
      expect(encodeChatBodyV1([after]), field).toBe(beforeDigest)
      expect(storage.queries.isSelectionCurrent(session.id, selected.fence), field).toBe(false)
    }
  })

  it('projects route attachments only through hasVision and keeps unrelated DTO fields out of route output', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'route attachment projection', model: 'test' })
    appendMessage(db, { id: 'route-attachment-user', sessionId: session.id, role: 'user', content: 'inspect this', timestamp: 1, status: 'sent' })
    const storage = createSqliteSessionStorage(db)
    const before = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'route-attachment-user' })
    expect(before).toMatchObject({ userInput: 'inspect this', hasVision: false })

    updateMessageContent(db, 'route-attachment-user', { attachments: [{ id: 'route-image', fileName: 'image.png', mimeType: 'image/png',
      byteLength: 4, stagingKey: 'stage/route-image.png' }] })
    const withImage = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'route-attachment-user' })
    expect(withImage).toMatchObject({ userInput: 'inspect this', hasVision: true, recentMessages: before.recentMessages })
    expect(storage.queries.isSelectionCurrent(session.id, before.fence)).toBe(false)

    updateMessageContent(db, 'route-attachment-user', { thinking: { content: 'private reasoning', isVisible: true },
      toolCalls: [{ id: 'route-tool', toolName: 'read_file', input: {}, status: 'completed' }],
      contentSegments: [{ type: 'text', text: 'presentation-only segment' }] })
    const afterMetadata = storage.queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'route-attachment-user' })
    expect(afterMetadata).toMatchObject({ userInput: 'inspect this', hasVision: true, recentMessages: withImage.recentMessages })
    expect(storage.queries.isSelectionCurrent(session.id, withImage.fence)).toBe(false)
  })

  it('keeps route, export and search scopes distinct for metadata and queued-message fields', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection scopes', model: 'test' })
    appendMessage(db, { id: 'scope-user', sessionId: session.id, role: 'user', content: 'body sentinel', timestamp: 1, status: 'sent', thinking: { content: 'private thought', isVisible: true }, contentSegments: [{ type: 'text', text: 'segment sentinel' }] })
    appendMessage(db, { id: 'scope-assistant', sessionId: session.id, role: 'assistant', content: 'answer sentinel', timestamp: 2, status: 'completed', toolCalls: [{ id: 'scope-tool', toolName: 'read_file', input: { path: 'note.txt' }, status: 'completed' }] })
    const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'scope-queued', content: 'queued excluded sentinel' })
    const queries = createSqliteSessionStorage(db).queries

    const routing = queries.readRoutingInput({ sessionId: session.id, requiredUserMessageId: 'scope-user' })
    expect(routing.recentMessages).toEqual([
      { role: 'user', content: 'body sentinel' }, { role: 'assistant', content: 'answer sentinel' }
    ])
    expect(routing.recentMessages.some((message) => JSON.stringify(message).includes('segment sentinel'))).toBe(false)

    const chatPage = queries.readChatPage({ sessionId: session.id, limit: 20 })
    expect(chatPage.entries.map(({ message }) => message.id)).toEqual(['scope-user', 'scope-assistant', queued.persisted.message.id])
    expect(chatPage.entries.at(-1)).toMatchObject({ sequence: 2, message: { status: 'queued', content: 'queued excluded sentinel' } })
    const apiBaseline = queries.readApiBaseline({ sessionId: session.id, limit: 20 })
    expect(apiBaseline.entries.map(({ message }) => message.id)).toEqual(['scope-user', 'scope-assistant', queued.persisted.message.id])
    expect(apiBaseline.entries.at(-1)).toMatchObject({ sequence: 2, message: { status: 'queued', content: 'queued excluded sentinel' } })

    const exported = queries.readExportPage({ sessionId: session.id, fromSequence: 0, pageSize: 10 })
    expect(exported.rows.map(({ message }) => message.id)).toEqual(['scope-user', 'scope-assistant', queued.persisted.message.id])
    expect(exported.rows[0]?.message).toMatchObject({ thinking: { content: 'private thought' }, contentSegments: [{ text: 'segment sentinel' }] })
    expect(exported.rows[1]?.message.toolCalls).toHaveLength(1)

    const corpus = queries.readSearchCorpusPage({ sessionId: session.id, fromSequence: 0, pageSize: 10 })
    expect(corpus.entries.map(({ message }) => message.id)).toEqual(['scope-user', 'scope-assistant'])
    expect(corpus.entries[0]?.message).toMatchObject({ thinking: { content: 'private thought' }, contentSegments: [{ text: 'segment sentinel' }] })
    expect(corpus.entries.some(({ message }) => message.id === queued.persisted.message.id)).toBe(false)
  })

  it('includes non-desktop queue scopes in the single-session search corpus while desktop readers stay scoped', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'search queue-scope boundary', model: 'test' })
    appendMessage(db, { id: 'desktop-row', sessionId: session.id, role: 'user', content: 'desktop body', timestamp: 1, status: 'sent' })
    const imQueued = enqueueQueuedUserMessageInScope(db, { sessionId: session.id, requestId: 'im-search-scope', content: 'im queued body',
      queueScope: buildImQueueScope('feishu', session.id) })
    expect(updateMessageContent(db, imQueued.persisted.message.id, { status: 'sent' })).not.toBeNull()
    const queries = createSqliteSessionStorage(db).queries

    expect(queries.readChatPage({ sessionId: session.id, limit: 10 }).entries.map(({ message }) => message.id)).toEqual(['desktop-row'])
    expect(queries.readExportPage({ sessionId: session.id, fromSequence: 0, pageSize: 10 }).rows.map(({ message }) => message.id))
      .toEqual(['desktop-row'])
    expect(queries.readApiBaseline({ sessionId: session.id, limit: 10 }).entries.map(({ message }) => message.id))
      .toEqual(['desktop-row', imQueued.persisted.message.id])
    expect(queries.readSearchCorpusPage({ sessionId: session.id, fromSequence: 0, pageSize: 10 }).entries.map(({ message }) => message.id))
      .toEqual(['desktop-row', imQueued.persisted.message.id])
  })

  it('preserves every mutable Message DTO field in chat and export scopes while sequence remains selection metadata', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'export field matrix', model: 'test' })
    appendMessage(db, { id: 'export-field-row', sessionId: session.id, role: 'assistant', content: 'base', timestamp: 7, status: 'completed' })
    const storage = createSqliteSessionStorage(db)
    const cases: Array<{ patch: Parameters<typeof updateMessageContent>[2]; field: string; value: unknown }> = [
      { patch: { content: 'body-v2' }, field: 'content', value: 'body-v2' },
      { patch: { status: 'failed' }, field: 'status', value: 'failed' },
      { patch: { schemaVersion: 2 }, field: 'schemaVersion', value: 2 },
      { patch: { attachments: [{ id: 'attachment-v2', fileName: 'note.txt', mimeType: 'text/plain', byteLength: 4, stagingKey: 'stage/note.txt' }] }, field: 'attachments', value: [{ id: 'attachment-v2', fileName: 'note.txt', mimeType: 'text/plain', byteLength: 4, stagingKey: 'stage/note.txt' }] },
      { patch: { imagesDeliveredToApi: true }, field: 'imagesDeliveredToApi', value: true },
      { patch: { toolUse: { id: 'tool-use-v2', toolName: 'read_file', toolType: 'builtin', parameters: { path: 'note.txt' }, status: 'completed', timestamp: 8 } }, field: 'toolUse', value: { id: 'tool-use-v2', toolName: 'read_file', toolType: 'builtin', parameters: { path: 'note.txt' }, status: 'completed', timestamp: 8 } },
      { patch: { toolCalls: [{ id: 'tool-call-v2', toolName: 'read_file', input: { path: 'note.txt' }, status: 'completed' }] }, field: 'toolCalls', value: [{ id: 'tool-call-v2', toolName: 'read_file', input: { path: 'note.txt' }, status: 'completed' }] },
      { patch: { thinking: { content: 'thinking-v2', isVisible: true } }, field: 'thinking', value: { content: 'thinking-v2', isVisible: true } },
      { patch: { contentSegments: [{ type: 'text', text: 'segment-v2' }] }, field: 'contentSegments', value: [{ type: 'text', text: 'segment-v2' }] },
      { patch: { skillHints: [{ id: 'skill-v2', text: 'hint', shownAt: 9 }] }, field: 'skillHints', value: [{ id: 'skill-v2', text: 'hint', shownAt: 9 }] }
    ]

    for (const { patch, field, value } of cases) {
      if (field === 'schemaVersion') {
        getDbConnection(db).prepare('UPDATE messages SET schema_version=? WHERE id=?').run(value, 'export-field-row')
      } else {
        expect(updateMessageContent(db, 'export-field-row', patch)).not.toBeNull()
      }
      const exported = storage.queries.readExportPage({ sessionId: session.id, fromSequence: 0, pageSize: 1 }).rows[0]?.message
      expect(exported, `export field ${field}`).toHaveProperty(field, value)
      expect(exported).toMatchObject({ id: 'export-field-row', sessionId: session.id, role: 'assistant', timestamp: 7 })
      const chatPage = storage.queries.readChatPage({ sessionId: session.id, limit: 1 })
      expect(chatPage.entries[0]?.message, `chat field ${field}`).toHaveProperty(field, value)
      expect(chatPage.entries[0]).toMatchObject({ sequence: 0, message: { id: 'export-field-row', sessionId: session.id, role: 'assistant', timestamp: 7 } })
      const searchCorpus = storage.queries.readSearchCorpusPage({ sessionId: session.id, fromSequence: 0, pageSize: 1 })
      expect(searchCorpus.entries[0]?.message, `search corpus field ${field}`).toHaveProperty(field, value)
      expect(searchCorpus.entries[0]).toMatchObject({ sequence: 0, message: { id: 'export-field-row', sessionId: session.id, role: 'assistant', timestamp: 7 } })
      const apiBaseline = storage.queries.readApiBaseline({ sessionId: session.id, limit: 1 })
      expect(apiBaseline.entries[0]?.message, `API baseline field ${field}`).toHaveProperty(field, value)
      expect(apiBaseline.entries[0]).toMatchObject({ sequence: 0, message: { id: 'export-field-row', sessionId: session.id, role: 'assistant', timestamp: 7 } })
    }
  })

  it('returns one coherent source snapshot across full, tail, page, item, search, export, and API views', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection snapshot agreement', model: 'test' })
    appendMessagesAtomically(db, [
      { id: 'snapshot-u1', sessionId: session.id, role: 'user', content: 'first', timestamp: 1, status: 'sent' },
      { id: 'snapshot-a1', sessionId: session.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' },
      { id: 'snapshot-u2', sessionId: session.id, role: 'user', content: 'second', timestamp: 3, status: 'sent' },
      { id: 'snapshot-a2', sessionId: session.id, role: 'assistant', content: 'latest', timestamp: 4, status: 'completed' },
    ])
    const queries = createSqliteSessionStorage(db).queries
    const full = queries.readMessages({ sessionId: session.id })
    const tail = queries.readChatPage({ sessionId: session.id, limit: 2 })
    const earlierPage = queries.readChatPage({ sessionId: session.id, beforeSequence: tail.oldestSequence, limit: 2 })
    const firstExportPage = queries.readExportPage({ sessionId: session.id, fromSequence: 0, pageSize: 2 })
    const secondExportPage = queries.readExportPage({ sessionId: session.id, fromSequence: firstExportPage.nextSequence, pageSize: 2 })
    const exportRows = [...firstExportPage.rows, ...secondExportPage.rows]
    const firstSearchPage = queries.readSearchCorpusPage({ sessionId: session.id, fromSequence: 0, pageSize: 50 })
    const searchRows = firstSearchPage.entries
    const apiBaseline = queries.readApiBaseline({ sessionId: session.id })

    expect([...earlierPage.entries, ...tail.entries].map(({ message }) => message.id)).toEqual(full.map(({ id }) => id))
    expect(exportRows.map(({ message }) => message.id)).toEqual(full.map(({ id }) => id))
    expect(searchRows.map(({ message }) => message.id)).toEqual(full.map(({ id }) => id))
    expect(apiBaseline.entries.map(({ message }) => message.id)).toEqual(full.map(({ id }) => id))
    for (const [index, message] of full.entries()) {
      expect(queries.readMessage({ sessionId: session.id, messageId: message.id })).toEqual(message)
      expect(queries.readMessageSequence({ sessionId: session.id, messageId: message.id })).toBe(index)
      expect(exportRows[index]).toMatchObject({ sequence: index, message })
      expect(searchRows[index]).toMatchObject({ sequence: index, message })
      expect(apiBaseline.entries[index]).toMatchObject({ sequence: index, message })
    }
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

  it('keeps canonical chat context available when a ledger projection is blocked', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'blocked-ledger-context' })
    appendMessagesAtomically(db, [{ id: 'still-readable', sessionId: session.id, role: 'user', content: 'canonical', timestamp: 1, status: 'sent' }])
    const sink = { eventsPath: '/unused', appendCritical: vi.fn(), appendChunk: vi.fn(), waitForCapacity: vi.fn(), flush: vi.fn(), close: vi.fn(), indexPath: '/unused-index' }
    const getLedger = vi.fn(() => sink as never)
    const readReplay = vi.fn()
    const storage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => '/tmp/blocked-context', getUserDataDir: () => '/tmp',
      getSessionEventSink: getLedger as never,
      readCompactionReplay: readReplay as never,
      ensureSessionLedgerReady: async () => false
    })
    expect(storage.queries.readApiBaseline({ sessionId: session.id, limit: 10 }).entries.map(({ message }) => message.content)).toEqual(['canonical'])
    const bound = await createBoundSessionContextAdapter(storage.contexts, { sessionId: session.id, isBusy: () => false })
    expect(bound.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'canonical' })]))
    expect(getLedger).not.toHaveBeenCalled()
    expect(readReplay).not.toHaveBeenCalled()
  })

  it('does not retry a blocked ledger while reading compaction markers for a session switch', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'blocked-compaction-marker-read' })
    const ensureSessionLedgerReady = vi.fn(async () => false)
    const getLedger = vi.fn(() => { throw new Error('blocked ledger must not open the event file') })
    const storage = createSqliteSessionStorage(db, {
      getWorkDirForSession: () => '/tmp/blocked-compaction-marker-read',
      ensureSessionLedgerReady,
      getSessionEventSink: getLedger as never
    })

    await expect(storage.readCompactionReplay({ sessionId: session.id, workDir: '/tmp/blocked-compaction-marker-read' }))
      .resolves.toEqual({ committed: [], rejected: [] })
    expect(ensureSessionLedgerReady).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: session.id }),
      workDir: '/tmp/blocked-compaction-marker-read',
      retryBlocked: false
    }))
    expect(getLedger).not.toHaveBeenCalled()
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

  it('commits manual compaction facts and the complete replacement snapshot to canonical History', async () => {
    const temp = createTempDatabase('session-context-canonical-compaction-')
    const workDir = path.join(path.dirname(temp.dbPath), 'session-context-ledger')
    fs.mkdirSync(workDir, { recursive: true })
    try {
      db = temp.db
      const session = createSession(db, { name: 'canonical manual compaction' })
      const messages = [
        { id: 'manual-compact-u1', sessionId: session.id, role: 'user' as const, content: 'old question '.repeat(80), timestamp: 1, status: 'sent' as const },
        { id: 'manual-compact-a1', sessionId: session.id, role: 'assistant' as const, content: 'old answer '.repeat(80), timestamp: 2, status: 'completed' as const },
        { id: 'manual-compact-u2', sessionId: session.id, role: 'user' as const, content: 'current question '.repeat(80), timestamp: 3, status: 'sent' as const },
        { id: 'manual-compact-a2', sessionId: session.id, role: 'assistant' as const, content: 'current answer '.repeat(80), timestamp: 4, status: 'completed' as const }
      ]
      appendMessagesAtomically(db, messages)
      const storage = createSqliteSessionStorage(db, {
        getWorkDirForSession: () => workDir, getUserDataDir: () => '/tmp',
        getSessionEventSink: getSessionEventSink
      })
      const bound = await createBoundSessionContextAdapter(storage.contexts, { sessionId: session.id, isBusy: () => false })
      const result = await compactSessionContext({
        sessionId: session.id, requestId: 'manual-compact-request', windowId: bound.windowId,
        messages: bound.messages, totalInputBudget: 100000, locale: 'en-US', contextAdapter: bound.adapter,
        summarize: async () => ({ task: 'task', completed: 'done', decisions: 'decision', constraints: 'constraints',
          pending: 'pending', blockers: 'none', nextStep: 'continue' })
      })
      expect(result.status).toBe('committed')
      if (result.status !== 'committed') throw new Error(`manual compaction failed: ${result.status}`)
      const snapshot = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).readSync(result.compactionId)
      expect(snapshot.events.map(({ kind }) => kind)).toEqual(['transcript-compacted', 'invocation-completed'])
      const compacted = snapshot.events[0]!.payload as { messages: Array<{ id?: string }>; sessionLedger?: { start?: Record<string, unknown>; summary?: Record<string, unknown> }; surfaceReplay?: Record<string, unknown> }
      expect(compacted.messages).toHaveLength(4)
      expect(compacted.messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining('context_checkpoint') })
      expect(compacted.messages.slice(1).map(({ id }) => id)).toEqual(['manual-compact-a1', 'manual-compact-u2', 'manual-compact-a2'])
      expect(compacted.messages.map(({ id }) => id)).toContain('manual-compact-u2')
      expect(compacted.messages).not.toContainEqual(expect.objectContaining({ id: 'manual-compact-u1' }))
      expect(compacted.sessionLedger?.start).toMatchObject({ compactionId: result.compactionId, inputSurfaceFingerprint: expect.any(String) })
      expect(compacted.sessionLedger?.summary).toMatchObject({ compactionId: result.compactionId,
        outputSurfaceFingerprint: result.outputSurfaceFingerprint, candidate: { checkpointReplayIdentity: expect.any(String) } })
      expect(compacted.surfaceReplay).toMatchObject({ inputFingerprint: expect.any(String), outputFingerprint: result.outputSurfaceFingerprint,
        checkpointReplayIdentity: expect.any(String), windowId: result.windowId })
      const canonicalStream = await storage.execution.historyFor({ sessionId: session.id }).read(result.compactionId)
      expect(canonicalStream.version).toBe(2)
      const persistedPayload = canonicalStream.events[0]!.payload as { messages: Array<{ id?: string }>; sessionLedger?: { start?: Record<string, unknown>; summary?: Record<string, unknown> } }
      await fs.promises.rm(getSessionEventSink(workDir, session.id, session.createdAt).eventsPath, { force: true })
      const canonicalReplay = storage.queries.readCanonicalCompactionReplay(session.id)
      expect(canonicalReplay.committed).toHaveLength(1)
      expect(canonicalReplay.committed[0]).toMatchObject({
        compactionId: result.compactionId,
        start: { type: 'compaction_start', payload: { compactionId: result.compactionId, windowId: bound.windowId } },
        summary: { type: 'compaction_summary', payload: { compactionId: result.compactionId, outputSurfaceFingerprint: result.outputSurfaceFingerprint,
          candidate: { checkpointReplayIdentity: expect.any(String) } } },
        end: { type: 'compaction_end', payload: { status: 'committed', outputSurfaceFingerprint: result.outputSurfaceFingerprint } }
      })
      const restored = await createBoundSessionContextAdapter(storage.contexts, { sessionId: session.id, isBusy: () => false })
      const restoredSnapshot = await restored.adapter.port.readCurrent({ kind: 'session', sessionId: session.id })
      expect(restoredSnapshot.frame.windowId).toBe(result.windowId)
      expect(restoredSnapshot.frame.items[0]?.replayIdentity).toBe((compacted.surfaceReplay as { checkpointReplayIdentity: string }).checkpointReplayIdentity)
      await storage.execution.historyFor({ sessionId: session.id }).appendBatch([{
        invocationId: 'invalid-compaction-sidecar', turnId: 'invalid-compaction-turn', sequence: 1, schemaVersion: 1,
        eventId: 'invalid-compaction-sidecar:event:1', idempotencyKey: 'invalid-compaction-sidecar:transcript-compacted:1',
        kind: 'transcript-compacted', payload: { compactionId: 'invalid-canonical-compaction', messages: [{ role: 'user', content: 'x' }],
          sessionLedger: { location: { workDir, sessionId: session.id, createdAt: session.createdAt }, start: { compactionId: 'invalid-canonical-compaction' } } }
      }], 0)
      const invalidSidecarReplay = storage.queries.readCanonicalCompactionReplay(session.id)
      expect(invalidSidecarReplay.committed.map(({ compactionId }) => compactionId)).toEqual([result.compactionId])
      expect(invalidSidecarReplay.rejected).toContainEqual({ compactionId: 'invalid-canonical-compaction', reason: 'canonical-session-ledger-missing-or-invalid' })
      const transaction = await fs.promises.readFile(path.join(workDir, 'sessions'), 'utf8').catch(() => '')
      expect(persistedPayload.sessionLedger?.summary).toBeDefined()
      expect(transaction).toBe('')
      expect(listPendingCanonicalLedgerProjectionTargets(getDbConnection(db), getDbConnection(db).prepare(
        'SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id)?.ledger_location_key as string)).toHaveLength(1)
    } finally {
      db?.close()
      db = undefined
      temp.cleanup()
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('replays a canonical manual compaction after a crash before its JSONL projection', async () => {
    const temp = createTempDatabase('session-context-canonical-compaction-recovery-')
    const workDir = path.join(path.dirname(temp.dbPath), 'session-context-canonical-compaction-recovery')
    fs.mkdirSync(workDir, { recursive: true })
    try {
      db = temp.db
      setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: workDir, isDefault: true }]))
      const session = createSession(db, { name: 'canonical compaction recovery', workDirProfileId: 'profile' })
      const messages = [
        { id: 'crash-compact-u1', sessionId: session.id, role: 'user' as const, content: 'old question '.repeat(80), timestamp: 1, status: 'sent' as const },
        { id: 'crash-compact-a1', sessionId: session.id, role: 'assistant' as const, content: 'old answer '.repeat(80), timestamp: 2, status: 'completed' as const },
        { id: 'crash-compact-u2', sessionId: session.id, role: 'user' as const, content: 'current question '.repeat(80), timestamp: 3, status: 'sent' as const },
        { id: 'crash-compact-a2', sessionId: session.id, role: 'assistant' as const, content: 'current answer '.repeat(80), timestamp: 4, status: 'completed' as const }
      ]
      appendMessagesAtomically(db, messages)
      const conn = getDbConnection(db)
      const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
      const ensureLedger = async ({ session: current, workDir: root }: { session: import('../../src/shared/domainTypes').Session; workDir: string }) => {
        const readiness = await ensureSessionLedgerReady({ conn, location: { workDir: root, sessionId: current.id, createdAt: current.createdAt },
          sessionGeneration: current.generation, processGeneration: 1, retryBlocked: true, dependencies })
        return readiness.status === 'ready'
      }
      const paths = resolveSessionEventPaths(workDir, session.id, session.createdAt)
      const failedSink = { eventsPath: paths.eventsPath, indexPath: paths.indexPath, appendCritical: vi.fn(async () => { throw new Error('simulated process loss') }),
        appendChunk: vi.fn(), waitForCapacity: vi.fn(), flush: vi.fn(), close: vi.fn() }
      const interruptedStorage = createSqliteSessionStorage(db, { getWorkDirForSession: () => workDir, getUserDataDir: () => '/tmp',
        getSessionEventSink: () => failedSink as never, readCompactionReplay: async () => ({ committed: [], rejected: [] }) as never,
        ensureSessionLedgerReady: ensureLedger })
      const interrupted = await createBoundSessionContextAdapter(interruptedStorage.contexts, { sessionId: session.id, isBusy: () => false })
      const compacted = await compactSessionContext({
        sessionId: session.id, requestId: 'crash-compact-request', windowId: interrupted.windowId,
        messages: interrupted.messages, totalInputBudget: 100000, locale: 'en-US', contextAdapter: interrupted.adapter,
        summarize: async () => ({ task: 'task', completed: 'done', decisions: 'decision', constraints: 'constraints',
          pending: 'pending', blockers: 'none', nextStep: 'continue' })
      })
      expect(compacted.status).toBe('failed')
      const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
      const compactedStream = conn.prepare(`SELECT streams.invocation_id FROM agent_history_streams streams
        JOIN agent_history_events events ON events.invocation_id=streams.invocation_id
        WHERE streams.session_id=? AND events.kind='transcript-compacted'`).get(session.id) as { invocation_id: string } | undefined
      expect(compactedStream).toBeDefined()
      expect(history.readSync(compactedStream!.invocation_id).events).toHaveLength(2)
      expect((await readSessionEvents(paths.eventsPath)).some(({ type }) => type.startsWith('compaction_'))).toBe(false)

      const recoveredStorage = createSqliteSessionStorage(db, { getWorkDirForSession: () => workDir, getUserDataDir: () => '/tmp',
        ensureSessionLedgerReady: ensureLedger })
      const recovered = await createBoundSessionContextAdapter(recoveredStorage.contexts, { sessionId: session.id, isBusy: () => false })
      const snapshot = await recovered.adapter.port.readCurrent({ kind: 'session', sessionId: session.id })
      expect(recovered.messages[0]?.id).toMatch(/^checkpoint:/)
      expect(snapshot.frame.items[0]?.replayIdentity).toBeTruthy()
      expect(snapshot.frame.items[0]?.message.id).toBe(recovered.messages[0]?.id)
      const canonicalEvent = conn.prepare("SELECT event_id FROM agent_history_events WHERE invocation_id=? AND kind='transcript-compacted'")
        .get(compactedStream!.invocation_id) as { event_id: string }
      expect(conn.prepare('SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id=?').get(canonicalEvent.event_id))
        .toEqual({ status: 'acked' })
      expect((await readSessionEvents(paths.eventsPath)).map(({ type }) => type).filter((type) => type.startsWith('compaction_')))
        .toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    } finally {
      db?.close()
      db = undefined
      temp.cleanup()
      fs.rmSync(workDir, { recursive: true, force: true })
    }
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

  it('owns session usage snapshots through session queries and commands', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'session usage snapshot' })
    const storage = createSqliteSessionStorage(db)
    const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 12 }

    expect(storage.queries.readSessionUsage(session.id)).toBeUndefined()
    storage.commands.setSessionUsage(session.id, usage)
    expect(storage.queries.readSessionUsage(session.id)).toEqual(usage)
    storage.commands.deleteSessionUsage(session.id)
    expect(storage.queries.readSessionUsage(session.id)).toBeUndefined()
  })

  it('strips retired plan metadata through a named session command and keeps unrelated metadata', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'strip plan metadata', metadata: { note: 'keep', plan: { old: true }, pending_plan: 'legacy' } })
    const commands = createSqliteSessionStorage(db).commands

    expect(commands.stripLegacyPlanMetadata(session.id)?.metadata).toEqual({ note: 'keep' })
    expect(commands.stripLegacyPlanMetadata(session.id)?.metadata).toEqual({ note: 'keep' })
    expect(commands.stripLegacyPlanMetadata('missing-session')).toBeUndefined()
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

  it('preserves legacy agentsMdEnabled metadata as inert data', () => {
    const db = createMemoryAppDb()
    const storage = createSqliteSessionStorage(db)
    const session = storage.commands.createSession({ name: 'legacy-agents-setting', metadata: { agentsMdEnabled: false } })
    expect(session.metadata.agentsMdEnabled).toBe(false)
    expect(storage.queries.readSession(session.id)?.metadata.agentsMdEnabled).toBe(false)
    db.close()
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
    const storage = createSqliteSessionStorage(db)
    const execution = storage.execution

    expect(execution.loadAcceptedMessages({ sessionId: session.id, turnId: 'accepted-turn' }).map(({ id }) => id))
      .toEqual(['accepted-user'])
    expect(execution.readTurn({ sessionId: session.id, turnId: 'accepted-turn' })).toMatchObject({ sessionId: session.id, requestId: 'accepted-request' })
    expect(execution.readTurn({ sessionId: 'wrong-session', turnId: 'accepted-turn' })).toBeUndefined()
    expect(execution.readTurnByRequest({ sessionId: session.id, requestId: 'accepted-request' })).toMatchObject({ turnId: 'accepted-turn' })
    expect(storage.queries.readTurnById({ turnId: 'accepted-turn' })).toMatchObject({
      sessionId: session.id, requestId: 'accepted-request', assistantMessageId: 'accepted-assistant'
    })
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

    const inspection = createSqliteSessionStorage(db).queries.continuationSources.read({ sessionId: session.id, activeTurnIds: [] })
    expect(inspection).toMatchObject({ kind: 'available', boundary: 'newer-input', failedCandidates: [] })
    if (inspection.kind === 'available') expect(inspection.fallback).toBeUndefined()
  })

  it('derives recovery facts only from canonical dispatched and settled History events', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'recovery facts', model: 'test' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'origin', turnId: 'origin-turn', sequence: 1, schemaVersion: 1, eventId: 'rf-1', idempotencyKey: 'rf-1', kind: 'invocation-context-committed', payload: { messages: [] } },
      { invocationId: 'origin', turnId: 'origin-turn', sequence: 2, schemaVersion: 1, eventId: 'rf-2', idempotencyKey: 'rf-2', kind: 'tool-call-started', payload: { toolCallId: 'unknown', toolName: 'file.write', inputHash: 'a'.repeat(64) } },
      { invocationId: 'origin', turnId: 'origin-turn', sequence: 3, schemaVersion: 1, eventId: 'rf-3', idempotencyKey: 'rf-3', kind: 'tool-call-finished', payload: { toolCallId: 'unknown', executionOutcome: 'unknown-after-dispatch', isError: true } },
      { invocationId: 'origin', turnId: 'origin-turn', sequence: 4, schemaVersion: 1, eventId: 'rf-4', idempotencyKey: 'rf-4', kind: 'tool-call-started', payload: { toolCallId: 'done', toolName: 'file.read', inputHash: 'b'.repeat(64) } },
      { invocationId: 'origin', turnId: 'origin-turn', sequence: 5, schemaVersion: 1, eventId: 'rf-5', idempotencyKey: 'rf-5', kind: 'tool-call-finished', payload: { toolCallId: 'done', executionOutcome: 'succeeded', isError: false } }
    ], 0)
    const facts = createSqliteSessionStorage(db).queries.continuationSources.readRecoveryFacts(session.id)
    expect(facts).toMatchObject({ unresolvedEffects: [{ id: 'origin:unknown', toolName: 'file.write', inputHash: 'a'.repeat(64) }], toolOutcomes: [
      { id: 'origin:unknown', outcome: 'unknown-after-dispatch' }, { id: 'origin:done', outcome: 'succeeded' }
    ] })
  })

  it('rejects a continuation source inspection without a non-empty session ID at the boundary', () => {
    db = createMemoryAppDb()
    const queries = createSqliteSessionStorage(db).queries.continuationSources
    expect(() => queries.read({ sessionId: undefined as unknown as string, activeTurnIds: [] }))
      .toThrow('CONTINUATION_SOURCE_SESSION_ID_REQUIRED')
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
    const selected = queries.continuationSources.read({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'candidate-assistant' })
    expect(selected).toMatchObject({ kind: 'available', selected: { kind: 'found', candidate: { source: { invocationId: 'failed-invocation-2' } } } })
    await history.appendBatch([
      { invocationId: 'running-invocation', turnId: 'running-turn', sequence: 1, schemaVersion: 1, eventId: 'running-1', idempotencyKey: 'running-key-1', kind: 'invocation-context-committed', payload: { messages: [] } }
    ], 0)
    const running = queries.continuationSources.read({ sessionId: session.id, activeTurnIds: ['running-turn'] })
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
    const inspection = queries.read({ sessionId: session.id, activeTurnIds: [] })
    expect(inspection).toMatchObject({ kind: 'available', fallback: { source: { invocationId: 'fallback-invocation', turnId: 'fallback-turn' }, assistantMessageId: 'fallback-assistant' } })
    expect(queries.read({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'fallback-assistant' }))
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
    expect(queries.read({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'completed-assistant' }))
      .toMatchObject({ kind: 'available', selected: { kind: 'not-recoverable' } })
    expect(queries.read({ sessionId: session.id, activeTurnIds: [], selectedAssistantMessageId: 'other-assistant' }))
      .toMatchObject({ kind: 'available', selected: { kind: 'not-found' } })
  })

  it('marks a latest open History stream unavailable unless it belongs to a running turn', async () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'unavailable continuation', model: 'test' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'open-invocation', turnId: 'open-turn', sequence: 1, schemaVersion: 1, eventId: 'open-1', idempotencyKey: 'open-key-1', kind: 'invocation-context-committed', payload: { messages: [] } }
    ], 0)
    expect(createSqliteSessionStorage(db).queries.continuationSources.read({ sessionId: session.id, activeTurnIds: [] }))
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

    expect(createSqliteSessionStorage(db).queries.continuationSources.read({ sessionId: session.id, activeTurnIds: [] }))
      .toMatchObject({ kind: 'available', failedCandidates: [{ source: { invocationId: 'interrupted-invocation', turnId: 'interrupted-turn', checkpointSequence: 1 } }] })
  })
})

describe('SQLite session storage public query contracts', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('reads durable turn errors scoped to requested assistant IDs in input order', () => {
    db = createMemoryAppDb()
    const first = createSession(db, { name: 'error lookup first' })
    const second = createSession(db, { name: 'error lookup second' })
    for (const [session, id, turn] of [[first, 'error-a', 'turn-a'], [second, 'error-b', 'turn-b']] as const) {
      appendMessage(db, { id, sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'failed' })
      createPersistedTurn(db, { turnId: turn, requestId: `request-${turn}`, sessionId: session.id, assistantMessageId: id, state: 'terminal', error: { code: 'TURN_FAILED', message: `failure ${id}` } })
    }
    const queries = createSqliteSessionStorage(db).queries
    expect(queries.listTurnErrorsByAssistantMessageIds(['error-b', 'error-a', 'error-b', 'missing']))
      .toEqual([{ assistantMessageId: 'error-b', message: 'failure error-b' }, { assistantMessageId: 'error-a', message: 'failure error-a' }])
  })
})

describe('SQLite session storage execution query contracts', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('lists the narrow active turn identities needed by startup orphan cleanup', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'startup orphan turns' })
    appendMessage(db, { id: 'startup-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    appendMessage(db, { id: 'terminal-assistant', sessionId: session.id, role: 'assistant', content: 'done', timestamp: 2, status: 'completed' })
    createPersistedTurn(db, { turnId: 'startup-active', requestId: 'startup-request', sessionId: session.id, assistantMessageId: 'startup-assistant', state: 'executing' })
    createPersistedTurn(db, { turnId: 'startup-terminal', requestId: 'terminal-request', sessionId: session.id, assistantMessageId: 'terminal-assistant', state: 'terminal' })

    expect(createSqliteSessionStorage(db).execution.listStartupOrphanTurns()).toEqual([
      { turnId: 'startup-active', state: 'executing', assistantMessageId: 'startup-assistant' }
    ])
  })

  it('reads the next queued message through the session execution port', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'execution queue query' })
    const other = createSession(db, { name: 'other execution queue' })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'queue-first', content: 'first' })
    enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'queue-second', content: 'second' })
    enqueueQueuedUserMessage(db, { sessionId: other.id, requestId: 'queue-other', content: 'other session' })

    expect(createSqliteSessionStorage(db).execution.getNextQueuedMessage(session.id))
      .toMatchObject({ message: { content: 'first' }, requestId: 'queue-first' })
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

  it('preserves queue identity and single-owner execution through a seeded edit-claim-reopen sequence', () => {
    const temp = createTempDatabase('session-storage-lifecycle-sequence-')
    try {
      db = temp.db
      const session = createSession(db, { name: 'lifecycle sequence', model: 'test' })
      const storage = createSqliteSessionStorage(db)
      let seed = 0x51a7e
      const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
      const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'sequence-q1', content: 'Q1 original' })
      expect(first.duplicate).toBe(false)
      expect(enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'sequence-q1', content: 'Q1 original' })).toMatchObject({ duplicate: true, persisted: { message: { id: first.persisted.message.id } } })
      expect(() => enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'sequence-q1', content: 'conflicting replay' })).toThrow('QUEUE_REQUEST_FINGERPRINT_MISMATCH')
      const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'sequence-q2', content: 'Q2 original' })
      const edited = storage.commands.editQueuedMessage({ sessionId: session.id, messageId: first.persisted.message.id, content: `Q1 edit ${next()}` })
      expect(edited).toMatchObject({ ok: true, message: { status: 'queued' } })
      if (!edited.ok) throw new Error('unexpected queued edit rejection')
      expect(getQueueInputReceipt(db, session.id, 'sequence-q1')).toMatchObject({ state: 'queued', queuedMessageId: first.persisted.message.id })

      const claimed = storage.execution.claimQueuedTurn({ sessionId: session.id, userMessageId: first.persisted.message.id,
        turnId: 'sequence-turn-1', assistantMessageId: 'sequence-assistant-1', requestId: 'sequence-q1', startToken: 'sequence-token-1' })
      expect(claimed.user.message).toMatchObject({ id: first.persisted.message.id, status: 'sent', content: edited.message.content })
      expect(getQueueInputReceipt(db, session.id, 'sequence-q1')).toMatchObject({ state: 'claimed', turnId: 'sequence-turn-1' })
      const claimA = storage.execution.claimExecution({ sessionId: session.id, turnId: 'sequence-turn-1', ownerId: 'sequence-owner-a' })
      expect(claimA.acquired).toBe(true)
      expect(storage.execution.claimExecution({ sessionId: session.id, turnId: 'sequence-turn-2', ownerId: 'sequence-owner-b' })).toMatchObject({ acquired: false, reason: 'owned' })
      const persistedPath = temp.dbPath
      db.close()
      db = undefined
      db = openDatabase(persistedPath)
      const afterReopen = createSqliteSessionStorage(db)
      expect(afterReopen.queries.readMessage({ sessionId: session.id, messageId: first.persisted.message.id })).toMatchObject({ content: edited.message.content, status: 'sent' })
      expect(getPersistedTurn(db, 'sequence-turn-1')).toMatchObject({ requestId: 'sequence-q1', userMessageId: first.persisted.message.id, state: 'prepared' })
      expect(getQueueInputReceipt(db, session.id, 'sequence-q1')).toMatchObject({ state: 'claimed', turnId: 'sequence-turn-1' })
      expect(getQueueInputReceipt(db, session.id, 'sequence-q2')).toMatchObject({ state: 'queued', queuedMessageId: second.persisted.message.id })
      expect(afterReopen.execution.claimExecution({ sessionId: session.id, turnId: 'sequence-turn-2', ownerId: 'sequence-owner-c' })).toMatchObject({ acquired: false, reason: 'owned' })
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')").get(session.id)).toMatchObject({ count: 1 })
    } finally {
      db?.close()
      db = undefined
      temp.cleanup()
    }
  })

  it('keeps queue receipts, message identity, and single-owner state through a seeded random lifecycle', async () => {
    const temp = createTempDatabase('session-storage-random-lifecycle-')
    try {
      db = temp.db
      const ledgerRoot = path.join(path.dirname(temp.dbPath), 'random-lifecycle-ledger')
      fs.mkdirSync(ledgerRoot, { recursive: true })
      setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'random-profile', path: ledgerRoot, isDefault: true }]))
      const session = createSession(db, { name: 'random lifecycle', model: 'test', workDirProfileId: 'random-profile' })
      let storage = createSqliteSessionStorage(db)
      let seed = 0x7a11ce55
      const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
      const operationTrace: string[] = []
      const entries = Array.from({ length: 8 }, (_, index) => {
        const requestId = `random-q${index}`
        const created = enqueueQueuedUserMessage(db!, { sessionId: session.id, requestId, content: `body-${index}` })
        expect(created.duplicate).toBe(false)
        expect(enqueueQueuedUserMessage(db!, { sessionId: session.id, requestId, content: `body-${index}` })).toMatchObject({ duplicate: true, persisted: { message: { id: created.persisted.message.id } } })
        return { requestId, messageId: created.persisted.message.id, state: 'queued' as 'queued' | 'claimed' | 'cancelled', content: `body-${index}`, turnId: undefined as string | undefined }
      })
      const assertLifecycleInvariants = (activeOwners: number) => {
        const claimedTurnIds = entries.filter(({ state }) => state === 'claimed').map(({ turnId }) => turnId)
        expect(claimedTurnIds.every((turnId) => Boolean(turnId))).toBe(true)
        expect(new Set(claimedTurnIds).size).toBe(claimedTurnIds.length)
        for (const entry of entries) {
          const receipt = getQueueInputReceipt(db!, session.id, entry.requestId)
          if (entry.state === 'cancelled') {
            expect(receipt).toMatchObject({ state: 'cancelled', queuedMessageId: null })
            expect(storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })).toBeUndefined()
          } else {
            expect(receipt).toMatchObject({ state: entry.state, queuedMessageId: entry.messageId,
              ...(entry.state === 'claimed' ? { turnId: entry.turnId } : {}) })
            expect(storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })).toMatchObject({
              id: entry.messageId, content: entry.content, status: entry.state === 'claimed' ? 'sent' : 'queued'
            })
          }
        }
        expect(getDbConnection(db!).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')")
          .get(session.id)).toMatchObject({ count: activeOwners })
      }
      assertLifecycleInvariants(0)

      // Reproducible mixed edit/cancel/claim sequence; after every transition check receipt-to-message identity.
      const queueMutations = entries.flatMap((entry) => {
        const choice = next() % 4
        return choice === 0 ? [{ kind: 'cancel' as const, entry }]
          : choice < 3 ? [{ kind: 'edit' as const, entry }] : []
      })
      for (let index = queueMutations.length - 1; index > 0; index -= 1) {
        const swapIndex = next() % (index + 1)
        ;[queueMutations[index], queueMutations[swapIndex]] = [queueMutations[swapIndex]!, queueMutations[index]!]
      }
      for (const mutation of queueMutations) {
        const { entry } = mutation
        if (mutation.kind === 'cancel') {
          operationTrace.push(`cancel:${entry.requestId}`)
          expect(storage.commands.deleteQueuedMessage(entry.messageId)).toEqual({ ok: true, sessionId: session.id })
          entry.state = 'cancelled'
          expect(getQueueInputReceipt(db, session.id, entry.requestId)).toMatchObject({ state: 'cancelled', queuedMessageId: null })
          expect(storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })).toBeUndefined()
        } else {
          entry.content = `${entry.content}-edit-${next()}`
          operationTrace.push(`edit:${entry.requestId}`)
          const edited = storage.commands.editQueuedMessage({ sessionId: session.id, messageId: entry.messageId, content: entry.content })
          expect(edited).toMatchObject({ ok: true, message: { id: entry.messageId, content: entry.content, status: 'queued' } })
        }
        assertLifecycleInvariants(0)
      }
      const live = entries.filter(({ state }) => state === 'queued')
      for (const entry of live) {
        expect(getQueueInputReceipt(db, session.id, entry.requestId)).toMatchObject({ state: 'queued', queuedMessageId: entry.messageId })
        expect(storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })).toMatchObject({ id: entry.messageId, content: entry.content, status: 'queued' })
        assertLifecycleInvariants(0)
      }
      const reorderedIds = live.map(({ messageId }) => messageId)
      for (let index = reorderedIds.length - 1; index > 0; index -= 1) {
        const swapIndex = next() % (index + 1)
        ;[reorderedIds[index], reorderedIds[swapIndex]] = [reorderedIds[swapIndex]!, reorderedIds[index]!]
      }
      const reordered = storage.commands.reorderQueuedMessages({ sessionId: session.id, messageIds: reorderedIds })
      operationTrace.push(`reorder:${reorderedIds.join(',')}`)
      expect(reordered).toMatchObject({ ok: true, entries: reorderedIds.map((messageId) => ({ message: { id: messageId, status: 'queued' } })) })
      const reorderedLive = reorderedIds.map((messageId) => live.find((entry) => entry.messageId === messageId)!)
      live.splice(0, live.length, ...reorderedLive)
      assertLifecycleInvariants(0)
      const winner = live[0]!
      const claimed = storage.execution.claimQueuedTurn({ sessionId: session.id, userMessageId: winner.messageId, turnId: 'random-turn',
        assistantMessageId: 'random-assistant', requestId: winner.requestId, startToken: 'random-token' })
      operationTrace.push(`claim-turn:${winner.requestId}`)
      winner.state = 'claimed'
      winner.turnId = 'random-turn'
      expect(claimed.user.message).toMatchObject({ id: winner.messageId, content: winner.content, status: 'sent' })
      expect(getQueueInputReceipt(db, session.id, winner.requestId)).toMatchObject({ state: 'claimed', queuedMessageId: winner.messageId, turnId: 'random-turn' })
      assertLifecycleInvariants(0)
      expect(storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn', ownerId: 'random-owner-a' })).toMatchObject({ acquired: true })
      assertLifecycleInvariants(1)
      const independentSession = createSession(db, { name: 'random lifecycle independent', model: 'test', workDirProfileId: 'random-profile' })
      const independentQueued = enqueueQueuedUserMessage(db, { sessionId: independentSession.id, requestId: 'random-independent-q', content: 'independent-session-body' })
      const independentClaim = storage.execution.claimQueuedTurn({ sessionId: independentSession.id, userMessageId: independentQueued.persisted.message.id,
        turnId: 'random-independent-turn', assistantMessageId: 'random-independent-assistant', requestId: 'random-independent-q', startToken: 'random-independent-token' })
      expect(independentClaim.user.message).toMatchObject({ id: independentQueued.persisted.message.id, status: 'sent' })
      const independentOwner = storage.execution.claimExecution({ sessionId: independentSession.id, turnId: 'random-independent-turn', ownerId: 'random-independent-owner' })
      expect(independentOwner).toMatchObject({ acquired: true })
      if (!independentOwner.acquired) throw new Error('expected independent session execution owner')
      let independentLease = { sessionId: independentSession.id, turnId: 'random-independent-turn', ownerId: 'random-independent-owner', generation: independentOwner.generation }
      const independentPending = enqueueQueuedUserMessage(db, { sessionId: independentSession.id, requestId: 'random-independent-pending-q', content: 'independent pending body' })
      let independentPendingState: 'queued' | 'cancelled' = 'queued'
      let independentPendingContent = 'independent pending body'
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE status IN ('claimed','executing','transcript_committed')")
        .get()).toMatchObject({ count: 2 })
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')")
        .get(independentSession.id)).toMatchObject({ count: 1 })
      expect(storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn', ownerId: 'random-owner-b' })).toMatchObject({ acquired: false })
      assertLifecycleInvariants(1)
      const originalLease = { sessionId: session.id, turnId: 'random-turn', ownerId: 'random-owner-a', generation: 1 }
      expect(storage.execution.releaseExecution(originalLease)).toBe(true)
      operationTrace.push('release:random-owner-a')
      const renewed = storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn', ownerId: 'renewed-owner-a' })
      expect(renewed).toMatchObject({ acquired: true })
      if (!renewed.acquired) throw new Error('expected renewed owner claim')
      const renewedLease = { sessionId: session.id, turnId: 'random-turn', ownerId: 'renewed-owner-a', generation: renewed.generation }
      expect(storage.execution.releaseExecution(originalLease)).toBe(false)
      assertLifecycleInvariants(1)
      expect(storage.execution.releaseExecution(renewedLease)).toBe(true)
      assertLifecycleInvariants(0)
      const contenderOwners = ['random-owner-c', 'random-owner-d', 'random-owner-e', 'random-owner-f']
      for (let index = contenderOwners.length - 1; index > 0; index -= 1) {
        const swapIndex = next() % (index + 1)
        ;[contenderOwners[index], contenderOwners[swapIndex]] = [contenderOwners[swapIndex]!, contenderOwners[index]!]
      }
      let priorLease = renewedLease
      let activeLease: typeof originalLease | undefined
      for (const ownerId of contenderOwners) {
        const acquired = storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn', ownerId })
        operationTrace.push(`claim-owner:${ownerId}`)
        expect(acquired).toMatchObject({ acquired: true })
        if (!acquired.acquired) throw new Error('expected randomized owner claim')
        activeLease = { sessionId: session.id, turnId: 'random-turn', ownerId, generation: acquired.generation }
        expect(activeLease.generation).toBeGreaterThan(priorLease.generation)
        expect(storage.execution.releaseExecution(priorLease)).toBe(false)
        expect(storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn', ownerId: `${ownerId}-rival` })).toMatchObject({ acquired: false })
        assertLifecycleInvariants(1)
        priorLease = activeLease
        if (ownerId !== contenderOwners.at(-1)) expect(storage.execution.releaseExecution(activeLease)).toBe(true)
        assertLifecycleInvariants(ownerId === contenderOwners.at(-1) ? 1 : 0)
      }
      expect(() => storage.execution.claimQueuedTurn({ sessionId: session.id, userMessageId: live.find(({ state }) => state === 'queued')!.messageId,
        turnId: 'random-turn-2', assistantMessageId: 'random-assistant-2', requestId: live.find(({ state }) => state === 'queued')!.requestId,
        startToken: 'random-token-2' })).toThrow('SESSION_TURN_BUSY')
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')")
        .get(session.id)).toMatchObject({ count: 1 })
      assertLifecycleInvariants(1)
      if (!activeLease) throw new Error('expected a live execution lease before claiming another queued turn')
      expect(storage.execution.releaseExecution(activeLease)).toBe(true)
      expect(updatePersistedTurnState(db, 'random-turn', 'terminal', { outcome: 'completed' })).toBe(true)
      expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn' }))
        .toMatchObject({ state: 'terminal', outcome: 'completed' })
      assertLifecycleInvariants(0)
      const secondWinner = live.find(({ state }) => state === 'queued')!
      const secondClaim = storage.execution.claimQueuedTurn({ sessionId: session.id, userMessageId: secondWinner.messageId, turnId: 'random-turn-2',
        assistantMessageId: 'random-assistant-2', requestId: secondWinner.requestId, startToken: 'random-token-2' })
      secondWinner.state = 'claimed'
      secondWinner.turnId = 'random-turn-2'
      operationTrace.push(`claim-turn:${secondWinner.requestId}`)
      expect(secondClaim.user.message).toMatchObject({ id: secondWinner.messageId, content: secondWinner.content, status: 'sent' })
      const secondTurnOwner = storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn-2', ownerId: 'random-turn-2-owner' })
      expect(secondTurnOwner).toMatchObject({ acquired: true })
      if (!secondTurnOwner.acquired) throw new Error('expected second turn execution owner')
      const secondTurnLease = { sessionId: session.id, turnId: 'random-turn-2', ownerId: 'random-turn-2-owner', generation: secondTurnOwner.generation }
      expect(storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn-2', ownerId: 'random-turn-2-rival' }))
        .toMatchObject({ acquired: false })
      assertLifecycleInvariants(1)

      const persistedPath = temp.dbPath
      operationTrace.push('reopen:active-owner')
      db.close()
      db = openDatabase(persistedPath)
      storage = createSqliteSessionStorage(db)
      for (const entry of entries) {
        const receipt = getQueueInputReceipt(db, session.id, entry.requestId)
        expect(receipt).toMatchObject({ queuedMessageId: entry.state === 'cancelled' ? null : entry.messageId, state: entry.state })
        if (entry.state === 'cancelled') expect(storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })).toBeUndefined()
        else expect(storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })).toMatchObject({
          id: entry.messageId, content: entry.content, status: entry.state === 'claimed' ? 'sent' : 'queued'
        })
      }
      assertLifecycleInvariants(1)
      expect(operationTrace).toContain(`claim-turn:${winner.requestId}`)
      const queuedMutationKinds = operationTrace.filter((step) => step.startsWith('edit:') || step.startsWith('cancel:'))
        .map((step) => step.startsWith('edit:') ? 'edit' : 'cancel')
      expect(queuedMutationKinds).toContain('edit')
      expect(queuedMutationKinds).toContain('cancel')
      expect(queuedMutationKinds.some((kind, index) => index > 0 && kind !== queuedMutationKinds[index - 1])).toBe(true)
      expect(operationTrace.at(-1)).toBe('reopen:active-owner')
      expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn' }))
        .toMatchObject({ requestId: winner.requestId, userMessageId: winner.messageId, state: 'terminal', outcome: 'completed' })
      expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn-2' }))
        .toMatchObject({ requestId: secondWinner.requestId, userMessageId: secondWinner.messageId, state: 'prepared' })
      expect(getQueueInputReceipt(db, independentSession.id, 'random-independent-q')).toMatchObject({
        state: 'claimed', queuedMessageId: independentQueued.persisted.message.id, turnId: 'random-independent-turn'
      })
      expect(storage.queries.readMessage({ sessionId: independentSession.id, messageId: independentQueued.persisted.message.id }))
        .toMatchObject({ content: 'independent-session-body', status: 'sent' })
      expect(storage.execution.readTurn({ sessionId: independentSession.id, turnId: 'random-independent-turn' }))
        .toMatchObject({ requestId: 'random-independent-q', userMessageId: independentQueued.persisted.message.id })
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE status IN ('claimed','executing','transcript_committed')")
        .get()).toMatchObject({ count: 2 })
      expect(getDbConnection(db).prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')")
        .get(session.id)).toMatchObject({ count: 1 })

      const rebuildMessages = entries.filter(({ state }) => state === 'claimed').map((entry) => ({
        id: entry.messageId, role: 'user' as const, content: entry.content,
        timestamp: storage.queries.readMessage({ sessionId: session.id, messageId: entry.messageId })!.timestamp
      }))
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
      await history.appendBatch([{
        invocationId: 'random-lifecycle-rebuild-invocation', turnId: 'random-lifecycle-rebuild-turn', sequence: 1, schemaVersion: 1,
        eventId: 'random-lifecycle-rebuild-context', idempotencyKey: 'random-lifecycle-rebuild-context',
        kind: 'invocation-context-committed', payload: { messages: rebuildMessages }
      }], 0)
      expect(history.readCanonicalSessionTranscriptForShadow(session.id)).toMatchObject({ kind: 'matched' })
      getDbConnection(db).prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
      getDbConnection(db).prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run(winner.messageId)
      getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
      const rebuilt = readSessionTranscriptProjection(db, session.id)
      expect(rebuilt.source).toBe('canonical:L2')
      expect(getProjectedMessages(db, session.id).filter(({ id }) => id === winner.messageId).map(({ id, content }) => ({ id, content })))
        .toEqual(rebuildMessages.filter(({ id }) => id === winner.messageId).map(({ id, content }) => ({ id, content })))
      for (const entry of entries) {
        const projected = getProjectedMessages(db, session.id).find(({ id }) => id === entry.messageId)
        if (entry.state === 'cancelled') expect(projected).toBeUndefined()
        else expect(projected).toMatchObject({ id: entry.messageId, content: entry.content, status: entry.state === 'claimed' ? 'sent' : 'queued' })
      }
      assertLifecycleInvariants(1)
      expect(getDbConnection(db).prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })

      const ledgerConn = getDbConnection(db)
      const ledgerLocation = ledgerConn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?')
        .get(session.id) as { ledger_location_key: string }
      const ledgerEventId = `random-lifecycle-ledger-${(next() >>> 0).toString(16)}`
      await new SqliteAgentHistory(ledgerConn, 1, Date.now, session.id).appendBatch([{
        invocationId: 'random-lifecycle-ledger-invocation', turnId: 'random-lifecycle-ledger-turn', sequence: 1, schemaVersion: 1,
        eventId: ledgerEventId, idempotencyKey: ledgerEventId, kind: 'invocation-context-committed', payload: { messages: rebuildMessages }
      }], 0)
      const target = {
        ledgerLocationKey: ledgerLocation.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
        canonicalEventId: ledgerEventId, projectionKind: 'tool-result',
        expectedEvents: [{ type: 'tool_result' as const, payload: { toolUseId: 'random-ledger-tool', stepId: 'random-ledger-step', result: { success: true } } }],
        expectedEventIds: ['tool_result:random-ledger-tool']
      }
      runInTransaction(ledgerConn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(ledgerConn, target))
      const sink = getSessionEventSink(ledgerRoot, session.id, session.createdAt)
      try {
        const failed = await drainCanonicalLedgerProjectionOutbox(ledgerConn, ledgerLocation.ledger_location_key,
          async () => { throw new Error('seeded random lifecycle sink failure') })
        expect(failed.failedTargetId).toBeTruthy()
        expect(listPendingCanonicalLedgerProjectionTargets(ledgerConn, ledgerLocation.ledger_location_key)).toHaveLength(1)
        const interleavedEdit = entries.find(({ state }) => state === 'queued')!
        interleavedEdit.content = `${interleavedEdit.content}-while-ledger-pending-${next()}`
        operationTrace.push(`edit-during-ledger-retry:${interleavedEdit.requestId}`)
        expect(() => updateMessageContent(db!, interleavedEdit.messageId, { content: 'unscoped-canonical-bypass' }))
          .toThrow('canonical write authority requires a canonical History append')
        const editedWhilePending = storage.commands.editQueuedMessage({ sessionId: session.id, messageId: interleavedEdit.messageId, content: interleavedEdit.content })
        expect(editedWhilePending).toMatchObject({ ok: true, message: { id: interleavedEdit.messageId, content: interleavedEdit.content, status: 'queued' } })
        if (!editedWhilePending.ok) throw new Error('unexpected queued edit rejection during pending ledger projection')
        expect(getQueueInputReceipt(db, session.id, interleavedEdit.requestId)?.fingerprint)
          .toBe(queueInputFingerprint({ text: interleavedEdit.content, attachments: editedWhilePending.message.attachments }))
        assertLifecycleInvariants(1)
        const interleavedCancel = entries.find(({ state, messageId }) => state === 'queued' && messageId !== interleavedEdit.messageId)
        expect(interleavedCancel).toBeDefined()
        if (!interleavedCancel) throw new Error('expected another queued entry to cancel during ledger retry')
        operationTrace.push(`cancel-during-ledger-retry:${interleavedCancel.requestId}`)
        expect(storage.commands.deleteQueuedMessage(interleavedCancel.messageId)).toEqual({ ok: true, sessionId: session.id })
        interleavedCancel.state = 'cancelled'
        assertLifecycleInvariants(1)
        expect(storage.execution.releaseExecution(secondTurnLease)).toBe(true)
        expect(updatePersistedTurnState(db, 'random-turn-2', 'terminal', { outcome: 'completed' })).toBe(true)
        const thirdWinner = entries.find(({ state }) => state === 'queued')!
        const thirdClaim = storage.execution.claimQueuedTurn({ sessionId: session.id, userMessageId: thirdWinner.messageId, turnId: 'random-turn-3',
          assistantMessageId: 'random-assistant-3', requestId: thirdWinner.requestId, startToken: 'random-token-3' })
        thirdWinner.state = 'claimed'
        thirdWinner.turnId = 'random-turn-3'
        operationTrace.push(`claim-turn-during-ledger-retry:${thirdWinner.requestId}`)
        expect(thirdClaim.user.message).toMatchObject({ id: thirdWinner.messageId, content: thirdWinner.content, status: 'sent' })
        const thirdOwner = storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn-3', ownerId: 'random-turn-3-owner' })
        expect(thirdOwner).toMatchObject({ acquired: true })
        if (!thirdOwner.acquired) throw new Error('expected third turn execution owner')
        let retryLease = { sessionId: session.id, turnId: 'random-turn-3', ownerId: 'random-turn-3-owner', generation: thirdOwner.generation }
        expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn-2' }))
          .toMatchObject({ state: 'terminal', outcome: 'completed' })
        assertLifecycleInvariants(1)
        const reopenPath = temp.dbPath
        db.close()
        db = openDatabase(reopenPath)
        storage = createSqliteSessionStorage(db)
        let reopenedConn = getDbConnection(db)
        const pending = listPendingCanonicalLedgerProjectionTargets(reopenedConn, ledgerLocation.ledger_location_key)
        expect(pending).toHaveLength(1)
        assertLifecycleInvariants(1)
        expect(storage.queries.readMessage({ sessionId: session.id, messageId: interleavedEdit.messageId }))
          .toMatchObject({ content: interleavedEdit.content, status: interleavedEdit.state === 'claimed' ? 'sent' : 'queued' })
        expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn' }))
          .toMatchObject({ requestId: winner.requestId, userMessageId: winner.messageId, state: 'terminal', outcome: 'completed' })
        expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn-2' }))
          .toMatchObject({ requestId: secondWinner.requestId, userMessageId: secondWinner.messageId, state: 'terminal', outcome: 'completed' })
        expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn-3' }))
          .toMatchObject({ requestId: thirdWinner.requestId, userMessageId: thirdWinner.messageId, state: 'prepared' })
        const seededAdditionalFailures = 1 + (next() % 3)
        for (let retry = 0; retry < seededAdditionalFailures; retry += 1) {
          operationTrace.push(`ledger-retry-failure:${retry + 1}`)
          const retryFailure = await drainCanonicalLedgerProjectionOutbox(reopenedConn, ledgerLocation.ledger_location_key,
            async () => { throw new Error(`seeded random lifecycle retry failure ${retry + 1}`) })
          expect(retryFailure.failedTargetId).toBeTruthy()
          expect(listPendingCanonicalLedgerProjectionTargets(reopenedConn, ledgerLocation.ledger_location_key)).toHaveLength(1)
        const retryActions: Array<{ kind: string; run: () => void }> = [
          { kind: 'append', run: () => {
            const appendNonce = (next() >>> 0).toString(16)
            const appendedRequestId = `random-retry-append-${retry + 1}-${appendNonce}`
            const appendedContent = `random retry append ${appendNonce}`
            const appended = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: appendedRequestId, content: appendedContent })
            expect(appended.duplicate).toBe(false)
            expect(enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: appendedRequestId, content: appendedContent }))
              .toMatchObject({ duplicate: true, persisted: { message: { id: appended.persisted.message.id } } })
            entries.push({ requestId: appendedRequestId, messageId: appended.persisted.message.id, state: 'queued',
              content: appendedContent, turnId: undefined })
            operationTrace.push(`append-during-ledger-retry:${appendedRequestId}`)
          } },
          { kind: 'primary-queue', run: () => {
            const retryQueueEntries = entries.filter(({ state }) => state === 'queued')
            if (retryQueueEntries.length === 0) return
            const retryEntry = retryQueueEntries[next() % retryQueueEntries.length]!
            if ((next() & 1) === 0) {
              retryEntry.content = `${retryEntry.content}-retry-edit-${next()}`
              operationTrace.push(`retry-edit-during-ledger-failure:${retryEntry.requestId}`)
              expect(storage.commands.editQueuedMessage({ sessionId: session.id, messageId: retryEntry.messageId, content: retryEntry.content }))
                .toMatchObject({ ok: true, message: { id: retryEntry.messageId, content: retryEntry.content, status: 'queued' } })
            } else {
              operationTrace.push(`retry-cancel-during-ledger-failure:${retryEntry.requestId}`)
              expect(storage.commands.deleteQueuedMessage(retryEntry.messageId)).toEqual({ ok: true, sessionId: session.id })
              retryEntry.state = 'cancelled'
            }
          } },
          { kind: 'independent-queue', run: () => {
            if (independentPendingState !== 'queued') return
            if ((next() & 1) === 0) {
              independentPendingContent = `${independentPendingContent}-retry-edit-${next()}`
              operationTrace.push(`independent-retry-edit:${retry + 1}`)
              expect(storage.commands.editQueuedMessage({ sessionId: independentSession.id,
                messageId: independentPending.persisted.message.id, content: independentPendingContent }))
                .toMatchObject({ ok: true, message: { id: independentPending.persisted.message.id, content: independentPendingContent, status: 'queued' } })
            } else {
              operationTrace.push(`independent-retry-cancel:${retry + 1}`)
              expect(storage.commands.deleteQueuedMessage(independentPending.persisted.message.id))
                .toEqual({ ok: true, sessionId: independentSession.id })
              independentPendingState = 'cancelled'
            }
          } },
          { kind: 'owner', run: () => {
            if (retry > 0 && (next() & 1) === 0) {
              expect(storage.execution.releaseExecution(retryLease)).toBe(true)
              expect(storage.execution.releaseExecution(retryLease)).toBe(false)
              const retryOwnerId = `random-turn-3-retry-owner-${(next() >>> 0).toString(16)}`
              const retryOwner = storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn-3', ownerId: retryOwnerId })
              expect(retryOwner.acquired).toBe(true)
              if (!retryOwner.acquired) throw new Error('expected seeded retry owner claim')
              expect(retryOwner.generation).toBeGreaterThan(retryLease.generation)
              retryLease = { sessionId: session.id, turnId: 'random-turn-3', ownerId: retryOwnerId, generation: retryOwner.generation }
              expect(storage.execution.claimExecution({ sessionId: session.id, turnId: 'random-turn-3', ownerId: `${retryOwnerId}-rival` }))
                .toMatchObject({ acquired: false })
              operationTrace.push(`primary-retry-owner-generation:${retryLease.generation}`)
            } else {
              expect(storage.execution.releaseExecution(independentLease)).toBe(true)
              expect(storage.execution.releaseExecution(independentLease)).toBe(false)
              const independentOwnerId = `random-independent-retry-owner-${(next() >>> 0).toString(16)}`
              const nextIndependentOwner = storage.execution.claimExecution({ sessionId: independentSession.id,
                turnId: 'random-independent-turn', ownerId: independentOwnerId })
              expect(nextIndependentOwner.acquired).toBe(true)
              if (!nextIndependentOwner.acquired) throw new Error('expected seeded independent retry owner claim')
              expect(nextIndependentOwner.generation).toBeGreaterThan(independentLease.generation)
              independentLease = { sessionId: independentSession.id, turnId: 'random-independent-turn',
                ownerId: independentOwnerId, generation: nextIndependentOwner.generation }
              expect(storage.execution.claimExecution({ sessionId: independentSession.id, turnId: 'random-independent-turn',
                ownerId: `${independentOwnerId}-rival` })).toMatchObject({ acquired: false })
              operationTrace.push(`independent-retry-owner-generation:${independentLease.generation}`)
            }
          } },
        ]
        for (let index = retryActions.length - 1; index > 0; index -= 1) {
          const swapIndex = next() % (index + 1)
          ;[retryActions[index], retryActions[swapIndex]] = [retryActions[swapIndex]!, retryActions[index]!]
        }
        for (const action of retryActions) {
          operationTrace.push(`retry-action:${action.kind}`)
          action.run()
          assertLifecycleInvariants(1)
          expect(listPendingCanonicalLedgerProjectionTargets(reopenedConn, ledgerLocation.ledger_location_key)).toHaveLength(1)
        }
          expect(reopenedConn.prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE status IN ('claimed','executing','transcript_committed')")
            .get()).toMatchObject({ count: 2 })
          expect(reopenedConn.prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')")
            .get(session.id)).toMatchObject({ count: 1 })
          expect(reopenedConn.prepare("SELECT COUNT(*) AS count FROM session_execution_claims WHERE session_id=? AND status IN ('claimed','executing','transcript_committed')")
            .get(independentSession.id)).toMatchObject({ count: 1 })
          assertLifecycleInvariants(1)
          const retryReopenPath = temp.dbPath
          db.close()
          db = openDatabase(retryReopenPath)
          storage = createSqliteSessionStorage(db)
          reopenedConn = getDbConnection(db)
          expect(listPendingCanonicalLedgerProjectionTargets(reopenedConn, ledgerLocation.ledger_location_key)).toHaveLength(1)
          expect(storage.execution.readTurn({ sessionId: session.id, turnId: 'random-turn-3' }))
            .toMatchObject({ state: 'prepared', requestId: thirdWinner.requestId })
          expect(getQueueInputReceipt(db, independentSession.id, 'random-independent-pending-q'))
            .toMatchObject(independentPendingState === 'cancelled'
              ? { state: 'cancelled', queuedMessageId: null }
              : { state: 'queued', queuedMessageId: independentPending.persisted.message.id })
          if (independentPendingState === 'cancelled') {
            expect(storage.queries.readMessage({ sessionId: independentSession.id, messageId: independentPending.persisted.message.id })).toBeUndefined()
          } else {
            expect(storage.queries.readMessage({ sessionId: independentSession.id, messageId: independentPending.persisted.message.id }))
              .toMatchObject({ content: independentPendingContent, status: 'queued' })
          }
          expect(storage.execution.readTurn({ sessionId: independentSession.id, turnId: 'random-independent-turn' }))
            .toMatchObject({ state: 'prepared', requestId: 'random-independent-q' })
          assertLifecycleInvariants(1)
        }
        expect(operationTrace.some((step) => step.startsWith('independent-retry-owner-generation:'))).toBe(true)
        expect(operationTrace.some((step) => step.startsWith('independent-retry-edit:') || step.startsWith('independent-retry-cancel:'))).toBe(true)
        expect(operationTrace.some((step) => step.startsWith('append-during-ledger-retry:'))).toBe(true)
        const firstRetryOperations = operationTrace.slice(operationTrace.indexOf('ledger-retry-failure:1') + 1)
          .filter((step) => step.startsWith('append-during-ledger-retry:') || step.startsWith('retry-edit-during-ledger-failure:') ||
            step.startsWith('retry-cancel-during-ledger-failure:') || step.startsWith('independent-retry-edit:') ||
            step.startsWith('independent-retry-cancel:') || step.startsWith('primary-retry-owner-generation:') ||
            step.startsWith('independent-retry-owner-generation:'))
          .map((step) => step.startsWith('append-') ? 'append' : step.startsWith('retry-') ? 'primary-queue' :
            step.startsWith('independent-retry-edit:') || step.startsWith('independent-retry-cancel:') ? 'independent-queue' : 'owner')
        expect(firstRetryOperations.slice(0, 4)).not.toEqual(['append', 'primary-queue', 'independent-queue', 'owner'])
        expect(await drainCanonicalLedgerProjectionOutbox(reopenedConn, ledgerLocation.ledger_location_key,
          (item) => projectCanonicalSessionLedgerTarget(sink, item))).toEqual({ projected: 1 })
        expect(await drainCanonicalLedgerProjectionOutbox(reopenedConn, ledgerLocation.ledger_location_key,
          (item) => projectCanonicalSessionLedgerTarget(sink, item))).toEqual({ projected: 0 })
        expect(listPendingCanonicalLedgerProjectionTargets(reopenedConn, ledgerLocation.ledger_location_key)).toEqual([])
        assertLifecycleInvariants(1)
        expect(operationTrace.filter((step) => step.startsWith('ledger-retry-failure:')).length).toBe(seededAdditionalFailures)
        expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'tool_result' && event.payload.toolUseId === 'random-ledger-tool')).toHaveLength(1)
        expect(reopenedConn.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
      } finally {
        await sink.close()
      }
    } finally {
      db?.close()
      db = undefined
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${temp.dbPath}${suffix}`, { force: true })
      fs.rmSync(path.dirname(temp.dbPath), { recursive: true, force: true })
    }
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

    const queuedResolution = execution.resolveContinuationAcceptance({ requestId: 'resolve-intent-request', sessionId: session.id, payloadSha256 })
    expect(queuedResolution).toMatchObject({ kind: 'queued', message: { id: queued.message.id, status: 'queued', sequence: queued.sequence } })
    expect(queuedResolution).not.toHaveProperty('message.message')
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
    const turnResolution = storage.execution.resolveContinuationAcceptance({ requestId: 'exact-request', sessionId: session.id, payloadSha256 })
    expect(turnResolution).toMatchObject({ kind: 'turn', turn: { turnId: 'exact-turn' },
      assistant: { id: 'exact-assistant', role: 'assistant', sequence: 1 } })
    expect(turnResolution.kind === 'turn' ? turnResolution.assistant : undefined).not.toHaveProperty('content')
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
    runtime = createSessionTurnRuntime(storage, { deps: { now: () => 10, id: (() => { let id = 0; return () => `launch-${++id}` })() } })
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
