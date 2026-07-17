import { describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import { getSchemaMeta } from '../database/sqliteStore'
import { SCHEMA_META_KEYS } from '../database/schema'

describe('artifact database migrations', () => {
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
})
