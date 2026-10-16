import { afterEach, describe, expect, it } from 'vitest'
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
})
