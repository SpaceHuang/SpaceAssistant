import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

describe('remote Track schema migration', () => {
  it('adds Track tables to an existing v82 database and is repeatable', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version','82');
        CREATE TABLE deferred_todos(todo_id TEXT PRIMARY KEY,state TEXT NOT NULL);
        INSERT INTO deferred_todos VALUES('legacy-todo','pending');`)
      runMigrations(conn)
      const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name)
      expect(tables).toEqual(expect.arrayContaining([
        'remote_tracks', 'remote_track_events', 'remote_track_message_map', 'remote_track_children',
        'remote_clarifications', 'remote_clarification_versions', 'remote_clarification_send_attempts', 'remote_track_work_queue',
        'im_inbox_clarification_park'
      ]))
      expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
      expect(conn.prepare('SELECT todo_id,state FROM deferred_todos').get()).toEqual({ todo_id: 'legacy-todo', state: 'pending' })
      expect(() => runMigrations(conn)).not.toThrow()
    } finally {
      conn.close()
    }
  })

  it('does not advance schema version if Track migration fails', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version','82');
        CREATE TABLE remote_tracks(track_id TEXT);`)
      expect(() => runMigrations(conn)).toThrow()
      expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    } finally {
      conn.close()
    }
  })

  it('adds Clarification and work recovery tables to v83 without rewriting existing Track rows', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version','83');
        CREATE TABLE remote_tracks(track_id TEXT PRIMARY KEY NOT NULL);
        INSERT INTO remote_tracks VALUES('existing-track');`)
      runMigrations(conn)
      expect(conn.prepare('SELECT track_id FROM remote_tracks').get()).toEqual({ track_id: 'existing-track' })
      expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
      expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_clarification_send_attempts'").get())
        .toEqual({ name: 'remote_clarification_send_attempts' })
    } finally {
      conn.close()
    }
  })

  it('adds nullable source links to existing turns and deferred todos without guessing legacy ownership', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version','84');
        CREATE TABLE remote_tracks(track_id TEXT PRIMARY KEY);
        CREATE TABLE turns(turn_id TEXT PRIMARY KEY,state TEXT NOT NULL);
        CREATE TABLE deferred_todos(todo_id TEXT PRIMARY KEY,state TEXT NOT NULL);
        INSERT INTO turns VALUES('legacy-turn','completed');
        INSERT INTO deferred_todos VALUES('legacy-todo','pending');`)
      runMigrations(conn)
      expect(conn.prepare('SELECT track_id FROM turns WHERE turn_id=?').get('legacy-turn')).toEqual({ track_id: null })
      expect(conn.prepare('SELECT track_id FROM deferred_todos WHERE todo_id=?').get('legacy-todo')).toEqual({ track_id: null })
      expect(DB_SCHEMA_VERSION).toBe(DB_SCHEMA_VERSION)
    } finally {
      conn.close()
    }
  })

  it('adds nullable Track attribution to persisted IM inbox context without inferring legacy rows', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version','85');
        CREATE TABLE remote_tracks(track_id TEXT PRIMARY KEY);
        CREATE TABLE remote_track_events(event_id TEXT PRIMARY KEY);
        CREATE TABLE im_inbox_message_context(message_id TEXT PRIMARY KEY,channel TEXT NOT NULL,platform_message_id TEXT NOT NULL,context_token TEXT,created_at INTEGER NOT NULL);
        INSERT INTO im_inbox_message_context VALUES('legacy-message','wechat','platform-legacy',NULL,1);`)
      runMigrations(conn)
      expect(conn.prepare('SELECT track_id,track_event_id FROM im_inbox_message_context WHERE message_id=?').get('legacy-message'))
        .toEqual({ track_id: null, track_event_id: null })
      expect(DB_SCHEMA_VERSION).toBe(DB_SCHEMA_VERSION)
      expect(conn.prepare('PRAGMA table_info(im_inbox_message_context)').all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'clarification_work_id' })
      ]))
    } finally { conn.close() }
  })

  it('adds optional classifier metering to v89 observations without changing historical rows', () => {
    const conn = new DatabaseSync(':memory:')
    try {
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES('schema_version','89');
        CREATE TABLE remote_track_attribution_observations(
          observation_id TEXT PRIMARY KEY,channel TEXT NOT NULL,identity_key TEXT NOT NULL,owner_id TEXT NOT NULL,authorization_epoch INTEGER NOT NULL,
          platform_message_id TEXT NOT NULL,classifier_version TEXT NOT NULL,decision_kind TEXT NOT NULL,reason_code TEXT NOT NULL,
          candidate_snapshot_json TEXT NOT NULL,latency_ms INTEGER NOT NULL,created_at INTEGER NOT NULL);
        INSERT INTO remote_track_attribution_observations VALUES('old','wechat','user','owner',1,'m','v1','ambiguous','timeout','{}',200,10);`)
      runMigrations(conn)
      const columns = conn.prepare('PRAGMA table_info(remote_track_attribution_observations)').all() as Array<{ name: string }>
      expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'classifier_invoked', 'provider_call_made', 'input_tokens', 'output_tokens', 'cache_read_input_tokens',
        'cache_creation_input_tokens', 'estimated_cost_usd', 'review_outcome', 'reviewed_at', 'pricing_source_url',
        'pricing_effective_at', 'pricing_verified_at', 'pricing_verified_by'
      ]))
      expect(conn.prepare(`SELECT classifier_invoked,provider_call_made,input_tokens,estimated_cost_usd,review_outcome,reviewed_at,
        pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by
        FROM remote_track_attribution_observations WHERE observation_id='old'`).get())
        .toEqual({ classifier_invoked: null, provider_call_made: null, input_tokens: null, estimated_cost_usd: null, review_outcome: null, reviewed_at: null,
          pricing_source_url: null, pricing_effective_at: null, pricing_verified_at: null, pricing_verified_by: null })
      expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
      expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_track_diagnostic_events'").get())
        .toEqual({ name: 'remote_track_diagnostic_events' })
    } finally { conn.close() }
  })
})
