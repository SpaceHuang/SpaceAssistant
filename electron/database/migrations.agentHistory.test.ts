import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

describe('agent canonical history migration', () => {
  it('v51 adds a durable cancellation marker to migration runs without changing existing run or item data', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','51');
      CREATE TABLE session_projection_migration_runs (
        run_id TEXT PRIMARY KEY NOT NULL, inventory_sha256 TEXT NOT NULL, inventory_data_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','paused','needs_retry','needs_attention','completed')),
        after_session_id TEXT,total_count INTEGER NOT NULL,migrated_count INTEGER NOT NULL DEFAULT 0,
        legacy_required_count INTEGER NOT NULL DEFAULT 0,deleted_count INTEGER NOT NULL DEFAULT 0,
        deferred_count INTEGER NOT NULL DEFAULT 0,retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,database_session_count INTEGER NOT NULL DEFAULT 0,
        migration_session_count INTEGER NOT NULL DEFAULT 0,excluded_internal_hidden_session_count INTEGER NOT NULL DEFAULT 0,
        internal_history_session_count INTEGER NOT NULL DEFAULT 0,internal_history_with_events_count INTEGER NOT NULL DEFAULT 0,
        internal_history_healthy_count INTEGER NOT NULL DEFAULT 0,internal_history_sha256 TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX idx_session_projection_migration_single_active
        ON session_projection_migration_runs(status) WHERE status IN ('running','paused','needs_retry');
      CREATE TABLE session_projection_migration_items(run_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,
        PRIMARY KEY(run_id,session_id));
      INSERT INTO session_projection_migration_runs(run_id,inventory_sha256,inventory_data_version,status,total_count,created_at,updated_at)
        VALUES('existing-run','abc',1,'paused',1,2,3);
      INSERT INTO session_projection_migration_items(run_id,session_id,status) VALUES('existing-run','s1','pending');`)

    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('SELECT run_id,status,cancelled_at FROM session_projection_migration_runs').get())
      .toEqual({ run_id: 'existing-run', status: 'paused', cancelled_at: null })
    expect(conn.prepare('SELECT run_id,session_id,status FROM session_projection_migration_items').get())
      .toEqual({ run_id: 'existing-run', session_id: 's1', status: 'pending' })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('v46-v50 add durable session projection storage, scope summary, and recovery work tables idempotently', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); INSERT INTO schema_meta(key,value) VALUES('schema_version','46');")
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_projection_migration_runs'").get()).toEqual({ name: 'session_projection_migration_runs' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_history_recovery_work'").get())
      .toEqual({ name: 'canonical_history_recovery_work' })
    expect(conn.prepare("SELECT status FROM canonical_history_recovery_work_migration WHERE migration_key='active-invocations-v1'").get())
      .toEqual({ status: 'pending' })
    expect(conn.prepare('PRAGMA table_info(session_projection_migration_runs)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'database_session_count' }),
      expect.objectContaining({ name: 'migration_session_count' }),
      expect.objectContaining({ name: 'excluded_internal_hidden_session_count' }),
      expect.objectContaining({ name: 'internal_history_session_count' }),
      expect.objectContaining({ name: 'internal_history_with_events_count' }),
      expect.objectContaining({ name: 'internal_history_healthy_count' }),
      expect.objectContaining({ name: 'internal_history_sha256' })
    ]))
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('v50 adds optional usage model identity columns without rewriting existing facts', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','50');
      CREATE TABLE usage_step_facts(id INTEGER PRIMARY KEY,session_id TEXT,turn_id TEXT,step_id TEXT,created_at INTEGER,day TEXT,model TEXT,llm_service_id TEXT,app_version TEXT);
      CREATE TABLE usage_turn_facts(turn_id TEXT PRIMARY KEY,session_id TEXT,created_at INTEGER,day TEXT,model TEXT,llm_service_id TEXT,app_version TEXT);
      INSERT INTO usage_step_facts(id,session_id,turn_id,step_id,created_at,day,model,llm_service_id,app_version)
        VALUES(1,'s','t','step',1,'2026-10-05','model-name','service','0.2.3');
      INSERT INTO usage_turn_facts(turn_id,session_id,created_at,day,model,llm_service_id,app_version)
        VALUES('t','s',1,'2026-10-05','model-name','service','0.2.3');`)
    runMigrations(conn)
    const stepColumns = new Set((conn.prepare('PRAGMA table_info(usage_step_facts)').all() as Array<{ name: string }>).map(({ name }) => name))
    const turnColumns = new Set((conn.prepare('PRAGMA table_info(usage_turn_facts)').all() as Array<{ name: string }>).map(({ name }) => name))
    for (const name of ['model_id', 'provider_model_name', 'route_identity']) {
      expect(stepColumns.has(name)).toBe(true)
      expect(turnColumns.has(name)).toBe(true)
    }
    expect(conn.prepare('SELECT model,llm_service_id,app_version,model_id FROM usage_step_facts').get())
      .toEqual({ model: 'model-name', llm_service_id: 'service', app_version: '0.2.3', model_id: null })
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('upgrades a file-backed storage v46 profile through v52 and preserves existing usage facts after reopen', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceassistant-storage-v46-migration-'))
    const databasePath = path.join(root, 'session.sqlite')
    try {
      const conn = new DatabaseSync(databasePath)
      conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
        INSERT INTO schema_meta(key,value) VALUES('schema_version','46');
        CREATE TABLE usage_step_facts(id INTEGER PRIMARY KEY,session_id TEXT,turn_id TEXT,step_id TEXT,created_at INTEGER,day TEXT,model TEXT,llm_service_id TEXT,app_version TEXT);
        CREATE TABLE usage_turn_facts(turn_id TEXT PRIMARY KEY,session_id TEXT,created_at INTEGER,day TEXT,model TEXT,llm_service_id TEXT,app_version TEXT);
        INSERT INTO usage_step_facts(id,session_id,turn_id,step_id,created_at,day,model,llm_service_id,app_version)
          VALUES(1,'s','t','step',1,'2026-10-05','model-name','service','0.2.3');
        INSERT INTO usage_turn_facts(turn_id,session_id,created_at,day,model,llm_service_id,app_version)
          VALUES('t','s',1,'2026-10-05','model-name','service','0.2.3');`)
      expect(() => runMigrations(conn)).not.toThrow()
      conn.close()

      const reopened = new DatabaseSync(databasePath)
      try {
        expect(reopened.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
          .toEqual({ value: String(DB_SCHEMA_VERSION) })
        expect(reopened.prepare('SELECT model,llm_service_id,app_version,model_id,provider_model_name,route_identity FROM usage_step_facts').get())
          .toEqual({ model: 'model-name', llm_service_id: 'service', app_version: '0.2.3', model_id: null, provider_model_name: null, route_identity: null })
        expect(reopened.prepare('SELECT model,llm_service_id,app_version,model_id,provider_model_name,route_identity FROM usage_turn_facts').get())
          .toEqual({ model: 'model-name', llm_service_id: 'service', app_version: '0.2.3', model_id: null, provider_model_name: null, route_identity: null })
        expect(reopened.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
        expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(() => runMigrations(reopened)).not.toThrow()
      } finally {
        reopened.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('v49 installs recovery work triggers without scanning existing history during schema migration', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','49');
      CREATE TABLE agent_history_streams(invocation_id TEXT PRIMARY KEY NOT NULL,version INTEGER NOT NULL,schema_version INTEGER NOT NULL,session_id TEXT);
      CREATE TABLE agent_history_events(invocation_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,turn_id TEXT NOT NULL,schema_version INTEGER NOT NULL,kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(invocation_id,sequence));
      INSERT INTO agent_history_streams VALUES('existing-terminal',1,1,'session-terminal');
      INSERT INTO agent_history_events VALUES('existing-terminal',1,'terminal','terminal-key','turn',1,'invocation-completed','{"status":"completed"}',1);`)

    runMigrations(conn)

    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([])
    expect(conn.prepare("SELECT status FROM canonical_history_recovery_work_migration WHERE migration_key='active-invocations-v1'").get())
      .toEqual({ status: 'pending' })
    const triggerNames = (conn.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%history_recovery_work%'`).all() as Array<{ name: string }>)
      .map(({ name }) => name)
    expect(triggerNames).toEqual(expect.arrayContaining([
      'add_history_recovery_work_for_new_stream', 'refresh_history_recovery_work_for_stream_update',
      'remove_history_recovery_work_for_stream_delete', 'refresh_history_recovery_work_for_event_insert',
      'refresh_history_recovery_work_for_event_update', 'refresh_history_recovery_work_for_event_delete'
    ]))

    conn.prepare('INSERT INTO agent_history_streams VALUES(?,?,?,?)').run('new-invocation', 1, 1, 'new-session')
    conn.prepare(`INSERT INTO agent_history_events(
      invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run('new-invocation', 1, 'start', 'start-key', 'new-turn', 1, 'tool-call-started', '{}', 1)
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([{ invocation_id: 'new-invocation' }])

    conn.prepare(`INSERT INTO agent_history_events(
      invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run('new-invocation', 2, 'terminal', 'terminal-key', 'new-turn', 1, 'invocation-completed', '{"status":"completed"}', 2)
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([{ invocation_id: 'new-invocation' }])
    conn.prepare('UPDATE agent_history_streams SET version=2 WHERE invocation_id=?').run('new-invocation')
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([])

    conn.prepare("UPDATE agent_history_events SET kind='tool-call-started' WHERE invocation_id='new-invocation' AND sequence=2").run()
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([{ invocation_id: 'new-invocation' }])
    conn.prepare("UPDATE agent_history_streams SET session_id='renamed-session' WHERE invocation_id='new-invocation'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_history_recovery_work WHERE invocation_id=?').get('new-invocation'))
      .toEqual({ session_id: 'renamed-session' })
    conn.prepare("DELETE FROM agent_history_events WHERE invocation_id='new-invocation' AND sequence=2").run()
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([{ invocation_id: 'new-invocation' }])
    conn.prepare('DELETE FROM agent_history_streams WHERE invocation_id=?').run('new-invocation')
    expect(conn.prepare('SELECT invocation_id FROM canonical_history_recovery_work').all()).toEqual([])
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('v47 assigns safe legacy policy metadata to existing queue rows', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','47');
      CREATE TABLE session_projection_migration_items(
        run_id TEXT NOT NULL,session_id TEXT NOT NULL,source_disposition TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,updated_at INTEGER NOT NULL,
        PRIMARY KEY(run_id,session_id));
      INSERT INTO session_projection_migration_items VALUES('run','legacy-session','legacy_required','legacy_required','legacy-mismatch',123);`)
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare(`SELECT legacy_owner,legacy_decision,legacy_user_behavior,legacy_decided_at
      FROM session_projection_migration_items WHERE session_id='legacy-session'`).get()).toEqual({
      legacy_owner: 'session-storage-refactor-maintainers', legacy_decision: 'retain-legacy',
      legacy_user_behavior: 'legacy-reader-retain-source', legacy_decided_at: 123
    })
    conn.close()
  })

  it('v49 fences active pre-scope inventories instead of resuming an unauditable cohort', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','48');
      CREATE TABLE session_projection_migration_runs(
        run_id TEXT PRIMARY KEY, inventory_sha256 TEXT NOT NULL, inventory_data_version INTEGER NOT NULL,
        status TEXT NOT NULL, after_session_id TEXT, total_count INTEGER NOT NULL,
        migrated_count INTEGER NOT NULL DEFAULT 0, legacy_required_count INTEGER NOT NULL DEFAULT 0,
        deleted_count INTEGER NOT NULL DEFAULT 0, deferred_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO session_projection_migration_runs(run_id,inventory_sha256,inventory_data_version,status,total_count,created_at,updated_at)
        VALUES('old-active','old-hash',1,'running',4,1,1);`)

    runMigrations(conn)
    expect(conn.prepare('SELECT status,database_session_count,internal_history_sha256 FROM session_projection_migration_runs WHERE run_id=?')
      .get('old-active')).toEqual({ status: 'needs_attention', database_session_count: -1, internal_history_sha256: '' })
    conn.close()
  })

  it('v36 installs fail-closed transcript eligibility invalidation triggers', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','36');
      CREATE TABLE sessions(id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT, content TEXT NOT NULL,
        tool_use TEXT, tool_calls TEXT, thinking TEXT, content_segments TEXT, skill_hints TEXT,
        attachments TEXT, images_delivered_to_api INTEGER, status TEXT, schema_version INTEGER,
        timestamp INTEGER, sequence INTEGER);
      CREATE TABLE agent_history_streams(invocation_id TEXT PRIMARY KEY NOT NULL, session_id TEXT, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_history_events(invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 1, event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'input', session_id TEXT, payload_json TEXT NOT NULL);
      INSERT INTO sessions(id,generation) VALUES('s','generation-1');
      INSERT INTO messages(id,session_id,content) VALUES('m','s','body');`)

    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    const markEligible = conn.prepare('INSERT OR REPLACE INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,?)')
    expect(conn.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'invalidate_session_projection_after_message_%'`).all()).toHaveLength(3)

    markEligible.run('s', 'generation-1', 1)
    conn.prepare("UPDATE messages SET content='changed' WHERE id='m'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    markEligible.run('s', 'generation-1', 2)
    conn.prepare("INSERT INTO messages(id,session_id,content) VALUES('m2','s','new')").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    markEligible.run('s', 'generation-1', 3)
    conn.prepare("DELETE FROM messages WHERE id='m2'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    conn.close()
  })

  it('v41 invalidates detached transcript cache on direct History event or stream mutation', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','41');
      CREATE TABLE agent_history_streams (invocation_id TEXT PRIMARY KEY NOT NULL, session_id TEXT, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_history_events (invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 1, event_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'input', session_id TEXT, payload_json TEXT NOT NULL);
      CREATE TABLE canonical_session_projection_cache (session_id TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,cache_key));
      INSERT INTO agent_history_streams(invocation_id,session_id) VALUES('inv','session-a');
      INSERT INTO agent_history_events(invocation_id,event_id,session_id,payload_json) VALUES('inv','event','session-a','{}');
      INSERT INTO canonical_session_projection_cache(session_id,cache_key,value) VALUES('session-a','transcript','[]');`)

    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('SELECT value FROM canonical_session_projection_cache').all()).toEqual([])

    conn.prepare("UPDATE agent_history_events SET payload_json='{}' WHERE event_id='event'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_cache').all()).toEqual([])
    conn.prepare("INSERT INTO canonical_session_projection_cache(session_id,cache_key,value) VALUES('session-a','transcript','[]')").run()
    conn.prepare("DELETE FROM agent_history_events WHERE event_id='event'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_cache').all()).toEqual([])
    conn.prepare("INSERT INTO agent_history_events(invocation_id,event_id,session_id,payload_json) VALUES('inv','event-2','session-a','{}')").run()
    conn.prepare("INSERT INTO canonical_session_projection_cache(session_id,cache_key,value) VALUES('session-a','transcript','[]')").run()
    conn.prepare("UPDATE agent_history_streams SET session_id='session-b' WHERE invocation_id='inv'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_cache').all()).toEqual([])

    conn.prepare("INSERT INTO canonical_session_projection_cache(session_id,cache_key,value) VALUES('session-b','transcript','[]')").run()
    conn.prepare("DELETE FROM agent_history_streams WHERE invocation_id='inv'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_cache').all()).toEqual([])
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('v42 adds transcript cache checksums and discards cache rows created before checksums existed', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','42');
      CREATE TABLE canonical_session_projection_cache (session_id TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(session_id,cache_key));
      INSERT INTO canonical_session_projection_cache(session_id,cache_key,value) VALUES('session-a','transcript','[]');`)

    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('PRAGMA table_info(canonical_session_projection_cache)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'value_sha256', dflt_value: "''" })]))
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_cache').all()).toEqual([])
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('backfills deterministic global and per-session order while preserving unknown owners as ineligible', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec('CREATE TABLE agent_history_streams (invocation_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, schema_version INTEGER NOT NULL, session_id TEXT)')
    conn.exec(`CREATE TABLE agent_history_events (
      invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(invocation_id, sequence), UNIQUE(invocation_id, event_id), UNIQUE(invocation_id, idempotency_key)
    )`)
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '31')
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, ?, 1, ?)').run('inv-a', 2, 'session-a')
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)').run('inv-b', 'session-a')
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)').run('inv-orphan', null)
    const insert = conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at)
      VALUES(?, ?, ?, ?, ?, 1, 'session-input-committed', '{}', ?)`)
    insert.run('inv-a', 1, 'a-1', 'a-1', 'turn-a', 100)
    insert.run('inv-a', 2, 'a-2', 'a-2', 'turn-a', 200)
    insert.run('inv-b', 1, 'b-1', 'b-1', 'turn-b', 100)
    insert.run('inv-orphan', 1, 'orphan-1', 'orphan-1', 'turn-orphan', 50)

    runMigrations(conn)

    expect(conn.prepare(`SELECT invocation_id, sequence, session_id, commit_order, session_seq
      FROM agent_history_events ORDER BY commit_order`).all()).toEqual([
      { invocation_id: 'inv-orphan', sequence: 1, session_id: null, commit_order: 1, session_seq: null },
      { invocation_id: 'inv-a', sequence: 1, session_id: 'session-a', commit_order: 2, session_seq: 1 },
      { invocation_id: 'inv-b', sequence: 1, session_id: 'session-a', commit_order: 3, session_seq: 2 },
      { invocation_id: 'inv-a', sequence: 2, session_id: 'session-a', commit_order: 4, session_seq: 3 }
    ])
    expect(conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get('session-a')).toEqual({ next_seq: 3 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM agent_history_commit_cursor').get()).toEqual({ count: 4 })
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    conn.close()
  })

  it('upgrades schema v30 through the projection repair queue and event-order cursor', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '30')
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare("SELECT status, after_invocation_id FROM canonical_projection_repair_migration WHERE migration_key='legacy-classification-v1'").get()).toEqual({ status: 'pending', after_invocation_id: null })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('assigns a fresh stable generation to every existing session and does not rotate it on rerun', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL);`)
    conn.prepare("INSERT INTO schema_meta(key, value) VALUES('schema_version', '32')").run()
    conn.prepare('INSERT INTO sessions(id) VALUES (?)').run('old-session')
    runMigrations(conn)
    const first = conn.prepare('SELECT generation FROM sessions WHERE id=?').get('old-session') as { generation: string }
    expect(first.generation).toMatch(/^[a-f0-9]{32}$/)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    runMigrations(conn)
    expect(conn.prepare('SELECT generation FROM sessions WHERE id=?').get('old-session')).toEqual(first)
    conn.close()
  })

  it('invalidates old projection cache values when upgrading v33 to v34', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version', '33');
      CREATE TABLE canonical_session_projection_cache (
        session_id TEXT NOT NULL, cache_key TEXT NOT NULL, session_generation TEXT NOT NULL, session_seq INTEGER NOT NULL,
        commit_order INTEGER NOT NULL, watermark_event_id TEXT, watermark_invocation_id TEXT, event_count INTEGER NOT NULL,
        value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, cache_key));
      INSERT INTO canonical_session_projection_cache VALUES('s','transcript','generation',1,1,'event','invocation',1,'[]',1);`)
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('SELECT cache_version FROM canonical_session_projection_cache').all()).toEqual([])
    expect((conn.prepare("PRAGMA table_info(canonical_session_projection_cache)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain('cache_version')
    conn.close()
  })

  it('adds compact session turn commit receipts when upgrading v34', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version', '34');`)
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect((conn.prepare('PRAGMA table_info(session_turn_commit_receipts)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(['session_id', 'turn_id', 'payload_sha256', 'base_version', 'next_version', 'outcome', 'event_start', 'event_end', 'created_at'])
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    conn.close()
  })

  it('adds transcript-committed execution state when upgrading v35 and preserves claim and queue rows', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version', '35');
      CREATE TABLE session_execution_claims (
        session_id TEXT PRIMARY KEY NOT NULL, turn_id TEXT NOT NULL, owner_id TEXT NOT NULL, generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','claimed','executing','commit_uncertain')), enqueued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE session_execution_queue (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, owner_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('queued','claimed','executing','commit_uncertain')), enqueued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id,turn_id));
      CREATE INDEX idx_session_execution_queue_order ON session_execution_queue(session_id,status,enqueued_at,turn_id);
      INSERT INTO session_execution_claims VALUES('s','t','owner',2,'executing',1,2);
      INSERT INTO session_execution_queue VALUES('s','t','owner',2,'executing',1,2);`)
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('SELECT * FROM session_execution_claims').get()).toMatchObject({ session_id: 's', turn_id: 't', owner_id: 'owner', status: 'executing', generation: 2 })
    expect(conn.prepare('SELECT * FROM session_execution_queue').get()).toMatchObject({ session_id: 's', turn_id: 't', owner_id: 'owner', status: 'executing', generation: 2 })
    expect(() => conn.prepare("UPDATE session_execution_claims SET status='transcript_committed' WHERE session_id='s'").run()).not.toThrow()
    expect(() => conn.prepare("UPDATE session_execution_queue SET status='transcript_committed' WHERE session_id='s'").run()).not.toThrow()
    conn.close()
  })
  it('drops the unused messages content index while upgrading an existing v30 database', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); CREATE TABLE messages(content TEXT)")
    conn.exec('CREATE INDEX idx_messages_content ON messages(content)')
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '30')
    runMigrations(conn)
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_content'").get()).toBeUndefined()
    conn.close()
  })
  it('commits schema migrations one version at a time when a later migration fails', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec('CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL, start_token TEXT)')
    conn.exec(`CREATE TABLE agent_continuations (
      continuation_id TEXT PRIMARY KEY, source_invocation_id TEXT, source_turn_id TEXT, checkpoint_sequence INTEGER, checkpoint_sha256 TEXT,
      request_idempotency_key TEXT, created_by TEXT, frozen_config_json TEXT, frozen_config_sha256 TEXT,
      target_invocation_id TEXT, target_turn_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER
    )`)
    conn.exec('CREATE TABLE canonical_projection_repairs (incompatible_column TEXT)')
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '29')

    expect(() => runMigrations(conn)).toThrow(/no such column: status/)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '30' })
    expect(conn.prepare('PRAGMA table_info(agent_continuations)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'target_start_token', dflt_value: "''" })
    ]))
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_projection_repair_migration'").get()).toBeUndefined()
    conn.close()
  })
  // 回归（真机打包反馈）：迁移编号重排把 usage attribution 从 v19 挪到 v28、agent_history 插在 v19–21。
  // 被旧编号迁移到 version=19 的库（旧 v19 = usage attribution 列已加、无 agent_history 表）,
  // 在新代码上会于 version===19 执行 V20 的 ALTER 而撞上「no such table: agent_history_streams」。
  it('upgrades a renumber-boundary v19 database (old numbering: usage attribution applied, no agent history tables)', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec('CREATE TABLE usage_step_facts (step_id TEXT PRIMARY KEY NOT NULL, input_tokens INTEGER)')
    conn.exec('CREATE TABLE usage_turn_facts (turn_id TEXT PRIMARY KEY NOT NULL)')
    conn.exec('CREATE TABLE turns (request_id TEXT NOT NULL, session_id TEXT NOT NULL)')
    // 旧 v19 = 用量归因列已加（与现行 V28 逐字相同）
    conn.exec('ALTER TABLE usage_step_facts ADD COLUMN system_tokens INTEGER')
    conn.exec('ALTER TABLE usage_step_facts ADD COLUMN tools_tokens INTEGER')
    conn.exec('ALTER TABLE usage_step_facts ADD COLUMN message_tokens INTEGER')
    conn.exec('ALTER TABLE usage_step_facts ADD COLUMN estimator_version TEXT')
    conn.exec('ALTER TABLE usage_step_facts ADD COLUMN attribution_json TEXT')
    conn.exec('ALTER TABLE usage_turn_facts ADD COLUMN tool_attribution_json TEXT')
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '19')
    conn.prepare('INSERT INTO turns(request_id, session_id) VALUES(?, ?)').run('owned', 'session-a')

    expect(() => runMigrations(conn)).not.toThrow()
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    // agent_history 基表被补建并带上 session_id 列与索引
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_history_streams'").get()).toEqual({ name: 'agent_history_streams' })
    expect((conn.prepare("PRAGMA table_info('agent_history_streams')").all() as Array<{ name: string }>).map(({ name }) => name)).toContain('session_id')
    expect((conn.prepare("PRAGMA index_list('agent_history_streams')").all() as Array<{ name: string }>).map(({ name }) => name)).toContain('idx_agent_history_streams_session')
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_continuations'").get()).toEqual({ name: 'agent_continuations' })
    // 归因列不重复（重跑不抛错）
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('upgrades an existing v24 database with the durable queue, reconciliation audit, and AcceptedTurn ledger', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '24')
    runMigrations(conn)
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_execution_queue'").get()).toEqual({ name: 'session_execution_queue' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_transcript_reconciliations'").get()).toEqual({ name: 'session_transcript_reconciliations' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accepted_turn_contexts'").get()).toEqual({ name: 'accepted_turn_contexts' })
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    conn.close()
  })

  it('backfills legacy History owners only when all evidence identifies exactly one session', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec(`CREATE TABLE agent_history_streams (invocation_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL, session_id TEXT)`)
    conn.exec(`CREATE TABLE agent_history_events (
      invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(invocation_id, sequence), UNIQUE(invocation_id, event_id), UNIQUE(invocation_id, idempotency_key)
    )`)
    conn.exec('CREATE INDEX idx_agent_history_streams_session ON agent_history_streams(session_id, invocation_id)')
    conn.exec('CREATE TABLE turns (request_id TEXT NOT NULL, session_id TEXT NOT NULL)')
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '20')
    for (const id of ['owned', 'ambiguous', 'orphan', 'event-owned', 'conflicting-facts', 'invalid-fact', 'malformed-json']) {
      conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version) VALUES(?, 0, 1)').run(id)
    }
    conn.prepare('INSERT INTO turns(request_id, session_id) VALUES(?, ?)').run('owned', 'session-a')
    conn.prepare('INSERT INTO turns(request_id, session_id) VALUES(?, ?)').run('ambiguous', 'session-a')
    conn.prepare('INSERT INTO turns(request_id, session_id) VALUES(?, ?)').run('ambiguous', 'session-b')
    conn.prepare('INSERT INTO turns(request_id, session_id) VALUES(?, ?)').run('conflicting-facts', 'session-a')
    const insert = conn.prepare('INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at) VALUES(?, 1, ?, ?, ?, 1, ?, ?, 1)')
    insert.run('event-owned', 'input', 'input', 'turn-event-owned', 'session-input-committed', JSON.stringify({ sessionId: 'session-c', messageId: 'user-c', role: 'user', inputFingerprint: 'hash' }))
    insert.run('conflicting-facts', 'terminal', 'terminal', 'turn-conflict', 'invocation-completed', JSON.stringify({ status: 'completed', sessionLedger: { location: { workDir: '/workspace', sessionId: 'session-b', createdAt: 1 } } }))
    insert.run('invalid-fact', 'input', 'input', 'turn-invalid', 'session-input-committed', JSON.stringify({ sessionId: 'session-d', messageId: 'assistant-d', role: 'assistant', inputFingerprint: '' }))
    insert.run('malformed-json', 'input', 'input', 'turn-broken', 'session-input-committed', '{broken')

    runMigrations(conn)

    expect(DB_SCHEMA_VERSION).toBe(82)
    expect(conn.prepare('PRAGMA table_info(turns)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'accepted_input_history_version', dflt_value: '0' })
    ]))
    expect(conn.prepare('SELECT invocation_id, session_id FROM agent_history_streams ORDER BY invocation_id').all()).toEqual([
      { invocation_id: 'ambiguous', session_id: null }, { invocation_id: 'conflicting-facts', session_id: null },
      { invocation_id: 'event-owned', session_id: 'session-c' }, { invocation_id: 'invalid-fact', session_id: null },
      { invocation_id: 'malformed-json', session_id: null }, { invocation_id: 'orphan', session_id: null },
      { invocation_id: 'owned', session_id: 'session-a' }
    ])
    runMigrations(conn)
    expect(conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id = ?').get('owned')).toEqual({ session_id: 'session-a' })
    conn.close()
  })

  it('upgrades v19 streams while retaining unknown owner and creating continuation storage', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec('CREATE TABLE agent_history_streams (invocation_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL)')
    conn.exec(`CREATE TABLE agent_history_events (
      invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(invocation_id, sequence), UNIQUE(invocation_id, event_id), UNIQUE(invocation_id, idempotency_key)
    )`)
    conn.exec('CREATE INDEX idx_agent_history_events_turn ON agent_history_events(invocation_id, turn_id, sequence)')
    conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version) VALUES(?, 0, 1)').run('old-invocation')
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '19')
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id = ?').get('old-invocation')).toEqual({ session_id: null })
    expect((conn.prepare("PRAGMA index_list('agent_history_streams')").all() as Array<{ name: string }>).map(({ name }) => name)).toContain('idx_agent_history_streams_session')
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_continuations'").get()).toEqual({ name: 'agent_continuations' })
    conn.close()
  })

  it('upgrades v21 turn receipts with a legacy default and is safe to rerun at current version', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec('CREATE TABLE agent_history_streams (invocation_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL, session_id TEXT)')
    conn.exec(`CREATE TABLE agent_history_events (
      invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(invocation_id, sequence), UNIQUE(invocation_id, event_id), UNIQUE(invocation_id, idempotency_key)
    )`)
    conn.exec('CREATE INDEX idx_agent_history_streams_session ON agent_history_streams(session_id, invocation_id)')
    conn.exec('CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL)')
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '21')
    runMigrations(conn)
    expect(conn.prepare('PRAGMA table_info(turns)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'accepted_input_history_version', dflt_value: '0' })
    ]))
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('v30 recovers an existing target token from its Turn and fences pending rows without a token', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.exec('CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL, start_token TEXT)')
    conn.exec(`CREATE TABLE agent_continuations (
      continuation_id TEXT PRIMARY KEY, source_invocation_id TEXT, source_turn_id TEXT, checkpoint_sequence INTEGER, checkpoint_sha256 TEXT,
      request_idempotency_key TEXT, created_by TEXT, frozen_config_json TEXT, frozen_config_sha256 TEXT,
      target_invocation_id TEXT, target_turn_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER
    )`)
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '29')
    conn.prepare('INSERT INTO turns(turn_id,start_token) VALUES(?,?)').run('turn-existing', 'persisted-token')
    const insert = conn.prepare('INSERT INTO agent_continuations(continuation_id,target_turn_id,status) VALUES(?,?,?)')
    insert.run('with-turn', 'turn-existing', 'running')
    insert.run('without-turn', 'turn-missing', 'pending')
    runMigrations(conn)
    expect(conn.prepare('SELECT target_start_token,status FROM agent_continuations ORDER BY continuation_id').all()).toEqual([
      { target_start_token: 'persisted-token', status: 'running' },
      { target_start_token: '', status: 'interrupted' }
    ])
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })
})
