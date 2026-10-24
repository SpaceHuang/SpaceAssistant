import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { SCHEMA_META_KEYS } from './schema'

describe('invocation pending view retirement migration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('drops the unused persisted pending view when upgrading the current schema', () => {
    db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec(`CREATE TABLE canonical_invocation_pending_views (
      invocation_id TEXT PRIMARY KEY NOT NULL,pending_json TEXT NOT NULL,stream_version INTEGER NOT NULL,updated_at INTEGER NOT NULL
    )`)
    conn.prepare(`INSERT INTO canonical_invocation_pending_views(invocation_id,pending_json,stream_version,updated_at)
      VALUES('retired-invocation','{}',1,1)`).run()
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('113', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_invocation_pending_views'").get()).toBeUndefined()
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '114' })
  })
})
