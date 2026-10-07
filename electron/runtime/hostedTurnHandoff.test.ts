import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRunHostedAgentTurn, mockRunHostedAgentTurnWithParticipant, mockSessionParticipants } = vi.hoisted(() => {
  const mockRunHostedAgentTurn = vi.fn()
  const mockSessionParticipants = new Map<string, { db: unknown; history: { read(invocationId: string): Promise<{ events: readonly { kind: string; payload?: unknown }[] }> } }>()
  const mockRunHostedAgentTurnWithParticipant = async (input: Record<string, unknown>) => {
    let result: unknown
    let failure: unknown
    try { result = await mockRunHostedAgentTurn(input) } catch (error) { failure = error }
    const invocationId = String(input.invocationId ?? '')
    const participant = mockSessionParticipants.get(invocationId)
    mockSessionParticipants.delete(invocationId)
    if (participant && input.sessionId && input.turnId && typeof input.sessionTranscriptBaseVersion === 'number') {
      const snapshot = await participant.history.read(invocationId)
      const terminal = [...snapshot.events].reverse().find((event) =>
        event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted'
      )
      if (terminal) {
        const payload = terminal.payload && typeof terminal.payload === 'object' ? terminal.payload as { status?: unknown; reason?: unknown } : {}
        const outcome = terminal.kind === 'invocation-completed' ? 'completed'
          : payload.status === 'cancelled' ? 'cancelled'
            : payload.reason === 'timeout' ? 'timed_out'
              : terminal.kind === 'invocation-interrupted' ? 'interrupted' : 'failed'
        let messages = outcome === 'completed'
          ? (result as { messages?: readonly Record<string, unknown>[] } | undefined)?.messages
          : undefined
        if (!messages) {
          const raw = input.sessionTranscriptFailureMessages as readonly Record<string, unknown>[] | undefined
          const compacted = [...snapshot.events].reverse().find((event) => event.kind === 'transcript-compacted')?.payload
          const canonical = compacted && typeof compacted === 'object' && Array.isArray((compacted as { messages?: unknown }).messages)
            ? (compacted as { messages: readonly Record<string, unknown>[] }).messages : raw ?? []
          const required = input.requiredUserMessage && typeof input.requiredUserMessage === 'object'
            ? JSON.stringify((input.requiredUserMessage as { message?: unknown }).message) : undefined
          const acceptedIndex = required ? canonical.findLastIndex((message) => JSON.stringify(message) === required) : -1
          messages = canonical.slice(0, acceptedIndex >= 0 ? acceptedIndex + 1 : canonical.length)
        }
        commitSessionTranscript(participant.db as AppDatabase, {
          sessionId: String(input.sessionId), turnId: String(input.turnId), baseVersion: input.sessionTranscriptBaseVersion,
          outcome, messages: (messages ?? []).filter((message) => message.role !== 'system')
        })
      }
    }
    if (failure !== undefined) throw failure
    return result
  }
  return { mockRunHostedAgentTurn, mockRunHostedAgentTurnWithParticipant, mockSessionParticipants }
})
const mockLogAgentEvent = vi.hoisted(() => vi.fn())
vi.mock('../../packages/agent-sdk/src/turn', () => ({
  runHostedAgentTurn: (input: Record<string, unknown>) => mockRunHostedAgentTurnWithParticipant(input),
  ToolLoopRoundLimitError: class ToolLoopRoundLimitError extends Error {}
}))
vi.mock('../agentLogger/agentLogger', () => ({ logAgentEvent: (...args: unknown[]) => mockLogAgentEvent(...args) }))

import { DatabaseSync } from 'node:sqlite'
import { createHostedTurnHandoff as createComposedHostedTurnHandoff } from './hostedTurnHandoff'
import { runMigrations } from '../database/migrations'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { appendMessage, createSession, getDbConnection, openDatabase } from '../database'
import type { AppDatabase } from '../database/sqliteStore'
import { claimSessionExecution, commitSessionTranscript, readSessionTranscript, releaseSessionExecution } from '../database/sessionTranscript'
import { reconcileStartupSessionTranscripts } from '../sessionStorage/recovery'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { getProjectedMessage, readSessionTranscriptProjection } from './sessionTranscriptProjection'

type HostedTurnHandoffFixtureInput = Omit<Parameters<typeof createComposedHostedTurnHandoff>[0], 'sessionDb'> & { sessionDb?: AppDatabase }
function createHostedTurnHandoff(input: HostedTurnHandoffFixtureInput) {
  const { sessionDb, ...ports } = input
  if (sessionDb && input.sessionId) mockSessionParticipants.set(input.invocationId, { db: sessionDb, history: input.history })
  const storage = sessionDb ? createSqliteSessionStorage(sessionDb) : undefined
  return createComposedHostedTurnHandoff({
    ...ports,
    ...(storage ? {
      sessionQueries: input.sessionQueries ?? storage.queries,
      sessionExecution: input.sessionExecution ?? storage.execution
    } : {})
  })
}

describe('createHostedTurnHandoff', () => {
  beforeEach(() => { mockRunHostedAgentTurn.mockReset(); mockLogAgentEvent.mockReset() })

  it('rejects a Hosted current user message that conflicts with the AcceptedTurn identity before provider dispatch', async () => {
    const createHostedTurnRuntime = vi.fn(() => ({ host: {}, dispose: async () => undefined }))
    const acceptedTurn = {
      turnId: 'accepted-turn', requestId: 'accepted-request', sessionId: 'accepted-session', lane: 'desktop' as const,
      startToken: 'accepted-token', currentUserMessageId: 'accepted-user', transcriptVersion: 0,
      config: { lane: 'desktop' as const }
    }
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime }, history: { read: async () => ({ events: [] }) } as never,
      invocationId: acceptedTurn.turnId, turnId: acceptedTurn.turnId, acceptedTurn,
      routeId: 'route', sessionId: acceptedTurn.sessionId
    })

    await expect(handoff({
      request: { messages: [{ role: 'user', content: 'different accepted input' }] },
      currentUserMessageId: 'different-user',
      requiredUserMessage: { id: 'different-user', message: { role: 'user', content: 'different accepted input' } }
    })).rejects.toThrow('ACCEPTED_TURN_USER_MESSAGE_ID_MISMATCH')
    expect(createHostedTurnRuntime).not.toHaveBeenCalled()
    expect(mockRunHostedAgentTurn).not.toHaveBeenCalled()
  })

  it('session claim 等待超时后移除排队行，不让后续 turn 永久卡在 FIFO 队首', async () => {
    vi.useFakeTimers()
    try {
    const db = createMemoryAppDb()
    const first = claimSessionExecution(db, { sessionId: 'queue-timeout-session', turnId: 'active-turn', ownerId: 'active-owner' })
    if (!first.acquired) throw new Error('test setup failed to claim session')
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) },
      history: { read: async () => ({ events: [] }) } as never,
      invocationId: 'timed-out-turn', turnId: 'timed-out-turn', routeId: 'route',
      sessionId: 'queue-timeout-session', sessionDb: db
    })

    const pending = handoff({
      request: { messages: [{ role: 'user', content: 'queued then timed out' }] },
      deadlineAt: Date.now() - 1
    } as never)
    const timedOut = expect(pending).rejects.toThrow('SESSION_EXECUTION_QUEUE_TIMEOUT')
    await vi.advanceTimersByTimeAsync(30_001)
    await timedOut
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?')
      .get('queue-timeout-session', 'timed-out-turn')).toBeUndefined()

    expect(releaseSessionExecution(db, {
      sessionId: 'queue-timeout-session', turnId: 'active-turn', ownerId: 'active-owner', generation: first.generation
    })).toBe(true)
    expect(claimSessionExecution(db, { sessionId: 'queue-timeout-session', turnId: 'next-turn', ownerId: 'next-owner' }))
      .toMatchObject({ acquired: true })
    db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces the prior request transcript with latest completed session History before Hosted execution', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
    runMigrations(conn)
    let now = 1
    const history = new SqliteAgentHistory(conn, 1, () => now++, 'session-shadow')
    const priorMessages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]
    await history.appendBatch([
      { invocationId: 'prior', turnId: 'prior-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-context', idempotencyKey: 'prior-context', kind: 'invocation-context-committed', payload: { messages: priorMessages } },
      { invocationId: 'prior', turnId: 'prior-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-done', idempotencyKey: 'prior-done', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    const currentMessage = { role: 'user' as const, content: 'next' }
    const request = { messages: [{ role: 'system' as const, content: 'dynamic' }, ...priorMessages, currentMessage], maxTokens: 100 }
    const dispose = vi.fn(async () => undefined)
    const runtime = { host: {}, dispose }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => runtime) }
    const beforeToolDispatch = vi.fn(() => ({ kind: 'dispatch' as const }))
    mockRunHostedAgentTurn.mockImplementation(async ({ invocationId }: { invocationId: string }) => {
      await history.appendBatch([
        { invocationId, turnId: 'new-turn', sequence: 1, schemaVersion: 1, eventId: 'new-context', idempotencyKey: 'new-context', kind: 'invocation-context-committed', payload: { messages: request.messages } },
        { invocationId, turnId: 'new-turn', sequence: 2, schemaVersion: 1, eventId: 'new-done', idempotencyKey: 'new-done', kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
      return { text: 'done', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 }, messages: [] }
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history, invocationId: 'current', turnId: 'new-turn', routeId: 'route', sessionId: 'session-shadow' })

    await expect(handoff({ request, requiredUserMessage: { id: 'current-user', message: currentMessage }, beforeToolDispatch })).resolves.toMatchObject({ result: { ok: true } })

    expect(mockLogAgentEvent).toHaveBeenCalledWith('info', 'history.cutover', expect.objectContaining({
      requestId: 'current', turnId: 'new-turn', sessionId: 'session-shadow', stage: 'match-current-message',
      reasonCode: 'matched', outcome: 'matched', historyStreamId: 'prior', previousTurnId: 'prior-turn', snapshotVersion: 2
    }))
    expect(mockRunHostedAgentTurn).toHaveBeenCalledOnce()
    expect(agentSdk.createHostedTurnRuntime).toHaveBeenCalledWith(expect.objectContaining({ beforeToolDispatch }))
    expect(mockRunHostedAgentTurn.mock.calls[0]?.[0]).toMatchObject({
      request: { messages: [{ role: 'system', content: 'dynamic' }, ...priorMessages, currentMessage] }
    })
    await conn.close()
  })

  it('fails closed on request transcript drift before creating the Hosted runtime', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
    runMigrations(conn)
    const history = new SqliteAgentHistory(conn, 1, () => 1, 'session-drift')
    await history.appendBatch([
      { invocationId: 'prior', turnId: 'prior-turn', sequence: 1, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'canonical' }] } },
      { invocationId: 'prior', turnId: 'prior-turn', sequence: 2, schemaVersion: 1, eventId: 'done', idempotencyKey: 'done', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    const createHostedTurnRuntime = vi.fn()
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime }, history, invocationId: 'current', turnId: 'current-turn', routeId: 'route', sessionId: 'session-drift'
    })
    const required = { role: 'user' as const, content: 'next' }

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'trimmed or drifted' }, required], maxTokens: 100 }, requiredUserMessage: { id: 'current-user', message: required } })).rejects.toThrow('Canonical session History')

    expect(createHostedTurnRuntime).not.toHaveBeenCalled()
    expect(mockRunHostedAgentTurn).not.toHaveBeenCalled()
    expect(mockLogAgentEvent).toHaveBeenCalledWith('warn', 'history.cutover', expect.objectContaining({
      requestId: 'current', turnId: 'current-turn', sessionId: 'session-drift', reasonCode: 'transcript-mismatch',
      stage: 'match-current-message', outcome: 'rejected', historyStreamId: 'prior', previousTurnId: 'prior-turn', snapshotVersion: 2
    }))
    await conn.close()
  })

  it('fails closed when a prior session stream has no completed canonical transcript', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
    runMigrations(conn)
    const history = new SqliteAgentHistory(conn, 1, () => 1, 'session-open')
    await history.appendBatch([
      { invocationId: 'prior', turnId: 'prior-turn', sequence: 1, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'hello' }] } }
    ], 0)
    const createHostedTurnRuntime = vi.fn()
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime }, history, invocationId: 'current', turnId: 'current-turn', routeId: 'route', sessionId: 'session-open'
    })
    const required = { role: 'user' as const, content: 'next' }

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }, required] }, requiredUserMessage: { id: 'current-user', message: required } })).rejects.toThrow('Canonical session History')

    expect(createHostedTurnRuntime).not.toHaveBeenCalled()
    expect(mockRunHostedAgentTurn).not.toHaveBeenCalled()
    await conn.close()
  })

  it('records the read-history failure stage without exposing transcript content', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
    runMigrations(conn)
    const history = new SqliteAgentHistory(conn, 1, () => 1, 'session-read-failure')
    vi.spyOn(history, 'readLatestInvocationForSession').mockRejectedValue(new Error('private transcript body'))
    const createHostedTurnRuntime = vi.fn()
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime }, history, invocationId: 'read-current', turnId: 'read-turn', routeId: 'route', sessionId: 'session-read-failure'
    })
    const required = { role: 'user' as const, content: 'private current message' }

    await expect(handoff({ request: { messages: [required] }, requiredUserMessage: { id: 'read-user', message: required } }))
      .rejects.toThrow('Canonical session History')

    expect(createHostedTurnRuntime).not.toHaveBeenCalled()
    expect(mockLogAgentEvent).toHaveBeenCalledWith('warn', 'history.cutover', expect.objectContaining({
      requestId: 'read-current', turnId: 'read-turn', sessionId: 'session-read-failure',
      stage: 'read-history', reasonCode: 'history-read-failed', outcome: 'rejected'
    }))
    expect(JSON.stringify(mockLogAgentEvent.mock.calls)).not.toContain('private')
    await conn.close()
  })

  it('records the select-snapshot stage and prior stream when the newest stream is unavailable', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
    runMigrations(conn)
    const history = new SqliteAgentHistory(conn, 1, () => 1, 'session-unavailable')
    await history.appendBatch([
      { invocationId: 'prior-open', turnId: 'prior-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-context', idempotencyKey: 'prior-context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'private prior transcript' }] } },
      { invocationId: 'prior-open', turnId: 'prior-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-open-event', idempotencyKey: 'prior-open-event', kind: 'model-request-started', payload: { requestId: 'private partial answer' } }
    ], 0)
    const createHostedTurnRuntime = vi.fn()
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime }, history, invocationId: 'unavailable-current', turnId: 'unavailable-turn', routeId: 'route', sessionId: 'session-unavailable'
    })
    const required = { role: 'user' as const, content: 'next' }

    await expect(handoff({ request: { messages: [required] }, requiredUserMessage: { id: 'unavailable-user', message: required } }))
      .rejects.toThrow('Canonical session History')

    expect(createHostedTurnRuntime).not.toHaveBeenCalled()
    expect(mockLogAgentEvent).toHaveBeenCalledWith('warn', 'history.cutover', expect.objectContaining({
      requestId: 'unavailable-current', turnId: 'unavailable-turn', sessionId: 'session-unavailable',
      stage: 'select-snapshot', reasonCode: 'history-unavailable', outcome: 'rejected',
      historyStreamId: 'prior-open', previousTurnId: 'prior-turn', snapshotVersion: 2
    }))
    expect(JSON.stringify(mockLogAgentEvent.mock.calls)).not.toContain('private')
    await conn.close()
  })

  it('从纯 session-input + process-restart History 安全恢复已接受用户消息', async () => {
    const temp = createTempDatabase('hosted-restart-canonical-only-')
    let db = temp.db
    const session = createSession(db, { name: 'restart-recovery', model: 'model' })
    const earlierUser = appendMessage(db, {
      id: 'restart-earlier-user', sessionId: session.id, role: 'user', content: 'earlier completed request',
      timestamp: 5, status: 'sent'
    }).message
    const earlierAssistant = appendMessage(db, {
      id: 'restart-earlier-assistant', sessionId: session.id, role: 'assistant', content: 'earlier completed answer',
      timestamp: 6, status: 'completed'
    }).message
    const prior = appendMessage(db, {
      id: 'restart-accepted-user', sessionId: session.id, role: 'user', content: 'previous accepted request',
      timestamp: 10, status: 'sent'
    }).message
    let history = new SqliteAgentHistory(getDbConnection(db), 1, () => 1, session.id)
    const acceptedTurnId = 'restart-interrupted-turn'
    const earlierTranscript = [
      { id: earlierUser.id, role: 'user' as const, content: earlierUser.content, timestamp: earlierUser.timestamp },
      { id: earlierAssistant.id, role: 'assistant' as const, content: earlierAssistant.content, timestamp: earlierAssistant.timestamp }
    ]
    await history.appendBatch([
      { invocationId: 'restart-earlier-history', turnId: 'restart-earlier-turn', sequence: 1, schemaVersion: 1,
        eventId: 'earlier-context', idempotencyKey: 'earlier-context', kind: 'invocation-context-committed',
        payload: { messages: [
          ...earlierTranscript,
          { id: prior.id, role: 'user', content: prior.content, timestamp: prior.timestamp }
        ] } },
      { invocationId: 'restart-earlier-history', turnId: 'restart-earlier-turn', sequence: 2, schemaVersion: 1,
        eventId: 'earlier-completed', idempotencyKey: 'earlier-completed', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    await history.appendBatch([
      { invocationId: 'restart-interrupted-history', turnId: acceptedTurnId, sequence: 1, schemaVersion: 1,
        eventId: 'restart-input', idempotencyKey: 'restart-input', kind: 'session-input-committed',
        payload: { sessionId: session.id, messageId: prior.id, role: 'user', inputFingerprint: queueInputFingerprint({ text: prior.content }) } },
      { invocationId: 'restart-interrupted-history', turnId: acceptedTurnId, sequence: 2, schemaVersion: 1,
        eventId: 'restart-terminal', idempotencyKey: 'restart-terminal', kind: 'invocation-interrupted',
        payload: { status: 'interrupted', reason: 'process-restart' } }
    ], 0)
    let conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get(prior.id)).toEqual({ content: '' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({
      source: 'canonical:L2', messages: [
        { id: earlierUser.id, content: earlierUser.content },
        { id: earlierAssistant.id, content: earlierAssistant.content },
        { id: prior.id, content: prior.content }
      ]
    })
    expect(getProjectedMessage(db, prior.id)?.content).toBe(prior.content)
    db.close()
    db = openDatabase(temp.dbPath)
    conn = getDbConnection(db)
    history = new SqliteAgentHistory(conn, 1, () => 1, session.id)
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(prior.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    expect(getProjectedMessage(db, prior.id)?.content).toBe(prior.content)
    const current = { role: 'user' as const, content: 'continue after restart' }
    const request = { messages: [{ role: 'system' as const, content: 'dynamic' }, ...earlierTranscript,
      { id: prior.id, role: 'user' as const, content: prior.content, timestamp: prior.timestamp }, current], maxTokens: 100 }
    mockRunHostedAgentTurn.mockImplementationOnce(async ({ invocationId, request: hostedRequest }: {
      invocationId: string; request: { messages: unknown[] }
    }) => {
      await history.appendBatch([
        { invocationId, turnId: 'restart-retry-turn', sequence: 1, schemaVersion: 1,
          eventId: 'retry-context', idempotencyKey: 'retry-context', kind: 'invocation-context-committed',
          payload: { messages: hostedRequest.messages } },
        { invocationId, turnId: 'restart-retry-turn', sequence: 2, schemaVersion: 1,
          eventId: 'retry-completed', idempotencyKey: 'retry-completed', kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
      return { text: 'done', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 },
        messages: [...hostedRequest.messages, { role: 'assistant', content: 'done' }] }
    })
    const baseQueries = createSqliteSessionStorage(db).queries
    const readMessage = vi.fn(baseQueries.readMessage)
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) },
      history, invocationId: 'restart-retry-invocation', turnId: 'restart-retry-turn', routeId: 'route',
      sessionId: session.id, sessionDb: db, sessionQueries: Object.freeze({ ...baseQueries, readMessage })
    })

    await expect(handoff({ request, requiredUserMessage: { id: 'current-user', message: current } })).resolves.toMatchObject({ result: { ok: true } })

    expect(readMessage).toHaveBeenCalledWith({ sessionId: session.id, messageId: prior.id })
    expect(mockRunHostedAgentTurn.mock.calls.at(-1)?.[0]).toMatchObject({ request: { messages: [
      { role: 'system', content: 'dynamic' }, ...earlierTranscript,
      { role: 'user', content: prior.content }, current
    ] } })
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 1, status: 'ready', messages: [
      ...earlierTranscript, { role: 'user', content: prior.content }, current, { role: 'assistant', content: 'done' }
    ] })
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get(prior.id)).toEqual({ content: '' })

    const nextUser = { role: 'user' as const, content: 'request ending in provider failure' }
    const nextUserSkeleton = appendMessage(db, { id: 'restart-next-user', sessionId: session.id, role: 'user',
      content: nextUser.content, timestamp: 20, status: 'sent' }).message
    mockRunHostedAgentTurn.mockImplementationOnce(async ({ invocationId, request: hostedRequest }: {
      invocationId: string; request: { messages: unknown[] }
    }) => {
      await history.appendBatch([
        { invocationId, turnId: 'restart-failed-turn', sequence: 1, schemaVersion: 1,
          eventId: 'restart-failed-context', idempotencyKey: 'restart-failed-context', kind: 'invocation-context-committed',
          payload: { messages: hostedRequest.messages } },
        { invocationId, turnId: 'restart-failed-turn', sequence: 2, schemaVersion: 1,
          eventId: 'restart-failed-terminal', idempotencyKey: 'restart-failed-terminal', kind: 'invocation-failed',
          payload: { status: 'failed', reason: 'provider-error' } }
      ], 0)
      throw new Error('provider failed')
    })
    const failedHandoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) },
      history, invocationId: 'restart-failed-invocation', turnId: 'restart-failed-turn', routeId: 'route',
      sessionId: session.id, sessionDb: db
    })
    await expect(failedHandoff({ request: { messages: [nextUser], maxTokens: 100 },
      requiredUserMessage: { id: nextUserSkeleton.id, message: nextUser } }))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'failed' })
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 2, status: 'ready', messages: [
      ...earlierTranscript, { role: 'user', content: prior.content }, current,
      { role: 'assistant', content: 'done' }, nextUser
    ] })
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(prior.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    db.close()
    temp.cleanup()
  })

  it('恢复旧 accepted input 时匹配重复文本的正确出现位置且不要求 API 消息带数据库时间戳', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'restart-empty-input', model: 'model' })
    const earlier = appendMessage(db, { id: 'restart-empty-earlier', sessionId: session.id, role: 'user', content: 'previous conversation', timestamp: 5, status: 'sent' }).message
    const accepted = appendMessage(db, { id: 'restart-empty-accepted', sessionId: session.id, role: 'user', content: earlier.content, timestamp: 10, status: 'sent' }).message
    const conn = getDbConnection(db)
    let historyClock = 0
    const history = new SqliteAgentHistory(conn, 1, () => ++historyClock, session.id)
    const acceptedTurnId = 'restart-empty-interrupted-turn'
    const priorTurnId = 'restart-empty-failed-turn'
    await history.appendBatch([
      { invocationId: 'restart-empty-earlier-history', turnId: 'restart-empty-earlier-turn', sequence: 1, schemaVersion: 1,
        eventId: 'restart-empty-earlier-context', idempotencyKey: 'restart-empty-earlier-context', kind: 'invocation-context-committed',
        payload: { messages: [{ role: 'user', content: earlier.content, timestamp: earlier.timestamp }] } },
      { invocationId: 'restart-empty-earlier-history', turnId: 'restart-empty-earlier-turn', sequence: 2, schemaVersion: 1,
        eventId: 'restart-empty-earlier-done', idempotencyKey: 'restart-empty-earlier-done', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    const beforeAccepted = history.listInvocationIdsForSession(session.id)
    await history.appendBatch([
      { invocationId: acceptedTurnId, turnId: acceptedTurnId, sequence: 1, schemaVersion: 1,
        eventId: 'restart-empty-input', idempotencyKey: 'restart-empty-input', kind: 'session-input-committed',
        payload: { sessionId: session.id, messageId: accepted.id, role: 'user', inputFingerprint: queueInputFingerprint({ text: accepted.content }) } }
    ], 0)
    await history.appendBatch([
      { invocationId: acceptedTurnId, turnId: acceptedTurnId, sequence: 2, schemaVersion: 1,
        eventId: 'restart-empty-terminal', idempotencyKey: 'restart-empty-terminal', kind: 'invocation-interrupted',
        payload: { status: 'interrupted', reason: 'process-restart' } }
    ], 1)
    expect(history.listInvocationIdsForSession(session.id)).toEqual([...beforeAccepted, acceptedTurnId])
    await history.appendBatch([
      { invocationId: 'restart-empty-failed-latest', turnId: priorTurnId, sequence: 1, schemaVersion: 1,
        eventId: 'restart-empty-failed-context', idempotencyKey: 'restart-empty-failed-context', kind: 'invocation-context-committed',
        payload: { messages: [{ role: 'user', content: earlier.content, timestamp: earlier.timestamp }, { role: 'user', content: 'failed attempt' }] } },
      { invocationId: 'restart-empty-failed-latest', turnId: priorTurnId, sequence: 2, schemaVersion: 1,
        eventId: 'restart-empty-failed-terminal', idempotencyKey: 'restart-empty-failed-terminal', kind: 'invocation-failed', payload: { status: 'failed' } }
    ], 0)
    expect(history.listInvocationIdsForSession(session.id)).toEqual([...beforeAccepted, acceptedTurnId, 'restart-empty-failed-latest'])
    const current = { role: 'user' as const, content: 'please continue' }
    const request = { messages: [
      { role: 'system' as const, content: 'dynamic' },
      { role: 'user' as const, content: earlier.content, timestamp: earlier.timestamp },
      { role: 'user' as const, content: accepted.content },
      { role: 'assistant' as const, content: ' ' },
      { role: 'user' as const, content: 'retry request context' },
      current
    ], maxTokens: 100 }
    mockRunHostedAgentTurn.mockImplementationOnce(async ({ invocationId, request: hostedRequest }: {
      invocationId: string; request: { messages: unknown[] }
    }) => {
      await history.appendBatch([
        { invocationId, turnId: 'restart-empty-retry-turn', sequence: 1, schemaVersion: 1,
          eventId: 'restart-empty-retry-context', idempotencyKey: 'restart-empty-retry-context', kind: 'invocation-context-committed', payload: { messages: hostedRequest.messages } },
        { invocationId, turnId: 'restart-empty-retry-turn', sequence: 2, schemaVersion: 1,
          eventId: 'restart-empty-retry-done', idempotencyKey: 'restart-empty-retry-done', kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
      return { text: 'done', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 }, messages: [...hostedRequest.messages] }
    })
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) },
      history, invocationId: 'restart-empty-retry-invocation', turnId: 'restart-empty-retry-turn', routeId: 'route',
      sessionId: session.id, sessionDb: db
    })

    await expect(handoff({ request, requiredUserMessage: { id: 'current-user', message: current } })).resolves.toMatchObject({ result: { ok: true } })

    expect(mockRunHostedAgentTurn.mock.calls.at(-1)?.[0].request.messages).toEqual([
      { role: 'system', content: 'dynamic' },
      { role: 'user', content: earlier.content, timestamp: earlier.timestamp },
      { role: 'user', content: accepted.content },
      current
    ])
    db.close()
  })

  it('does not fall back to an older completed transcript when the newest session invocation was interrupted', async () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
    runMigrations(conn)
    const history = new SqliteAgentHistory(conn, 1, () => 1, 'session-latest-interrupted')
    await history.appendBatch([
      { invocationId: 'older-completed', turnId: 'older-turn', sequence: 1, schemaVersion: 1, eventId: 'older-context', idempotencyKey: 'older-context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'older canonical transcript' }] } },
      { invocationId: 'older-completed', turnId: 'older-turn', sequence: 2, schemaVersion: 1, eventId: 'older-done', idempotencyKey: 'older-done', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    await history.appendBatch([
      { invocationId: 'newest-interrupted', turnId: 'newest-turn', sequence: 1, schemaVersion: 1, eventId: 'newest-context', idempotencyKey: 'newest-context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'newer partial transcript' }] } },
      { invocationId: 'newest-interrupted', turnId: 'newest-turn', sequence: 2, schemaVersion: 1, eventId: 'newest-interrupted-terminal', idempotencyKey: 'newest-interrupted-terminal', kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } }
    ], 0)
    const createHostedTurnRuntime = vi.fn()
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime }, history, invocationId: 'current', turnId: 'current-turn', routeId: 'route', sessionId: 'session-latest-interrupted'
    })
    const required = { role: 'user' as const, content: 'new request' }

    await expect(handoff({
      request: { messages: [{ role: 'user', content: 'older canonical transcript' }, required] },
      requiredUserMessage: { id: 'current-user', message: required }
    })).rejects.toThrow('Canonical session History')

    expect(createHostedTurnRuntime).not.toHaveBeenCalled()
    expect(mockRunHostedAgentTurn).not.toHaveBeenCalled()
    await conn.close()
  })

  it('classifies a cancelled canonical terminal without sessionLedger as cancelled', async () => {
    const db = createMemoryAppDb()
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-interrupted', payload: { status: 'cancelled' } }] })) }
    mockRunHostedAgentTurn.mockResolvedValue({ text: '', modelTurns: 0, finishReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 }, messages: [] })
    const user = { role: 'user' as const, content: 'hello' }
    const handoff = createHostedTurnHandoff({ agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) }, history: history as never, invocationId: 'cancelled-no-ledger', turnId: 'cancelled-turn', routeId: 'route', sessionId: 'cancel-session', sessionDb: db })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'cancel-user', message: user } } as never)).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'cancelled'
    })
    expect(readSessionTranscript(db, 'cancel-session')).toMatchObject({ version: 1, status: 'ready', messages: [user] })
    db.close()
  })

  it('preserves timed-out terminal outcome in the caller error and committed transcript', async () => {
    const db = createMemoryAppDb()
    const failure = new Error('deadline exceeded')
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-failed', payload: { status: 'failed', reason: 'timeout' } }] })) }
    mockRunHostedAgentTurn.mockRejectedValue(failure)
    const user = { role: 'user' as const, content: 'finish this task' }
    const handoff = createHostedTurnHandoff({ agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) }, history: history as never, invocationId: 'timeout-invocation', turnId: 'timeout-turn', routeId: 'route', sessionId: 'timeout-session', sessionDb: db })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'timeout-user', message: user } } as never)).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'timed-out'
    })
    expect(getDbConnection(db).prepare('SELECT outcome FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get('timeout-session', 'timeout-turn')).toEqual({ outcome: 'timed_out' })
    expect(readSessionTranscript(db, 'timeout-session')).toMatchObject({ version: 1, status: 'ready', messages: [user] })
    db.close()
  })

  it('preserves interrupted terminal outcome in both caller error and committed transcript', async () => {
    const db = createMemoryAppDb()
    const failure = new Error('process stopped during turn')
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } }] })) }
    mockRunHostedAgentTurn.mockRejectedValue(failure)
    const user = { role: 'user' as const, content: 'continue after recovery' }
    const handoff = createHostedTurnHandoff({ agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) }, history: history as never, invocationId: 'interrupted-invocation', turnId: 'interrupted-turn', routeId: 'route', sessionId: 'interrupted-session', sessionDb: db })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'interrupted-user', message: user } } as never)).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'interrupted'
    })
    expect(getDbConnection(db).prepare('SELECT outcome FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get('interrupted-session', 'interrupted-turn')).toEqual({ outcome: 'interrupted' })
    expect(readSessionTranscript(db, 'interrupted-session')).toMatchObject({ version: 1, status: 'ready', messages: [user] })
    db.close()
  })

  it('preserves the tool loop stop diagnostic committed in canonical History', async () => {
    const failure = new Error('same tool error repeated 2 times; stopped: SHELL_DIALECT_MISMATCH')
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-failed', payload: { status: 'failed', reason: failure.message, errorCode: 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED' } }] })) }
    mockRunHostedAgentTurn.mockRejectedValue(failure)
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: history as never, invocationId: 'tool-loop-stop', turnId: 'tool-loop-stop', routeId: 'route'
    })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'inspect this' }] } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'failed', message: failure.message })
  })

  it('preserves SHELL_DIALECT_MISMATCH from the failed invocation terminal', async () => {
    const reason = 'SHELL_DIALECT_MISMATCH: use POSIX Bash syntax'
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-failed', payload: { status: 'failed', reason, errorCode: 'SHELL_DIALECT_MISMATCH' } }] })) }
    mockRunHostedAgentTurn.mockRejectedValue(Object.assign(new Error(reason), { code: 'SHELL_DIALECT_MISMATCH' }))
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: history as never, invocationId: 'dialect-mismatch', turnId: 'dialect-mismatch', routeId: 'route'
    })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'check command' }] } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'failed', message: reason })
  })

  it.each([
    ['failed', { kind: 'invocation-failed', payload: { status: 'failed', reason: 'provider-error' } }, 'failed'],
    ['cancelled', { kind: 'invocation-interrupted', payload: { status: 'cancelled', reason: 'user-cancelled' } }, 'cancelled'],
    ['timed_out', { kind: 'invocation-failed', payload: { status: 'failed', reason: 'timeout' } }, 'timed_out'],
    ['interrupted', { kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } }, 'interrupted']
  ] as const)('terminal matrix retains only accepted input for %s', async (label, terminal, expectedOutcome) => {
    const db = createMemoryAppDb()
    const history = { read: vi.fn(async () => ({ events: [terminal] })) }
    mockRunHostedAgentTurn.mockRejectedValue(new Error(`${label} terminal`))
    const user = { role: 'user' as const, content: `accepted ${label}` }
    const partial = { role: 'assistant' as const, content: 'uncommitted partial answer' }
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: history as never, invocationId: `matrix-${label}`, turnId: `matrix-turn-${label}`,
      routeId: 'route', sessionId: `matrix-session-${label}`, sessionDb: db
    })

    await expect(handoff({ request: { messages: [user, partial] }, requiredUserMessage: { id: `user-${label}`, message: user } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError' })
    expect(getDbConnection(db).prepare('SELECT outcome,messages_json FROM session_transcript_entries WHERE session_id=?')
      .get(`matrix-session-${label}`)).toEqual({ outcome: expectedOutcome, messages_json: JSON.stringify([user]) })
    expect(readSessionTranscript(db, `matrix-session-${label}`)).toMatchObject({ version: 1, status: 'ready', messages: [user] })
    db.close()
  })

  it.each([
    ['cancelled', { kind: 'invocation-interrupted', payload: { status: 'cancelled', reason: 'user-cancelled' } }, 'cancelled'],
    ['timed_out', { kind: 'invocation-failed', payload: { status: 'failed', reason: 'timeout' } }, 'timed_out'],
    ['interrupted', { kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } }, 'interrupted']
  ] as const)('canonical-only reopen preserves Hosted %s terminal outcome and transcript', async (label, terminal, expectedOutcome) => {
    const temp = createTempDatabase(`hosted-${label}-canonical-only-`)
    let db = temp.db
    const session = createSession(db, { name: `hosted ${label}`, model: 'model' })
    const priorUserRow = appendMessage(db, { id: `hosted-${label}-prior-user`, sessionId: session.id, role: 'user',
      content: 'prior canonical user', timestamp: 1, status: 'sent' }).message
    const priorAssistantRow = appendMessage(db, { id: `hosted-${label}-prior-assistant`, sessionId: session.id, role: 'assistant',
      content: 'prior canonical assistant', timestamp: 2, status: 'completed' }).message
    const currentRow = appendMessage(db, { id: `hosted-${label}-current-user`, sessionId: session.id, role: 'user',
      content: `current ${label}`, timestamp: 3, status: 'sent' }).message
    const priorUser = { id: priorUserRow.id, role: 'user' as const, content: priorUserRow.content, timestamp: priorUserRow.timestamp }
    const priorAssistant = { id: priorAssistantRow.id, role: 'assistant' as const, content: priorAssistantRow.content, timestamp: priorAssistantRow.timestamp }
    const currentUser = { id: currentRow.id, role: 'user' as const, content: currentRow.content, timestamp: currentRow.timestamp }
    let conn = getDbConnection(db)
    let history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: `hosted-${label}-prior`, turnId: `hosted-${label}-prior-turn`, sequence: 1, schemaVersion: 1,
        eventId: `hosted-${label}-prior-context`, idempotencyKey: `hosted-${label}-prior-context`, kind: 'invocation-context-committed',
        payload: { messages: [priorUser, priorAssistant] } },
      { invocationId: `hosted-${label}-prior`, turnId: `hosted-${label}-prior-turn`, sequence: 2, schemaVersion: 1,
        eventId: `hosted-${label}-prior-terminal`, idempotencyKey: `hosted-${label}-prior-terminal`, kind: 'invocation-completed',
        payload: { status: 'completed' } }
    ], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id IN (?,?)").run(priorUserRow.id, priorAssistantRow.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    db.close()

    db = openDatabase(temp.dbPath)
    conn = getDbConnection(db)
    history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    const invocationId = `hosted-${label}-current`
    const turnId = `hosted-${label}-current-turn`
    const currentContext = { invocationId, turnId, sequence: 1, schemaVersion: 1,
      eventId: `hosted-${label}-current-context`, idempotencyKey: `hosted-${label}-current-context`,
      kind: 'invocation-context-committed', payload: { messages: [priorUser, priorAssistant, currentUser] } }
    const currentTerminal = { invocationId, turnId, sequence: 2, schemaVersion: 1,
      eventId: `hosted-${label}-current-terminal`, idempotencyKey: `hosted-${label}-current-terminal`,
      kind: terminal.kind, payload: terminal.payload }
    mockRunHostedAgentTurn.mockImplementationOnce(async () => {
      await history.appendBatch([currentContext as never, currentTerminal as never], 0)
      throw new Error(`${label} terminal`)
    })
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history, invocationId, turnId, routeId: 'route', sessionId: session.id, sessionDb: db
    })

    await expect(handoff({ request: { messages: [priorUser, priorAssistant, currentUser] },
      requiredUserMessage: { id: currentUser.id, message: currentUser } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: expectedOutcome === 'timed_out' ? 'timed-out' : expectedOutcome })
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 1, status: 'ready', messages: [priorUser, priorAssistant, currentUser] })
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(priorUserRow.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get(priorAssistantRow.id))
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    db.close()
    temp.cleanup()
  })

  it('fails closed when a canonical prior event is detached from its owning session', async () => {
    const temp = createTempDatabase('hosted-detached-event-owner-')
    const db = temp.db
    const session = createSession(db, { name: 'detached event owner', model: 'model' })
    const priorUser = { id: 'detached-prior-user', role: 'user' as const, content: 'prior canonical user', timestamp: 1 }
    const priorAssistant = { id: 'detached-prior-assistant', role: 'assistant' as const, content: 'prior canonical assistant', timestamp: 2 }
    const currentUser = { id: 'detached-current-user', role: 'user' as const, content: 'current user', timestamp: 3 }
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'detached-prior', turnId: 'detached-prior-turn', sequence: 1, schemaVersion: 1,
        eventId: 'detached-context', idempotencyKey: 'detached-context', kind: 'invocation-context-committed',
        payload: { messages: [priorUser, priorAssistant] } },
      { invocationId: 'detached-prior', turnId: 'detached-prior-turn', sequence: 2, schemaVersion: 1,
        eventId: 'detached-terminal', idempotencyKey: 'detached-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare("UPDATE agent_history_events SET session_id='foreign-session',session_seq=NULL,commit_order=NULL WHERE invocation_id='detached-prior' AND sequence=2").run()
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) },
      history, invocationId: 'detached-current', turnId: 'detached-current-turn', routeId: 'route', sessionId: session.id, sessionDb: db
    })

    await expect(handoff({ request: { messages: [priorUser, priorAssistant, currentUser] },
      requiredUserMessage: { id: currentUser.id, message: currentUser } } as never))
      .rejects.toThrow('Canonical session History could not safely provide the Hosted transcript')
    expect(mockRunHostedAgentTurn).not.toHaveBeenCalled()
    db.close()
    temp.cleanup()
  })

  it.each([
    ['failed', { kind: 'invocation-failed', payload: { status: 'failed', reason: 'provider-error' } }, 'failed'],
    ['cancelled', { kind: 'invocation-interrupted', payload: { status: 'cancelled', reason: 'user-cancelled' } }, 'cancelled'],
    ['timed_out', { kind: 'invocation-failed', payload: { status: 'failed', reason: 'timeout' } }, 'timed_out'],
    ['interrupted', { kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } }, 'interrupted']
  ] as const)('first legacy History cutover preserves prior transcript when the initial turn ends %s', async (label, terminal, expectedOutcome) => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const history = new SqliteAgentHistory(conn, 1, () => Date.now(), `first-cutover-${label}`)
    const priorUser = { role: 'user' as const, content: 'prior user context' }
    const priorAssistant = { role: 'assistant' as const, content: 'prior assistant context' }
    await history.appendBatch([
      { invocationId: 'prior-completed', turnId: 'prior-turn', sequence: 1, schemaVersion: 1, eventId: 'prior-context', idempotencyKey: 'prior-context', kind: 'invocation-context-committed', payload: { messages: [priorUser, priorAssistant] } },
      { invocationId: 'prior-completed', turnId: 'prior-turn', sequence: 2, schemaVersion: 1, eventId: 'prior-terminal', idempotencyKey: 'prior-terminal', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    const currentUser = { role: 'user' as const, content: `accepted ${label} request` }
    const originalRead = history.read.bind(history)
    vi.spyOn(history, 'read').mockImplementation(async (invocationId: string) => invocationId === `failed-invocation-${label}`
      ? ({ invocationId, version: 2, schemaVersion: 1, events: [
          { invocationId, turnId: `failed-turn-${label}`, sequence: 1, schemaVersion: 1, eventId: 'current-context', idempotencyKey: 'current-context', kind: 'invocation-context-committed', payload: { messages: [priorUser, priorAssistant, currentUser] } },
          { invocationId, turnId: `failed-turn-${label}`, sequence: 2, schemaVersion: 1, eventId: 'current-terminal', idempotencyKey: 'current-terminal', kind: terminal.kind, payload: terminal.payload }
        ] } as never)
      : originalRead(invocationId))
    mockRunHostedAgentTurn.mockRejectedValueOnce(new Error(`${label} after dispatch`))
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history, invocationId: `failed-invocation-${label}`, turnId: `failed-turn-${label}`,
      routeId: 'route', sessionId: `first-cutover-${label}`, sessionDb: db
    })

    await expect(handoff({
      request: { messages: [priorUser, priorAssistant, currentUser] },
      requiredUserMessage: { id: `current-user-${label}`, message: currentUser }
    } as never)).rejects.toMatchObject({ name: 'HostedTurnFinalizedError' })

    expect(readSessionTranscript(db, `first-cutover-${label}`)).toMatchObject({
      version: 1, status: 'ready',
      messages: [priorUser, priorAssistant, currentUser]
    })
    expect(conn.prepare('SELECT outcome FROM session_transcript_entries WHERE session_id=?').get(`first-cutover-${label}`))
      .toEqual({ outcome: expectedOutcome })
    db.close()
  })

  it('reads the committed transcript checkpoint on the next turn and advances its version', async () => {
    const db = createMemoryAppDb()
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] })) }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) }
    mockRunHostedAgentTurn
      .mockResolvedValueOnce({ text: 'answer-1', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer-1' }] })
      .mockResolvedValueOnce({ text: 'answer-2', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer-1' }, { role: 'user', content: 'second' }, { role: 'assistant', content: 'answer-2' }] })
    const first = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'legacy-r1', turnId: 'turn-1', routeId: 'route', sessionId: 'checkpoint-session', sessionDb: db })
    const firstUser = { role: 'user' as const, content: 'first' }
    await first({ request: { messages: [firstUser] }, requiredUserMessage: { id: 'u1', message: firstUser } })
    expect(readSessionTranscript(db, 'checkpoint-session')).toMatchObject({ version: 1, lastTurnId: 'turn-1', status: 'ready' })

    const second = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'legacy-r2', turnId: 'turn-2', routeId: 'route', sessionId: 'checkpoint-session', sessionDb: db })
    const secondUser = { role: 'user' as const, content: 'second' }
    await second({ request: { messages: [{ role: 'system', content: 'dynamic' }, secondUser] }, requiredUserMessage: { id: 'u2', message: secondUser } })
    expect(mockRunHostedAgentTurn.mock.calls.at(-1)?.[0]).toMatchObject({ request: { messages: [
      { role: 'system', content: 'dynamic' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer-1' }, secondUser
    ] } })
    expect(readSessionTranscript(db, 'checkpoint-session')).toMatchObject({ version: 2, lastTurnId: 'turn-2', status: 'ready' })
    db.close()
  })

  it('does not persist prior system instructions across three successful turns', async () => {
    const db = createMemoryAppDb()
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] })) }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) }
    const users = ['one', 'two', 'three'].map((content) => ({ role: 'user' as const, content }))
    const systems = ['system A', 'system B', 'system C'].map((content) => ({ role: 'system' as const, content }))
    mockRunHostedAgentTurn
      .mockResolvedValueOnce({ text: 'answer 1', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [systems[0], users[0], { role: 'assistant', content: 'answer 1' }] })
      .mockResolvedValueOnce({ text: 'answer 2', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [systems[1], users[0], { role: 'assistant', content: 'answer 1' }, users[1], { role: 'assistant', content: 'answer 2' }] })
      .mockResolvedValueOnce({ text: 'answer 3', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [systems[2], users[0], { role: 'assistant', content: 'answer 1' }, users[1], { role: 'assistant', content: 'answer 2' }, users[2], { role: 'assistant', content: 'answer 3' }] })

    for (let index = 0; index < users.length; index += 1) {
      const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: `system-turn-${index}`, turnId: `system-turn-${index}`, routeId: 'route', sessionId: 'system-session', sessionDb: db })
      await handoff({ request: { messages: [systems[index], users[index]] }, requiredUserMessage: { id: `system-user-${index}`, message: users[index] } })
      const checkpoint = readSessionTranscript(db, 'system-session')
      expect(checkpoint.messages.some((message) => message.role === 'system')).toBe(false)
      const sent = mockRunHostedAgentTurn.mock.calls[index][0].request.messages
      expect(sent.filter((message: { role: string }) => message.role === 'system')).toEqual([systems[index]])
    }
    db.close()
  })

  it('uses canonical compacted transcript after provider failure instead of restoring preflight messages', async () => {
    const db = createMemoryAppDb()
    const priorUser = { role: 'user' as const, content: 'prior detail removed by compaction' }
    const priorAssistant = { role: 'assistant' as const, content: 'prior answer removed by compaction' }
    const summary = { role: 'assistant' as const, content: 'summary of earlier conversation' }
    const currentUser = { role: 'user' as const, content: 'current accepted question' }
    const compacted = [summary, currentUser]
    const history = {
      read: vi.fn(async (invocationId: string) => invocationId === 'compact-failed-turn'
        ? { events: [
            { kind: 'transcript-compacted', payload: { messages: compacted } },
            { kind: 'invocation-failed', payload: { status: 'failed' } }
          ] }
        : { events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] })
    }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) }
    commitSessionTranscript(db, { sessionId: 'compact-failure-session', turnId: 'prior-turn', baseVersion: 0, outcome: 'completed', messages: [priorUser, priorAssistant] })
    mockRunHostedAgentTurn
      .mockRejectedValueOnce(new Error('provider failed after compaction'))
      .mockResolvedValueOnce({ text: 'follow-up answer', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [...compacted, { role: 'user', content: 'follow-up question' }, { role: 'assistant', content: 'follow-up answer' }] })
    const failed = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'compact-failed-turn', turnId: 'compact-failed-turn', routeId: 'route', sessionId: 'compact-failure-session', sessionDb: db })

    await expect(failed({
      request: { messages: [priorUser, priorAssistant, currentUser] },
      requiredUserMessage: { id: 'compact-current-user', message: currentUser }
    } as never)).rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'failed' })

    expect(readSessionTranscript(db, 'compact-failure-session')).toMatchObject({
      version: 2, status: 'ready', messages: compacted
    })
    const followupUser = { role: 'user' as const, content: 'follow-up question' }
    const followup = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'compact-followup-turn', turnId: 'compact-followup-turn', routeId: 'route', sessionId: 'compact-failure-session', sessionDb: db })
    await followup({ request: { messages: [priorUser, priorAssistant, currentUser, followupUser] }, requiredUserMessage: { id: 'compact-followup-user', message: followupUser } })
    expect(mockRunHostedAgentTurn.mock.calls.at(-1)?.[0].request.messages).toEqual([...compacted, followupUser])
    db.close()
  })

  it('retains prior committed conversation context across a failed turn', async () => {
    const db = createMemoryAppDb()
    const terminals = new Map<string, unknown>([
      ['failure-history-1', { kind: 'invocation-completed', payload: { status: 'completed' } }],
      ['failure-history-2', { kind: 'invocation-failed', payload: { status: 'failed', reason: 'provider-error' } }],
      ['failure-history-3', { kind: 'invocation-completed', payload: { status: 'completed' } }]
    ])
    const history = { read: vi.fn(async (invocationId: string) => ({ events: [terminals.get(invocationId)] })) }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) }
    const firstUser = { role: 'user' as const, content: 'first committed question' }
    const firstAssistant = { role: 'assistant' as const, content: 'first committed answer' }
    const failedUser = { role: 'user' as const, content: 'question that fails' }
    const laterUser = { role: 'user' as const, content: 'question after failure' }
    const laterAssistant = { role: 'assistant' as const, content: 'answer after failure' }
    mockRunHostedAgentTurn
      .mockResolvedValueOnce({ text: firstAssistant.content, modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [firstUser, firstAssistant] })
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce({ text: laterAssistant.content, modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [firstUser, firstAssistant, failedUser, laterUser, laterAssistant] })

    const first = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'failure-history-1', turnId: 'failure-turn-1', routeId: 'route', sessionId: 'failure-session', sessionDb: db })
    await first({ request: { messages: [firstUser] }, requiredUserMessage: { id: 'failure-user-1', message: firstUser } } as never)

    const failed = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'failure-history-2', turnId: 'failure-turn-2', routeId: 'route', sessionId: 'failure-session', sessionDb: db })
    await expect(failed({ request: { messages: [firstUser, firstAssistant, failedUser] }, requiredUserMessage: { id: 'failure-user-2', message: failedUser } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'failed' })
    expect(readSessionTranscript(db, 'failure-session')).toMatchObject({
      version: 2, status: 'ready', messages: [firstUser, firstAssistant, failedUser]
    })

    const later = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'failure-history-3', turnId: 'failure-turn-3', routeId: 'route', sessionId: 'failure-session', sessionDb: db })
    await later({ request: { messages: [firstUser, firstAssistant, failedUser, laterUser] }, requiredUserMessage: { id: 'failure-user-3', message: laterUser } } as never)
    expect(mockRunHostedAgentTurn.mock.calls.at(-1)?.[0]).toMatchObject({ request: { messages: [
      { role: 'user', content: firstUser.content },
      { role: 'assistant', content: firstAssistant.content },
      { role: 'user', content: failedUser.content },
      laterUser
    ] } })
    expect(readSessionTranscript(db, 'failure-session')).toMatchObject({
      version: 3, status: 'ready', messages: [firstUser, firstAssistant, failedUser, laterUser, laterAssistant]
    })
    db.close()
  })

  it('同 session 后续 turn 在前一 turn checkpoint 提交前不派发 Hosted', async () => {
    const db = createMemoryAppDb()
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] })) }
    let unblockFirst!: () => void
    let signalFirstStarted!: () => void
    let signalSecondStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve })
    const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve })
    const firstGate = new Promise<void>((resolve) => { unblockFirst = resolve })
    const firstUser = { role: 'user' as const, content: 'first instruction' }
    const secondUser = { role: 'user' as const, content: 'second instruction' }
    mockRunHostedAgentTurn.mockImplementation(async ({ invocationId, request }: { invocationId: string; request: { messages: unknown[] } }) => {
      if (invocationId === 'fifo-first') {
        signalFirstStarted()
        await firstGate
        return { text: 'first answer', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [firstUser, { role: 'assistant', content: 'first answer' }] }
      }
      signalSecondStarted()
      expect(request.messages).toEqual([firstUser, { role: 'assistant', content: 'first answer' }, secondUser])
      return { text: 'second answer', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [firstUser, { role: 'assistant', content: 'first answer' }, secondUser, { role: 'assistant', content: 'second answer' }] }
    })
    const agentSdk = { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) }
    const first = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'fifo-first', turnId: 'fifo-first', routeId: 'route', sessionId: 'fifo-session', sessionDb: db })
    const second = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'fifo-second', turnId: 'fifo-second', routeId: 'route', sessionId: 'fifo-session', sessionDb: db })
    const firstRun = first({ request: { messages: [firstUser] }, requiredUserMessage: { id: 'u1', message: firstUser } })
    await firstStarted
    const secondRun = second({ request: { messages: [secondUser] }, requiredUserMessage: { id: 'u2', message: secondUser } })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get('fifo-session', 'fifo-second')).toEqual({ status: 'queued' })
    expect(mockRunHostedAgentTurn).toHaveBeenCalledTimes(1)
    unblockFirst()
    await firstRun
    await secondStarted
    await secondRun
    expect(readSessionTranscript(db, 'fifo-session')).toMatchObject({ version: 2, lastTurnId: 'fifo-second', status: 'ready' })
    db.close()
  })

  it('CAS 冲突将已执行 turn 标为待对账且不重跑 Hosted invocation', async () => {
    const db = createMemoryAppDb()
    const toolSideEffect = vi.fn()
    mockRunHostedAgentTurn.mockImplementationOnce(async () => {
      toolSideEffect()
      commitSessionTranscript(db, { sessionId: 'cas-session', turnId: 'concurrent-writer', baseVersion: 0, outcome: 'completed', messages: [{ role: 'user', content: 'other' }] })
      return { text: 'already executed', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [{ role: 'assistant', content: 'already executed' }] }
    })
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose: async () => undefined })) },
      history: { read: async () => ({ events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] }) } as never,
      invocationId: 'cas-invocation', turnId: 'cas-turn', routeId: 'route', sessionId: 'cas-session', sessionDb: db
    })
    const user = { role: 'user' as const, content: 'execute once' }
    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'cas-user', message: user } })).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain', message: expect.stringContaining('SESSION_TRANSCRIPT_COMMIT_UNCERTAIN')
    })
    expect(mockRunHostedAgentTurn).toHaveBeenCalledOnce()
    expect(toolSideEffect).toHaveBeenCalledOnce()
    expect(readSessionTranscript(db, 'cas-session')).toMatchObject({ version: 1, status: 'commit_uncertain' })
    expect(claimSessionExecution(db, { sessionId: 'cas-session', turnId: 'next-turn', ownerId: 'next-process' }))
      .toMatchObject({ acquired: false, reason: 'blocked' })
    db.close()
  })

  it('History terminal 已提交但 checkpoint 写入抛错时保留 uncertain claim，不释放 session', async () => {
    const temp = createTempDatabase('sa-checkpoint-failure-')
    const db = temp.db
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_checkpoint_insert BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.session_id='checkpoint-failure-session' BEGIN SELECT RAISE(ABORT, 'injected checkpoint insert failure'); END`)
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] })) }
    const user = { role: 'user' as const, content: 'accepted before checkpoint fault' }
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: history as never, invocationId: 'checkpoint-failure-invocation', turnId: 'checkpoint-failure-turn',
      routeId: 'route', sessionId: 'checkpoint-failure-session', sessionDb: db
    })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'checkpoint-failure-user', message: user } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain' })
    expect(mockLogAgentEvent).toHaveBeenCalledWith('error', 'session.transcript.reconciliation', expect.objectContaining({
      sessionId: 'checkpoint-failure-session', turnId: 'checkpoint-failure-turn',
      outcome: 'commit_uncertain', reasonCode: 'terminal-participant-incomplete', transcriptVersion: 0
    }))
    expect(JSON.stringify(mockLogAgentEvent.mock.calls)).not.toContain('accepted before checkpoint fault')
    expect(conn.prepare('SELECT status,turn_id FROM session_execution_claims WHERE session_id=?').get('checkpoint-failure-session'))
      .toMatchObject({ status: 'commit_uncertain', turn_id: 'checkpoint-failure-turn' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get('checkpoint-failure-session'))
      .toEqual({ count: 0 })
    expect(mockRunHostedAgentTurn).toHaveBeenCalledOnce()
    conn.exec('DROP TRIGGER fail_checkpoint_insert')
    db.close()

    const reopened = openDatabase(temp.dbPath)
    try {
      expect(reconcileStartupSessionTranscripts(reopened, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 9_000))
        .toMatchObject({ repairedCheckpoints: 1, reconciled: 0 })
      expect(readSessionTranscript(reopened, 'checkpoint-failure-session'))
        .toMatchObject({ version: 0, lastTurnId: 'checkpoint-failure-turn', status: 'commit_uncertain' })
      expect(claimSessionExecution(reopened, { sessionId: 'checkpoint-failure-session', turnId: 'next-turn', ownerId: 'new-process' }))
        .toMatchObject({ acquired: false, reason: 'blocked' })
    } finally {
      reopened.close()
      temp.cleanup()
    }
  })

  it('SQLite terminal participant 原子失败后重启保留 uncertain fence', async () => {
    const temp = createTempDatabase('hosted-terminal-participant-restart-')
    const db = temp.db
    const session = createSession(db, { name: 'terminal-participant-restart', model: 'model' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    getDbConnection(db).exec(`CREATE TRIGGER fail_atomic_terminal_participant BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.version > 0 BEGIN SELECT RAISE(ABORT, 'injected atomic transcript participant failure'); END`)
    const user = { role: 'user' as const, content: 'accepted before restart' }
    mockRunHostedAgentTurn.mockImplementationOnce(async ({ invocationId }: { invocationId: string }) => {
      const terminal = { invocationId, turnId: 'atomic-failure-turn', sequence: 1, schemaVersion: 1,
        eventId: 'atomic-failure-terminal', idempotencyKey: 'atomic-failure-terminal', kind: 'invocation-failed' as const,
        payload: { status: 'failed', reason: 'provider-error' } }
      await expect(history.appendBatch([terminal], 0, {
        sessionId: session.id, baseVersion: 0, outcome: 'failed', messages: [user]
      })).rejects.toThrow('injected atomic transcript participant failure')
      // SDK records the terminal outcome after the atomic participant attempt failed.
      await history.appendBatch([terminal], 0)
      throw new Error('provider failed after atomic participant rollback')
    })
    const storage = createSqliteSessionStorage(db)
    const handoff = createComposedHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) }, history,
      invocationId: 'atomic-failure-invocation', turnId: 'atomic-failure-turn', routeId: 'route', sessionId: session.id,
      sessionQueries: storage.queries, sessionExecution: storage.execution
    })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'atomic-failure-user', message: user } }))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain' })
    expect((await history.read('atomic-failure-invocation')).events).toHaveLength(1)
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 0, lastTurnId: 'atomic-failure-turn', status: 'commit_uncertain', messages: [] })
    db.close()

    const reopened = openDatabase(temp.dbPath)
    try {
      expect(reconcileStartupSessionTranscripts(reopened, { historyRecoverySucceeded: true, turnCoordinatorRecoverySucceeded: true }, 9_000))
        .toMatchObject({ markedUncertain: 0, reconciled: 0 })
      expect(readSessionTranscript(reopened, session.id)).toMatchObject({ version: 0, status: 'commit_uncertain', messages: [] })
      expect(claimSessionExecution(reopened, { sessionId: session.id, turnId: 'retry-after-restart', ownerId: 'new-process' }))
        .toMatchObject({ acquired: false, reason: 'blocked' })
    } finally {
      reopened.close()
      temp.cleanup()
    }
  })

  it('失败 terminal 的 transcript checkpoint 写入抛错时也保留 uncertain claim', async () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_failed_checkpoint BEFORE INSERT ON session_transcript_checkpoints
      WHEN NEW.session_id='failed-checkpoint-session' BEGIN SELECT RAISE(ABORT, 'injected failed checkpoint failure'); END`)
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-failed', payload: { status: 'failed', reason: 'provider-error' } }] })) }
    mockRunHostedAgentTurn.mockRejectedValueOnce(new Error('provider failed'))
    const user = { role: 'user' as const, content: 'accepted before failed checkpoint fault' }
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: history as never, invocationId: 'failed-checkpoint-invocation', turnId: 'failed-checkpoint-turn',
      routeId: 'route', sessionId: 'failed-checkpoint-session', sessionDb: db
    })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'failed-checkpoint-user', message: user } } as never))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain' })
    expect(conn.prepare('SELECT status,turn_id FROM session_execution_claims WHERE session_id=?').get('failed-checkpoint-session'))
      .toMatchObject({ status: 'commit_uncertain', turn_id: 'failed-checkpoint-turn' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_transcript_entries WHERE session_id=?').get('failed-checkpoint-session'))
      .toEqual({ count: 0 })
    db.close()
  })

  it('Hosted 执行后 canonical History 缺少 terminal 时保留 uncertain claim', async () => {
    const db = createMemoryAppDb()
    const toolSideEffect = vi.fn()
    mockRunHostedAgentTurn.mockImplementationOnce(async () => {
      toolSideEffect()
      throw new Error('injected terminal append failure')
    })
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: { read: async () => ({ events: [] }) } as never,
      invocationId: 'missing-terminal-invocation', turnId: 'missing-terminal-turn', routeId: 'route', sessionId: 'missing-terminal-session', sessionDb: db
    })
    const user = { role: 'user' as const, content: 'accepted instruction' }

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'missing-terminal-user', message: user } }))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain' })
    expect(mockRunHostedAgentTurn).toHaveBeenCalledOnce()
    expect(toolSideEffect).toHaveBeenCalledOnce()
    expect(readSessionTranscript(db, 'missing-terminal-session')).toMatchObject({ version: 0, status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('missing-terminal-session'))
      .toMatchObject({ status: 'commit_uncertain' })
    expect(claimSessionExecution(db, { sessionId: 'missing-terminal-session', turnId: 'next-turn', ownerId: 'next-process' }))
      .toMatchObject({ acquired: false, reason: 'blocked' })
    db.close()
  })

  it('completed History terminal 缺少 transcript participant 时标记 uncertain 并阻止重试', async () => {
    const db = createMemoryAppDb()
    const history = new SqliteAgentHistory(db)
    const session = createSession(db, { name: 'incomplete-terminal', model: 'model' })
    commitSessionTranscript(db, {
      sessionId: session.id, turnId: 'prior-turn', baseVersion: 0, outcome: 'completed',
      messages: [{ id: 'prior-user', role: 'user', content: 'prior instruction' }, { id: 'prior-assistant', role: 'assistant', content: 'prior response' }]
    })
    const toolSideEffect = vi.fn()
    const runInvocation = vi.fn(async () => {
      toolSideEffect()
      await history.append('incomplete-terminal-invocation', 'invocation-context-committed', {
        messages: [{ id: 'incomplete-terminal-user', role: 'user', content: 'accepted instruction' }]
      }, { turnId: 'incomplete-terminal-turn', sessionId: session.id })
      await history.append('incomplete-terminal-invocation', 'invocation-completed', { status: 'completed' }, {
        turnId: 'incomplete-terminal-turn', sessionId: session.id
      })
      throw new Error('SDK failed after terminal append')
    })
    mockRunHostedAgentTurn.mockImplementationOnce(runInvocation)
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history, invocationId: 'incomplete-terminal-invocation', turnId: 'incomplete-terminal-turn',
      routeId: 'route', sessionId: session.id, sessionDb: db
    })

    await expect(handoff({
      request: { messages: [{ role: 'user', content: 'accepted instruction' }] },
      requiredUserMessage: { id: 'incomplete-terminal-user', message: { role: 'user', content: 'accepted instruction' } }
    })).rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain' })
    expect(toolSideEffect).toHaveBeenCalledOnce()
    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 1, status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get(session.id))
      .toMatchObject({ status: 'commit_uncertain' })
    expect(claimSessionExecution(db, { sessionId: session.id, turnId: 'retry-turn', ownerId: 'retry-owner' }))
      .toMatchObject({ acquired: false, reason: 'blocked' })
    expect(mockRunHostedAgentTurn).toHaveBeenCalledOnce()
    db.close()
  })

  it('completed History 已原子提交 transcript participant 时 handoff 不再二次写入', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'atomic-terminal-participant', model: 'model' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 1, session.id)
    const prior = [{ id: 'atomic-prior-user', role: 'user' as const, content: 'prior instruction' },
      { id: 'atomic-prior-assistant', role: 'assistant' as const, content: 'prior response' }]
    commitSessionTranscript(db, { sessionId: session.id, turnId: 'atomic-prior-turn', baseVersion: 0, outcome: 'completed', messages: prior })
    const user = { id: 'atomic-user', role: 'user' as const, content: 'accepted instruction' }
    const assistant = { id: 'atomic-assistant', role: 'assistant' as const, content: 'done' }
    mockRunHostedAgentTurn.mockImplementationOnce(async ({ invocationId }: { invocationId: string }) => {
      await history.appendBatch([
        { invocationId, turnId: 'atomic-turn', sequence: 1, schemaVersion: 1, eventId: 'atomic-done', idempotencyKey: 'atomic-done', kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0, { sessionId: session.id, baseVersion: 1, outcome: 'completed', messages: [...prior, user, assistant] })
      return { text: 'done', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, messages: [...prior, user, assistant] }
    })
    const storage = createSqliteSessionStorage(db)
    expect(storage.execution).not.toHaveProperty('commitHostedTranscript')
    const handoff = createHostedTurnHandoff({ agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) }, history,
      invocationId: 'atomic-invocation', turnId: 'atomic-turn', routeId: 'route', sessionId: session.id,
      sessionQueries: storage.queries, sessionExecution: storage.execution })

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: user.id, message: user } })).resolves.toMatchObject({ result: { ok: true } })

    expect(readSessionTranscript(db, session.id)).toMatchObject({ version: 2, lastTurnId: 'atomic-turn', status: 'ready', messages: [...prior, user, assistant] })
    db.close()
  })

  it('Hosted 执行后无法读取 canonical History 时保留 uncertain claim', async () => {
    const db = createMemoryAppDb()
    const toolSideEffect = vi.fn()
    mockRunHostedAgentTurn.mockImplementationOnce(async () => {
      toolSideEffect()
      throw new Error('provider result is unknown')
    })
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: () => ({ host: {}, dispose: async () => undefined }) },
      history: { read: async () => { throw new Error('injected History read failure') } } as never,
      invocationId: 'unreadable-history-invocation', turnId: 'unreadable-history-turn', routeId: 'route', sessionId: 'unreadable-history-session', sessionDb: db
    })
    const user = { role: 'user' as const, content: 'accepted instruction' }

    await expect(handoff({ request: { messages: [user] }, requiredUserMessage: { id: 'unreadable-history-user', message: user } }))
      .rejects.toMatchObject({ name: 'HostedTurnFinalizedError', outcome: 'commit-uncertain' })
    expect(toolSideEffect).toHaveBeenCalledOnce()
    expect(readSessionTranscript(db, 'unreadable-history-session')).toMatchObject({ version: 0, status: 'commit_uncertain' })
    expect(getDbConnection(db).prepare('SELECT status FROM session_execution_claims WHERE session_id=?').get('unreadable-history-session'))
      .toMatchObject({ status: 'commit_uncertain' })
    expect(claimSessionExecution(db, { sessionId: 'unreadable-history-session', turnId: 'next-turn', ownerId: 'next-process' }))
      .toMatchObject({ acquired: false, reason: 'blocked' })
    db.close()
  })

  it('runs an invocation scoped host and converts the SDK summary while disposing the runtime', async () => {
    const dispose = vi.fn(async () => undefined)
    const runtime = { host: { createPorts: vi.fn() }, dispose }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => runtime) }
    const history = { read: vi.fn(async () => ({ events: [
      { kind: 'tool-call-not-dispatched', payload: { toolCallId: 'denied-tool', reason: 'POLICY_DENY' } },
      { kind: 'invocation-completed', payload: { status: 'completed' } }
    ] })) }
    mockRunHostedAgentTurn.mockResolvedValue({
      text: 'finished', modelTurns: 3, finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 9, cacheReadInputTokens: 4 },
      messages: [{ role: 'assistant', content: 'finished' }]
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1' })
    const request = { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100 }
    const initialResponse = { message: { role: 'assistant', content: 'first' }, finishReason: 'stop', usage: { type: 'usage', inputTokens: 3, outputTokens: 2 }, historyCommitted: true as const }
    const result = await handoff({ request, initialResponse })

    expect(agentSdk.createHostedTurnRuntime).not.toHaveBeenCalledWith(expect.objectContaining({ applicationAdmission: expect.anything() }))
    expect(agentSdk.createHostedTurnRuntime).not.toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: expect.any(Number) }))
    expect(mockRunHostedAgentTurn).toHaveBeenCalledWith(expect.objectContaining({ host: runtime.host, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1', request, initialResponse }))
    expect(result).toMatchObject({ result: { ok: true, content: [{ text: 'finished' }], usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 4 } }, finalization: { outcome: 'completed', usage: { modelTurns: 2, initialMessageCount: 1, notDispatchedToolCallIds: ['denied-tool'] } } })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not report success when the SDK returned after committing a non-completed invocation terminal', async () => {
    const dispose = vi.fn(async () => undefined)
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose })) }
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-interrupted', payload: { status: 'interrupted', sessionLedger: { reason: 'interrupted' } } }] })) }
    mockRunHostedAgentTurn.mockResolvedValue({
      text: '', modelTurns: 0, finishReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 }, messages: []
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1' })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }] } as never })).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'interrupted'
    })
    expect(history.read).toHaveBeenCalledWith('req-1')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('carries accepted model usage from the canonical failed terminal to the Hosted caller', async () => {
    const failure = new Error('tool execution failed')
    const dispose = vi.fn(async () => undefined)
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose })) }
    const history = { read: vi.fn(async () => ({ events: [{
      kind: 'invocation-interrupted', payload: {
        status: 'interrupted', reason: 'unknown-after-dispatch',
        usage: { type: 'usage', inputTokens: 1000, outputTokens: 50 }
      }
    }] })) }
    mockRunHostedAgentTurn.mockRejectedValue(failure)
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-usage', turnId: 'turn-usage', routeId: 'route-1' })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }] } as never })).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'interrupted', usage: { inputTokens: 1000, outputTokens: 50 }
    })
  })

  it('fails closed when a successful SDK result has no canonical terminal event', async () => {
    const dispose = vi.fn(async () => undefined)
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose })) }
    const history = { read: vi.fn(async () => ({ events: [] })) }
    mockRunHostedAgentTurn.mockResolvedValue({
      text: 'finished', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 }, messages: []
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1' })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }] } as never })).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'failed'
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not convert canonical History read failure into a completed Hosted handoff', async () => {
    const failure = new Error('history unavailable')
    const dispose = vi.fn(async () => undefined)
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => ({ host: {}, dispose })) }
    const history = { read: vi.fn(async () => { throw failure }) }
    mockRunHostedAgentTurn.mockResolvedValue({
      text: 'finished', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 }, messages: []
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1' })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }] } as never })).rejects.toMatchObject({
      name: 'HostedTurnFinalizedError', outcome: 'failed'
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not attempt to read history or dispose when runtime creation fails', async () => {
    const failure = new Error('composition failed')
    const agentSdk = { createHostedTurnRuntime: vi.fn().mockRejectedValue(failure) }
    const history = { read: vi.fn() }
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1' })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }] } as never })).rejects.toBe(failure)

    expect(history.read).not.toHaveBeenCalled()
  })

  it('releases a claimed session when Hosted runtime creation fails before execution starts', async () => {
    const db = createMemoryAppDb()
    const failure = new Error('composition failed')
    const history = { read: vi.fn(async () => ({ version: 0, status: 'ready', messages: [], events: [] })) }
    const handoff = createHostedTurnHandoff({
      agentSdk: { createHostedTurnRuntime: vi.fn().mockRejectedValue(failure) },
      history: history as never,
      invocationId: 'composition-failure', turnId: 'composition-failure-turn', routeId: 'route',
      sessionId: 'composition-failure-session', sessionDb: db
    })

    await expect(handoff({
      request: { messages: [{ role: 'user', content: 'hello' }] },
      requiredUserMessage: { id: 'composition-failure-user', message: { role: 'user', content: 'hello' } }
    } as never)).rejects.toBe(failure)

    expect(getDbConnection(db).prepare('SELECT turn_id,status FROM session_execution_claims WHERE session_id=?')
      .get('composition-failure-session')).toEqual({ turn_id: '', status: 'queued' })
    expect(getDbConnection(db).prepare('SELECT turn_id,status FROM session_execution_queue WHERE session_id=?')
      .get('composition-failure-session')).toBeUndefined()
    expect(claimSessionExecution(db, {
      sessionId: 'composition-failure-session', turnId: 'next-turn', ownerId: 'next-owner'
    })).toMatchObject({ acquired: true })
    db.close()
  })

  it('treats disposal failure as diagnostic after a successful hosted turn', async () => {
    const dispose = vi.fn().mockRejectedValue(new Error('dispose failed'))
    const runtime = { host: { createPorts: vi.fn() }, dispose }
    const agentSdk = { createHostedTurnRuntime: vi.fn(() => runtime) }
    const history = { read: vi.fn(async () => ({ events: [{ kind: 'invocation-completed', payload: { status: 'completed' } }] })) }
    mockRunHostedAgentTurn.mockResolvedValue({
      text: 'finished', modelTurns: 1, finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 1 }, messages: [{ role: 'assistant', content: 'finished' }]
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history: history as never, invocationId: 'req-1', turnId: 'turn-1', routeId: 'route-1' })

    await expect(handoff({ request: { messages: [{ role: 'user', content: 'hello' }] } as never })).resolves.toMatchObject({ result: { ok: true } })

    expect(dispose).toHaveBeenCalledOnce()
    expect(history.read).toHaveBeenCalledOnce()
  })

})
