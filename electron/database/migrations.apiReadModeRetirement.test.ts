import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { SCHEMA_META_KEYS } from './schema'
import { createSession } from './operations'
import { openDatabase } from './index'

describe('api_read_mode retirement migration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('removes the marker and rewrites dependent triggers without dropping their source guards', () => {
    db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const existing = createSession(db, { name: 'api marker retirement', model: 'test' })
    conn.exec("ALTER TABLE session_message_content_cutover ADD COLUMN api_read_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(api_read_mode IN ('legacy','canonical','revalidation-required'))")
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id=?").run(existing.id)
    conn.exec(`DROP TRIGGER invalidate_session_projection_after_content_revision;
      CREATE TRIGGER invalidate_session_projection_after_content_revision
      AFTER UPDATE OF session_generation,message_revision,api_read_mode,write_mode,cleanup_state ON session_message_content_cutover
      WHEN OLD.session_generation IS NOT NEW.session_generation OR OLD.message_revision IS NOT NEW.message_revision OR
        OLD.api_read_mode IS NOT NEW.api_read_mode OR OLD.write_mode IS NOT NEW.write_mode OR OLD.cleanup_state IS NOT NEW.cleanup_state
      BEGIN
        UPDATE session_projection_state SET status='invalid',history_watermark_json=NULL,message_revision=NULL,
          source_identity_json=NULL,payload_generation=NULL,payload_digest=NULL,validated_range_json=NULL,
          process_generation=NULL,rebuild_token=NULL,failure_case_json=NULL,attempts=0,retry_after=NULL,updated_at=NEW.updated_at
          WHERE session_id=NEW.session_id;
        DELETE FROM session_projection_cache WHERE session_id=NEW.session_id;
        UPDATE session_message_content_cutover SET api_read_mode='revalidation-required',message_revision=message_revision+1,
          updated_at=NEW.updated_at+1 WHERE session_id=NEW.session_id;
      END;`)
    conn.prepare(`INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,history_watermark_json,
      message_revision,payload_generation,payload_digest,validated_range_json,source_identity_json,attempts,updated_at)
      VALUES(?,?,?,'valid','[]',0,'payload','digest','{}','{}',0,1)`).run(existing.id, 'scope:test', existing.generation)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('114', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    const columns = conn.prepare('PRAGMA table_info(session_message_content_cutover)').all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).not.toContain('api_read_mode')
    expect(conn.prepare('SELECT message_revision,write_mode,cleanup_state,updated_at FROM session_message_content_cutover WHERE session_id=?').get(existing.id))
      .toMatchObject({ message_revision: 0, write_mode: 'legacy', cleanup_state: 'retained', updated_at: expect.any(Number) })
    const triggers = conn.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string; sql: string }>
    expect(triggers.some(({ name }) => name === 'invalidate_session_projection_after_content_revision')).toBe(true)
    expect(triggers.some(({ sql }) => sql.includes('api_read_mode'))).toBe(false)
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '115' })
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical',updated_at=2 WHERE session_id=?").run(existing.id)
    expect(conn.prepare("SELECT status FROM session_projection_state WHERE session_id=? AND scope_key='scope:test'").get(existing.id))
      .toEqual({ status: 'invalid' })
    expect(conn.prepare('SELECT message_revision,write_mode,updated_at FROM session_message_content_cutover WHERE session_id=?').get(existing.id))
      .toEqual({ message_revision: 1, write_mode: 'canonical', updated_at: 3 })

    const next = createSession(db, { name: 'api marker retirement after migration', model: 'test' })
    expect(conn.prepare('SELECT session_generation,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get(next.id))
      .toMatchObject({ session_generation: next.generation, write_mode: 'legacy', cleanup_state: 'retained' })
  })

  it('does not recreate the retired column when reopening an upgraded database', () => {
    const temp = createTempDatabase('api-read-mode-reopen-')
    let reopened: ReturnType<typeof openDatabase> | undefined
    try {
      temp.db.close()
      reopened = openDatabase(temp.dbPath)
      const columns = getDbConnection(reopened).prepare('PRAGMA table_info(session_message_content_cutover)').all() as Array<{ name: string }>
      expect(columns.map(({ name }) => name)).not.toContain('api_read_mode')
      expect(getDbConnection(reopened).prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion))
        .toEqual({ value: '115' })
    } finally {
      reopened?.close()
      temp.cleanup()
    }
  })
})
