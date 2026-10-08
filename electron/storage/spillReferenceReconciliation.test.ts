import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { runSpillReferenceBackfillBatch } from './spillReferenceBackfill'
import { getCanonicalSpillChangeGeneration } from './spillReferenceIndex'
import { spillHistoryOwnerKey } from './spillReferenceIndex'
import { runSpillReferenceReconciliationBatch } from './spillReferenceReconciliation'

const spill = { version: 1, kind: 'source-of-truth', locator: 'fed.spill', byteLength: 1, sha256: 'c'.repeat(64), createdAt: 1, head: '', tail: '' }

async function reconcileToTerminal(conn: ReturnType<typeof getDbConnection>) {
  let result = await runSpillReferenceReconciliationBatch(conn)
  for (let attempt = 0; result.status === 'running' && attempt < 10; attempt += 1) result = await runSpillReferenceReconciliationBatch(conn)
  return result
}

describe('spill reference generation reconciliation', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.close() })

  it('sets complete only after both canonical datasets match their indexed paths at one generation', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'reconcile', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'reconcile-event', idempotencyKey: 'reconcile-event', kind: 'invocation-context-committed',
      payload: { one: { __spaceassistant_spill_v1: spill } }
    }], 0)
    expect(await runSpillReferenceBackfillBatch(conn)).toMatchObject({ status: 'running', processedOwners: 1 })
    const result = await reconcileToTerminal(conn)
    expect(result).toMatchObject({ status: 'complete', checkedOwners: expect.any(Number), generation: getCanonicalSpillChangeGeneration(conn) })
    expect(conn.prepare("SELECT status,verified_generation FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get())
      .toEqual({ status: 'complete', verified_generation: result.generation })
    expect(conn.prepare("SELECT status,verified_generation FROM spill_reference_backfill_state WHERE owner_table='session_transcript_entries'").get())
      .toEqual({ status: 'complete', verified_generation: result.generation })
  })

  it('fails closed on an extra indexed owner path and never leaves a trusted state', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'reconcile-extra', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'reconcile-extra-event', idempotencyKey: 'reconcile-extra-event', kind: 'invocation-context-committed', payload: {}
    }], 0)
    conn.prepare(`INSERT INTO spill_reference_index(owner_table,owner_key,descriptor_path,owner_revision,locator,kind,descriptor_json,updated_at)
      VALUES('agent_history_events',?,'/ghost','bad','ghost.spill','degradable','{}',1)`).run(spillHistoryOwnerKey('reconcile-extra', 'reconcile-extra-event'))
    const result = await runSpillReferenceReconciliationBatch(conn)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('spill-reference-index-extra-row')
    expect(conn.prepare("SELECT status,verified_generation FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get())
      .toEqual({ status: 'failed', verified_generation: null })
  })

  it('fails closed when a canonical owner was deleted without its index rows', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'orphan-index-owner', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'orphan-index-event', idempotencyKey: 'orphan-index-event', kind: 'invocation-context-committed',
      payload: { marker: { __spaceassistant_spill_v1: spill } }
    }], 0)
    conn.prepare("DELETE FROM agent_history_events WHERE event_id='orphan-index-event'").run()
    const result = await reconcileToTerminal(conn)
    expect(result).toMatchObject({ status: 'failed', error: `spill-reference-index-extra-owner:agent_history_events:${spillHistoryOwnerKey('orphan-index-owner', 'orphan-index-event')}` })
  })

  it('detects canonical generation changes after a prior trusted pass and reopens the full audit', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const first = await reconcileToTerminal(conn)
    expect(first.status).toBe('complete')
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES('new','1',1,NULL)`).run()
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('new',1,'new-event','new-key','turn',1,'tool-call-started','{}',1)`).run()
    expect(getCanonicalSpillChangeGeneration(conn)).toBeGreaterThan(first.generation ?? 0)
    const next = await reconcileToTerminal(conn)
    expect(next.status).toBe('complete')
    expect(next.generation).toBe(getCanonicalSpillChangeGeneration(conn))
  })

  it('reconciles a large owner through bounded SQLite blob reads', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'reconcile-large', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'reconcile-large-event', idempotencyKey: 'reconcile-large-event', kind: 'invocation-context-committed',
      payload: { padding: 'x'.repeat(700 * 1024), descriptor: { __spaceassistant_spill_v1: spill } }
    }], 0)
    await runSpillReferenceBackfillBatch(conn)
    expect(await reconcileToTerminal(conn)).toMatchObject({ status: 'complete', checkedOwners: expect.any(Number) })
  })

  it('preserves the fixed generation and cursor when cancelled during a reconciliation page', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'cancel-reconcile', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'cancel-reconcile-event', idempotencyKey: 'cancel-reconcile-event', kind: 'invocation-context-committed',
      payload: { nested: { __spaceassistant_spill_v1: spill } }
    }], 0)
    await runSpillReferenceBackfillBatch(conn)
    expect(await runSpillReferenceReconciliationBatch(conn, { signal: AbortSignal.abort() })).toMatchObject({ status: 'paused' })
    expect(conn.prepare("SELECT status,reconcile_cursor_json,verified_generation FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get())
      .toEqual({ status: 'paused', reconcile_cursor_json: '{}', verified_generation: null })
  })

  it('restarts a bounded audit when a canonical owner revision changes mid-read', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const payload = JSON.stringify({ nested: { __spaceassistant_spill_v1: spill } })
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'racing-reconcile', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'racing-reconcile-event', idempotencyKey: 'racing-reconcile-event', kind: 'invocation-context-committed', payload: JSON.parse(payload)
    }], 0)
    await runSpillReferenceBackfillBatch(conn)
    let clockCalls = 0
    const result = await runSpillReferenceReconciliationBatch(conn, { now: () => {
      clockCalls += 1
      if (clockCalls === 5) conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?').run(payload, 'racing-reconcile-event')
      return 100
    } })
    expect(result).toMatchObject({ status: 'running', restartRequired: true })
    const state = conn.prepare("SELECT status,reconcile_generation,reconcile_cursor_json,verified_generation FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get()
    expect(state).toEqual({ status: 'running', reconcile_generation: getCanonicalSpillChangeGeneration(conn), reconcile_cursor_json: '{}', verified_generation: null })
  })
})
