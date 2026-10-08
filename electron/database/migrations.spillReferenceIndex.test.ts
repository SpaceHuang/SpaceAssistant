import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations, DatabaseUpgradeRequiredError } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

describe('spill reference index migration', () => {
  it('creates private live, staging, maintenance state and lease tables idempotently', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema_version','53');")
    runMigrations(conn)
    const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name)
    expect(tables).toEqual(expect.arrayContaining(['spill_reference_index', 'spill_reference_staging', 'spill_reference_backfill_state', 'spill_reference_maintenance_lease', 'spill_reference_meta']))
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('rejects databases from a future schema floor', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema_version','${DB_SCHEMA_VERSION + 1}');`)
    expect(() => runMigrations(conn)).toThrow(DatabaseUpgradeRequiredError)
    conn.close()
  })

  it('does not advance the schema floor when the migration transaction fails', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version','53'); CREATE TABLE spill_reference_index(x);`)
    expect(() => runMigrations(conn)).toThrow()
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '53' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spill_reference_meta'").get()).toBeUndefined()
    conn.close()
  })
})
