import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { openDatabase } from '../database'
import { runMigrations } from '../database/migrations'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from '../database/schema'
import { appendMessage, createSession } from '../database/operations'

describe('runtime trigger migration', () => {
  const databases: ReturnType<typeof createTempDatabase>[] = []
  afterEach(() => { for (const db of databases.splice(0)) db.cleanup() })

  it('creates a runtime trigger table and nullable IM acceptance identity columns on upgrade', () => {
    const database = createTempDatabase('runtime-trigger-migration-')
    databases.push(database)
    const conn = getDbConnection(database.db)
    conn.exec('DROP TABLE runtime_triggers')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_state_due')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_owner_created')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_active_sync_target')
    conn.exec('DROP INDEX IF EXISTS idx_im_inbox_accepted_seq')
    conn.exec('DROP TRIGGER IF EXISTS bump_im_fact_coverage_after_delete')
    conn.exec('DROP TRIGGER IF EXISTS guard_im_fact_identity_immutable')
    for (const column of ['account_id', 'conversation_id', 'sender_id', 'accepted_seq']) conn.exec(`ALTER TABLE im_inbox_message_context DROP COLUMN ${column}`)
    const legacySession = createSession(database.db, { name: 'legacy runtime trigger migration' })
    const legacyMessage = appendMessage(database.db, { id: 'legacy-watermark', sessionId: legacySession.id, role: 'user', content: 'legacy', timestamp: 1, status: 'sent' })
    conn.prepare(`INSERT INTO im_inbox_message_context(message_id,channel,platform_message_id,context_token,created_at,track_id,track_event_id,clarification_work_id)
      VALUES(?,?,?,?,?,NULL,NULL,NULL)`).run(legacyMessage.message.id, 'feishu', 'legacy-platform', null, 1)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('120', SCHEMA_META_KEYS.schemaVersion)
    runMigrations(conn)
    const version = Number((conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion) as { value: string }).value)
    expect(version).toBe(DB_SCHEMA_VERSION)
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_triggers'").get()).toEqual({ name: 'runtime_triggers' })
    expect(conn.prepare('PRAGMA table_info(im_inbox_message_context)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'account_id', notnull: 0 }), expect.objectContaining({ name: 'conversation_id', notnull: 0 }),
      expect.objectContaining({ name: 'sender_id', notnull: 0 }), expect.objectContaining({ name: 'accepted_seq', notnull: 0 })
    ]))
    expect(conn.prepare('SELECT account_id,conversation_id,sender_id,accepted_seq FROM im_inbox_message_context WHERE message_id=?').get(legacyMessage.message.id))
      .toEqual({ account_id: null, conversation_id: null, sender_id: null, accepted_seq: 1 })
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.imFactNextSeq)).toEqual({ value: '1' })
    expect(() => runMigrations(conn)).not.toThrow()
    expect(conn.prepare('SELECT accepted_seq FROM im_inbox_message_context WHERE message_id=?').get(legacyMessage.message.id)).toEqual({ accepted_seq: 1 })
  })

  it('preserves legacy IM rows as unknown and rolls back every v121 DDL change on failure', () => {
    const database = createTempDatabase('runtime-trigger-migration-rollback-')
    databases.push(database)
    const conn = getDbConnection(database.db)
    conn.exec(`INSERT INTO sessions(id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version)
      VALUES('session-legacy','legacy','test-model',0.2,10,1,1,'{}','{}',1)`)
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,timestamp,status,schema_version,sequence)
      VALUES('legacy-im-fact','session-legacy','user','legacy',1,'sent',1,1)`).run()
    conn.prepare(`INSERT INTO im_inbox_message_context(message_id,channel,platform_message_id,context_token,created_at,track_id,track_event_id,clarification_work_id)
      VALUES('legacy-im-fact','feishu','legacy-platform',NULL,1,NULL,NULL,NULL)`).run()
    conn.exec('DROP TABLE runtime_triggers')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_state_due')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_owner_created')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_active_sync_target')
    conn.exec('DROP INDEX IF EXISTS idx_im_inbox_accepted_seq')
    conn.exec('DROP TRIGGER IF EXISTS bump_im_fact_coverage_after_delete')
    conn.exec('DROP TRIGGER IF EXISTS guard_im_fact_identity_immutable')
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('120', SCHEMA_META_KEYS.schemaVersion)
    for (const column of ['account_id', 'conversation_id', 'sender_id', 'accepted_seq']) conn.exec(`ALTER TABLE im_inbox_message_context DROP COLUMN ${column}`)
    conn.exec(`CREATE TRIGGER reject_migration BEFORE UPDATE OF value ON schema_meta
      WHEN OLD.key='${SCHEMA_META_KEYS.schemaVersion}' AND NEW.value='121'
      BEGIN SELECT RAISE(ABORT,'injected v121 failure'); END`)
    expect(() => runMigrations(conn)).toThrow('injected v121 failure')
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '120' })
    expect(conn.prepare('PRAGMA table_info(im_inbox_message_context)').all()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'account_id' }), expect.objectContaining({ name: 'accepted_seq' })
    ]))
    expect(conn.prepare('SELECT channel,platform_message_id FROM im_inbox_message_context WHERE message_id=?').get('legacy-im-fact'))
      .toEqual({ channel: 'feishu', platform_message_id: 'legacy-platform' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_triggers'").get()).toBeUndefined()
    conn.exec('DROP TRIGGER reject_migration')
    expect(() => runMigrations(conn)).not.toThrow()
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: String(DB_SCHEMA_VERSION) })
  })

  it('restores a closed whole-database v120 copy after an upgraded copy cannot be used by old code', () => {
    const database = createTempDatabase('runtime-trigger-whole-db-restore-')
    databases.push(database)
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-trigger-backup-'))
    const backupPath = path.join(backupDir, 'before-upgrade.db')
    const conn = getDbConnection(database.db)
    conn.exec('DROP TABLE runtime_triggers')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_state_due')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_owner_created')
    conn.exec('DROP INDEX IF EXISTS idx_runtime_triggers_active_sync_target')
    conn.exec('DROP INDEX IF EXISTS idx_im_inbox_accepted_seq')
    conn.exec('DROP TRIGGER IF EXISTS bump_im_fact_coverage_after_delete')
    conn.exec('DROP TRIGGER IF EXISTS guard_im_fact_identity_immutable')
    for (const column of ['account_id', 'conversation_id', 'sender_id', 'accepted_seq']) conn.exec(`ALTER TABLE im_inbox_message_context DROP COLUMN ${column}`)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('120', SCHEMA_META_KEYS.schemaVersion)
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '120' })
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    database.db.close()
    database.db = { close: () => undefined } as typeof database.db
    fs.copyFileSync(database.dbPath, backupPath)

    const upgraded = openDatabase(database.dbPath)
    expect(Number((getDbConnection(upgraded).prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion) as { value: string }).value))
      .toBe(DB_SCHEMA_VERSION)
    expect(getDbConnection(upgraded).prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_triggers'").get()).toBeTruthy()
    upgraded.close()

    // Rollback is replacement from the closed, consistent whole-database copy, never schema surgery.
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${database.dbPath}${suffix}`, { force: true })
    fs.copyFileSync(backupPath, database.dbPath)
    const restoredConn = new DatabaseSync(database.dbPath)
    expect(restoredConn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '120' })
    expect(restoredConn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_triggers'").get()).toBeUndefined()
    restoredConn.close()
    database.db = { close: () => undefined } as typeof database.db
    fs.rmSync(backupDir, { recursive: true, force: true })
  })
})
