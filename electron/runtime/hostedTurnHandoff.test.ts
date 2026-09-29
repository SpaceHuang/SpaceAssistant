import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRunHostedAgentTurn = vi.hoisted(() => vi.fn())
const mockLogAgentEvent = vi.hoisted(() => vi.fn())
vi.mock('../../packages/agent-sdk/src/turn', () => ({
  runHostedAgentTurn: (...args: unknown[]) => mockRunHostedAgentTurn(...args),
  ToolLoopRoundLimitError: class ToolLoopRoundLimitError extends Error {}
}))
vi.mock('../agentLogger/agentLogger', () => ({ logAgentEvent: (...args: unknown[]) => mockLogAgentEvent(...args) }))

import { DatabaseSync } from 'node:sqlite'
import { createHostedTurnHandoff } from './hostedTurnHandoff'
import { runMigrations } from '../database/migrations'
import { SqliteAgentHistory } from './sqliteAgentHistory'

describe('createHostedTurnHandoff', () => {
  beforeEach(() => { mockRunHostedAgentTurn.mockReset(); mockLogAgentEvent.mockReset() })

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
    mockRunHostedAgentTurn.mockImplementation(async ({ invocationId }: { invocationId: string }) => {
      await history.appendBatch([
        { invocationId, turnId: 'new-turn', sequence: 1, schemaVersion: 1, eventId: 'new-context', idempotencyKey: 'new-context', kind: 'invocation-context-committed', payload: { messages: request.messages } },
        { invocationId, turnId: 'new-turn', sequence: 2, schemaVersion: 1, eventId: 'new-done', idempotencyKey: 'new-done', kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
      return { text: 'done', modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 }, messages: [] }
    })
    const handoff = createHostedTurnHandoff({ agentSdk, history, invocationId: 'current', turnId: 'new-turn', routeId: 'route', sessionId: 'session-shadow' })

    await expect(handoff({ request, requiredUserMessage: { id: 'current-user', message: currentMessage } })).resolves.toMatchObject({ result: { ok: true } })

    expect(mockLogAgentEvent).not.toHaveBeenCalled()
    expect(mockRunHostedAgentTurn).toHaveBeenCalledOnce()
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
    expect(mockLogAgentEvent).toHaveBeenCalledWith('warn', 'tool.error', expect.objectContaining({ message: 'transcript-mismatch' }))
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
    const applicationAdmission = { park: vi.fn(() => 'parked'), resume: vi.fn(async () => true) }
    const deadlineAt = Date.now() + 10_000

    const result = await handoff({ request, initialResponse, applicationAdmission, deadlineAt })

    expect(agentSdk.createHostedTurnRuntime).toHaveBeenCalledWith(expect.objectContaining({ applicationAdmission, deadlineAt }))
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
