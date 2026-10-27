import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createSession } from './operations'
import { createTempDatabase } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { appendSqliteAgentHistoryBatchInTransaction } from './agentHistoryStorage'

describe('session body locator schema v116', () => {
  const databases: ReturnType<typeof createTempDatabase>[] = []
  afterEach(() => { for (const database of databases.splice(0)) database.cleanup() })

  it('creates rebuildable locator state and advances its fence for canonical History writes', () => {
    const database = createTempDatabase('session-body-locator-migration-')
    databases.push(database)
    const session = createSession(database.db, { name: 'locator migration' })
    const conn = getDbConnection(database.db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{ invocationId: 'pre-migration-history', turnId: 'legacy-turn', sequence: 1,
      schemaVersion: 1, eventId: 'pre-migration-event', idempotencyKey: 'pre-migration-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'pre-migration-message', role: 'assistant', content: 'retained canonical history', timestamp: 1 }] } }], 0,
    { sessionId: session.id })
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('115', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(DB_SCHEMA_VERSION).toBe(116)
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '116' })
    expect(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?').get('pre-migration-event'))
      .toMatchObject({ payload_json: expect.stringContaining('retained canonical history') })
    const initial = conn.prepare('SELECT source_revision,status,checkpoint_json FROM session_body_source_state WHERE session_id=?')
      .get(session.id) as { source_revision: number; status: string; checkpoint_json: string | null }
    expect(initial).toMatchObject({ status: 'pending', checkpoint_json: null })
    expect(initial.source_revision).toBeGreaterThanOrEqual(0)

    appendSqliteAgentHistoryBatchInTransaction(conn, [{ invocationId: 'locator-write-invocation', turnId: 'turn', sequence: 1,
      schemaVersion: 1, eventId: 'locator-write-event', idempotencyKey: 'locator-write-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'locator-message', role: 'assistant', content: 'body', timestamp: 1 }] } }], 0,
    { sessionId: session.id })
    const afterWrite = conn.prepare('SELECT source_revision,status,checkpoint_json FROM session_body_source_state WHERE session_id=?')
      .get(session.id) as { source_revision: number; status: string; checkpoint_json: string | null }
    expect(afterWrite.source_revision).toBeGreaterThan(initial.source_revision)
    expect(afterWrite).toMatchObject({ status: 'pending', checkpoint_json: null })

    conn.prepare(`INSERT INTO session_projection_cache(session_id,scope_key,payload_generation,source_identity_json,payload_digest,
      validated_range_json,inline_payload,blob_locator,blob_byte_length,updated_at) VALUES(?,?,?,?,?,'{}','{}',NULL,NULL,1)`)
      .run(session.id, 'paged-body-v1', 'generation-a', '{}', 'a'.repeat(64))
    conn.prepare(`INSERT INTO session_projection_blob_references(session_id,scope_key,payload_generation,locator,byte_length,payload_digest,kind)
      VALUES(?,?,?,?,?,?,?)`).run(session.id, 'paged-body-v1', 'generation-a', 'projection-00000000-0000-4000-8000-000000000001.blob',
        12, 'b'.repeat(64), 'body-block')
    conn.prepare('DELETE FROM session_projection_cache WHERE session_id=? AND scope_key=?').run(session.id, 'paged-body-v1')
    expect(conn.prepare('SELECT 1 FROM session_projection_blob_references WHERE session_id=?').get(session.id)).toBeUndefined()
  })

  it('advances sparse compatibility databases while installing only triggers whose source tables exist', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES ('schema_version','115');`)

    runMigrations(conn)

    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion))
      .toEqual({ value: '116' })
    expect(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message_body_locator'").get())
      .toBeDefined()
    expect(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='bump_session_body_source_after_history_insert'").get())
      .toBeUndefined()
    conn.close()
  })
})
