import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import { runMigrations } from '../database/migrations'
import { createAcceptedTurn } from '../../src/shared/acceptedTurn'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { ensureCompactionTransaction, ensureFinalRequestContextEvent, ensureRequestProjectionEvents, ensureRequestRetryEvent, ensureRequestUsageEvent, ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, getSessionEventSink, readSessionEvents } from '../sessionEvents'

function createDb(dbPath = ':memory:'): DatabaseSync {
  const conn = new DatabaseSync(dbPath)
  conn.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
  conn.prepare('INSERT OR IGNORE INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '18')
  runMigrations(conn)
  return conn
}

const event = (id: string, sequence: number): HistoryEvent => ({
  invocationId: 'inv-1', turnId: 'turn-1', sequence, schemaVersion: 1, eventId: id,
  idempotencyKey: `client:${id}`, kind: sequence === 1 ? 'tool-call-started' : 'tool-call-finished', payload: { id }
})

describe('SqliteAgentHistory', () => {
  it.each(['before-commit', 'after-commit-ack-lost'] as const)('settles SDK terminal History append failure against real SQLite: %s', async (failurePoint) => {
    const conn = createDb()
    const durableHistory = new SqliteAgentHistory(conn)
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register({ routeId: `terminal-${failurePoint}`, protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'terminal-fault-provider', stream: async function* () {
        providerCalls += 1
        yield { type: 'text-delta', text: 'accepted answer' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const history = failurePoint === 'before-commit'
      ? (() => {
          conn.exec(`CREATE TRIGGER fail_completion_terminal BEFORE INSERT ON agent_history_events
            WHEN NEW.kind='invocation-completed' BEGIN SELECT RAISE(ABORT, 'injected terminal History failure'); END`)
          return durableHistory
        })()
      : {
          appendBatch: async (events: readonly HistoryEvent[], version: number) => {
            const result = await durableHistory.appendBatch(events, version)
            if (events.some((entry) => entry.kind === 'invocation-completed')) throw new Error('completion acknowledgement lost')
            return result
          },
          read: (invocationId: string) => durableHistory.read(invocationId)
        }
    const permits = new InMemorySafetyPermitStore()
    const onTurnFinished = vi.fn()

    const run = runAgentTurn({
      registry, routeId: `terminal-${failurePoint}`, invocationId: `terminal-${failurePoint}`, turnId: `turn-${failurePoint}`,
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10 }, maxModelTurns: 1, history,
      safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: vi.fn(),
      toolExecution: createPermitBoundToolExecutionPort({
        permits, admission: new InMemoryExecutionAdmissionCoordinator(),
        resolveExpected: async () => { throw new Error('tool execution is not expected') },
        execute: async () => ({ output: undefined })
      }),
      observer: { onTurnFinished }
    })

    if (failurePoint === 'before-commit') await expect(run).rejects.toThrow('injected terminal History failure')
    else await expect(run).resolves.toMatchObject({ text: 'accepted answer' })

    const events = (await durableHistory.read(`terminal-${failurePoint}`)).events
    const terminals = events.filter((entry) => ['invocation-completed', 'invocation-failed', 'invocation-interrupted'].includes(entry.kind))
    expect(providerCalls).toBe(1)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.kind).toBe(failurePoint === 'before-commit' ? 'invocation-failed' : 'invocation-completed')
    expect(onTurnFinished).toHaveBeenCalledTimes(failurePoint === 'before-commit' ? 0 : 1)
    conn.close()
  })

  it('resolves requestId to the canonical turn stream from the durable AcceptedTurn ledger', async () => {
    const conn = createDb()
    const acceptedTurn = createAcceptedTurn({
      turnId: 'approval-turn', requestId: 'approval-request', sessionId: 'approval-session', lane: 'automation',
      startToken: 'approval-start', currentUserMessageId: 'approval-user', transcriptVersion: 0, config: { lane: 'automation' }
    })
    conn.prepare('INSERT INTO accepted_turn_contexts(turn_id,session_id,request_id,accepted_turn_json,created_at) VALUES(?,?,?,?,?)')
      .run(acceptedTurn.turnId, acceptedTurn.sessionId, acceptedTurn.requestId, JSON.stringify(acceptedTurn), 1)
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'approval-session')
    await history.appendBatch([{ ...event('approval-event', 1), invocationId: acceptedTurn.turnId, turnId: acceptedTurn.turnId }], 0)

    expect(conn.prepare('SELECT request_id,turn_id FROM accepted_turn_contexts').all()).toEqual([{ request_id: 'approval-request', turn_id: 'approval-turn' }])
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accepted_turn_contexts'").get()).toBeDefined()
    expect(history.readSync('approval-request')).toMatchObject({ invocationId: 'approval-turn', events: [{ turnId: 'approval-turn' }] })
    conn.close()
  })

  it('resolves a shared requestId only to the turn owned by this session', async () => {
    const conn = createDb()
    conn.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, role TEXT, content TEXT);
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(session_id, request_id));`)
    for (const sessionId of ['session-a', 'session-b']) {
      conn.prepare('INSERT INTO sessions(id) VALUES(?)').run(sessionId)
      const messageId = `${sessionId}-assistant`
      conn.prepare("INSERT INTO messages(id,session_id,role,content) VALUES(?,?,'assistant','')").run(messageId, sessionId)
      conn.prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at)
        VALUES(?, 'same-request', ?, ?, 'completed', 1, 1)`).run(`${sessionId}-turn`, sessionId, messageId)
      const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
      await history.appendBatch([
        { ...event(`${sessionId}-context`, 1), invocationId: `${sessionId}-turn`, turnId: `${sessionId}-turn`, kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: sessionId }] } },
        { ...event(`${sessionId}-terminal`, 2), invocationId: `${sessionId}-turn`, turnId: `${sessionId}-turn`, kind: 'invocation-completed', payload: { status: 'completed' } }
      ], 0)
    }

    const sessionASnapshot = new SqliteAgentHistory(conn, 1, Date.now, 'session-a').readSync('same-request')
    const sessionBSnapshot = new SqliteAgentHistory(conn, 1, Date.now, 'session-b').readSync('same-request')
    expect(sessionASnapshot.invocationId).toBe('session-a-turn')
    expect(sessionASnapshot.events[0]?.payload).toMatchObject({ messages: [{ role: 'user', content: 'session-a' }] })
    expect(sessionBSnapshot.invocationId).toBe('session-b-turn')
    expect(sessionBSnapshot.events[0]?.payload).toMatchObject({ messages: [{ role: 'user', content: 'session-b' }] })
    expect(() => new SqliteAgentHistory(conn, 1, Date.now, 'session-a').readSync('session-b-turn'))
      .toThrow(/does not belong to session/)
    expect(() => new SqliteAgentHistory(conn).readSync('same-request')).toThrow(/maps to multiple session turns/)
    conn.close()
  })

  it('indexes invocations by owning session and rejects rebinding a stream to another session', async () => {
    const conn = createDb()
    const sessionA = new SqliteAgentHistory(conn, 1, Date.now, 'session-a')
    const sessionB = new SqliteAgentHistory(conn, 1, Date.now, 'session-b')
    await sessionA.appendBatch([event('session-a-event', 1)], 0)
    await sessionB.appendBatch([{ ...event('session-b-event', 1), invocationId: 'inv-2', turnId: 'turn-2' }], 0)

    expect(sessionA.listInvocationIdsForSession('session-a')).toEqual(['inv-1'])
    expect(sessionA.listInvocationIdsForSession('session-b')).toEqual(['inv-2'])
    await expect(new SqliteAgentHistory(conn, 1, Date.now, 'session-b').appendBatch([event('session-a-next', 2)], 1))
      .rejects.toThrow(/belongs to session-a/)
    expect(sessionA.listInvocationIdsForSession('session-a')).toEqual(['inv-1'])
    conn.close()
  })

  it('returns only the latest completed invocation snapshot for a session', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-reader')
    const appendInvocation = async (invocationId: string, sequence: number, kind: HistoryEvent['kind'], payload: unknown) => history.appendBatch([{
      ...event(`${invocationId}-${sequence}`, sequence), invocationId, turnId: invocationId, kind, payload
    }], sequence - 1)
    await appendInvocation('inv-older', 1, 'invocation-context-committed', { messages: [{ role: 'user', content: 'old' }] })
    await appendInvocation('inv-older', 2, 'invocation-completed', { status: 'completed' })
    await appendInvocation('inv-latest', 1, 'invocation-context-committed', { messages: [{ role: 'user', content: 'latest' }] })

    expect(await history.readLatestCompletedInvocationForSession('session-reader')).toBeUndefined()
    await expect(history.readLatestCompletedInvocationForSession('session-reader', { excludeInvocationId: 'inv-latest' }))
      .resolves.toMatchObject({ invocationId: 'inv-older' })

    await appendInvocation('inv-latest', 2, 'invocation-completed', { status: 'completed' })
    await new SqliteAgentHistory(conn, 1, () => 100, 'other-session').appendBatch([{
      ...event('other-session-event', 1), invocationId: 'inv-other', turnId: 'inv-other', kind: 'invocation-context-committed', payload: { messages: [] }
    }], 0)

    await expect(history.readLatestCompletedInvocationForSession('session-reader')).resolves.toMatchObject({
      invocationId: 'inv-latest', version: 2,
      events: [expect.objectContaining({ eventId: 'inv-latest-1' }), expect.objectContaining({ kind: 'invocation-completed' })]
    })
    conn.close()
  })

  it('distinguishes a session without History from a latest open canonical stream', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-latest-state')
    await expect(history.readLatestInvocationForSession('session-latest-state')).resolves.toEqual({ kind: 'none' })
    await history.appendBatch([{
      ...event('latest-incomplete-context', 1), invocationId: 'latest-incomplete', turnId: 'latest-incomplete-turn',
      kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'in progress' }] }
    }], 0)

    await expect(history.readLatestInvocationForSession('session-latest-state')).resolves.toEqual({ kind: 'unavailable', invocationId: 'latest-incomplete' })
    conn.close()
  })

  it('uses the last completed transcript after a later invocation has a failed terminal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-failed-latest')
    await history.appendBatch([
      { ...event('prior-context', 1), invocationId: 'prior-completed', turnId: 'prior-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'prior' }] } },
      { ...event('prior-done', 2), invocationId: 'prior-completed', turnId: 'prior-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    await history.appendBatch([
      { ...event('failed-context', 1), invocationId: 'latest-failed', turnId: 'latest-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'failed request' }] } },
      { ...event('failed-terminal', 2), invocationId: 'latest-failed', turnId: 'latest-turn', kind: 'invocation-failed', payload: { status: 'failed' } }
    ], 0)

    await expect(history.readLatestInvocationForSession('session-failed-latest')).resolves.toMatchObject({
      kind: 'completed', snapshot: { invocationId: 'prior-completed' }
    })
    conn.close()
  })

  it('returns a user-cancelled canonical transcript for validated next-turn cutover', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-cancelled-latest')
    await history.appendBatch([
      { ...event('cancelled-context', 1), invocationId: 'user-cancelled', turnId: 'cancelled-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'accepted user input' }] } },
      { ...event('cancelled-terminal', 2), invocationId: 'user-cancelled', turnId: 'cancelled-turn', kind: 'invocation-interrupted', payload: { status: 'cancelled' } }
    ], 0)

    await expect(history.readLatestInvocationForSession('session-cancelled-latest')).resolves.toMatchObject({
      kind: 'cancelled', snapshot: { invocationId: 'user-cancelled' }
    })
    await expect(history.readLatestCompletedInvocationForSession('session-cancelled-latest')).resolves.toBeUndefined()
    conn.close()
  })

  it('does not treat a completion-kind terminal with a failed status as a usable session transcript', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-terminal-payload-mismatch')
    await history.appendBatch([
      { ...event('mismatched-terminal-context', 1), invocationId: 'mismatched-terminal', turnId: 'mismatched-terminal-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'must not handoff' }] } },
      { ...event('mismatched-terminal-done', 2), invocationId: 'mismatched-terminal', turnId: 'mismatched-terminal-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare('UPDATE agent_history_events SET payload_json = ? WHERE event_id = ?')
      .run(JSON.stringify({ status: 'failed' }), 'mismatched-terminal-done')

    await expect(history.readLatestInvocationForSession('session-terminal-payload-mismatch'))
      .rejects.toThrow(/history stream mismatched-terminal is corrupt: completed invocation terminal requires completed status/)
    await expect(history.readLatestCompletedInvocationForSession('session-terminal-payload-mismatch'))
      .rejects.toThrow(/history stream mismatched-terminal is corrupt: completed invocation terminal requires completed status/)
    conn.close()
  })

  it('fails closed when a persisted invocation uses a schema version newer than this adapter', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-future-schema')
    await history.appendBatch([
      { ...event('future-schema-context', 1), invocationId: 'future-schema-invocation', turnId: 'future-schema-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'do not replay with an old schema' }] } },
      { ...event('future-schema-completed', 2), invocationId: 'future-schema-invocation', turnId: 'future-schema-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare('UPDATE agent_history_streams SET schema_version = ? WHERE invocation_id = ?').run(2, 'future-schema-invocation')
    conn.prepare('UPDATE agent_history_events SET schema_version = ? WHERE invocation_id = ?').run(2, 'future-schema-invocation')

    await expect(history.readLatestInvocationForSession('session-future-schema'))
      .rejects.toThrow(/history stream future-schema-invocation is corrupt: unsupported schema version 2 \(adapter supports 1\)/)
    await expect(history.read('future-schema-invocation'))
      .rejects.toThrow(/unsupported schema version 2/)
    conn.close()
  })

  it('fails closed when a persisted event kind is unknown to the History contract', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, () => 100, 'session-unknown-event')
    await history.appendBatch([
      { ...event('unknown-event-context', 1), invocationId: 'unknown-event-invocation', turnId: 'unknown-event-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'unknown event' }] } },
      { ...event('unknown-event-completed', 2), invocationId: 'unknown-event-invocation', turnId: 'unknown-event-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    conn.prepare('UPDATE agent_history_events SET kind = ? WHERE invocation_id = ? AND sequence = ?')
      .run('future-history-event', 'unknown-event-invocation', 1)

    await expect(history.readLatestInvocationForSession('session-unknown-event'))
      .rejects.toThrow(/history stream unknown-event-invocation is corrupt: unsupported history event kind future-history-event/)
    conn.close()
  })

  it('does not include legacy streams with unknown session ownership in a session transcript index', async () => {
    const conn = createDb()
    const ownedHistory = new SqliteAgentHistory(conn, 1, () => 100, 'session-owner')
    const legacyHistory = new SqliteAgentHistory(conn, 1, () => 90)
    await legacyHistory.appendBatch([
      { ...event('legacy-context', 1), kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'belongs somewhere' }] } },
      { ...event('legacy-completed', 2), kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)
    await ownedHistory.appendBatch([
      { ...event('owned-context', 1), invocationId: 'owned-invocation', turnId: 'owned-turn', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'owned' }] } },
      { ...event('owned-completed', 2), invocationId: 'owned-invocation', turnId: 'owned-turn', kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 0)

    expect(ownedHistory.listInvocationIdsForSession('session-owner')).toEqual(['owned-invocation'])
    expect(await ownedHistory.readLatestCompletedInvocationForSession('session-owner')).toMatchObject({ invocationId: 'owned-invocation' })
    conn.close()
  })

  it('rejects a durable terminal batch when a previous batch still has a pending tool proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('cross-batch-proposal', 1), kind: 'model-response-committed',
      payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-cross-batch' }] } }
    }], 0)

    await expect(history.appendBatch([{
      ...event('cross-batch-terminal', 2), kind: 'invocation-completed', payload: { status: 'completed' }
    }], 1)).rejects.toThrow(/pending tool calls or approvals/)
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 1, events: [expect.objectContaining({ eventId: 'cross-batch-proposal' })]
    })
    conn.close()
  })

  it('repairs a missing request_usage event from canonical attempt ledger metadata', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-usage-repair-'))
    const location = { workDir: root, sessionId: 'session-usage', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const repairUsageLedger = vi.fn((repairLocation, requestUsage) => {
      expect(repairLocation).toEqual(location)
      return ensureRequestUsageEvent(sink, requestUsage as never)
    })
    await history.appendBatch([
      {
        ...event('discarded-attempt', 1), kind: 'model-attempt-discarded',
        payload: { modelTurn: 1, attempt: 1, reasonCode: 'SILENT_CONTEXT_OVERFLOW', sessionLedger: { location, requestUsage: {
          schemaVersion: 1, requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { input_tokens: 20, output_tokens: 2 }, source: 'api', resultDisposition: 'discarded_overflow'
        } } }
      },
      {
        ...event('model-response', 2), kind: 'model-response-committed',
        payload: {
          modelTurn: 1,
          attempt: 2,
          message: { role: 'assistant', content: 'done' },
          sessionLedger: { location, requestUsage: {
            schemaVersion: 1, requestId: 'inv-1:round:1:attempt:2', turnId: 'turn-1', usage: { input_tokens: 12, output_tokens: 3 }, source: 'api'
          } }
        }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairUsageLedger })

    expect(repairUsageLedger).toHaveBeenNthCalledWith(1, location, {
      schemaVersion: 1, requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { input_tokens: 20, output_tokens: 2 }, source: 'api', resultDisposition: 'discarded_overflow'
    })
    expect(repairUsageLedger).toHaveBeenNthCalledWith(2, location, {
      schemaVersion: 1, requestId: 'inv-1:round:1:attempt:2', turnId: 'turn-1', usage: { input_tokens: 12, output_tokens: 3 }, source: 'api'
    })
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'request_usage', payload: { requestId: 'inv-1:round:1', usage: { input_tokens: 20, output_tokens: 2 }, resultDisposition: 'discarded_overflow' } },
      { type: 'request_usage', payload: { requestId: 'inv-1:round:1:attempt:2', usage: { input_tokens: 12, output_tokens: 3 } } }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('rejects a request_usage sidecar bound to another invocation before session projection', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/cross-invocation-usage', sessionId: 'session-usage-owner', createdAt: 1000 }
    const repairUsageLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([{
      ...event('cross-invocation-usage', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done' }, sessionLedger: { location, requestUsage: {
        schemaVersion: 1, requestId: 'other-invocation:round:1', turnId: 'turn-1', usage: { input_tokens: 2, output_tokens: 1 }, source: 'api'
      } } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairUsageLedger, onUsageLedgerRepairError: onRepairError })

    expect(repairUsageLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'other-invocation:round:1')
    conn.close()
  })

  it('replays missing tool proposal and result ledger events in canonical History order', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-ledger-order-'))
    const location = { workDir: root, sessionId: 'session-order', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const proposal = (id: string, sequence: number) => ({
      ...event(`response-${sequence}`, sequence), kind: 'model-response-committed' as const,
      payload: { message: { role: 'assistant', toolCalls: [{ id, name: 'read_file', input: { path: `${id}.txt` } }] }, sessionLedger: {
        location, stepId: `${id}:step`, toolCalls: [{ toolUseId: id, name: 'read_file', args: { path: `${id}.txt` } }]
      } }
    })
    await history.appendBatch([
      proposal('call-1', 1),
      { ...event('finished-1', 2), kind: 'tool-call-finished', payload: { toolCallId: 'call-1', result: { success: true, data: 'one' }, sessionLedger: { location, stepId: 'call-1:step', result: { success: true, data: 'one' } } } },
      proposal('call-2', 3),
      { ...event('finished-2', 4), kind: 'tool-call-finished', payload: { toolCallId: 'call-2', result: { success: true, data: 'two' }, sessionLedger: { location, stepId: 'call-2:step', result: { success: true, data: 'two' } } } }
    ], 0)

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: (repairLocation, toolCall) => ensureToolCallEvent(sink, toolCall as never),
      repairToolLedger: (repairLocation, result) => ensureToolResultEvent(sink, result as never)
    })

    const repaired = await readSessionEvents(sink.eventsPath)
    expect(repaired.map(({ type, payload }) => [type, payload.toolUseId])).toEqual([
      ['tool_call', 'call-1'], ['tool_result', 'call-1'], ['tool_call', 'call-2'], ['tool_result', 'call-2']
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs missing tool-call session events from a canonical model response envelope', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-tool-call-repair-'))
    const location = { workDir: root, sessionId: 'session-1', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const repairToolCallLedger = vi.fn((repairLocation, toolCall) => {
      expect(repairLocation).toEqual(location)
      return ensureToolCallEvent(sink, toolCall)
    })
    await history.appendBatch([{
      ...event('model-response', 1),
      kind: 'model-response-committed',
      payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'tc-proposed', name: 'write_file', input: { path: 'a.txt' } }] },
        sessionLedger: {
          location,
          stepId: 'req-1:model:1', toolCalls: [{ toolUseId: 'tc-proposed', name: 'write_file', args: { path: 'a.txt' } }]
        }
      }
    }], 0)

    await history.recoverInterruptedInvocations({ repairToolCallLedger })

    expect(repairToolCallLedger).toHaveBeenCalledWith(
      location,
      { toolUseId: 'tc-proposed', turnId: 'turn-1', stepId: 'req-1:model:1', name: 'write_file', args: { path: 'a.txt' } }
    )
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'tool_call', payload: { toolUseId: 'tc-proposed', turnId: 'turn-1', stepId: 'req-1:model:1', name: 'write_file', args: { path: 'a.txt' } } }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs the tool result session ledger from a canonical tool completion event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-tool-repair-'))
    const location = { workDir: root, sessionId: 'session-1', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const repairToolLedger = vi.fn((repairLocation, repairEvent) => {
      expect(repairLocation).toEqual(location)
      return ensureToolResultEvent(sink, repairEvent)
    })
    await history.appendBatch([{
      ...event('tool-finished', 1),
      kind: 'tool-call-finished',
      payload: {
        toolCallId: 'tc-1', toolName: 'read_file', isError: false, result: { success: true, data: 'file contents' },
        sessionLedger: {
          location,
          stepId: 'req-1', result: { success: true, data: 'file contents' }
        }
      }
    }], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger })

    expect(repairToolLedger).toHaveBeenCalledWith(
      location,
      { toolUseId: 'tc-1', turnId: 'turn-1', stepId: 'req-1', result: { success: true, data: 'file contents' } }
    )
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'tool_result', payload: { toolUseId: 'tc-1', turnId: 'turn-1', stepId: 'req-1', result: { success: true, data: 'file contents' } } }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('rejects a tool result sidecar whose call id differs from the canonical proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/cross-tool-result', sessionId: 'session-tool-owner', createdAt: 1000 }
    const repairToolLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('proposal-identity', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'expected-call', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: { location, stepId: 'expected-step', toolCalls: [{ toolUseId: 'expected-call', name: 'read_file', args: { path: 'a.txt' } }] } }
      },
      {
        ...event('finished-identity', 2), kind: 'tool-call-finished',
        payload: { toolCallId: 'other-call', sessionLedger: { location, stepId: 'other-step', result: { success: true, data: 'foreign result' } } }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'other-call')
    conn.close()
  })

  it('rejects a tool result sidecar that differs from the canonical completion result', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/result-drift', sessionId: 'session-result-drift', createdAt: 1000 }
    const repairToolLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('proposal-result-drift', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-result-drift', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: { location, stepId: 'result-drift-step', toolCalls: [{ toolUseId: 'call-result-drift', name: 'read_file', args: { path: 'a.txt' } }] } }
      },
      {
        ...event('finished-result-drift', 2), kind: 'tool-call-finished',
        payload: {
          toolCallId: 'call-result-drift', result: { success: true, data: 'canonical contents' },
          sessionLedger: { location, stepId: 'result-drift-step', result: { success: true, data: 'different contents' } }
        }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'call-result-drift')
    conn.close()
  })

  it('rejects an orphan tool result when canonical model responses declare no tool calls', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/orphan-tool-result', sessionId: 'session-orphan-result', createdAt: 1000 }
    const repairToolLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([
      { ...event('response-without-tools', 1), kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'done' } } },
      { ...event('orphan-result', 2), kind: 'tool-call-finished', payload: { toolCallId: 'orphan-call', sessionLedger: {
        location, stepId: 'orphan-step', result: { success: true, data: 'unrequested result' }
      } } }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'orphan-call')
    conn.close()
  })

  it('rejects a tool proposal sidecar whose call id is absent from the canonical response', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/cross-tool-proposal', sessionId: 'session-proposal-owner', createdAt: 1000 }
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onRepairError = vi.fn()
    await history.appendBatch([{
      ...event('proposal-sidecar-identity', 1), kind: 'model-response-committed',
      payload: { message: { role: 'assistant', toolCalls: [{ id: 'canonical-call', name: 'read_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'request:model:1', toolCalls: [{ toolUseId: 'foreign-call', name: 'read_file', args: { path: 'secret.txt' } }] } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError: onRepairError })

    expect(repairToolCallLedger).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'foreign-call')
    conn.close()
  })

  it('does not project later tool results after an earlier proposal projection fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-order', sessionId: 'session-order', createdAt: 1000 }
    await history.appendBatch([
      {
        ...event('response-order', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-order', name: 'read_file', input: { path: '/tmp/a.txt' } }] },
          sessionLedger: { location, stepId: 'request-order:model:1', toolCalls: [{ toolUseId: 'call-order', name: 'read_file', args: { path: '/tmp/a.txt' } }] } }
      },
      {
        ...event('finished-order', 2), kind: 'tool-call-finished',
        payload: { toolCallId: 'call-order', result: { success: true, data: 'contents' }, sessionLedger: { location, stepId: 'request-order:model:1', result: { success: true, data: 'contents' } } }
      }
    ], 0)
    let failProposalOnce = true
    const repairOrder: string[] = []
    const repairProposal = vi.fn(async () => {
      if (failProposalOnce) {
        failProposalOnce = false
        throw new Error('injected proposal JSONL failure')
      }
      repairOrder.push('tool_call')
    })
    const repairResult = vi.fn(async () => { repairOrder.push('tool_result') })
    const onRepairError = vi.fn()

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: repairProposal,
      repairToolLedger: repairResult,
      onToolLedgerRepairError: onRepairError
    })

    expect(repairProposal).toHaveBeenCalledOnce()
    expect(repairResult).not.toHaveBeenCalled()
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'call-order')

    await history.recoverInterruptedInvocations({ repairToolCallLedger: repairProposal, repairToolLedger: repairResult })
    expect(repairProposal).toHaveBeenCalledTimes(2)
    expect(repairResult).toHaveBeenCalledOnce()
    expect(repairOrder).toEqual(['tool_call', 'tool_result'])
    conn.close()
  })

  it('continues recovery for an independent session ledger after another ledger projection fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const firstLocation = { workDir: '/tmp/recovery-first', sessionId: 'session-first', createdAt: 1000 }
    const secondLocation = { workDir: '/tmp/recovery-second', sessionId: 'session-second', createdAt: 2000 }
    await history.appendBatch([
      {
        ...event('response-first', 1), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-first', name: 'read_file', input: { path: '/tmp/a.txt' } }] },
          sessionLedger: { location: firstLocation, stepId: 'step-first', toolCalls: [{ toolUseId: 'call-first', name: 'read_file', args: { path: '/tmp/a.txt' } }] } }
      },
      {
        ...event('finished-first', 2), kind: 'tool-call-finished',
        payload: { toolCallId: 'call-first', result: { success: true, data: 'first' }, sessionLedger: { location: firstLocation, stepId: 'step-first', result: { success: true, data: 'first' } } }
      },
      {
        ...event('response-second', 3), kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-second', name: 'read_file', input: { path: '/tmp/b.txt' } }] },
          sessionLedger: { location: secondLocation, stepId: 'step-second', toolCalls: [{ toolUseId: 'call-second', name: 'read_file', args: { path: '/tmp/b.txt' } }] } }
      },
      {
        ...event('finished-second', 4), kind: 'tool-call-finished',
        payload: { toolCallId: 'call-second', result: { success: true, data: 'second' }, sessionLedger: { location: secondLocation, stepId: 'step-second', result: { success: true, data: 'second' } } }
      }
    ], 0)
    const repaired: string[] = []
    const repairProposal = vi.fn(async (location: { sessionId: string }, call: { toolUseId: string }) => {
      if (location.sessionId === firstLocation.sessionId) throw new Error('first ledger is unavailable')
      repaired.push(`${call.toolUseId}:tool_call`)
    })
    const repairResult = vi.fn(async (location: { sessionId: string }, result: { toolUseId: string }) => {
      if (location.sessionId === firstLocation.sessionId) throw new Error('first ledger is unavailable')
      repaired.push(`${result.toolUseId}:tool_result`)
    })
    const onRepairError = vi.fn()

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: repairProposal,
      repairToolLedger: repairResult,
      onToolLedgerRepairError: onRepairError
    })

    expect(repairProposal).toHaveBeenCalledTimes(2)
    expect(repairResult).toHaveBeenCalledTimes(1)
    expect(repaired).toEqual(['call-second:tool_call', 'call-second:tool_result'])
    expect(onRepairError).toHaveBeenCalledTimes(1)
    conn.close()
  })

  it('recovers a tool result when the JSONL sink fails after canonical History commit', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-outbox-recovery-'))
    const location = { workDir: root, sessionId: 'session-outbox', createdAt: 1000 }
    await fs.writeFile(path.join(root, 'sessions'), 'block session directory creation')
    const result = { success: true, data: { content: 'committed output' }, auditRef: 'audit:tc-outbox' }
    await history.appendBatch([{
      ...event('tool-finished-outbox', 1),
      kind: 'tool-call-finished',
      payload: { toolCallId: 'tc-outbox', isError: false, result, auditRef: result.auditRef, sessionLedger: { location, stepId: 'req-outbox', result } }
    }], 0)

    const failedSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await expect(failedSink.appendCritical({ type: 'tool_result', payload: { toolUseId: 'tc-outbox', stepId: 'req-outbox', result } })).rejects.toThrow()
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [{ kind: 'tool-call-finished' }] })
    await expect(failedSink.close()).rejects.toThrow()
    await fs.rm(path.join(root, 'sessions'))

    const recoveredSink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await history.recoverInterruptedInvocations({
      repairToolLedger: (_location, repairEvent) => ensureToolResultEvent(recoveredSink, repairEvent as never)
    })
    await expect(readSessionEvents(recoveredSink.eventsPath)).resolves.toMatchObject([
      { type: 'tool_result', payload: { toolUseId: 'tc-outbox', stepId: 'req-outbox', result } }
    ])
    await recoveredSink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('persists ordered invocation events and replays idempotently after adapter recreation', async () => {
    const conn = createDb()
    const first = new SqliteAgentHistory(conn, 1, () => 123)
    const events = [event('e1', 1), event('e2', 2)]
    await expect(first.appendBatch(events, 0)).resolves.toEqual({ version: 2, duplicate: false })

    const reopened = new SqliteAgentHistory(conn)
    await expect(reopened.read('inv-1')).resolves.toEqual({ invocationId: 'inv-1', version: 2, schemaVersion: 1, events })
    await expect(reopened.appendBatch(events, 0)).resolves.toEqual({ version: 2, duplicate: true })
    conn.close()
  })

  it('refuses new History facts after an invocation terminal event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{ ...event('history-terminal', 1), kind: 'invocation-completed', payload: { status: 'completed' } }], 0)

    await expect(history.appendBatch([{
      ...event('history-after-terminal', 2), kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'late write' } }
    }], 1)).rejects.toThrow(/terminal invocation event/)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ eventId: 'history-terminal' })] })
    conn.close()
  })

  it('treats persisted events after a terminal as History corruption', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([
      { ...event('before-terminal', 1), kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'done' } } },
      { ...event('after-terminal', 2), kind: 'approval-updated', payload: { status: 'late' } }
    ], 0)
    conn.prepare('UPDATE agent_history_events SET kind = ? WHERE invocation_id = ? AND sequence = ?').run('invocation-completed', 'inv-1', 1)

    await expect(history.read('inv-1')).rejects.toMatchObject({ code: 'history-corrupt' })
    conn.close()
  })

  it('rolls back the whole batch if any event insert fails', async () => {
    const conn = createDb()
    conn.exec(`CREATE TRIGGER reject_second_history_event BEFORE INSERT ON agent_history_events
      WHEN NEW.event_id = 'e2' BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`)
    const history = new SqliteAgentHistory(conn)
    await expect(history.appendBatch([event('e1', 1), event('e2', 2)], 0)).rejects.toThrow('injected history failure')
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 0, events: [] })
    expect((conn.prepare('SELECT COUNT(*) AS count FROM agent_history_events').get() as { count: number }).count).toBe(0)
    conn.close()
  })

  it('isolates versions by invocation and rejects stale writers', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('e1', 1)], 0)
    const other = { ...event('e2', 1), invocationId: 'inv-2', turnId: 'turn-2' }
    await expect(history.appendBatch([other], 0)).resolves.toEqual({ version: 1, duplicate: false })
    await expect(history.appendBatch([{ ...event('e2', 2) }], 0)).rejects.toMatchObject({ code: 'version-conflict' })
    conn.close()
  })

  it('rejects changing turn ownership within one invocation stream', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('turn-owner', 1)], 0)

    await expect(history.appendBatch([{ ...event('wrong-turn', 2), turnId: 'another-turn' }], 1))
      .rejects.toThrow(/invocation.*turn/i)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ turnId: 'turn-1' })] })
    conn.close()
  })

  it('reports a persisted stream with multiple turn owners as History corruption', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('turn-one', 1), event('turn-two', 2)], 0)
    conn.prepare('UPDATE agent_history_events SET turn_id = ? WHERE invocation_id = ? AND sequence = ?').run('another-turn', 'inv-1', 2)

    await expect(history.read('inv-1')).rejects.toMatchObject({ code: 'history-corrupt' })
    conn.close()
  })

  it('refuses completed tool reconstruction when terminal and result success facts conflict', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-tool-result-conflict')
    await history.appendBatch([
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 1, schemaVersion: 1, eventId: 'response', idempotencyKey: 'response', kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] } } },
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 2, schemaVersion: 1, eventId: 'started', idempotencyKey: 'started', kind: 'tool-call-started', payload: { toolCallId: 'call-1', toolName: 'read_file', inputHash: 'a'.repeat(64) } },
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 3, schemaVersion: 1, eventId: 'finished', idempotencyKey: 'finished', kind: 'tool-call-finished', payload: { toolCallId: 'call-1', success: true, result: { success: false, error: 'contradictory result' } } },
      { invocationId: 'tool-result-conflict', turnId: 'turn-conflict', sequence: 4, schemaVersion: 1, eventId: 'completed', idempotencyKey: 'completed', kind: 'invocation-completed', payload: { status: 'completed', outputText: 'done' } }
    ], 0)

    expect(history.readCompletedToolCallsForSession('tool-result-conflict', 'session-tool-result-conflict', 'turn-conflict')).toBeUndefined()
    conn.close()
  })

  it('rejects a repeated event id with a new idempotency key', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('same-id', 1)], 0)
    await expect(history.appendBatch([{ ...event('same-id', 2), idempotencyKey: 'other-key' }], 1)).rejects.toMatchObject({ code: 'idempotency-conflict' })
    conn.close()
  })

  it('refuses to rebuild when persisted version metadata no longer matches canonical events', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([event('e1', 1), event('e2', 2)], 0)
    conn.prepare('DELETE FROM agent_history_events WHERE invocation_id = ? AND sequence = ?').run('inv-1', 1)
    await expect(history.read('inv-1')).rejects.toMatchObject({ code: 'history-corrupt' })
    conn.close()
  })

  it('blocks recovery when a tool result is bound to a different model-response step', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-cross-step', createdAt: 1000 }
    const proposalStepId = 'inv-1:model:1'
    const repairToolCallLedger = vi.fn(async () => undefined)
    const repairToolLedger = vi.fn(async () => undefined)
    const repairError = vi.fn()
    await history.appendBatch([
      {
        ...event('cross-step-response', 1), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: 'step-call', name: 'read_file', input: { path: 'a.txt' } }] },
          sessionLedger: { location, stepId: proposalStepId, toolCalls: [{ toolUseId: 'step-call', name: 'read_file', args: { path: 'a.txt' } }] } }
      },
      { ...event('cross-step-start', 2), kind: 'tool-call-started', payload: { toolCallId: 'step-call', toolName: 'read_file' } },
      { ...event('cross-step-finish', 3), kind: 'tool-call-finished', payload: {
        toolCallId: 'step-call', success: true,
        sessionLedger: { location, stepId: 'another-invocation-step', result: { success: true, data: 'contents' } }
      } }
    ], 0)

    await history.recoverInterruptedInvocations({ repairToolCallLedger, repairToolLedger, onToolLedgerRepairError: repairError })

    expect(repairToolCallLedger).toHaveBeenCalledOnce()
    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(repairError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/step identity/i) }), 'inv-1', 'step-call')
    conn.close()
  })

  it('closes pending dispatches as interrupted on restart and does not append twice', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{ ...event('e1', 1), payload: { toolCallId: 'tc-1' } }], 0)

    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
      { invocationId: 'inv-1', state: 'interrupted' }
    ])
    const snapshot = await history.read('inv-1')
    expect(snapshot.events.at(-1)).toMatchObject({
      kind: 'invocation-interrupted',
      payload: { status: 'interrupted', reason: 'process-restart' }
    })
    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
      { invocationId: 'inv-1', state: 'interrupted' }
    ])
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 2 })
    conn.close()
  })

  it('keeps a restarted dispatched invocation fenced from provider replay', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-dispatch-restart-'))
    const dbPath = path.join(root, 'history.db')
    let conn = createDb(dbPath)
    try {
      const history = new SqliteAgentHistory(conn)
      await history.appendBatch([{
        ...event('restart-dispatched-tool', 1),
        kind: 'tool-call-started',
        payload: { toolCallId: 'already-dispatched', toolName: 'write_file' }
      }], 0)
      await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
        { invocationId: 'inv-1', state: 'interrupted' }
      ])
      conn.close()

      conn = createDb(dbPath)
      const reopenedHistory = new SqliteAgentHistory(conn)
      const registry = new ModelProviderRegistry()
      const providerStream = vi.fn(async function* () {
        yield { type: 'text-delta' as const, text: 'must not replay' }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' as const }
      })
      registry.register({ routeId: 'restart-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
        providerId: 'restart-provider', stream: providerStream
      })
      const permits = new InMemorySafetyPermitStore()
      const capabilities = new CapabilityRegistry()
      await expect(runAgentTurn({
        registry, routeId: 'restart-route', invocationId: 'inv-1', turnId: 'turn-1',
        request: { messages: [{ role: 'user', content: 'resume' }], maxTokens: 20 },
        safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
        prepareTool: vi.fn(),
        toolExecution: createPermitBoundToolExecutionPort({
          permits, admission: new InMemoryExecutionAdmissionCoordinator(),
          resolveExpected: async () => { throw new Error('provider replay must not reach tool execution') },
          execute: async () => ({ output: null })
        }),
        maxModelTurns: 1, history: reopenedHistory
      })).rejects.toThrow('History invocation is already terminal')
      expect(providerStream).not.toHaveBeenCalled()
      const recovered = await reopenedHistory.read('inv-1')
      expect(recovered.version).toBe(2)
      expect(recovered.events[0]).toMatchObject({ kind: 'tool-call-started', payload: { toolCallId: 'already-dispatched' } })
      expect(recovered.events[1]).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })
    } finally {
      conn.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a restarted committed tool proposal fenced before approval or dispatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-proposal-restart-'))
    const dbPath = path.join(root, 'history.db')
    let conn = createDb(dbPath)
    try {
      const history = new SqliteAgentHistory(conn)
      await history.appendBatch([{
        ...event('restart-proposed-tool', 1),
        kind: 'model-response-committed',
        payload: { message: { role: 'assistant', toolCalls: [{ id: 'not-yet-approved', name: 'write_file', input: { path: 'draft.txt' } }] } }
      }], 0)
      await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
        { invocationId: 'inv-1', state: 'interrupted' }
      ])
      conn.close()

      conn = createDb(dbPath)
      const reopenedHistory = new SqliteAgentHistory(conn)
      const registry = new ModelProviderRegistry()
      const providerStream = vi.fn(async function* () {
        yield { type: 'text-delta' as const, text: 'must not replay' }
        yield { type: 'usage' as const, inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish' as const, reason: 'stop' as const }
      })
      registry.register({ routeId: 'proposal-restart-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
        providerId: 'proposal-restart-provider', stream: providerStream
      })
      const permits = new InMemorySafetyPermitStore()
      await expect(runAgentTurn({
        registry, routeId: 'proposal-restart-route', invocationId: 'inv-1', turnId: 'turn-1',
        request: { messages: [{ role: 'user', content: 'resume' }], maxTokens: 20 },
        safetyGate: new SafetyGate({ capabilities: new CapabilityRegistry(), permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
        prepareTool: vi.fn(),
        toolExecution: createPermitBoundToolExecutionPort({
          permits, admission: new InMemoryExecutionAdmissionCoordinator(),
          resolveExpected: async () => { throw new Error('provider replay must not reach tool execution') },
          execute: async () => ({ output: null })
        }),
        maxModelTurns: 1, history: reopenedHistory
      })).rejects.toThrow('History invocation is already terminal')
      expect(providerStream).not.toHaveBeenCalled()
      const recovered = await reopenedHistory.read('inv-1')
      expect(recovered.version).toBe(2)
      expect(recovered.events[0]).toMatchObject({ kind: 'model-response-committed', payload: { message: { toolCalls: [{ id: 'not-yet-approved' }] } } })
      expect(recovered.events[1]).toMatchObject({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })
    } finally {
      conn.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('projects a restart interruption to turn_end from its canonical request ledger', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-restart-terminal', createdAt: 1000 }
    await history.appendBatch([{
      ...event('restart-request', 1), kind: 'model-request-started',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1,
        sessionLedger: { location, requestHeader: { requestId: 'inv-1:round:1', attempt: 1 }, requestContext: { requestId: 'inv-1:round:1', attempt: 1 } } }
    }], 0)
    let failTerminalRepair = true
    const repairInvocationTerminal = vi.fn(async () => {
      if (failTerminalRepair) {
        failTerminalRepair = false
        throw new Error('injected restart turn_end write failure')
      }
    })
    const onInvocationTerminalRepairError = vi.fn()

    const recoveryOptions = { repairInvocationTerminal, onInvocationTerminalRepairError }
    await expect(history.recoverInterruptedInvocations(recoveryOptions)).resolves.toMatchObject([{ state: 'interrupted' }])

    expect(repairInvocationTerminal).toHaveBeenNthCalledWith(1, location, {
      status: 'interrupted', turnId: 'turn-1', reason: 'interrupted'
    })
    expect(onInvocationTerminalRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'turn-1')
    await expect(history.recoverInterruptedInvocations(recoveryOptions)).resolves.toMatchObject([{ state: 'interrupted' }])
    expect(repairInvocationTerminal).toHaveBeenCalledTimes(2)
    await expect(history.read('inv-1')).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'invocation-interrupted', payload: {
        status: 'interrupted', reason: 'process-restart', sessionLedger: { location, turnId: 'turn-1', reason: 'interrupted' }
      } })])
    })
    conn.close()
  })

  it('resolves a restart terminal owner from the atomic accepted-input marker before invocation context exists', async () => {
    const conn = createDb()
    const sessionId = 'session-accepted-before-context'
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const location = { workDir: '/workspace', sessionId, createdAt: 1000 }
    await history.appendBatch([{
      ...event('accepted-input-only', 1),
      kind: 'session-input-committed',
      payload: { sessionId, messageId: 'user-accepted', role: 'user', inputFingerprint: 'a'.repeat(64) }
    }], 0)
    const resolveSessionLedgerLocation = vi.fn(async (ownerSessionId: string) => ownerSessionId === sessionId ? location : undefined)
    let failRepair = true
    const repairInvocationTerminal = vi.fn(async () => {
      if (failRepair) { failRepair = false; throw new Error('injected accepted-input terminal repair failure') }
    })
    const onInvocationTerminalRepairError = vi.fn()

    const recoveryOptions = { resolveSessionLedgerLocation, repairInvocationTerminal, onInvocationTerminalRepairError }
    await history.recoverInterruptedInvocations(recoveryOptions)
    await history.recoverInterruptedInvocations(recoveryOptions)

    expect(resolveSessionLedgerLocation).toHaveBeenCalledWith(sessionId)
    expect(resolveSessionLedgerLocation).toHaveBeenCalledOnce()
    expect(repairInvocationTerminal).toHaveBeenCalledTimes(2)
    expect(onInvocationTerminalRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'turn-1')
    expect(repairInvocationTerminal).toHaveBeenCalledWith(location, { status: 'interrupted', turnId: 'turn-1', reason: 'interrupted' })
    await expect(history.read('inv-1')).resolves.toMatchObject({ events: [
      expect.objectContaining({ kind: 'session-input-committed', sequence: 1 }),
      expect.objectContaining({ kind: 'invocation-interrupted', payload: {
        status: 'interrupted', reason: 'process-restart',
        sessionLedger: { location, turnId: 'turn-1', reason: 'interrupted' }
      } })
    ] })
    conn.close()
  })

  it('does not resolve a restart owner from a malformed or cross-session accepted-input marker', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-stream-owner')
    await history.appendBatch([{
      ...event('accepted-input-invalid-owner', 1),
      kind: 'session-input-committed',
      payload: { sessionId: 'session-other', messageId: 'user-accepted', role: 'user', inputFingerprint: 'not-a-fingerprint' }
    }], 0)
    const resolveSessionLedgerLocation = vi.fn(() => ({ workDir: '/workspace', sessionId: 'session-other', createdAt: 1000 }))
    const repairInvocationTerminal = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ resolveSessionLedgerLocation, repairInvocationTerminal })

    expect(resolveSessionLedgerLocation).not.toHaveBeenCalled()
    expect(repairInvocationTerminal).not.toHaveBeenCalled()
    await expect(history.read('inv-1')).resolves.toMatchObject({ events: [
      expect.objectContaining({ kind: 'session-input-committed', sequence: 1 }),
      expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })
    ] })
    conn.close()
  })

  it('does not guess a restart terminal location when canonical sidecars disagree', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const firstLocation = { workDir: '/workspace', sessionId: 'session-a', createdAt: 1000 }
    const secondLocation = { workDir: '/workspace', sessionId: 'session-b', createdAt: 1000 }
    await history.appendBatch([
      { ...event('restart-request-a', 1), kind: 'model-request-started', payload: {
        requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1,
        sessionLedger: { location: firstLocation, requestHeader: { requestId: 'inv-1:round:1', attempt: 1 }, requestContext: { requestId: 'inv-1:round:1', attempt: 1 } }
      } },
      { ...event('restart-request-b', 2), kind: 'model-request-started', payload: {
        requestId: 'inv-1:round:2', modelTurn: 2, attempt: 1,
        sessionLedger: { location: secondLocation, requestHeader: { requestId: 'inv-1:round:2', attempt: 1 }, requestContext: { requestId: 'inv-1:round:2', attempt: 1 } }
      } }
    ], 0)
    const repairInvocationTerminal = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).not.toHaveBeenCalled()
    await expect(history.read('inv-1')).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } })])
    })
    conn.close()
  })

  it('closes a committed model request as interrupted on restart instead of resuming it', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('request-started-restart', 1), kind: 'model-request-started',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1', requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } } }
    }], 0)

    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([{ invocationId: 'inv-1', state: 'interrupted' }])
    const snapshot = await history.read('inv-1')
    expect(snapshot.events.map(({ kind }) => kind)).toEqual(['model-request-started', 'invocation-interrupted'])
    conn.close()
  })

  it('repairs missing request header and context session events from canonical request History', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-request-repair-'))
    const location = { workDir: root, sessionId: 'session-request-repair', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const requestHeader = { route: 'anthropic.messages.stream', requestId: 'inv-1:round:1', attempt: 1, system: 'safe system', messages: [] }
    const requestContext = { requestId: 'inv-1:round:1', attempt: 1, provider: 'anthropic', model: 'test-model' }
    const repairModelRequestLedger = vi.fn(async (repairLocation, ledger) => {
      expect(repairLocation).toEqual(location)
      await ensureRequestProjectionEvents(sink, ledger as never)
    })
    await history.appendBatch([{
      ...event('request-started-sidecars', 1), kind: 'model-request-started',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1',
        requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
        sessionLedger: { location, requestHeader, requestContext } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger })
    await history.recoverInterruptedInvocations({ repairModelRequestLedger })

    expect(repairModelRequestLedger).toHaveBeenCalledTimes(2)
    expect(repairModelRequestLedger).toHaveBeenCalledWith(location, { requestHeader, requestContext })
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'request_header', payload: requestHeader }, { type: 'request_context', payload: requestContext }
    ])
    expect(await readSessionEvents(sink.eventsPath)).toHaveLength(2)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs final usage-anchored request context from the committed model response outbox', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context', createdAt: 1000 }
    const requestContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 55 } }
    await history.appendBatch([{
      ...event('response-final-context', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] },
        sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } }, requestContext } }
    }], 0)
    const repairUsageLedger = vi.fn(async () => undefined)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairUsageLedger, repairFinalRequestContextLedger })

    expect(repairFinalRequestContextLedger).toHaveBeenCalledOnce()
    expect(repairFinalRequestContextLedger).toHaveBeenCalledWith(location, requestContext)
    conn.close()
  })

  it('repairs final response context even when its usage ledger is absent', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context-without-usage', createdAt: 1000 }
    const requestContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 55 } }
    await history.appendBatch([{
      ...event('response-final-context-without-usage', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: { location, requestContext } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairFinalRequestContextLedger })

    expect(repairFinalRequestContextLedger).toHaveBeenCalledWith(location, requestContext)
    conn.close()
  })

  it('repairs output truncation tool result and retry projections from canonical History sidecars', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-output-recovery-'))
    const location = { workDir: root, sessionId: 'session-output-recovery', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const toolCallId = 'partial-call'
    const requestRetry = { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'model_output_token_limit' }
    const toolResult = { success: false, error: 'model_output_token_limit', userMessage: 'tool proposal truncated', notExecuted: true, notExecutedReason: 'model_output_truncated' }
    await history.appendBatch([
      { ...event('output-response', 1), kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: toolCallId, name: 'write_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'inv-1', toolCalls: [{ toolUseId: toolCallId, name: 'write_file', args: { path: 'a.txt' } }] }
      } },
      { ...event('output-not-dispatched', 2), kind: 'tool-call-not-dispatched', payload: {
        toolCallId, reason: 'MODEL_OUTPUT_TRUNCATED', replayContent: 'tool proposal truncated', isError: true,
        sessionLedger: { location, stepId: 'inv-1', result: toolResult }
      } },
      { ...event('output-retry-scheduled', 3), kind: 'provider-retry-scheduled', payload: {
        requestId: requestRetry.requestId, modelTurn: 1, routeId: 'route-1', retryAttempt: 1, code: requestRetry.code, backoffMs: 0,
        sessionLedger: { location, requestRetry }
      } }
    ], 0)
    const repairToolLedger = vi.fn(async (_location, result) => { await ensureToolResultEvent(sink, result as never) })
    const repairProviderRetryLedger = vi.fn(async (_location, retry) => { await ensureRequestRetryEvent(sink, retry) })

    await history.recoverInterruptedInvocations({ repairToolLedger, repairProviderRetryLedger })
    await history.recoverInterruptedInvocations({ repairToolLedger, repairProviderRetryLedger })

    expect(repairToolLedger).toHaveBeenCalledWith(location, { toolUseId: toolCallId, turnId: 'turn-1', stepId: 'inv-1', result: toolResult })
    expect(repairProviderRetryLedger).toHaveBeenCalledWith(location, requestRetry)
    const projected = await readSessionEvents(sink.eventsPath)
    expect(projected.map(({ type }) => type)).toEqual(['tool_result', 'request_retry'])
    expect(projected[0]?.payload).toMatchObject({ toolUseId: toolCallId, turnId: 'turn-1', stepId: 'inv-1', result: toolResult })
    expect(projected[1]?.payload).toEqual(requestRetry)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs revoked not-dispatched tool result projection from canonical History sidecars', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-revoked-recovery-'))
    const location = { workDir: root, sessionId: 'session-revoked-recovery', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const toolCallId = 'revoked-call'
    const result = { success: false, data: 'Tool call was not dispatched (REVOKED).' }
    await history.appendBatch([
      { ...event('revoked-response', 1), kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: toolCallId, name: 'read_file', input: { path: 'note.txt' } }] },
        sessionLedger: { location, stepId: 'invocation-revoked', toolCalls: [{ toolUseId: toolCallId, name: 'read_file', args: { path: 'note.txt' } }] }
      } },
      { ...event('revoked-not-dispatched', 2), kind: 'tool-call-not-dispatched', payload: {
        toolCallId, reason: 'REVOKED', replayContent: result.data, isError: true,
        sessionLedger: { location, stepId: 'invocation-revoked', result }
      } }
    ], 0)
    const repairToolCallLedger = vi.fn(async (_location, proposal) => { await ensureToolCallEvent(sink, proposal as never) })
    const repairToolLedger = vi.fn(async (_location, projected) => { await ensureToolResultEvent(sink, projected as never) })

    await history.recoverInterruptedInvocations({ repairToolCallLedger, repairToolLedger })
    await history.recoverInterruptedInvocations({ repairToolCallLedger, repairToolLedger })

    expect(repairToolLedger).toHaveBeenCalledWith(location, { toolUseId: toolCallId, turnId: 'turn-1', stepId: 'invocation-revoked', result })
    const projected = await readSessionEvents(sink.eventsPath)
    expect(projected.map(({ type }) => type)).toEqual(['tool_call', 'tool_result'])
    expect(projected[1]?.payload).toMatchObject({ toolUseId: toolCallId, turnId: 'turn-1', stepId: 'invocation-revoked', result })
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('blocks output recovery sidecars when the truncated tool ID is absent from canonical proposals', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-output-recovery-forged', createdAt: 1000 }
    await history.appendBatch([
      { ...event('output-forged-response', 1), kind: 'model-response-committed', payload: {
        modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: 'canonical-call', name: 'write_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'inv-1', toolCalls: [{ toolUseId: 'canonical-call', name: 'write_file', args: { path: 'a.txt' } }] }
      } },
      { ...event('output-forged-not-dispatched', 2), kind: 'tool-call-not-dispatched', payload: {
        toolCallId: 'forged-call', reason: 'MODEL_OUTPUT_TRUNCATED', replayContent: 'not executed', isError: true,
        sessionLedger: { location, stepId: 'inv-1', result: { success: false, notExecuted: true, notExecutedReason: 'model_output_truncated' } }
      } },
      { ...event('output-forged-retry', 3), kind: 'provider-retry-scheduled', payload: {
        requestId: 'inv-1:round:1', modelTurn: 1, routeId: 'route-1', retryAttempt: 1, code: 'model_output_token_limit', backoffMs: 0,
        sessionLedger: { location, requestRetry: { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'model_output_token_limit' } }
      } }
    ], 0)
    const repairToolLedger = vi.fn(async () => undefined)
    const repairProviderRetryLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()
    const onModelRequestLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolLedger, repairProviderRetryLedger, onToolLedgerRepairError, onModelRequestLedgerRepairError })

    expect(repairToolLedger).not.toHaveBeenCalled()
    expect(repairProviderRetryLedger).not.toHaveBeenCalled()
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'forged-call')
    expect(onModelRequestLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('does not repair final response context when its usage ledger repair fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context-usage-failed', createdAt: 1000 }
    const requestContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, contextUsage: { pressureTokens: 55 } }
    await history.appendBatch([{
      ...event('response-final-context-usage-failed', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: {
        location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } }, requestContext
      } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({
      repairUsageLedger: async () => { throw new Error('usage projection failed') },
      repairFinalRequestContextLedger
    })

    expect(repairFinalRequestContextLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('rejects final request-context sidecars with a nonpositive attempt or array usage', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-invalid-final-context', createdAt: 1000 }
    await history.appendBatch([{
      ...event('response-invalid-final-context', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: {
        location, requestContext: { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 0, contextUsage: [] }
      } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)
    const onModelRequestLedgerRepairError = vi.fn()
    const onFinalRequestContextLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairFinalRequestContextLedger, onFinalRequestContextLedgerRepairError })

    expect(repairFinalRequestContextLedger).not.toHaveBeenCalled()
    expect(onFinalRequestContextLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'inv-1:round:1')
    expect(onModelRequestLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('diagnoses a non-object final context sidecar', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-final-context-missing-usage', createdAt: 1000 }
    await history.appendBatch([{
      ...event('response-final-context-missing-usage', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] }, sessionLedger: {
        location, requestContext: null
      } }
    }], 0)
    const repairFinalRequestContextLedger = vi.fn(async () => undefined)
    const onModelRequestLedgerRepairError = vi.fn()
    const onFinalRequestContextLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairFinalRequestContextLedger, onFinalRequestContextLedgerRepairError })

    expect(repairFinalRequestContextLedger).not.toHaveBeenCalled()
    expect(onFinalRequestContextLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'inv-1:round:1')
    expect(onModelRequestLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('diagnoses malformed tool proposal sidecars and blocks later repair for that session only', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const badLocation = { workDir: '/workspace', sessionId: 'bad-proposal-sidecar', createdAt: 1000 }
    const goodLocation = { workDir: '/workspace', sessionId: 'good-proposal-sidecar', createdAt: 1000 }
    const response = (id: string, location: typeof badLocation, args: unknown) => ({
      ...event(id, 1), kind: 'model-response-committed' as const,
      payload: { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: `${id}-tool`, name: 'read_file', input: Array.isArray(args) ? {} : args }] }, sessionLedger: {
        location, stepId: id, toolCalls: [{ toolUseId: `${id}-tool`, name: 'read_file', args }]
      } }
    })
    await history.appendBatch([response('bad-sidecar-response', badLocation, [])], 0)
    await history.appendBatch([{ ...response('good-sidecar-response', goodLocation, { path: '/ok' }), sequence: 2 }], 1)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).toHaveBeenCalledTimes(1)
    expect(repairToolCallLedger).toHaveBeenCalledWith(goodLocation, expect.objectContaining({ toolUseId: 'good-sidecar-response-tool' }))
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'bad-sidecar-response-tool')
    conn.close()
  })

  it('diagnoses malformed tool result sidecars and blocks later repair for that session only', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const badLocation = { workDir: '/workspace', sessionId: 'bad-result-sidecar', createdAt: 1000 }
    const goodLocation = { workDir: '/workspace', sessionId: 'good-result-sidecar', createdAt: 1000 }
    const proposal = (id: string, location: typeof badLocation) => ({
      ...event(`${id}-response`, 1), kind: 'model-response-committed' as const,
      payload: { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: `${id}-tool`, name: 'read_file', input: { path: '/ok' } }] }, sessionLedger: {
        location, stepId: id, toolCalls: [{ toolUseId: `${id}-tool`, name: 'read_file', args: { path: '/ok' } }]
      } }
    })
    const result = (id: string, location: typeof badLocation, sidecarResult: unknown, sequence: number) => ({
      ...event(`${id}-result`, sequence), kind: 'tool-call-finished' as const,
      payload: { toolCallId: `${id}-tool`, result: sidecarResult, sessionLedger: { location, stepId: id, result: sidecarResult } }
    })
    await history.appendBatch([proposal('bad', badLocation)], 0)
    await history.appendBatch([result('bad', badLocation, [], 2)], 1)
    await history.appendBatch([{ ...proposal('good', goodLocation), sequence: 3 }], 2)
    await history.appendBatch([result('good', goodLocation, { success: true }, 4)], 3)
    const repairToolLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolLedger, onToolLedgerRepairError })

    expect(repairToolLedger).toHaveBeenCalledTimes(1)
    expect(repairToolLedger).toHaveBeenCalledWith(goodLocation, { toolUseId: 'good-tool', turnId: 'turn-1', stepId: 'good', result: { success: true } })
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'bad-tool')
    conn.close()
  })

  it('fails closed when a canonical session identity would escape the configured workspace during recovery', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-escaped-session-'))
    const escapedSessionId = `../../${path.basename(root)}-escape`
    const location = { workDir: root, sessionId: escapedSessionId, createdAt: 1000 }
    const outsideDirectory = path.resolve(root, 'sessions', `${escapedSessionId}-19700101`)
    await history.appendBatch([{
      ...event('escaped-session-proposal', 1), kind: 'model-response-committed',
      payload: {
        modelTurn: 1,
        message: { role: 'assistant', toolCalls: [{ id: 'escaped-tool', name: 'read_file', input: { path: 'note.txt' } }] },
        sessionLedger: { location, stepId: 'inv-1:model:1', toolCalls: [{ toolUseId: 'escaped-tool', name: 'read_file', args: { path: 'note.txt' } }] }
      }
    }], 0)
    const repairErrors: unknown[] = []

    await history.recoverInterruptedInvocations({
      repairToolCallLedger: async (repairLocation, proposal) => {
        const sink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureToolCallEvent(sink, proposal as never) }
        finally { await sink.close() }
      },
      onToolLedgerRepairError: (error) => repairErrors.push(error)
    })

    expect(repairErrors).toHaveLength(1)
    expect(repairErrors[0]).toMatchObject({ message: expect.stringMatching(/escapes sessions root/i) })
    await expect(fs.access(outsideDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('blocks a tool-call recovery sidecar whose name or args differ from the canonical model proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-proposal-binding', sessionId: 'session-proposal-binding', createdAt: 1000 }
    await history.appendBatch([{
      ...event('proposal-binding-response', 1), kind: 'model-response-committed', payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'proposal-binding-call', name: 'read_file', input: { path: 'canonical.txt' } }] },
        sessionLedger: { location, stepId: 'proposal-binding-step', toolCalls: [{ toolUseId: 'proposal-binding-call', name: 'read_file', args: { path: 'forged.txt' } }] }
      }
    }], 0)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).not.toHaveBeenCalled()
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'proposal-binding-call')
    conn.close()
  })

  it('accepts the canonical redacted toolkit.call proposal projection during recovery', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-toolkit-binding', sessionId: 'session-toolkit-binding', createdAt: 1000 }
    await history.appendBatch([{
      ...event('toolkit-binding-response', 1), kind: 'model-response-committed', payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'toolkit-binding-call', name: 'toolkit.call', input: { capabilityId: 'auth.set', params: { apiKey: 'private-value', region: 'test' } } }] },
        sessionLedger: { location, stepId: 'toolkit-binding-step', toolCalls: [{ toolUseId: 'toolkit-binding-call', name: 'toolkit_call', args: { capabilityId: 'auth.set', params: { apiKey: true, region: 'test' } } }] }
      }
    }], 0)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).toHaveBeenCalledWith(location, expect.objectContaining({ toolUseId: 'toolkit-binding-call', name: 'toolkit_call' }))
    expect(onToolLedgerRepairError).not.toHaveBeenCalled()
    conn.close()
  })

  it('blocks a tool-call recovery sidecar whose name differs from the canonical proposal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/recovery-name-binding', sessionId: 'session-name-binding', createdAt: 1000 }
    await history.appendBatch([{
      ...event('name-binding-response', 1), kind: 'model-response-committed', payload: {
        message: { role: 'assistant', toolCalls: [{ id: 'name-binding-call', name: 'read_file', input: { path: 'note.txt' } }] },
        sessionLedger: { location, stepId: 'name-binding-step', toolCalls: [{ toolUseId: 'name-binding-call', name: 'write_file', args: { path: 'note.txt' } }] }
      }
    }], 0)
    const repairToolCallLedger = vi.fn(async () => undefined)
    const onToolLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({ repairToolCallLedger, onToolLedgerRepairError })

    expect(repairToolCallLedger).not.toHaveBeenCalled()
    expect(onToolLedgerRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'name-binding-call')
    conn.close()
  })

  it('repairs a missing final request context projection idempotently after restart', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-final-context-repair-'))
    const location = { workDir: root, sessionId: 'session-final-context-repair', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const initialContext = { requestId: 'inv-1:round:1', turnId: 'turn-1', attempt: 1, provider: 'anthropic', model: 'test' }
    const finalContext = { ...initialContext, contextUsage: { pressureTokens: 55 }, projectionStage: 'final' as const }
    await sink.appendCritical({ type: 'request_context', payload: initialContext })
    await sink.close()
    await history.appendBatch([{
      ...event('response-final-context-repair', 1), kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] },
        sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } }, requestContext: finalContext } }
    }], 0)
    const repairUsageLedger = vi.fn(async () => undefined)
    const repairFinalRequestContextLedger = async (repairLocation: typeof location, payload: Record<string, unknown>) => {
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureFinalRequestContextEvent(repairSink, payload) }
      finally { await repairSink.close() }
    }

    await history.recoverInterruptedInvocations({ repairUsageLedger, repairFinalRequestContextLedger })
    await history.recoverInterruptedInvocations({ repairUsageLedger, repairFinalRequestContextLedger })

    const recoveredEvents = await readSessionEvents(path.join(root, 'sessions', 'session-final-context-repair-19700101', 'events.jsonl'))
    expect(recoveredEvents).toMatchObject([
      { type: 'request_context', payload: initialContext }, { type: 'request_context', payload: finalContext }
    ])
    expect(recoveredEvents).toHaveLength(2)
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs canonical provider retry projections idempotently after restart', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-retry-repair-'))
    const location = { workDir: root, sessionId: 'session-retry-repair', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const retryPayload = { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'provider_context_overflow' }
    const repairProviderRetryLedger = vi.fn(async (repairLocation, payload) => {
      expect(repairLocation).toEqual(location)
      await ensureRequestRetryEvent(sink, payload as Record<string, unknown>)
    })
    await history.appendBatch([{
      ...event('provider-retry-scheduled', 1), kind: 'provider-retry-scheduled',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
        sessionLedger: { location, requestRetry: retryPayload } }
    }], 0)

    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })
    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })

    expect(repairProviderRetryLedger).toHaveBeenCalledTimes(2)
    expect(await readSessionEvents(sink.eventsPath)).toMatchObject([{ type: 'request_retry', payload: retryPayload }])
    expect(await readSessionEvents(sink.eventsPath)).toHaveLength(1)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('reports provider retry projection repair failure through its dedicated diagnostic', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const repairLocation = { workDir: '/workspace', sessionId: 'session-retry-repair-failure', createdAt: 1000 }
    await history.appendBatch([{
      ...event('provider-retry-repair-failed', 1), kind: 'provider-retry-scheduled',
      payload: { requestId: 'inv-1:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
        sessionLedger: { location: repairLocation, requestRetry: { turnId: 'turn-1', stepId: 'inv-1', requestId: 'inv-1:round:1', attempt: 1, backoffMs: 0, code: 'provider_context_overflow' } } }
    }], 0)
    const repairFailure = new Error('retry projection unavailable')
    const onProviderRetryLedgerRepairError = vi.fn()

    await history.recoverInterruptedInvocations({
      repairProviderRetryLedger: async () => { throw repairFailure },
      onProviderRetryLedgerRepairError
    })

    expect(onProviderRetryLedgerRepairError).toHaveBeenCalledWith(repairFailure, 'inv-1', 'inv-1:round:1')
    conn.close()
  })

  it('repairs the actual SDK provider retry outbox after a simulated crash before JSONL projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-live-retry-repair-'))
    const databasePath = path.join(root, 'history.sqlite')
    let conn = createDb(databasePath)
    let history = new SqliteAgentHistory(conn)
    const location = { workDir: root, sessionId: 'session-live-retry', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    const registry = new ModelProviderRegistry()
    let providerCalls = 0
    registry.register({ routeId: 'retry-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'fake', stream: () => {
        providerCalls += 1
        return providerCalls === 1
          ? (async function* () { throw Object.assign(new Error('maximum context length exceeded'), { type: 'context_length_exceeded' }) })()
          : (async function* () { throw new Error('simulated process stop after retry projection') })()
      }
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('retry-invocation', [])
    const permits = new InMemorySafetyPermitStore()
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    await expect(runAgentTurn({
      registry, routeId: 'retry-route', invocationId: 'retry-invocation', turnId: 'retry-turn', history,
      request: { messages: [{ role: 'user', content: 'recover' }], maxTokens: 9 }, maxModelTurns: 1,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') }, toolExecution: createPermitBoundToolExecutionPort(permits, new InMemoryExecutionAdmissionCoordinator(), async () => ({ output: 'unused' })),
      recoverProviderAttempt: async ({ messages, error, attempt }) => error && attempt === 1
        ? { reasonCode: 'CONTEXT_OVERFLOW', messages, retryEvent: { attempt: 1, code: 'provider_context_overflow' } }
        : undefined,
      observer: {
        criticalModelRequestProjection: true,
        onModelRequest: async () => undefined,
        prepareProviderRetry: (retry) => ({ location, requestRetry: { turnId: 'retry-turn', stepId: 'retry-invocation', requestId: retry.requestId, attempt: retry.attempt, backoffMs: 0, code: retry.code } }),
        onProviderRetry: async (retry) => { events.push({ type: 'request_retry', payload: { turnId: 'retry-turn', stepId: 'retry-invocation', requestId: retry.requestId, attempt: retry.attempt, backoffMs: 0, code: retry.code } }) }
      }
    })).rejects.toThrow(/simulated process stop/)
    const retryEvent = events[0]!
    const canonicalBeforeRestart = await history.read('retry-invocation')
    await sink.close()
    await fs.rm(path.join(root, 'sessions'), { recursive: true, force: true })
    conn.close()

    conn = createDb(databasePath)
    history = new SqliteAgentHistory(conn)
    await expect(history.read('retry-invocation')).resolves.toEqual(canonicalBeforeRestart)

    const repairProviderRetryLedger = async (repairLocation: typeof location, payload: Record<string, unknown>) => {
      const recoverySink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureRequestRetryEvent(recoverySink, payload) }
      finally { await recoverySink.close() }
    }
    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })
    await history.recoverInterruptedInvocations({ repairProviderRetryLedger })

    const recoveredEvents = await readSessionEvents(path.join(root, 'sessions', 'session-live-retry-19700101', 'events.jsonl'))
    expect(recoveredEvents).toHaveLength(1)
    expect(recoveredEvents[0]).toMatchObject(retryEvent)
    const recoveredHistory = await history.read('retry-invocation')
    expect(recoveredHistory).toEqual(canonicalBeforeRestart)
    expect(recoveredHistory.events.some((event) => event.kind === 'provider-retry-scheduled')).toBe(true)
    expect(recoveredHistory.events.at(-1)).toMatchObject({ kind: 'invocation-failed' })
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('blocks request usage repair after a provider retry repair fails for the same session ledger', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-blocked-retry', createdAt: 1000 }
    await history.appendBatch([
      {
        ...event('retry-repair-fails', 1), kind: 'provider-retry-scheduled',
        payload: { requestId: 'inv-1:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
          sessionLedger: { location, requestRetry: { requestId: 'inv-1:round:1', attempt: 1, code: 'provider_context_overflow', backoffMs: 0 } } }
      },
      {
        ...event('response-after-retry', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', text: 'done', toolCalls: [] },
          sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)
    const repairProviderRetryLedger = vi.fn(async () => { throw new Error('retry ledger unavailable') })
    const repairUsageLedger = vi.fn(async () => undefined)

    await history.recoverInterruptedInvocations({ repairProviderRetryLedger, repairUsageLedger })

    expect(repairProviderRetryLedger).toHaveBeenCalledTimes(1)
    expect(repairUsageLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('does not continue repairing a session ledger after request projection repair fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-request-failure', createdAt: 1000 }
    const requestHeader = { route: 'anthropic.messages.stream', requestId: 'inv-1:round:1', attempt: 1 }
    const requestContext = { requestId: 'inv-1:round:1', attempt: 1, provider: 'anthropic' }
    const repairModelRequestLedger = vi.fn(async () => { throw new Error('request ledger unavailable') })
    const repairUsageLedger = vi.fn(async () => undefined)
    await history.appendBatch([
      {
        ...event('request-started-failure', 1), kind: 'model-request-started',
        payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1',
          requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
          sessionLedger: { location, requestHeader, requestContext } }
      },
      {
        ...event('response-after-request-failure', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', text: 'done', toolCalls: [] },
          sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger, repairUsageLedger })

    expect(repairModelRequestLedger).toHaveBeenCalledTimes(1)
    expect(repairUsageLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('blocks later sidecar repair when a canonical request projection has invalid identity', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-invalid-request', createdAt: 1000 }
    const sensitiveSystemPrompt = 'PRIVATE_SYSTEM_PROMPT_SHOULD_NOT_ENTER_RECOVERY_DIAGNOSTICS'
    const repairModelRequestLedger = vi.fn(async () => undefined)
    const repairUsageLedger = vi.fn(async () => undefined)
    const requestRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('request-started-invalid', 1), kind: 'model-request-started',
        payload: { requestId: 'wrong-request-id', modelTurn: 1, attempt: 1, routeId: 'route-1',
          requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
          sessionLedger: { location, requestHeader: { requestId: 'wrong-request-id', attempt: 1, system: sensitiveSystemPrompt, tools: [{ name: 'private-tool-definition' }] }, requestContext: { requestId: 'wrong-request-id', attempt: 1, system: sensitiveSystemPrompt } } }
      },
      {
        ...event('response-after-invalid-request', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', text: 'done', toolCalls: [] },
          sessionLedger: { location, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger, repairUsageLedger, onModelRequestLedgerRepairError: requestRepairError })

    expect(requestRepairError).toHaveBeenCalledTimes(1)
    expect(String(requestRepairError.mock.calls[0]?.[0])).not.toContain(sensitiveSystemPrompt)
    expect(repairModelRequestLedger).not.toHaveBeenCalled()
    expect(repairUsageLedger).not.toHaveBeenCalled()
    conn.close()
  })

  it('rejects request and retry projections bound to a different canonical turn', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const requestLocation = { workDir: '/workspace', sessionId: 'session-cross-turn-request', createdAt: 1000 }
    const retryLocation = { workDir: '/workspace', sessionId: 'session-cross-turn-retry', createdAt: 1000 }
    const repairModelRequestLedger = vi.fn(async () => undefined)
    const repairProviderRetryLedger = vi.fn(async () => undefined)
    const repairUsageLedger = vi.fn(async () => undefined)
    const requestRepairError = vi.fn()
    const retryRepairError = vi.fn()
    await history.appendBatch([
      {
        ...event('cross-turn-request', 1), kind: 'model-request-started',
        payload: { requestId: 'inv-1:round:1', modelTurn: 1, attempt: 1, routeId: 'route-1',
          requestSnapshot: { route: { routeId: 'route-1' }, request: { messages: [] } },
          sessionLedger: { location: requestLocation,
            requestHeader: { requestId: 'inv-1:round:1', attempt: 1, turnId: 'other-turn' },
            requestContext: { requestId: 'inv-1:round:1', attempt: 1, turnId: 'other-turn' } } }
      },
      {
        ...event('cross-turn-request-response', 2), kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', content: 'done', toolCalls: [] },
          sessionLedger: { location: requestLocation, requestUsage: { requestId: 'inv-1:round:1', turnId: 'turn-1', usage: { inputTokens: 1 } } } }
      }
    ], 0)
    const retryEvent: HistoryEvent = {
      ...event('cross-turn-retry', 1), invocationId: 'inv-retry', turnId: 'canonical-retry-turn', kind: 'provider-retry-scheduled',
      payload: { requestId: 'inv-retry:round:1', modelTurn: 1, retryAttempt: 1, routeId: 'route-1', code: 'provider_context_overflow', backoffMs: 0,
        sessionLedger: { location: retryLocation, requestRetry: { requestId: 'inv-retry:round:1', attempt: 1, turnId: 'other-turn', code: 'provider_context_overflow', backoffMs: 0 } } }
    }
    await history.appendBatch([retryEvent], 0)

    await history.recoverInterruptedInvocations({
      repairModelRequestLedger, repairProviderRetryLedger, repairUsageLedger,
      onModelRequestLedgerRepairError: requestRepairError,
      onProviderRetryLedgerRepairError: retryRepairError
    })

    expect(repairModelRequestLedger).not.toHaveBeenCalled()
    expect(repairProviderRetryLedger).not.toHaveBeenCalled()
    expect(repairUsageLedger).not.toHaveBeenCalled()
    expect(requestRepairError).toHaveBeenCalledTimes(1)
    expect(retryRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-retry', 'inv-retry:round:1')
    conn.close()
  })

  it('recovers a committed model tool declaration if the process stops before approval or dispatch starts', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('model-response', 1),
      kind: 'model-response-committed',
      payload: { message: { role: 'assistant', toolCalls: [{ id: 'tc-proposed', name: 'write_file', input: { path: 'a.txt' } }] } }
    }], 0)

    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([
      { invocationId: 'inv-1', state: 'interrupted' }
    ])
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 2,
      events: [expect.objectContaining({ kind: 'model-response-committed' }), expect.objectContaining({
        kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' }
      })]
    })
    conn.close()
  })

  it('recovers a committed compacted transcript if projection to the session ledger has not finished', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const repairCompaction = vi.fn(async () => undefined)
    await history.appendBatch([{
      ...event('compacted', 1),
      kind: 'transcript-compacted',
      payload: {
        messages: [{ role: 'user', content: 'current request' }],
        sessionLedger: {
          location: { workDir: '/workspace', sessionId: 'session-1', createdAt: 1000 },
          start: { compactionId: 'compact-1' }, summary: { compactionId: 'compact-1' }
        }
      }
    }], 0)
    await expect(history.recoverInterruptedInvocations({ repairCompaction })).resolves.toMatchObject([{ state: 'interrupted' }])
    expect(repairCompaction).toHaveBeenCalledWith(
      { workDir: '/workspace', sessionId: 'session-1', createdAt: 1000 },
      { compactionId: 'compact-1' }, { compactionId: 'compact-1' }
    )
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 2,
      events: [expect.objectContaining({ kind: 'transcript-compacted' }), expect.objectContaining({
        kind: 'invocation-interrupted', payload: {
          status: 'interrupted', reason: 'process-restart',
          sessionLedger: { location: { workDir: '/workspace', sessionId: 'session-1', createdAt: 1000 }, turnId: 'turn-1', reason: 'interrupted' }
        }
      })]
    })
    conn.close()
  })

  it('keeps failed compaction repair retryable even if its diagnostic callback fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{
      ...event('compacted-retry', 1),
      kind: 'transcript-compacted',
      payload: {
        messages: [{ role: 'user', content: 'current request' }],
        sessionLedger: {
          location: { workDir: '/workspace', sessionId: 'session-retry', createdAt: 2000 },
          start: { compactionId: 'compact-retry' }, summary: { compactionId: 'compact-retry' }
        }
      }
    }], 0)
    const firstError = new Error('ledger unavailable')
    const failedRepair = vi.fn(async () => { throw firstError })

    await expect(history.recoverInterruptedInvocations({
      repairCompaction: failedRepair,
      onCompactionRepairError: () => { throw new Error('diagnostic sink unavailable') }
    })).resolves.toMatchObject([{ state: 'interrupted' }])

    const retryRepair = vi.fn(async () => undefined)
    await expect(history.recoverInterruptedInvocations({ repairCompaction: retryRepair })).resolves.toMatchObject([{ state: 'interrupted' }])
    expect(failedRepair).toHaveBeenCalledTimes(1)
    expect(retryRepair).toHaveBeenCalledTimes(1)
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 2 })
    conn.close()
  })

  it('repairs a partial JSONL compaction from SQLite during restart recovery and closes the repair sink', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-compaction-recovery-'))
    const sessionId = 'session-recovery'
    const createdAt = 3000
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const ledgerStart = { compactionId: 'compact-recovery', windowId: 'w1', inputSurfaceFingerprint: 'input', targetTokens: 10 }
    const ledgerSummary = {
      compactionId: 'compact-recovery', windowId: 'w1', outputWindowId: 'w2', summaryHash: 'hash',
      outputSurfaceFingerprint: 'output', candidate: {}
    }
    const initialSink = getSessionEventSink(workDir, sessionId, createdAt)
    await initialSink.appendCritical({ type: 'compaction_start', payload: ledgerStart })
    await initialSink.close()
    await history.appendBatch([{
      ...event('compacted-recovery', 1), kind: 'transcript-compacted',
      payload: {
        messages: [{ role: 'user', content: 'current request' }],
        sessionLedger: { location: { workDir, sessionId, createdAt }, start: ledgerStart, summary: ledgerSummary }
      }
    }], 0)

    await expect(history.recoverInterruptedInvocations({
      repairCompaction: async (location, start, summary) => {
        const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        try { await ensureCompactionTransaction(sink, start, summary) }
        finally { await sink.close() }
      }
    })).resolves.toMatchObject([{ invocationId: 'inv-1', state: 'interrupted' }])

    const eventsPath = path.join(workDir, 'sessions', `${sessionId}-19700101`, 'events.jsonl')
    const ledgerEvents = await readSessionEvents(eventsPath)
    expect(ledgerEvents.map((entry) => entry.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect(ledgerEvents.at(-1)?.payload).toMatchObject({ status: 'committed', compactionId: 'compact-recovery' })
    expect((await history.read('inv-1')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted' })
    conn.close()
  })

  it('recovers the actual Hosted turn-boundary outbox after its JSONL commit fails', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-boundary-outbox-recovery-'))
    const sessionId = 'hosted-boundary-recovery'
    const createdAt = 4000
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const registry = new ModelProviderRegistry()
    registry.register({ routeId: 'hosted-boundary-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }, {
      providerId: 'fake', stream: async function* () {
        yield { type: 'text-delta', text: 'answer' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        yield { type: 'finish', reason: 'stop' }
      }
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define('hosted-boundary-invocation', [])
    const permits = new InMemorySafetyPermitStore()
    const start = { compactionId: 'hosted-boundary-compaction', windowId: 'w1', inputSurfaceFingerprint: 'input', targetTokens: 10 }
    const summary = { compactionId: 'hosted-boundary-compaction', windowId: 'w1', outputWindowId: 'w2', summaryHash: 'hash', outputSurfaceFingerprint: 'output', candidate: {} }

    await expect(runAgentTurn({
      registry, routeId: 'hosted-boundary-route', invocationId: 'hosted-boundary-invocation', turnId: 'hosted-boundary-turn',
      request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 20 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async () => ({ kind: 'deny' as const, reasonCode: 'POLICY_DENY' as const }) } }),
      prepareTool: async () => { throw new Error('unused') },
      toolExecution: createPermitBoundToolExecutionPort({
        permits, admission: new InMemoryExecutionAdmissionCoordinator(), allowedPhase: 'recheck',
        resolveExpected: async (call) => ({ requestId: call.invocationId, turnId: 'hosted-boundary-turn', invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName, inputSnapshotHash: 'hash', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'v1', phase: 'recheck' }),
        execute: async () => ({ output: undefined })
      }),
      maxModelTurns: 1, history,
      turnBoundary: async ({ messages }) => ({
        messages,
        historyPayload: { sessionLedger: { location: { workDir, sessionId, createdAt }, start, summary } },
        commitProjection: async () => { throw new Error('simulated JSONL outage') }
      })
    })).rejects.toThrow('turn boundary ledger projection failed: simulated JSONL outage')

    const beforeRecovery = await history.read('hosted-boundary-invocation')
    expect(beforeRecovery.events.find((entry) => entry.kind === 'transcript-compacted')?.payload).toMatchObject({ sessionLedger: { location: { workDir, sessionId, createdAt }, start, summary } })
    await expect(history.recoverInterruptedInvocations({
      repairCompaction: async (location, repairStart, repairSummary) => {
        const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
        try { await ensureCompactionTransaction(sink, repairStart, repairSummary) }
        finally { await sink.close() }
      }
    })).resolves.toMatchObject([{ invocationId: 'hosted-boundary-invocation', state: 'interrupted' }])

    const eventsPath = path.join(workDir, 'sessions', `${sessionId}-19700101`, 'events.jsonl')
    expect((await readSessionEvents(eventsPath)).map((entry) => entry.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect((await history.read('hosted-boundary-invocation')).events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'turn-boundary-ledger-projection-failed' } })
    conn.close()
  })

  it('marks a finished tool stream interrupted if the process stopped before invocation completion', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([
      { ...event('e1', 1), payload: { toolCallId: 'tc-1' } },
      { ...event('e2', 2), payload: { toolCallId: 'tc-1' } }
    ], 0)
    await expect(history.recoverInterruptedInvocations()).resolves.toMatchObject([{ state: 'interrupted' }])
    await expect(history.read('inv-1')).resolves.toMatchObject({
      version: 3,
      events: expect.arrayContaining([
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
        expect.objectContaining({ sequence: 3, kind: 'invocation-interrupted' })
      ])
    })
    conn.close()
  })

  it('does not recover terminal completed or failed invocations', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    await history.appendBatch([{ ...event('done', 1), kind: 'invocation-completed', payload: { status: 'completed' } }], 0)
    await expect(history.recoverInterruptedInvocations()).resolves.toEqual([])
    await expect(history.read('inv-1')).resolves.toMatchObject({ version: 1 })
    conn.close()
  })

  it('repairs the missing turn_end projection from a canonical completed terminal', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-repair-'))
    const location = { workDir: root, sessionId: 'session-terminal', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-completed', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal', reason: 'completed' }
      }
    }], 0)

    const repairs: Array<{ location: unknown; terminal: unknown }> = []
    await history.recoverInterruptedInvocations({
      repairInvocationTerminal: async (repairLocation, terminal) => {
        repairs.push({ location: repairLocation, terminal })
        const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
        try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
        finally { await repairSink.close() }
      }
    })

    expect(repairs).toEqual([{ location, terminal: { status: 'completed', turnId: 'turn-terminal', reason: 'completed' } }])
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-19700101', 'events.jsonl'))).resolves.toMatchObject([
      { type: 'turn_start', payload: { turnId: 'turn-terminal' } },
      { type: 'turn_end', payload: { turnId: 'turn-terminal', reason: 'completed' } }
    ])
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('repairs a canonical turn terminal even when an unrelated request projection is malformed', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/workspace', sessionId: 'session-terminal-independent-repair', createdAt: 1000 }
    const repairModelRequestLedger = vi.fn(async () => undefined)
    const repairInvocationTerminal = vi.fn(async () => undefined)
    await history.appendBatch([
      { ...event('invalid-request-projection', 1), kind: 'model-request-started', payload: {
        requestId: 'wrong-request', modelTurn: 1, attempt: 1,
        sessionLedger: { location, requestHeader: { requestId: 'wrong-request', attempt: 1 }, requestContext: { requestId: 'wrong-request', attempt: 1 } }
      } },
      { ...event('terminal-after-invalid-request', 2), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-independent-repair', reason: 'completed' }
      } }
    ], 0)

    await history.recoverInterruptedInvocations({ repairModelRequestLedger, repairInvocationTerminal })

    expect(repairModelRequestLedger).not.toHaveBeenCalled()
    expect(repairInvocationTerminal).toHaveBeenCalledWith(location, {
      status: 'completed', turnId: 'turn-independent-repair', reason: 'completed'
    })
    conn.close()
  })

  it('does not project a terminal sidecar whose state does not match the canonical event kind', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const location = { workDir: '/tmp/terminal-state-mismatch', sessionId: 'session-terminal-mismatch', createdAt: 1000 }
    const repairInvocationTerminal = vi.fn(async () => undefined)
    await history.appendBatch([{
      ...event('terminal-state-mismatch', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal-mismatch', reason: 'interrupted' }
      }
    }], 0)

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).not.toHaveBeenCalled()
    conn.close()
  })

  it('does not report a terminal repair failure when the turn already has its end event', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-idempotent-'))
    const location = { workDir: root, sessionId: 'session-terminal-idempotent', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal-idempotent' } })
    await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'turn-terminal-idempotent', reason: 'completed' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-existing-end', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal-idempotent', reason: 'completed' }
      }
    }], 0)
    const repairInvocationTerminal = vi.fn(async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
      finally { await repairSink.close() }
    })

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).toHaveBeenCalledOnce()
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-idempotent-19700101', 'events.jsonl'))).resolves.toHaveLength(2)
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('keeps a completed terminal retryable after SessionEvent projection fails', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-retry-'))
    const location = { workDir: root, sessionId: 'session-terminal-retry', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal-retry' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-retry', 1), kind: 'invocation-completed', payload: {
        status: 'completed', sessionLedger: { location, turnId: 'turn-terminal-retry', reason: 'completed' }
      }
    }], 0)
    const before = await history.read('inv-1')
    const onRepairError = vi.fn()
    let fail = true
    const repairInvocationTerminal = async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
      if (fail) { fail = false; throw new Error('injected terminal JSONL failure') }
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
      finally { await repairSink.close() }
    }

    await history.recoverInterruptedInvocations({ repairInvocationTerminal, onInvocationTerminalRepairError: onRepairError })
    await expect(history.read('inv-1')).resolves.toEqual(before)
    expect(onRepairError).toHaveBeenCalledWith(expect.any(Error), 'inv-1', 'turn-terminal-retry')
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-retry-19700101', 'events.jsonl'))).resolves.toHaveLength(1)

    await history.recoverInterruptedInvocations({ repairInvocationTerminal, onInvocationTerminalRepairError: onRepairError })

    await expect(history.read('inv-1')).resolves.toEqual(before)
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-retry-19700101', 'events.jsonl'))).resolves.toMatchObject([
      { type: 'turn_start', payload: { turnId: 'turn-terminal-retry' } },
      { type: 'turn_end', payload: { turnId: 'turn-terminal-retry', reason: 'completed' } }
    ])
    expect(onRepairError).toHaveBeenCalledOnce()
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('preserves the cancelled SessionEvent reason from canonical terminal sidecar', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-terminal-cancelled-'))
    const location = { workDir: root, sessionId: 'session-terminal-cancelled', createdAt: 1000 }
    const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-terminal-cancelled' } })
    await sink.close()
    await history.appendBatch([{
      ...event('terminal-cancelled', 1), kind: 'invocation-interrupted', payload: {
        status: 'cancelled', sessionLedger: { location, turnId: 'turn-terminal-cancelled', reason: 'cancelled' }
      }
    }], 0)
    const repairInvocationTerminal = vi.fn(async (repairLocation: typeof location, terminal: Record<string, unknown>) => {
      const repairSink = getSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      try { await ensureTurnEndEvent(repairSink, String(terminal.turnId), String(terminal.reason)) }
      finally { await repairSink.close() }
    })

    await history.recoverInterruptedInvocations({ repairInvocationTerminal })

    expect(repairInvocationTerminal).toHaveBeenCalledWith(location, { status: 'cancelled', turnId: 'turn-terminal-cancelled', reason: 'cancelled' })
    await expect(readSessionEvents(path.join(root, 'sessions', 'session-terminal-cancelled-19700101', 'events.jsonl'))).resolves.toMatchObject([
      { type: 'turn_start', payload: { turnId: 'turn-terminal-cancelled' } },
      { type: 'turn_end', payload: { turnId: 'turn-terminal-cancelled', reason: 'cancelled' } }
    ])
    await fs.rm(root, { recursive: true, force: true })
    conn.close()
  })

  it('does not rewrite denied or cancelled terminal invocation states during restart recovery', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn)
    const denied: HistoryEvent = {
      ...event('denied', 1), invocationId: 'inv-denied', turnId: 'turn-denied',
      kind: 'invocation-failed', payload: { status: 'denied', reason: 'POLICY_DENY' }
    }
    const cancelled: HistoryEvent = {
      ...event('cancelled', 1), invocationId: 'inv-cancelled', turnId: 'turn-cancelled',
      kind: 'invocation-interrupted', payload: { status: 'cancelled' }
    }
    await history.appendBatch([denied], 0)
    await history.appendBatch([cancelled], 0)
    await expect(history.recoverInterruptedInvocations()).resolves.toEqual([])
    await expect(history.read('inv-denied')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ kind: 'invocation-failed', payload: { status: 'denied', reason: 'POLICY_DENY' } })] })
    await expect(history.read('inv-cancelled')).resolves.toMatchObject({ version: 1, events: [expect.objectContaining({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } })] })
    conn.close()
  })

  it('rebuilds approval answerer and cause from the terminal decision after agent fallback', async () => {
    const conn = createDb()
    const history = new SqliteAgentHistory(conn, 1, Date.now, 'session-agent-fallback')
    const makeEvent = (sequence: number, kind: HistoryEvent['kind'], payload: unknown): HistoryEvent => ({
      invocationId: 'inv-agent-fallback', turnId: 'turn-agent-fallback', sequence, schemaVersion: 1,
      eventId: `agent-fallback-${sequence}`, idempotencyKey: `agent-fallback-${sequence}`, kind, payload
    })
    await history.appendBatch([
      makeEvent(1, 'model-response-committed', { message: { role: 'assistant', toolCalls: [{ id: 'fallback-write', name: 'write_file', input: { path: 'out.txt' } }] } }),
      makeEvent(2, 'approval-waiting', { toolCallId: 'fallback-write', approvalId: 'inv-agent-fallback:approval:fallback-write', answerer: 'agent', reasonCode: 'agent-approval', requestedAt: 10 }),
      makeEvent(3, 'approval-resolved', { toolCallId: 'fallback-write', approvalId: 'inv-agent-fallback:approval:fallback-write', approved: true, outcome: 'approved', answerer: 'user', cause: 'user-approved', settledAt: 11 }),
      makeEvent(4, 'tool-call-started', { toolCallId: 'fallback-write' }),
      makeEvent(5, 'tool-call-finished', { toolCallId: 'fallback-write', success: true, result: { success: true, data: 'written' } }),
      makeEvent(6, 'invocation-completed', { status: 'completed' })
    ], 0)

    expect(history.readCompletedToolCallsForSession('inv-agent-fallback', 'session-agent-fallback', 'turn-agent-fallback')?.[0]?.approval)
      .toMatchObject({ answerer: 'user', status: 'approved', cause: 'user-approved', requestedAt: 10, settledAt: 11 })
    conn.close()
  })
})
