import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { appendSqliteAgentHistoryBatchInTransaction } from './agentHistoryStorage'
import { commitSessionTranscriptInTransaction } from './sessionTranscript'
import { getCanonicalSpillChangeGeneration, readSpillReferenceIndexRows, spillHistoryOwnerKey, spillTranscriptOwnerKey } from '../storage/spillReferenceIndex'
import { createSession, deleteSession } from './operations'

const spill = { version: 1, kind: 'source-of-truth', locator: 'abc.spill', byteLength: 1, sha256: 'a'.repeat(64), createdAt: 1, head: '', tail: '' }

describe('canonical spill index dual write', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.close() })

  it('keeps History and transcript descriptors in the canonical write transaction', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'spill-dual-write', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-dual-write-event', idempotencyKey: 'spill-dual-write-event', kind: 'invocation-context-committed',
      payload: { context: { __spaceassistant_spill_v1: spill } }
    }], 0, { sessionId: 'spill-dual-write-session', now: () => 7 })
    const transcript = commitSessionTranscriptInTransaction(conn, {
      sessionId: 'spill-dual-write-session', turnId: 'transcript-turn', baseVersion: 0, outcome: 'completed',
      messages: [{ nested: { __spaceassistant_spill_v1: spill } }], now: 8
    })

    expect(transcript).toEqual({ committed: true, version: 1 })
    expect(readSpillReferenceIndexRows(conn).map(({ owner_table, owner_key, descriptor_path, locator }) => ({ owner_table, owner_key, descriptor_path, locator }))).toEqual([
      { owner_table: 'agent_history_events', owner_key: spillHistoryOwnerKey('spill-dual-write', 'spill-dual-write-event'), descriptor_path: '/context/__spaceassistant_spill_v1', locator: 'abc.spill' },
      { owner_table: 'session_transcript_entries', owner_key: spillTranscriptOwnerKey('spill-dual-write-session', 1), descriptor_path: '/0/nested/__spaceassistant_spill_v1', locator: 'abc.spill' }
    ])
    expect(getCanonicalSpillChangeGeneration(conn)).toBe(2)
  })

  it('keeps same event ids from different invocations as distinct index owners through backfill and reconciliation', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const payload = (locator: string) => ({ marker: { __spaceassistant_spill_v1: { ...spill, locator } } })
    for (const [invocationId, locator] of [['first', 'aaa.spill'], ['second', 'bbb.spill']] as const) {
      appendSqliteAgentHistoryBatchInTransaction(conn, [{
        invocationId, turnId: 'turn', sequence: 1, schemaVersion: 1, eventId: 'shared-id',
        idempotencyKey: `${invocationId}-shared-id`, kind: 'invocation-context-committed', payload: payload(locator)
      }], 0)
    }
    expect(conn.prepare('SELECT invocation_id,event_id FROM agent_history_events ORDER BY invocation_id').all())
      .toEqual([{ invocation_id: 'first', event_id: 'shared-id' }, { invocation_id: 'second', event_id: 'shared-id' }])
    expect(conn.prepare("SELECT owner_key,locator FROM spill_reference_index WHERE owner_table='agent_history_events' ORDER BY owner_key").all())
      .toEqual([
        { owner_key: spillHistoryOwnerKey('first', 'shared-id'), locator: 'aaa.spill' },
        { owner_key: spillHistoryOwnerKey('second', 'shared-id'), locator: 'bbb.spill' }
      ])
    conn.prepare("DELETE FROM spill_reference_index WHERE owner_table='agent_history_events'").run()
    const { runSpillReferenceBackfillBatch } = await import('../storage/spillReferenceBackfill')
    const { runSpillReferenceReconciliationBatch } = await import('../storage/spillReferenceReconciliation')
    expect(await runSpillReferenceBackfillBatch(conn)).toMatchObject({ status: 'running', processedOwners: 2, indexedDescriptors: 2 })
    let result = await runSpillReferenceReconciliationBatch(conn)
    for (let attempt = 0; result.status === 'running' && attempt < 10; attempt += 1) result = await runSpillReferenceReconciliationBatch(conn)
    expect(result.status).toBe('complete')
    expect(conn.prepare("SELECT owner_key,locator FROM spill_reference_index WHERE owner_table='agent_history_events' ORDER BY owner_key").all())
      .toEqual([
        { owner_key: spillHistoryOwnerKey('first', 'shared-id'), locator: 'aaa.spill' },
        { owner_key: spillHistoryOwnerKey('second', 'shared-id'), locator: 'bbb.spill' }
      ])
  })

  it('uses the composite canonical History key for indexed revision lookups', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const plan = conn.prepare(`EXPLAIN QUERY PLAN SELECT spill_reference_revision FROM agent_history_events WHERE invocation_id=? AND event_id=?`).all('invocation', 'event') as Array<{ detail: string }>
    expect(plan.map(({ detail }) => detail).join(' ')).toMatch(/SEARCH agent_history_events USING (COVERING )?INDEX/)
    expect(plan.map(({ detail }) => detail).join(' ')).not.toMatch(/SCAN agent_history_events/)
  })

  it('does not commit an index row when the enclosing owner write rolls back', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    conn.exec('BEGIN IMMEDIATE')
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'spill-rollback', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-rollback-event', idempotencyKey: 'spill-rollback-event', kind: 'invocation-context-committed',
      payload: { __spaceassistant_spill_v1: spill }
    }], 0, { now: () => 7 })
    conn.exec('ROLLBACK')
    expect(conn.prepare("SELECT count(*) AS count FROM agent_history_events WHERE event_id='spill-rollback-event'").get()).toEqual({ count: 0 })
    expect(conn.prepare("SELECT count(*) AS count FROM spill_reference_index WHERE owner_key=?").get(spillHistoryOwnerKey('spill-rollback', 'spill-rollback-event'))).toEqual({ count: 0 })
    expect(getCanonicalSpillChangeGeneration(conn)).toBe(0)
  })

  it('removes both owners from the index atomically with session deletion', () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'spill owner delete' })
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'spill-delete', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-delete-event', idempotencyKey: 'spill-delete-event', kind: 'invocation-context-committed',
      payload: { __spaceassistant_spill_v1: spill }
    }], 0, { sessionId: session.id })
    commitSessionTranscriptInTransaction(conn, {
      sessionId: session.id, turnId: 'spill-delete-turn', baseVersion: 0, outcome: 'completed',
      messages: [{ __spaceassistant_spill_v1: spill }]
    })
    deleteSession(db, session.id, { flush: false })
    expect(conn.prepare('SELECT count(*) AS count FROM spill_reference_index').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT count(*) AS count FROM agent_history_events WHERE event_id=?').get('spill-delete-event')).toEqual({ count: 0 })
    expect(conn.prepare('SELECT count(*) AS count FROM session_transcript_entries WHERE session_id=?').get(session.id)).toEqual({ count: 0 })
  })
})
