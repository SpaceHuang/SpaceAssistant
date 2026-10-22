import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { SCHEMA_META_KEYS } from './schema'

describe('session API eligibility retirement migration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('drops the legacy table and strips its invalidation statement while preserving the rest of existing triggers', () => {
    db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TABLE migration_probe(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO migration_probe VALUES(1,'before');
      CREATE TABLE legacy_source(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO legacy_source VALUES(1,'before');
      CREATE TRIGGER migration_probe_legacy_api_fence AFTER UPDATE ON legacy_source BEGIN
        UPDATE migration_probe SET value='after' WHERE id=NEW.id;
        DELETE FROM canonical_session_api_context_eligibility WHERE session_id='legacy-test';
      END;`)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('111', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_session_api_context_eligibility'").get()).toBeUndefined()
    const trigger = conn.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='migration_probe_legacy_api_fence'").get() as { sql: string } | undefined
    expect(trigger?.sql).toContain("UPDATE migration_probe SET value='after'")
    expect(trigger?.sql).not.toContain('canonical_session_api_context_eligibility')
    expect(conn.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND sql LIKE '%canonical_session_api_context_eligibility%'").get())
      .toEqual({ count: 0 })
    conn.prepare("UPDATE legacy_source SET value='changed' WHERE id=1").run()
    expect(conn.prepare('SELECT value FROM migration_probe WHERE id=1').get()).toEqual({ value: 'after' })
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '113' })

    conn.exec('CREATE TABLE canonical_session_api_context_eligibility(session_id TEXT PRIMARY KEY)')
    runMigrations(conn)
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_session_api_context_eligibility'").get()).toBeUndefined()
  })
})
