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
  drainCanonicalLedgerProjectionOutbox,
  enqueueCanonicalLedgerProjectionTargetInTransaction,
  listPendingCanonicalLedgerProjectionTargets,
  type CanonicalLedgerProjectionTarget
} from './sessionLedgerOutbox'
import { getSessionEventSink, readSessionEvents } from './sessionEvents'
import { projectCanonicalSessionLedgerTarget } from './runtime/sessionLedgerOutboxProjector'

function appendCanonicalEvent(conn: ReturnType<typeof getDbConnection>, sessionId: string, eventId: string) {
  runInTransaction(conn, () => appendSqliteAgentHistoryBatchInTransaction(conn, [{
    invocationId: `seed-${eventId}`, turnId: `turn-${eventId}`, sequence: 1, schemaVersion: 1,
    eventId, idempotencyKey: eventId, kind: 'invocation-context-committed', payload: { context: {} }
  }], 0, { sessionId }))
}

describe('canonical session ledger outbox', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.close() })

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
})
