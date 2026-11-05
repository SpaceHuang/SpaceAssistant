import { describe, expect, it } from 'vitest'
import { createSession, enqueueQueuedUserMessage } from './operations'
import { createMemoryAppDb, createTempDatabase } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { DatabaseUpgradeRequiredError, runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'
import { openDatabase } from './index'

function restoreV123QueueInputRequests(db: ReturnType<typeof createMemoryAppDb>): void {
  const conn = getDbConnection(db)
  conn.exec(`DROP INDEX IF EXISTS idx_queue_input_requests_agent_owner_request;
    DROP INDEX IF EXISTS idx_queue_input_requests_message;
    CREATE TABLE queue_input_requests_v123 (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      queue_scope TEXT NOT NULL DEFAULT 'desktop',
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      queued_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (queue_scope, session_id, request_id)
    );
    INSERT INTO queue_input_requests_v123(session_id,request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at,queue_scope)
      SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at,queue_scope FROM queue_input_requests;
    DROP TABLE queue_input_requests;
    ALTER TABLE queue_input_requests_v123 RENAME TO queue_input_requests;
    CREATE INDEX idx_queue_input_requests_message ON queue_input_requests(queued_message_id);`)
  conn.prepare("UPDATE schema_meta SET value='123' WHERE key='schema_version'").run()
}

describe('agent session message schema migration', () => {
  it('upgrades a file-backed Electron SQLite database, preserves legacy receipts, and stays upgraded after reopen', () => {
    const temp = createTempDatabase('agent-session-v123-file-')
    let db = temp.db
    try {
      const target = createSession(db, { name: 'file legacy target' })
      const queued = enqueueQueuedUserMessage(db, { sessionId: target.id, requestId: 'file-v123-receipt', content: 'old payload' })
      restoreV123QueueInputRequests(db)
      db.close()
      db = openDatabase(temp.dbPath)
      const conn = getDbConnection(db)
      const migrated = conn.prepare(`SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state,source_json
        FROM queue_input_requests WHERE session_id=? AND request_id=?`).get(target.id, 'file-v123-receipt')
      expect(migrated).toMatchObject({ session_id: target.id, request_id: 'file-v123-receipt',
        queued_message_id: queued.persisted.message.id, state: 'queued', source_json: null })
      expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      const foreignKeys = conn.prepare('PRAGMA foreign_key_list(queue_input_requests)').all() as Array<{ table: string; on_delete: string }>
      expect(foreignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'messages', on_delete: 'SET NULL' }),
        expect.objectContaining({ table: 'turns', on_delete: 'SET NULL' })
      ]))
      db.close()
      db = openDatabase(temp.dbPath)
      expect(getDbConnection(db).prepare(`SELECT source_json,state,queued_message_id FROM queue_input_requests
        WHERE session_id=? AND request_id=?`).get(target.id, 'file-v123-receipt'))
        .toEqual({ source_json: null, state: 'queued', queued_message_id: queued.persisted.message.id })
      expect(getDbConnection(db).prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
        .toEqual({ value: String(DB_SCHEMA_VERSION) })
    } finally { temp.cleanup(db) }
  })

  it('adds only the nullable source column, preserves old receipts, and keeps the intended foreign keys', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const target = createSession(db, { name: 'legacy target' })
    const queued = enqueueQueuedUserMessage(db, { sessionId: target.id, requestId: 'legacy-v123-request', content: 'legacy payload' })
    restoreV123QueueInputRequests(db)

    const before = conn.prepare(`SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at,queue_scope
      FROM queue_input_requests WHERE session_id=? AND request_id=?`).get(target.id, 'legacy-v123-request')
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '123' })

    runMigrations(conn)

    const columns = conn.prepare('PRAGMA table_info(queue_input_requests)').all() as Array<{ name: string; notnull: number }>
    expect(columns.map(({ name }) => name)).toEqual([
      'session_id', 'queue_scope', 'request_id', 'fingerprint', 'queued_message_id', 'turn_id', 'state', 'created_at', 'updated_at', 'source_json'
    ])
    expect(columns.find(({ name }) => name === 'source_json')?.notnull).toBe(0)
    expect(columns.filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk).map(({ name }) => name))
      .toEqual(['queue_scope', 'session_id', 'request_id'])
    expect(conn.prepare(`SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at,queue_scope,source_json
      FROM queue_input_requests WHERE session_id=? AND request_id=?`).get(target.id, 'legacy-v123-request'))
      .toEqual({ ...(before as object), source_json: null })
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })

    const foreignKeys = conn.prepare('PRAGMA foreign_key_list(queue_input_requests)').all() as Array<{ table: string; on_delete: string }>
    expect(foreignKeys).toHaveLength(2)
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'messages', on_delete: 'SET NULL' }),
      expect.objectContaining({ table: 'turns', on_delete: 'SET NULL' })
    ]))
    expect(foreignKeys).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: 'sessions' })]))
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_queue_input_requests_message','idx_queue_input_requests_scope_session_request') ORDER BY name").all())
      .toEqual([{ name: 'idx_queue_input_requests_message' }, { name: 'idx_queue_input_requests_scope_session_request' }])

    const target2 = createSession(db, { name: 'second target' })
    const source = (targetSessionId: string, ownerSessionId: string, requestId: string, messageId: string) => JSON.stringify({
      version: 1, kind: 'agent-session', ownerSessionId, requestId,
      targetSessionId, messageId, payloadSha256: 'a'.repeat(64), authorizationBinding: {}
    })
    conn.prepare(`INSERT INTO queue_input_requests(session_id,request_id,fingerprint,state,created_at,updated_at,queue_scope,source_json)
      VALUES(?,?,?,'queued',1,1,'desktop',?)`).run(target.id, 'same-agent-request', 'fp-a', source(target.id, 'owner-a', 'same-agent-request', 'message-a'))
    expect(() => conn.prepare(`INSERT INTO queue_input_requests(session_id,request_id,fingerprint,state,created_at,updated_at,queue_scope,source_json)
      VALUES(?,?,?,'queued',1,1,'desktop',?)`).run(target2.id, 'same-agent-request', 'fp-b', source(target2.id, 'owner-a', 'same-agent-request', 'message-b')))
      .toThrow()

    runMigrations(conn)
    expect(conn.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_queue_input_requests_agent_owner_request'").get())
      .toEqual({ count: 1 })
    db.close()
    expect(queued.persisted.message.id).toBeTruthy()
  })

  it('aborts and rolls back when an unexpected table references queue input receipts', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const target = createSession(db, { name: 'dependent target' })
    enqueueQueuedUserMessage(db, { sessionId: target.id, requestId: 'referenced-receipt', content: 'preserve me' })
    restoreV123QueueInputRequests(db)
    conn.exec(`CREATE TABLE unexpected_queue_receipt_dependency (
      queue_scope TEXT NOT NULL,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      FOREIGN KEY(queue_scope,session_id,request_id) REFERENCES queue_input_requests(queue_scope,session_id,request_id) ON DELETE RESTRICT
    );`)
    conn.prepare('INSERT INTO unexpected_queue_receipt_dependency(queue_scope,session_id,request_id) VALUES(?,?,?)')
      .run('desktop', target.id, 'referenced-receipt')

    expect(() => runMigrations(conn)).toThrow()
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '123' })
    expect(conn.prepare('PRAGMA table_info(queue_input_requests)').all()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'source_json' })
    ]))
    expect(conn.prepare('SELECT state FROM queue_input_requests WHERE session_id=? AND request_id=?').get(target.id, 'referenced-receipt'))
      .toEqual({ state: 'queued' })
    db.close()
  })

  it('rejects a database schema newer than the running application', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(String(DB_SCHEMA_VERSION + 1), 'schema_version')

    expect(() => runMigrations(conn)).toThrow(DatabaseUpgradeRequiredError)
    expect(conn.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', 'queue_input_requests'))
      .toBeDefined()
    db.close()
  })
})
