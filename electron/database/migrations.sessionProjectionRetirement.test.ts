import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { SCHEMA_META_KEYS } from './schema'

describe('session projection legacy retirement migration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('retires legacy tables and removes only their statements from existing triggers', () => {
    db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TABLE migration_probe(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO migration_probe VALUES(1,'before');
      CREATE TABLE legacy_source(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO legacy_source VALUES(1,'before');
      CREATE TRIGGER migration_probe_legacy_projection AFTER UPDATE ON legacy_source BEGIN
        UPDATE migration_probe SET value='after;still' WHERE id=NEW.id;
        DELETE FROM canonical_session_projection_eligibility WHERE session_id='legacy;test';
        DELETE FROM canonical_session_projection_rejections WHERE session_id='legacy-test';
      END;`)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('112', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    for (const table of ['canonical_session_projection_eligibility', 'canonical_session_projection_rejections']) {
      expect(conn.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)).toBeUndefined()
      expect(conn.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type=? AND sql LIKE ?').get('trigger', `%${table}%`))
        .toEqual({ count: 0 })
    }
    const trigger = conn.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='migration_probe_legacy_projection'").get() as { sql: string } | undefined
    expect(trigger?.sql).toContain("UPDATE migration_probe SET value='after;still'")
    conn.prepare("UPDATE legacy_source SET value='changed' WHERE id=1").run()
    expect(conn.prepare('SELECT value FROM migration_probe WHERE id=1').get()).toEqual({ value: 'after;still' })
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '115' })

    conn.exec('CREATE TABLE canonical_session_projection_eligibility(session_id TEXT PRIMARY KEY)')
    conn.exec('CREATE TABLE canonical_session_projection_rejections(session_id TEXT PRIMARY KEY)')
    runMigrations(conn)
    expect(conn.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('canonical_session_projection_eligibility','canonical_session_projection_rejections')").get())
      .toEqual({ count: 0 })
  })
})
