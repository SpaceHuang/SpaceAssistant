import { describe, expect, it } from 'vitest'
import { createSession } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { SCHEMA_META_KEYS } from './schema'

describe('legacy projection rejection retirement', () => {
  it('drops v112 rejection and eligibility rows while keeping scope state', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const session = createSession(db, { name: 'legacy rejection retirement', model: 'test' })
    conn.exec(`CREATE TABLE canonical_session_projection_rejections(
      session_id TEXT PRIMARY KEY, session_generation TEXT NOT NULL, fingerprint TEXT NOT NULL,
      attempts INTEGER NOT NULL, retry_after INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE canonical_session_projection_eligibility(
        session_id TEXT PRIMARY KEY, session_generation TEXT NOT NULL, validated_at INTEGER NOT NULL);`)
    conn.prepare(`INSERT INTO canonical_session_projection_rejections VALUES(?,?,?,?,?,?)`)
      .run(session.id, session.generation, 'legacy-fingerprint', 2, 100, 1)
    conn.prepare(`INSERT INTO canonical_session_projection_eligibility VALUES(?,?,?)`).run(session.id, session.generation, 1)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('112', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?)")
      .all('canonical_session_projection_eligibility', 'canonical_session_projection_rejections')).toEqual([])
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key=?").get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '113' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_projection_state WHERE session_id=?').get(session.id)).toEqual({ count: 0 })
    db.close()
  })
})
