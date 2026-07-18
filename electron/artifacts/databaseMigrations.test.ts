import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import { getSchemaMeta } from '../database/sqliteStore'
import { SCHEMA_META_KEYS } from '../database/schema'
import { runMigrations } from '../database/migrations'

describe('artifact database migrations', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates v2 artifact tables and indexes for a new database', () => {
    const db = openSqliteDatabase(':memory:')
    const conn = getDbConnection(db)
    const schemaVersion = getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    const indexes = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>

    expect(schemaVersion).toBe('2')
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'session_artifacts',
      'artifact_references',
      'artifact_operations'
    ]))
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      'idx_artifacts_active_path',
      'idx_artifacts_session_container',
      'idx_artifacts_package'
    ]))
    db.close()
  })

  it('upgrades a v1 database to v2 in one startup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-artifact-v1-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const legacy = openSqliteDatabase(dbPath)
    const legacyConn = getDbConnection(legacy)
    legacyConn.exec(`
      DROP TABLE IF EXISTS artifact_references;
      DROP TABLE IF EXISTS artifact_operations;
      DROP TABLE IF EXISTS session_artifacts;
    `)
    legacyConn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('1', SCHEMA_META_KEYS.schemaVersion)
    legacy.close()

    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)

    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('2')
    expect(
      conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_artifacts'").get()
    ).toBeTruthy()
    db.close()
  })

  it('keeps v2 and does not duplicate indexes on a repeated startup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-artifact-repeat-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    openSqliteDatabase(dbPath).close()
    const repeated = openSqliteDatabase(dbPath)
    const conn = getDbConnection(repeated)

    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('2')
    expect(
      (conn.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_artifacts_active_path'").get() as { count: number }).count
    ).toBe(1)
    repeated.close()
  })

  it('rejects a database created by a newer application version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-artifact-newer-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const older = openSqliteDatabase(dbPath)
    getDbConnection(older).prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('3', SCHEMA_META_KEYS.schemaVersion)
    older.close()

    expect(() => openSqliteDatabase(dbPath)).toThrow(/请升级应用/)
  })

  it('rolls back DDL and schema version when a migration fails', () => {
    const db = openSqliteDatabase(':memory:')
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE artifact_references; DROP TABLE artifact_operations; DROP TABLE session_artifacts;')
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('1', SCHEMA_META_KEYS.schemaVersion)

    expect(() => runMigrations(conn, { v2Sql: 'CREATE TABLE rollback_probe (id INTEGER); NOT VALID SQL;' })).toThrow()
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('1')
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'").get()).toBeUndefined()
    db.close()
  })
})
