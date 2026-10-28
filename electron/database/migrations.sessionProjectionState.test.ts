import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('session projection state schema', () => {
  it('adds empty scope keyed state/cache tables without promoting legacy cache rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-projection-state-v108-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'session.db')
    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)

    // Schema 107 is the frozen P0 baseline. Existing cache data is deliberately untrusted.
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('107', SCHEMA_META_KEYS.schemaVersion)
    conn.prepare(`INSERT INTO canonical_session_projection_cache(
      session_id,cache_key,cache_version,session_generation,session_seq,commit_order,
      watermark_event_id,watermark_invocation_id,event_count,value,updated_at,value_sha256
    ) VALUES('legacy-session','transcript',1,'generation-1',9,12,'old-event','old-invocation',1,'deliberately-wrong',1,'valid-looking-digest')`).run()
    db.close()

    const upgraded = openSqliteDatabase(dbPath)
    const upgradedConn = getDbConnection(upgraded)
    expect(upgradedConn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion))
      .toEqual({ value: String(DB_SCHEMA_VERSION) })

    const columns = (table: string) => (upgradedConn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name)
    expect(columns('session_projection_state')).toEqual(expect.arrayContaining([
      'session_id', 'scope_key', 'session_generation', 'status', 'history_watermark_json',
      'message_revision', 'source_identity_json', 'payload_generation', 'payload_digest', 'validated_range_json',
      'process_generation', 'rebuild_token', 'failure_case_json', 'attempts', 'retry_after', 'updated_at', 'build_checkpoint_json',
    ]))
    expect(columns('session_projection_cache')).toEqual(expect.arrayContaining([
      'session_id', 'scope_key', 'payload_generation', 'source_identity_json', 'payload_digest',
      'inline_payload', 'blob_locator', 'updated_at',
    ]))
    expect(upgradedConn.prepare('SELECT COUNT(*) AS count FROM session_projection_state').get()).toEqual({ count: 0 })
    expect(upgradedConn.prepare('SELECT COUNT(*) AS count FROM session_projection_cache').get()).toEqual({ count: 0 })
    expect(upgradedConn.prepare("SELECT value FROM canonical_session_projection_cache WHERE session_id='legacy-session' AND cache_key='transcript'").get())
      .toEqual({ value: 'deliberately-wrong' })
    expect(upgradedConn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_projection_state_due'").get())
      .toEqual({ name: 'idx_session_projection_state_due' })
    expect(upgradedConn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_projection_state_rebuilding'").get())
      .toEqual({ name: 'idx_session_projection_state_rebuilding' })
    expect((upgradedConn.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'invalidate_session_projection_after_%'").all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining([
        'invalidate_session_projection_after_content_revision',
        'invalidate_session_projection_after_history_event_insert',
        'invalidate_session_projection_after_history_event_update',
        'invalidate_session_projection_after_history_event_delete',
        'invalidate_session_projection_after_history_stream_owner_update',
        'invalidate_session_projection_after_history_stream_delete',
      ]))

    upgraded.close()
    const reopened = openSqliteDatabase(dbPath)
    expect(getDbConnection(reopened).prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion))
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(getDbConnection(reopened).prepare('SELECT COUNT(*) AS count FROM session_projection_state').get()).toEqual({ count: 0 })
    reopened.close()
  })
})
