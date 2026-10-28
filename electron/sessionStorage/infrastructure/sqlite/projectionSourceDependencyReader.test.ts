import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createTempDatabase } from '../../../database/testHelpers'
import { createSession } from '../../../database/operations'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { projectionSourceEventDigest, readProjectionPageSourceSpills } from './projectionSourceDependencyReader'

describe('projection page source dependency reader', () => {
  let cleanup: (() => void) | undefined
  afterEach(() => { cleanup?.(); cleanup = undefined })

  it('reads and verifies only dependencies selected by page message locators', async () => {
    const temp = createTempDatabase('projection-page-dependencies-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'page dependency reader' })
    const history = new SqliteAgentHistory(conn, 1, () => 10, session.id)
    await history.appendBatch([
      { invocationId: 'page-invocation', turnId: 'page-turn', sequence: 1, schemaVersion: 1,
        eventId: 'page-event', idempotencyKey: 'page-event', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'page-message', role: 'user', content: 'page body' }] } },
    ], 0)
    await history.appendBatch([
      { invocationId: 'unrelated-invocation', turnId: 'unrelated-turn', sequence: 1, schemaVersion: 1,
        eventId: 'unrelated-event', idempotencyKey: 'unrelated-event', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    for (let index = 0; index < 99; index += 1) {
      const suffix = String(index).padStart(3, '0')
      await history.appendBatch([{ invocationId: `unrelated-invocation-${suffix}`, turnId: `unrelated-turn-${suffix}`,
        sequence: 1, schemaVersion: 1, eventId: `unrelated-event-${suffix}`, idempotencyKey: `unrelated-event-${suffix}`,
        kind: 'invocation-completed', payload: { status: 'completed' } }], 0)
    }
    const sourceState = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(session.id) as { source_revision: number }
    const event = conn.prepare('SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,commit_order,created_at,payload_json FROM agent_history_events WHERE event_id=?')
      .get('page-event') as Parameters<typeof projectionSourceEventDigest>[0]
    conn.prepare(`INSERT INTO session_body_source_manifest(session_id,invocation_id,source_revision,manifest_locator,byte_length,sha256,
      history_watermark_json,schema_version) VALUES(?,?,?,?,?,?,?,?)`).run(session.id, 'page-invocation', sourceState.source_revision,
        'projection-11111111-1111-4111-8111-111111111111.blob', 2, 'a'.repeat(64), '[1,1]', 1)
    conn.prepare(`INSERT INTO session_message_body_locator(session_id,message_id,sequence,fragment_locator,byte_length,sha256)
      VALUES(?,?,?,?,?,?)`).run(session.id, 'page-message', 0, 'projection-22222222-2222-4222-8222-222222222222.blob', 2, 'b'.repeat(64))
    conn.prepare(`INSERT INTO session_message_body_source_event(session_id,message_id,invocation_id,event_id,event_sequence,
      session_sequence,schema_version,kind,source_digest) VALUES(?,?,?,?,?,?,?,?,?)`).run(session.id, 'page-message', 'page-invocation',
        'page-event', event.sequence, event.session_seq, event.schema_version, event.kind, projectionSourceEventDigest(event))
    conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value
      FROM spill_reference_meta WHERE meta_key='canonical_change_generation') WHERE owner_table='agent_history_events'`).run()

    const historyPayloadRowCounts: number[] = []
    const prepare = conn.prepare.bind(conn)
    vi.spyOn(conn, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (!sql.includes('payload_json FROM agent_history_events')) return statement
      return new Proxy(statement, { get(target, property) {
        if (property === 'all') return (...parameters: unknown[]) => {
          const rows = Reflect.get(target, 'all', target).apply(target, parameters) as unknown[]
          historyPayloadRowCounts.push(rows.length)
          return rows
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } }) as typeof statement
    })

    expect(readProjectionPageSourceSpills(conn, session.id, sourceState.source_revision, ['page-message'])).toEqual([])
    expect(historyPayloadRowCounts).toEqual([1])

    historyPayloadRowCounts.length = 0
    conn.prepare("UPDATE agent_history_events SET payload_json='{' WHERE event_id='unrelated-event'").run()
    expect(readProjectionPageSourceSpills(conn, session.id, sourceState.source_revision, ['page-message'])).toEqual([])
    expect(historyPayloadRowCounts).toEqual([1])
  })

  it('fails closed when a selected locator is missing or its source event changed', async () => {
    const temp = createTempDatabase('projection-page-dependency-invalid-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'page dependency invalid' })
    await new SqliteAgentHistory(conn, 1, () => 10, session.id).appendBatch([{
      invocationId: 'selected-invocation', turnId: 'selected-turn', sequence: 1, schemaVersion: 1,
      eventId: 'selected-event', idempotencyKey: 'selected-event', kind: 'invocation-completed', payload: { status: 'completed' },
    }], 0)
    const revision = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(session.id) as { source_revision: number }
    conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value
      FROM spill_reference_meta WHERE meta_key='canonical_change_generation') WHERE owner_table='agent_history_events'`).run()
    expect(() => readProjectionPageSourceSpills(conn, session.id, revision.source_revision, ['absent-message']))
      .toThrow('PROJECTION_SOURCE_LOCATOR_UNAVAILABLE')

    const event = conn.prepare('SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,commit_order,created_at,payload_json FROM agent_history_events WHERE event_id=?')
      .get('selected-event') as Parameters<typeof projectionSourceEventDigest>[0]
    conn.prepare(`INSERT INTO session_body_source_manifest(session_id,invocation_id,source_revision,manifest_locator,byte_length,sha256,
      history_watermark_json,schema_version) VALUES(?,?,?,?,?,?,?,?)`).run(session.id, 'selected-invocation', revision.source_revision,
        'projection-33333333-3333-4333-8333-333333333333.blob', 2, 'c'.repeat(64), '[1,1]', 1)
    conn.prepare(`INSERT INTO session_message_body_locator(session_id,message_id,sequence,fragment_locator,byte_length,sha256)
      VALUES(?,?,?,?,?,?)`).run(session.id, 'selected-message', 0, 'projection-44444444-4444-4444-8444-444444444444.blob', 2, 'd'.repeat(64))
    conn.prepare(`INSERT INTO session_message_body_source_event(session_id,message_id,invocation_id,event_id,event_sequence,
      session_sequence,schema_version,kind,source_digest) VALUES(?,?,?,?,?,?,?,?,?)`).run(session.id, 'selected-message',
        'selected-invocation', 'selected-event', event.sequence, event.session_seq, event.schema_version, event.kind,
        projectionSourceEventDigest(event))
    conn.prepare("UPDATE agent_history_events SET payload_json='{}' WHERE event_id='selected-event'").run()
    expect(() => readProjectionPageSourceSpills(conn, session.id, revision.source_revision, ['selected-message']))
      .toThrow('PROJECTION_SOURCE_DEPENDENCY_MISMATCH')
  })

  it('resolves selected source spills from canonical History while the derived spill index is reconciling', async () => {
    const temp = createTempDatabase('projection-page-spill-index-pending-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'page dependency pending spill index' })
    const descriptor = { version: 1, kind: 'source-of-truth', locator: '11111111-1111-4111-8111-111111111111.spill',
      byteLength: 3, sha256: 'a'.repeat(64), createdAt: 10, head: 'abc', tail: 'abc' }
    await new SqliteAgentHistory(conn, 1, () => 10, session.id).appendBatch([{
      invocationId: 'pending-index-invocation', turnId: 'pending-index-turn', sequence: 1, schemaVersion: 1,
      eventId: 'pending-index-event', idempotencyKey: 'pending-index-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'pending-index-message', role: 'assistant', content: 'body' }] },
    }], 0)
    conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?')
      .run(JSON.stringify({ messages: [{ id: 'pending-index-message', role: 'assistant',
        content: { __spaceassistant_spill_v1: descriptor } }] }), 'pending-index-event')
    const event = conn.prepare(`SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,
      commit_order,created_at,payload_json FROM agent_history_events WHERE event_id=?`)
      .get('pending-index-event') as Parameters<typeof projectionSourceEventDigest>[0]
    const sourceRevision = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?')
      .get(session.id) as { source_revision: number }
    conn.prepare(`INSERT INTO session_body_source_manifest(session_id,invocation_id,source_revision,manifest_locator,byte_length,sha256,
      history_watermark_json,schema_version) VALUES(?,?,?,?,?,?,?,?)`).run(session.id, 'pending-index-invocation', sourceRevision.source_revision,
        'projection-77777777-7777-4777-8777-777777777777.blob', 2, 'e'.repeat(64), '[1,1]', 1)
    conn.prepare(`INSERT INTO session_message_body_locator(session_id,message_id,sequence,fragment_locator,byte_length,sha256)
      VALUES(?,?,?,?,?,?)`).run(session.id, 'pending-index-message', 0, 'projection-88888888-8888-4888-8888-888888888888.blob', 2, 'f'.repeat(64))
    conn.prepare(`INSERT INTO session_message_body_source_event(session_id,message_id,invocation_id,event_id,event_sequence,
      session_sequence,schema_version,kind,source_digest) VALUES(?,?,?,?,?,?,?,?,?)`).run(session.id, 'pending-index-message',
        'pending-index-invocation', 'pending-index-event', event.sequence, event.session_seq, event.schema_version, event.kind,
        projectionSourceEventDigest(event))
    const revision = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?')
      .get(session.id) as { source_revision: number }
    conn.prepare(`UPDATE spill_reference_backfill_state SET status='running',verified_generation=NULL
      WHERE owner_table='agent_history_events'`).run()

    expect(readProjectionPageSourceSpills(conn, session.id, revision.source_revision, ['pending-index-message']))
      .toEqual([descriptor])

    const eventRevision = conn.prepare('SELECT spill_reference_revision FROM agent_history_events WHERE event_id=?')
      .get('pending-index-event') as { spill_reference_revision: number | null }
    const wrongDescriptor = { ...descriptor, locator: '22222222-2222-4222-8222-222222222222.spill' }
    conn.prepare(`INSERT INTO spill_reference_index(owner_table,owner_key,descriptor_path,owner_revision,locator,kind,
      descriptor_json,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('agent_history_events',
        JSON.stringify(['pending-index-invocation', 'pending-index-event']), '/messages/0/content/__spaceassistant_spill_v1',
        String(eventRevision.spill_reference_revision), wrongDescriptor.locator, 'source-of-truth', JSON.stringify(wrongDescriptor), 10)
    expect(() => readProjectionPageSourceSpills(conn, session.id, revision.source_revision, ['pending-index-message']))
      .toThrow('PROJECTION_SOURCE_SPILL_INDEX_MISMATCH')
  })

  it('requires every History event in each selected invocation dependency set', async () => {
    const temp = createTempDatabase('projection-page-dependency-coverage-')
    cleanup = temp.cleanup
    const conn = getDbConnection(temp.db)
    const session = createSession(temp.db, { name: 'page dependency coverage' })
    await new SqliteAgentHistory(conn, 1, () => 10, session.id).appendBatch([
      { invocationId: 'coverage-invocation', turnId: 'coverage-turn', sequence: 1, schemaVersion: 1,
        eventId: 'coverage-event-1', idempotencyKey: 'coverage-event-1', kind: 'invocation-context-committed', payload: { messages: [] } },
      { invocationId: 'coverage-invocation', turnId: 'coverage-turn', sequence: 2, schemaVersion: 1,
        eventId: 'coverage-event-2', idempotencyKey: 'coverage-event-2', kind: 'invocation-completed', payload: { status: 'completed' } },
    ], 0)
    const revision = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(session.id) as { source_revision: number }
    conn.prepare(`INSERT INTO session_body_source_manifest(session_id,invocation_id,source_revision,manifest_locator,byte_length,sha256,
      history_watermark_json,schema_version) VALUES(?,?,?,?,?,?,?,?)`).run(session.id, 'coverage-invocation', revision.source_revision,
        'projection-55555555-5555-4555-8555-555555555555.blob', 2, 'e'.repeat(64), '[2,2]', 1)
    conn.prepare(`INSERT INTO session_message_body_locator(session_id,message_id,sequence,fragment_locator,byte_length,sha256)
      VALUES(?,?,?,?,?,?)`).run(session.id, 'coverage-message', 0, 'projection-66666666-6666-4666-8666-666666666666.blob', 2, 'f'.repeat(64))
    const event = conn.prepare('SELECT invocation_id,turn_id,sequence,event_id,idempotency_key,schema_version,kind,session_seq,commit_order,created_at,payload_json FROM agent_history_events WHERE event_id=?')
      .get('coverage-event-1') as Parameters<typeof projectionSourceEventDigest>[0]
    conn.prepare(`INSERT INTO session_message_body_source_event(session_id,message_id,invocation_id,event_id,event_sequence,
      session_sequence,schema_version,kind,source_digest) VALUES(?,?,?,?,?,?,?,?,?)`).run(session.id, 'coverage-message',
        'coverage-invocation', 'coverage-event-1', event.sequence, event.session_seq, event.schema_version, event.kind,
        projectionSourceEventDigest(event))
    expect(() => readProjectionPageSourceSpills(conn, session.id, revision.source_revision, ['coverage-message']))
      .toThrow('PROJECTION_SOURCE_DEPENDENCY_INCOMPLETE:coverage-message')
  })

  it('hashes large History payloads in bounded JSON string chunks without changing the digest', () => {
    const payload_json = `${'quote" slash\\ newline\n snow 雪 emoji 😀 '.repeat(8_000)}\u2028\u2029\u0001`
    const event = { invocation_id: 'large-invocation', turn_id: 'large-turn', sequence: 7, event_id: 'large-event',
      idempotency_key: 'large-key', schema_version: 1, kind: 'invocation-context-committed', session_seq: 9,
      commit_order: 3, created_at: 11, payload_json }
    const expected = createHash('sha256').update(JSON.stringify({ invocationId: event.invocation_id, turnId: event.turn_id,
      sequence: event.sequence, eventId: event.event_id, idempotencyKey: event.idempotency_key, schemaVersion: event.schema_version,
      kind: event.kind, sessionSequence: event.session_seq, commitOrder: event.commit_order, createdAt: event.created_at,
      payloadJson: event.payload_json }), 'utf8').digest('hex')
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(projectionSourceEventDigest(event)).toBe(expected)
      expect(stringify.mock.calls.some(([value]) => !!value && typeof value === 'object' &&
        'payloadJson' in value && (value as { payloadJson?: unknown }).payloadJson === payload_json)).toBe(false)
    } finally { stringify.mockRestore() }
  })
})
