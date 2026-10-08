import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { getCanonicalSpillChangeGeneration } from './spillReferenceIndex'
import { spillHistoryOwnerKey } from './spillReferenceIndex'
import { claimSpillReferenceMaintenanceLease, runSpillReferenceBackfillBatch, validateSpillReferenceMaintenanceLease } from './spillReferenceBackfill'

const spill = { version: 1, kind: 'degradable', locator: 'def.spill', byteLength: 1, sha256: 'b'.repeat(64), createdAt: 1, head: '', tail: '' }

describe('spill reference staged backfill', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.close() })

  it('resumes from the committed keyset cursor and idempotently publishes an owner snapshot', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'backfill-invocation', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'backfill-event', idempotencyKey: 'backfill-event', kind: 'invocation-context-committed', payload: { nested: { __spaceassistant_spill_v1: spill } }
    }], 0)
    conn.prepare("DELETE FROM spill_reference_index WHERE owner_table='agent_history_events'").run()

    const result = await runSpillReferenceBackfillBatch(conn, { now: () => 100 })
    expect(result).toMatchObject({ status: 'running', processedOwners: 1, indexedDescriptors: 1 })
    expect(conn.prepare("SELECT locator,kind,descriptor_path FROM spill_reference_index WHERE owner_table='agent_history_events'").get())
      .toEqual({ locator: 'def.spill', kind: 'degradable', descriptor_path: '/nested/__spaceassistant_spill_v1' })
    expect(getCanonicalSpillChangeGeneration(conn)).toBe(1)
    const cursor = conn.prepare("SELECT cursor_json FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get() as { cursor_json: string }
    expect(JSON.parse(cursor.cursor_json)).toEqual({ invocationId: 'backfill-invocation', eventId: 'backfill-event' })
    expect(await runSpillReferenceBackfillBatch(conn, { now: () => 200 })).toMatchObject({ status: 'running', processedOwners: 0 })
    expect(conn.prepare("SELECT count(*) AS count FROM spill_reference_index WHERE owner_table='agent_history_events'").get()).toEqual({ count: 1 })
  })

  it('rejects payloads over 64 MiB by size before trying to parse their invalid JSON', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES('large','1',1,NULL)`).run()
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('large',1,'large-event','large-key','turn',1,'tool-call-started',CAST(zeroblob(67108865) AS TEXT),1)`).run()
    const result = await runSpillReferenceBackfillBatch(conn)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('owner-payload-over-limit:agent_history_events:["large","large-event"]:67108865')
    expect(conn.prepare("SELECT cursor_json FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get()).toEqual({ cursor_json: null })
    expect(conn.prepare("SELECT count(*) AS count FROM spill_reference_index WHERE owner_key=?").get(spillHistoryOwnerKey('large', 'large-event'))).toEqual({ count: 0 })
  })

  it('uses one exclusive persistent maintenance lease for backfill activations', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO spill_reference_maintenance_lease(lease_name,owner_token,fencing_token,expires_at,updated_at)
      VALUES('spill-reference-index','other-worker',8,1000,1)`).run()
    expect(await runSpillReferenceBackfillBatch(conn, { ownerToken: 'worker', now: () => 10 })).toEqual({ status: 'idle', processedOwners: 0, indexedDescriptors: 0 })
  })

  it('fences an expired worker after a successor acquires the lease', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const stale = claimSpillReferenceMaintenanceLease(conn, 'old-worker', 100)
    const current = claimSpillReferenceMaintenanceLease(conn, 'new-worker', 30_101)
    expect(current.fencingToken).toBeGreaterThan(stale.fencingToken)
    expect(() => validateSpillReferenceMaintenanceLease(conn, stale, 30_102)).toThrow('spill-reference-maintenance-lease-lost')
    expect(() => validateSpillReferenceMaintenanceLease(conn, current, 30_102)).not.toThrow()
  })

  it('keeps the keyset cursor unchanged when cancelled at an owner boundary', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'cancel-backfill', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'cancel-backfill-event', idempotencyKey: 'cancel-backfill-event', kind: 'invocation-context-committed', payload: { marker: { __spaceassistant_spill_v1: spill } }
    }], 0)
    expect(await runSpillReferenceBackfillBatch(conn, { signal: AbortSignal.abort(), now: () => 100 })).toMatchObject({ status: 'paused', processedOwners: 0 })
    expect(conn.prepare("SELECT cursor_json,status FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get())
      .toEqual({ cursor_json: null, status: 'paused' })
  })

  it('does not publish a staged snapshot after a writer advances the owner revision', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const payload = JSON.stringify({ marker: { __spaceassistant_spill_v1: spill } })
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'racing-backfill', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'racing-backfill-event', idempotencyKey: 'racing-backfill-event', kind: 'invocation-context-committed', payload: JSON.parse(payload)
    }], 0)
    let clockCalls = 0
    const result = await runSpillReferenceBackfillBatch(conn, { now: () => {
      clockCalls += 1
      if (clockCalls === 2) conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?').run(payload, 'racing-backfill-event')
      return 100
    } })
    expect(result).toMatchObject({ status: 'running', retryRequired: true })
    expect(conn.prepare("SELECT cursor_json FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get()).toEqual({ cursor_json: null })
    expect(conn.prepare("SELECT owner_revision FROM spill_reference_index WHERE owner_table='agent_history_events' AND owner_key=?").get(spillHistoryOwnerKey('racing-backfill', 'racing-backfill-event'))).toEqual({ owner_revision: '0' })
  })

  it('aborts a descriptor-dense staging owner without publishing its partial chunks', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const payload = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`ref-${index}`, { __spaceassistant_spill_v1: { ...spill, locator: `${index.toString(16).padStart(8, '0')}.spill` } }]))
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'cancel-dense-backfill', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'cancel-dense-backfill-event', idempotencyKey: 'cancel-dense-backfill-event', kind: 'invocation-context-committed', payload
    }], 0)
    conn.prepare("DELETE FROM spill_reference_index WHERE owner_table='agent_history_events' AND owner_key=?").run(spillHistoryOwnerKey('cancel-dense-backfill', 'cancel-dense-backfill-event'))
    const controller = new AbortController()
    const pending = runSpillReferenceBackfillBatch(conn, { signal: controller.signal, now: () => 100 })
    controller.abort()
    expect(await pending).toMatchObject({ status: 'paused', processedOwners: 0 })
    expect(conn.prepare("SELECT cursor_json,status FROM spill_reference_backfill_state WHERE owner_table='agent_history_events'").get())
      .toEqual({ cursor_json: null, status: 'paused' })
    expect(conn.prepare("SELECT count(*) AS count FROM spill_reference_staging WHERE owner_key=?").get(spillHistoryOwnerKey('cancel-dense-backfill', 'cancel-dense-backfill-event'))).toEqual({ count: 0 })
    expect(conn.prepare("SELECT count(*) AS count FROM spill_reference_index WHERE owner_key=?").get(spillHistoryOwnerKey('cancel-dense-backfill', 'cancel-dense-backfill-event'))).toEqual({ count: 0 })
  })
})
