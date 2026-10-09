import { describe, expect, it } from 'vitest'
import { appendMessage, createPersistedTurn, createSession, enqueueQueuedUserMessage } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'

function restoreLegacyV54Schema(db: ReturnType<typeof createMemoryAppDb>): void {
  const conn = getDbConnection(db)
  conn.exec(`DROP INDEX IF EXISTS idx_messages_queue_scope_status_order;
    DROP INDEX IF EXISTS idx_queue_input_requests_scope_session_request;
    DROP INDEX IF EXISTS idx_queue_input_requests_message;
    ALTER TABLE messages DROP COLUMN queue_scope;
    CREATE TABLE queue_input_requests_v54 (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      queued_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,request_id)
    );
    INSERT INTO queue_input_requests_v54(session_id,request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at)
      SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state,created_at,updated_at FROM queue_input_requests;
    DROP TABLE queue_input_requests;
    ALTER TABLE queue_input_requests_v54 RENAME TO queue_input_requests;
    CREATE INDEX idx_queue_input_requests_message ON queue_input_requests(queued_message_id);`)
  conn.prepare("UPDATE schema_meta SET value='54' WHERE key='schema_version'").run()
}

describe('queue scope migration', () => {
  it('backfills legacy queued desktop messages and receipts without changing message or turn data', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'legacy-desktop-queue-scope' })
    const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'legacy-queue-1', content: 'first payload' })
    const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'legacy-queue-2', content: 'second payload' })
    appendMessage(db, { id: 'legacy-queue-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 3, status: 'streaming' })
    createPersistedTurn(db, {
      turnId: 'legacy-queue-turn', requestId: 'legacy-queue-turn-request', sessionId: session.id,
      assistantMessageId: 'legacy-queue-assistant', userMessageId: first.persisted.message.id, state: 'prepared'
    })
    conn.prepare('UPDATE queue_input_requests SET turn_id=? WHERE session_id=? AND request_id=?')
      .run('legacy-queue-turn', session.id, 'legacy-queue-1')
    restoreLegacyV54Schema(db)

    const messagesBefore = conn.prepare(`SELECT id,content,status,sequence FROM messages
      WHERE id IN (?,?) ORDER BY sequence`).all(first.persisted.message.id, second.persisted.message.id)
    const receiptsBefore = conn.prepare(`SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state
      FROM queue_input_requests WHERE session_id=? ORDER BY request_id`).all(session.id)

    runMigrations(conn)

    expect(conn.prepare(`SELECT id,content,status,sequence,queue_scope FROM messages
      WHERE id IN (?,?) ORDER BY sequence`).all(first.persisted.message.id, second.persisted.message.id)).toEqual([
      { ...(messagesBefore[0] as object), queue_scope: 'desktop' },
      { ...(messagesBefore[1] as object), queue_scope: 'desktop' }
    ])
    expect(conn.prepare(`SELECT session_id,request_id,fingerprint,queued_message_id,turn_id,state,queue_scope
      FROM queue_input_requests WHERE session_id=? ORDER BY request_id`).all(session.id)).toEqual([
      ...(receiptsBefore as Array<Record<string, unknown>>).map((receipt) => ({ ...receipt, queue_scope: 'desktop' }))
    ])
    expect(conn.prepare('SELECT turn_id,session_id,user_message_id,assistant_message_id,state FROM turns WHERE turn_id=?').get('legacy-queue-turn'))
      .toMatchObject({ turn_id: 'legacy-queue-turn', session_id: session.id, user_message_id: first.persisted.message.id, assistant_message_id: 'legacy-queue-assistant', state: 'prepared' })
    db.close()
  })
})

it('rolls back queue scope DDL and version when legacy backfill fails', () => {
  const db = createMemoryAppDb()
  const conn = getDbConnection(db)
  const session = createSession(db, { name: 'queue-scope-backfill-rollback' })
  const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'rollback-queue', content: 'preserved payload' })
  restoreLegacyV54Schema(db)
  conn.exec(`CREATE TRIGGER reject_legacy_queue_scope_backfill
    BEFORE UPDATE ON messages WHEN OLD.id='${queued.persisted.message.id}'
    BEGIN SELECT RAISE(ABORT, 'injected queue scope backfill failure'); END`)

  expect(() => runMigrations(conn)).toThrow('injected queue scope backfill failure')
  expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '54' })
  expect(conn.prepare('SELECT content,status FROM messages WHERE id=?').get(queued.persisted.message.id))
    .toEqual({ content: 'preserved payload', status: 'queued' })
  expect(conn.prepare('PRAGMA table_info(messages)').all()).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'queue_scope' })
  ]))
  db.close()
})

it('can rerun the migration without duplicating indexes or changing queued data', () => {
  const db = createMemoryAppDb()
  const conn = getDbConnection(db)
  const session = createSession(db, { name: 'queue-scope-rerun' })
  const queued = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'rerun-queue', content: 'repeat safely' })
  restoreLegacyV54Schema(db)

  runMigrations(conn)
  runMigrations(conn)

  expect(conn.prepare('SELECT queue_scope,content,status FROM messages WHERE id=?').get(queued.persisted.message.id))
    .toEqual({ queue_scope: 'desktop', content: 'repeat safely', status: 'queued' })
  expect(conn.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_messages_queue_scope_status_order'").get())
    .toEqual({ count: 1 })
  expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
  db.close()
})
