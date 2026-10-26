import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HistoryEvent } from '../packages/agent-sdk/src/history'
import { appendSqliteAgentHistoryBatchInTransaction } from './database/agentHistoryStorage'
import { createMemoryAppDb } from './database/testHelpers'
import { getDbConnection } from './database/sqliteStore'
import { createSession, setConfigValue } from './database/operations'
import { runInTransaction } from './database/transaction'
import { ensureLegacyLedgerReadiness } from './sessionLedgerReadiness'
import {
  acknowledgeCanonicalLedgerProjectionTarget,
  buildCanonicalToolResultProjectionTargets,
  drainCanonicalLedgerProjectionOutbox,
  enqueueCanonicalLedgerProjectionTargetInTransaction,
  listPendingCanonicalLedgerProjectionTargets,
  type CanonicalLedgerProjectionTarget
} from './sessionLedgerOutbox'
import { getSessionEventSink, readSessionEvents, type SessionEventSink } from './sessionEvents'
import { projectCanonicalSessionLedgerTarget } from './runtime/sessionLedgerOutboxProjector'
import { toolResultProjectionPayloadMatches } from './sessionLedgerProjectionCompatibility'

function appendCanonicalEvent(conn: ReturnType<typeof getDbConnection>, sessionId: string, eventId: string) {
  runInTransaction(conn, () => appendSqliteAgentHistoryBatchInTransaction(conn, [{
    invocationId: `seed-${eventId}`, turnId: `turn-${eventId}`, sequence: 1, schemaVersion: 1,
    eventId, idempotencyKey: eventId, kind: 'invocation-context-committed', payload: { context: {} }
  }], 0, { sessionId }))
}

describe('canonical session ledger outbox', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.close() })

  it('maps every canonical session sidecar kind to an exact ordered projection target', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const session = createSession(db, { name: 'outbox mapping' })
    const location = { workDir: '/tmp/outbox-mapping', sessionId: session.id, createdAt: session.createdAt }
    const make = (eventId: string, sequence: number, kind: HistoryEvent['kind'], payload: Record<string, unknown>): HistoryEvent => ({
      invocationId: 'mapping-invocation', turnId: 'mapping-turn', sequence, schemaVersion: 1, eventId, idempotencyKey: eventId, kind, payload
    })
    const events = [
      make('mapping-request', 1, 'model-request-started', { sessionLedger: { location,
        requestHeader: { requestId: 'mapping-request', attempt: 1 }, requestContext: { requestId: 'mapping-request', attempt: 1 } } }),
      make('mapping-retry', 2, 'provider-retry-scheduled', { sessionLedger: { location,
        requestRetry: { requestId: 'mapping-request', attempt: 1, code: 'retry', backoffMs: 1 } } }),
      make('mapping-response', 3, 'model-response-committed', { sessionLedger: { location, stepId: 'mapping-step',
        toolCalls: [{ toolUseId: 'mapping-tool', name: 'read_file', args: {} }],
        requestUsage: { requestId: 'mapping-request', usage: { inputTokens: 1 } },
        requestContext: { requestId: 'mapping-request', attempt: 1, turnId: 'mapping-turn', contextUsage: { inputTokens: 2 } } } }),
      make('mapping-result', 4, 'tool-call-finished', { toolCallId: 'mapping-tool', sessionLedger: { location, stepId: 'mapping-step', result: { success: true } } }),
      make('mapping-compaction', 5, 'transcript-compacted', { sessionLedger: { location,
        start: { compactionId: 'mapping-compaction' }, summary: { compactionId: 'mapping-compaction' } } }),
      make('mapping-terminal', 6, 'invocation-interrupted', { sessionLedger: { location, turnId: 'mapping-turn', reason: 'interrupted' } })
    ]

    const targets = buildCanonicalToolResultProjectionTargets(getDbConnection(db), events, session.id, session.generation)

    expect(targets.map((target) => target.projectionKind)).toEqual([
      'request-projection', 'request-retry', 'tool-call:mapping-tool', 'request-usage', 'request-final-context',
      'tool-result', 'compaction', 'invocation-terminal'
    ])
    expect(targets[0]?.expectedEventIds).toEqual(['request_header:mapping-request:1', 'request_context:mapping-request:1'])
    expect(targets[4]?.expectedEventIds).toEqual(['request_context_final:mapping-request:1'])
  })

  it('commits the canonical event and exact projection obligation atomically, then acks only a complete identity set', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: '/tmp/outbox', isDefault: true }]))
    const session = createSession(db, { name: 'outbox', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'retry-event')
    const event: HistoryEvent = { invocationId: 'outbox-invocation', turnId: 'outbox-turn', sequence: 1, schemaVersion: 1,
      eventId: 'outbox-canonical-event', idempotencyKey: 'outbox-canonical-event', kind: 'invocation-context-committed', payload: { context: {} } }
    const target: CanonicalLedgerProjectionTarget = { ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id,
      sessionGeneration: session.generation, canonicalEventId: event.eventId, projectionKind: 'invocation-context',
      expectedEvents: [{ type: 'turn_start', payload: { turnId: event.turnId } }], expectedEventIds: ['turn_start:outbox-turn'], now: 50 }

    runInTransaction(conn, () => {
      appendSqliteAgentHistoryBatchInTransaction(conn, [event], 0, { sessionId: session.id, projectionTargets: [target] })
    })

    expect(conn.prepare('SELECT event_id FROM agent_history_events WHERE event_id=?').get(event.eventId)).toEqual({ event_id: event.eventId })
    const pending = listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)
    expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0].expected_events_json)).toEqual(target.expectedEvents)
    const projected = { eventIds: target.expectedEventIds, events: target.expectedEvents }
    expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending[0].target_id, { eventIds: [], events: [] })).toBe(false)
    expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending[0].target_id,
      { ...projected, events: [{ type: 'turn_start', payload: { turnId: 'drifted' } }] }, 55)).toBe(false)
    expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending[0].target_id, projected, 60)).toBe(true)
    expect(listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)).toEqual([])
    expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending[0].target_id, projected, 61)).toBe(true)
  })

  it('acks an older tool-call outbox payload against an already enriched JSONL projection', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: '/tmp/outbox-attribution-compat', isDefault: true }]))
    const session = createSession(db, { name: 'outbox attribution compatibility', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?')
      .get(session.id) as { ledger_location_key: string }
    const toolCall = { toolUseId: 'compat-tool', stepId: 'compat-step', name: 'read_file', args: {}, turnId: 'compat-turn' }
    const target: CanonicalLedgerProjectionTarget = { ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id,
      sessionGeneration: session.generation, canonicalEventId: 'compat-canonical', projectionKind: 'tool-call:compat-tool',
      expectedEvents: [{ type: 'tool_call', payload: toolCall }], expectedEventIds: ['tool_call:compat-tool'] }
    appendCanonicalEvent(conn, session.id, 'compat-canonical')
    runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target))
    const pending = listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)[0]!
    const enriched = { ...toolCall, requestId: 'request-1', invocationRequestId: 'invocation-1', lane: 'desktop' }

    expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending.target_id, {
      eventIds: target.expectedEventIds, events: [{ type: 'tool_call', payload: enriched }]
    })).toBe(true)
  })

  it('acks an older tool-call outbox payload against an already enriched JSONL projection', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: '/tmp/outbox-attribution-compat', isDefault: true }]))
    const session = createSession(db, { name: 'outbox attribution compatibility', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?')
      .get(session.id) as { ledger_location_key: string }
    const toolCall = { toolUseId: 'compat-tool', stepId: 'compat-step', name: 'read_file', args: {}, turnId: 'compat-turn' }
    const target: CanonicalLedgerProjectionTarget = { ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id,
      sessionGeneration: session.generation, canonicalEventId: 'compat-canonical', projectionKind: 'tool-call:compat-tool',
      expectedEvents: [{ type: 'tool_call', payload: toolCall }], expectedEventIds: ['tool_call:compat-tool'] }
    appendCanonicalEvent(conn, session.id, 'compat-canonical')
    runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target))
    const pending = listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)[0]!
    const enriched = { ...toolCall, requestId: 'request-1', invocationRequestId: 'invocation-1', lane: 'desktop' }

    expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending.target_id, {
      eventIds: target.expectedEventIds, events: [{ type: 'tool_call', payload: enriched }]
    })).toBe(true)
  })

  it('rolls back an outbox target with its canonical batch and rejects target conflicts', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: '/tmp/outbox-rollback', isDefault: true }]))
    const session = createSession(db, { name: 'outbox rollback', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'projected-result')
    const event: HistoryEvent = { invocationId: 'rollback-invocation', turnId: 'rollback-turn', sequence: 1, schemaVersion: 1,
      eventId: 'rollback-canonical-event', idempotencyKey: 'rollback-canonical-event', kind: 'invocation-context-committed', payload: { context: {} } }
    const target: CanonicalLedgerProjectionTarget = { ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id,
      sessionGeneration: session.generation, canonicalEventId: event.eventId, projectionKind: 'context',
      expectedEvents: [{ type: 'turn_start', payload: { turnId: event.turnId } }], expectedEventIds: ['start'] }
    expect(() => runInTransaction(conn, () => {
      appendSqliteAgentHistoryBatchInTransaction(conn, [event], 0, { sessionId: session.id, projectionTargets: [target] })
      throw new Error('injected rollback')
    })).toThrow('injected rollback')
    expect(conn.prepare('SELECT 1 FROM agent_history_events WHERE event_id=?').get(event.eventId)).toBeUndefined()
    expect(conn.prepare('SELECT 1 FROM session_ledger_projection_outbox WHERE canonical_event_id=?').get(event.eventId)).toBeUndefined()

    runInTransaction(conn, () => {
      appendSqliteAgentHistoryBatchInTransaction(conn, [event], 0, { sessionId: session.id, projectionTargets: [target] })
    })
    expect(() => runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
      ...target, expectedEvents: [{ type: 'turn_start', payload: { turnId: 'conflict' } }]
    }))).toThrow('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
  })

  it('refuses a projection target bound to another session generation', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const readiness = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/outbox-scope', sessionId: 'scope', createdAt: 1 }, 'g1')
    appendCanonicalEvent(conn, 'scope', 'event')
    expect(() => runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
      ledgerLocationKey: readiness.ledgerLocationKey, sessionId: 'scope', sessionGeneration: 'g2', canonicalEventId: 'event',
      projectionKind: 'context', expectedEvents: [{ type: 'turn_start', payload: { turnId: 't' } }], expectedEventIds: ['start']
    }))).toThrow('SESSION_LEDGER_PROJECTION_LOCATION_MISMATCH')
  })

  it('retains a failed target and retries only that target until identity confirmation', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: '/tmp/outbox-retry', isDefault: true }]))
    const session = createSession(db, { name: 'outbox retry', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'retry-event')
    runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
      ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
      canonicalEventId: 'retry-event', projectionKind: 'tool-result', expectedEvents: [{ type: 'tool_result', payload: { toolUseId: 'tool' } }],
      expectedEventIds: ['tool-result:tool']
    }))
    const first = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key, async () => { throw new Error('sink unavailable') })
    expect(first).toMatchObject({ projected: 0, failedTargetId: expect.any(String) })
    expect(listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)).toHaveLength(1)
    const apply = async (target: { expectedEventIds: readonly string[]; expectedEvents: readonly import('./sessionEvents').SessionEventInput[] }) => ({
      eventIds: target.expectedEventIds, events: target.expectedEvents
    })
    const second = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key, apply, 5)
    expect(second).toEqual({ projected: 1 })
    expect(listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)).toEqual([])
  })

  it('projects a tool-result target idempotently to JSONL before acknowledgement', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-outbox-projector-'))
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: tempRoot, isDefault: true }]))
    const session = createSession(db, { name: 'outbox projector', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'projected-result')
    const sink = getSessionEventSink(tempRoot, session.id, session.createdAt)
    try {
      runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
        ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
        canonicalEventId: 'projected-result', projectionKind: 'tool-result',
        expectedEvents: [{ type: 'tool_result', payload: { toolUseId: 'projector-tool', stepId: 'projector-step', result: { success: true, data: 'ok' } } }],
        expectedEventIds: ['tool_result:projector-tool']
      }))
      const first = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (target) => projectCanonicalSessionLedgerTarget(sink, target))
      const again = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (target) => projectCanonicalSessionLedgerTarget(sink, target))
      expect(first).toEqual({ projected: 1 })
      expect(again).toEqual({ projected: 0 })
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'tool_result')).toHaveLength(1)
    } finally {
      await sink.close()
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('acknowledges a canonical tool result when the ledger already has additive execution diagnostics', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-result-diagnostics-'))
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'tool result execution diagnostics', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?')
      .get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'result-diagnostics-canonical-event')
    const target: CanonicalLedgerProjectionTarget = {
      ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
      canonicalEventId: 'result-diagnostics-canonical-event', projectionKind: 'tool-result',
      expectedEvents: [{ type: 'tool_result', payload: {
        toolUseId: 'diagnostic-tool', stepId: 'diagnostic-step', result: { success: true, data: { marker: 'kept' } }
      } }],
      expectedEventIds: ['tool_result:diagnostic-tool']
    }
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    try {
      await sink.appendCritical({ type: 'tool_result', payload: {
        toolUseId: 'diagnostic-tool', stepId: 'diagnostic-step',
        result: { success: true, data: { marker: 'kept' }, executionOutcome: 'succeeded', executorEntry: 'entered' }
      } })
      runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target))

      const drained = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (pending) => projectCanonicalSessionLedgerTarget(sink, pending))

      expect(drained).toEqual({ projected: 1 })
      expect(conn.prepare('SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id=?')
        .get('result-diagnostics-canonical-event')).toEqual({ status: 'acked' })
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'tool_result'))
        .toMatchObject([{ payload: { result: { executionOutcome: 'succeeded', executorEntry: 'entered' } } }])
      expect(toolResultProjectionPayloadMatches({
        toolUseId: 'diagnostic-tool', stepId: 'diagnostic-step',
        result: { success: true, data: { marker: 'kept' }, executorEntry: 'unrecognized' }
      }, target.expectedEvents[0]!.payload)).toBe(false)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('accepts legal terminal diagnostics and snapshot during projection and ack comparison', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-terminal-snapshot-'))
    const session = createSession(db, { name: 'terminal snapshot' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const readiness = ensureLegacyLedgerReadiness(conn, location, session.generation)
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    const target: CanonicalLedgerProjectionTarget = { ledgerLocationKey: readiness.ledgerLocationKey, sessionId: session.id,
      sessionGeneration: session.generation, canonicalEventId: 'terminal-event', projectionKind: 'invocation-terminal',
      expectedEvents: [{ type: 'turn_end', payload: { turnId: 'terminal-turn', reason: 'completed' } }],
      expectedEventIds: ['turn_end:terminal-turn'] }
    try {
      await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'terminal-turn' } })
      await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'terminal-turn', reason: 'completed',
        finalSurfaceSnapshot: { text: 'done' } } })
      const projected = await projectCanonicalSessionLedgerTarget(sink, target)
      expect(projected.eventIds).toEqual(target.expectedEventIds)
      expect(projected.events[0]?.payload).toMatchObject({ finalSurfaceSnapshot: { text: 'done' } })
      appendCanonicalEvent(conn, session.id, 'terminal-event')
      runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target))
      const pending = listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledgerLocationKey)[0]!
      expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending.target_id, projected)).toBe(true)
      expect(listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledgerLocationKey)).toEqual([])
      await expect(projectCanonicalSessionLedgerTarget(sink, { ...target,
        expectedEvents: [{ type: 'turn_end', payload: { turnId: 'terminal-turn', reason: 'failed' } }] }))
        .rejects.toThrow(/conflicting invocation terminal projection/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('drains multiple projections from one canonical event in their declared order', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-outbox-order-'))
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: tempRoot, isDefault: true }]))
    const session = createSession(db, { name: 'outbox ordered projections', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'ordered-projections')
    const sink = getSessionEventSink(tempRoot, session.id, session.createdAt)
    try {
      runInTransaction(conn, () => {
        enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
          ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
          canonicalEventId: 'ordered-projections', projectionOrder: 1, projectionKind: 'tool-result',
          expectedEvents: [{ type: 'tool_result', payload: { toolUseId: 'ordered-tool', stepId: 'ordered-step', result: { success: true } } }],
          expectedEventIds: ['tool_result:ordered-tool']
        })
        enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
          ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
          canonicalEventId: 'ordered-projections', projectionOrder: 0, projectionKind: 'tool-call:ordered-tool',
          expectedEvents: [{ type: 'tool_call', payload: { toolUseId: 'ordered-tool', stepId: 'ordered-step', name: 'read_file', args: {} } }],
          expectedEventIds: ['tool_call:ordered-tool']
        })
      })
      expect(listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key).map((target) => target.projection_kind))
        .toEqual(['tool-call:ordered-tool', 'tool-result'])
      const result = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (target) => projectCanonicalSessionLedgerTarget(sink, target))
      expect(result).toEqual({ projected: 2 })
      expect((await readSessionEvents(sink.eventsPath)).map((event) => event.type)).toEqual(['tool_call', 'tool_result'])
    } finally {
      await sink.close()
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('repairs and acknowledges a legacy tool result missing only its canonical raw artifact id', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-tool-result-artifact-compat-'))
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'tool result artifact compatibility', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?')
      .get(session.id) as { ledger_location_key: string }
    const canonicalEventId = 'tool-result-artifact-compat-canonical'
    appendCanonicalEvent(conn, session.id, canonicalEventId)
    const artifactId = `artifact-${'a'.repeat(64)}`
    const legacyResult = { success: true, data: { rawArtifact: { bytes: 8, sha256: 'b'.repeat(64), truncated: true } } }
    const canonicalResult = { success: true, data: { rawArtifact: { bytes: 8, sha256: 'b'.repeat(64), truncated: true, artifactId } } }
    const toolUseId = 'artifact-compat-tool'
    const target: CanonicalLedgerProjectionTarget = {
      ledgerLocationKey: readiness.ledger_location_key,
      sessionId: session.id,
      sessionGeneration: session.generation,
      canonicalEventId,
      projectionKind: 'tool-result',
      expectedEvents: [{ type: 'tool_result', payload: { toolUseId, stepId: 'artifact-compat-step', result: canonicalResult } }],
      expectedEventIds: [`tool_result:${toolUseId}`]
    }
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    try {
      await sink.appendCritical({ type: 'tool_result', payload: { toolUseId, stepId: 'artifact-compat-step', result: legacyResult } })
      runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target))
      const pending = listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledger_location_key)
      expect(pending).toHaveLength(1)
      const unexpectedDrift = { success: true, data: { rawArtifact: { bytes: 9, sha256: 'b'.repeat(64), truncated: true } } }
      expect(acknowledgeCanonicalLedgerProjectionTarget(conn, pending[0]!.target_id, {
        eventIds: target.expectedEventIds,
        events: [{ type: 'tool_result', payload: { toolUseId, stepId: 'artifact-compat-step', result: unexpectedDrift } }]
      })).toBe(false)

      await expect(drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (projectionTarget) => projectCanonicalSessionLedgerTarget(sink, projectionTarget))).resolves.toEqual({ projected: 1 })
      expect(conn.prepare('SELECT status FROM session_ledger_projection_outbox WHERE target_id=?').get(pending[0]!.target_id))
        .toEqual({ status: 'acked' })
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'tool_result')).toHaveLength(1)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('upgrades a pending outbox target only through a canonical, versioned additive-field adapter', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = '/tmp/session-ledger-outbox-schema-upgrade'
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'tool result schema upgrade', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const readiness = ensureLegacyLedgerReadiness(conn, location, session.generation)
    const toolUseId = 'schema-upgrade-tool'
    const eventId = 'schema-upgrade-canonical-event'
    const artifactId = `artifact-${'c'.repeat(64)}`
    const legacyResult = { success: true, data: { rawArtifact: { bytes: 8, truncated: true } } }
    const canonicalResult = { success: true, data: { rawArtifact: { bytes: 8, truncated: true, artifactId } } }
    const canonicalEvent: HistoryEvent = {
      invocationId: 'schema-upgrade-invocation', turnId: 'schema-upgrade-turn', sequence: 1, schemaVersion: 1,
      eventId, idempotencyKey: eventId, kind: 'tool-call-finished',
      payload: { toolCallId: toolUseId, sessionLedger: { location, stepId: 'schema-upgrade-step', result: canonicalResult } }
    }
    runInTransaction(conn, () => appendSqliteAgentHistoryBatchInTransaction(conn, [canonicalEvent], 0, { sessionId: session.id }))
    const legacyTarget: CanonicalLedgerProjectionTarget = {
      ledgerLocationKey: readiness.ledgerLocationKey, sessionId: session.id, sessionGeneration: session.generation,
      canonicalEventId: eventId, projectionKind: 'tool-result',
      expectedEvents: [{ type: 'tool_result', schemaVersion: 1, payload: { toolUseId, stepId: 'schema-upgrade-step', result: legacyResult } }],
      expectedEventIds: [`tool_result:${toolUseId}`]
    }
    runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, legacyTarget))

    const currentTarget: CanonicalLedgerProjectionTarget = {
      ...legacyTarget,
      expectedEvents: [{ type: 'tool_result', schemaVersion: 2, payload: { toolUseId, stepId: 'schema-upgrade-step', result: canonicalResult } }]
    }
    runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, currentTarget))

    const pending = listPendingCanonicalLedgerProjectionTargets(conn, readiness.ledgerLocationKey)
    expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0]!.expected_events_json)).toEqual(currentTarget.expectedEvents)
  })

  it('projects and acknowledges a paired request header/context target only after both events match', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-request-projection-'))
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: tempRoot, isDefault: true }]))
    const session = createSession(db, { name: 'request projection', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'paired-request')
    const sink = getSessionEventSink(tempRoot, session.id, session.createdAt)
    const requestId = 'paired-request-id'
    const expectedEvents = [
      { type: 'request_header' as const, payload: { requestId, attempt: 1, turnId: 'paired-turn' } },
      { type: 'request_context' as const, payload: { requestId, attempt: 1, turnId: 'paired-turn', contextUsage: { inputTokens: 1 } } }
    ]
    try {
      runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, {
        ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
        canonicalEventId: 'paired-request', projectionKind: 'request-projection', expectedEvents,
        expectedEventIds: [`request_header:${requestId}:1`, `request_context:${requestId}:1`]
      }))
      const result = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (target) => projectCanonicalSessionLedgerTarget(sink, target))
      expect(result).toEqual({ projected: 1 })
      expect((await readSessionEvents(sink.eventsPath)).map((event) => event.type)).toEqual(['request_header', 'request_context'])
    } finally {
      await sink.close()
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('projects retry, usage, final context, terminal and compaction obligations exactly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-project-all-'))
    const sink = getSessionEventSink(root, 'project-all', 1000)
    const targets: CanonicalLedgerProjectionTarget[] = [
      { ledgerLocationKey: 'location', sessionId: 'project-all', sessionGeneration: 'g', canonicalEventId: 'retry', projectionKind: 'request-retry',
        expectedEvents: [{ type: 'request_retry', payload: { requestId: 'request-all', attempt: 1, code: 'retry', backoffMs: 2 } }], expectedEventIds: ['request_retry:request-all:1'] },
      { ledgerLocationKey: 'location', sessionId: 'project-all', sessionGeneration: 'g', canonicalEventId: 'usage', projectionKind: 'request-usage',
        expectedEvents: [{ type: 'request_usage', payload: { requestId: 'request-all', usage: { inputTokens: 3 } } }], expectedEventIds: ['request_usage:request-all'] },
      { ledgerLocationKey: 'location', sessionId: 'project-all', sessionGeneration: 'g', canonicalEventId: 'final-context', projectionKind: 'request-final-context',
        expectedEvents: [{ type: 'request_context', payload: { requestId: 'request-all', attempt: 1, turnId: 'turn-all', projectionStage: 'final', contextUsage: { inputTokens: 4 } } }],
        expectedEventIds: ['request_context_final:request-all:1'] },
      { ledgerLocationKey: 'location', sessionId: 'project-all', sessionGeneration: 'g', canonicalEventId: 'terminal', projectionKind: 'invocation-terminal',
        expectedEvents: [{ type: 'turn_start', payload: { turnId: 'turn-all' } }, { type: 'turn_end', payload: { turnId: 'turn-all', reason: 'interrupted' } }],
        expectedEventIds: ['turn_start:turn-all', 'turn_end:turn-all'] },
      { ledgerLocationKey: 'location', sessionId: 'project-all', sessionGeneration: 'g', canonicalEventId: 'compaction', projectionKind: 'compaction',
        expectedEvents: [
          { type: 'compaction_start', payload: { compactionId: 'compact-all', windowId: 'window-all', inputSurfaceFingerprint: 'in', targetTokens: 1 } },
          { type: 'compaction_summary', payload: { compactionId: 'compact-all', windowId: 'window-all', summaryHash: 'hash', outputSurfaceFingerprint: 'out', candidate: {} } }
        ], expectedEventIds: ['compaction_start:compact-all', 'compaction_summary:compact-all'] }
    ]
    try {
      for (const target of targets) {
        const projected = await projectCanonicalSessionLedgerTarget(sink, target)
        expect(projected.eventIds).toEqual(target.expectedEventIds)
        expect(projected.events).toEqual(target.expectedEvents)
      }
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a partially projected compaction pending and resumes it without duplicating the prefix', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-compaction-retry-'))
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'p', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'compaction retry', workDirProfileId: 'p' })
    const conn = getDbConnection(db)
    const readiness = conn.prepare('SELECT ledger_location_key FROM session_ledger_projection_state WHERE session_id=?')
      .get(session.id) as { ledger_location_key: string }
    appendCanonicalEvent(conn, session.id, 'compaction-retry-event')
    const target: CanonicalLedgerProjectionTarget = {
      ledgerLocationKey: readiness.ledger_location_key, sessionId: session.id, sessionGeneration: session.generation,
      canonicalEventId: 'compaction-retry-event', projectionKind: 'compaction',
      expectedEvents: [
        { type: 'compaction_start', payload: { compactionId: 'retry-compaction', windowId: 'retry-window', inputSurfaceFingerprint: 'in', targetTokens: 1 } },
        { type: 'compaction_summary', payload: { compactionId: 'retry-compaction', windowId: 'retry-window', summaryHash: 'hash', outputSurfaceFingerprint: 'out', candidate: {} } }
      ], expectedEventIds: ['compaction_start:retry-compaction', 'compaction_summary:retry-compaction']
    }
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    try {
      runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target))
      let failSummaryOnce = true
      const flakySink: SessionEventSink = {
        eventsPath: sink.eventsPath, indexPath: sink.indexPath,
        appendCritical: async (event) => {
          if (event.type === 'compaction_summary' && failSummaryOnce) { failSummaryOnce = false; throw new Error('injected compaction prefix failure') }
          return sink.appendCritical(event)
        },
        appendChunk: (event) => sink.appendChunk(event), waitForCapacity: () => sink.waitForCapacity(),
        flush: () => sink.flush(), close: () => sink.close()
      }
      const failed = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (pending) => projectCanonicalSessionLedgerTarget(flakySink, pending))
      expect(failed.failedTargetId).toBeTruthy()
      expect(conn.prepare('SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id=?').get('compaction-retry-event'))
        .toEqual({ status: 'pending' })
      expect((await readSessionEvents(sink.eventsPath)).map((event) => event.type)).toEqual(['compaction_start'])

      const retried = await drainCanonicalLedgerProjectionOutbox(conn, readiness.ledger_location_key,
        (pending) => projectCanonicalSessionLedgerTarget(sink, pending))
      expect(retried).toEqual({ projected: 1 })
      const events = await readSessionEvents(sink.eventsPath)
      expect(events.map((event) => event.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
      expect(conn.prepare('SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id=?').get('compaction-retry-event'))
        .toEqual({ status: 'acked' })
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
