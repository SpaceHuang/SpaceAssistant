import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

function createMainV33Database(databasePath = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta(key,value) VALUES('schema_version','33');
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      fixed_work_dir TEXT
    );
    CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL, retry_of_message_id TEXT, retry_of_invocation_id TEXT);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_use TEXT, tool_calls TEXT,
      thinking TEXT, content_segments TEXT, skill_hints TEXT, attachments TEXT,
      images_delivered_to_api INTEGER, status TEXT NOT NULL DEFAULT 'sent',
      schema_version INTEGER NOT NULL DEFAULT 1, timestamp INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_history_streams (
      invocation_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1,
      session_id TEXT
    );
    CREATE TABLE agent_history_events (
      invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      session_id TEXT,
      PRIMARY KEY(invocation_id,sequence)
    );
    CREATE TABLE continuation_intents (
      request_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      route TEXT NOT NULL,
      source_invocation_id TEXT,
      source_turn_id TEXT,
      source_sequence INTEGER,
      target_id TEXT,
      status TEXT NOT NULL,
      rejection_reason TEXT,
      continuation_context_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE automation_tasks (
      task_id TEXT PRIMARY KEY NOT NULL,
      work_dir TEXT, model_id TEXT, model_service_id TEXT, reasoning_effort TEXT
    );
    CREATE TABLE automation_task_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      config_snapshot_json TEXT
    );
    CREATE TABLE usage_step_facts (
      id TEXT PRIMARY KEY NOT NULL,
      model_id TEXT, provider_model_name TEXT, route_identity TEXT
    );
    CREATE TABLE usage_turn_facts (
      id TEXT PRIMARY KEY NOT NULL,
      model_id TEXT, provider_model_name TEXT, route_identity TEXT
    );
    INSERT INTO sessions(id,fixed_work_dir) VALUES('main-v33-session','/tmp/work');
    INSERT INTO usage_step_facts(id,model_id,provider_model_name,route_identity)
      VALUES('main-v33-usage','catalog-v33','provider/model-v33','route-v33');
    INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,status,continuation_context_json,created_at,updated_at)
      VALUES('main-v33-request','main-v33-session','digest','continue','[]','retry','desktop','pending','{"source":"main"}',1,1);
    INSERT INTO automation_tasks(task_id,work_dir,model_id,model_service_id,reasoning_effort)
      VALUES('main-v33-task','/tmp/task','model-id','service-id','high');
    INSERT INTO automation_task_runs(run_id,config_snapshot_json) VALUES('main-v33-run','{"model":"model-id"}');
    INSERT INTO agent_history_streams(invocation_id,session_id) VALUES('main-v33-invocation','main-v33-session');
    INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id)
      VALUES('main-v33-invocation',1,'main-v33-event','main-v33-key','main-v33-turn',1,'transcript-compacted','{}',1,'main-v33-session');
  `)
  return db
}

function createMainV30Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta(key,value) VALUES('schema_version','30');
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '');
    CREATE TABLE turns (turn_id TEXT PRIMARY KEY NOT NULL, start_token TEXT);
    CREATE TABLE automation_tasks (task_id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE automation_task_runs (run_id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE usage_step_facts (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE usage_turn_facts (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE agent_history_streams (
      invocation_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1,
      session_id TEXT
    );
    CREATE TABLE agent_history_events (
      invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(invocation_id,sequence)
    );
    INSERT INTO sessions(id,name) VALUES('main-v30-session','preserve me');
    INSERT INTO turns(turn_id,start_token) VALUES('main-v30-turn','turn-token');
    INSERT INTO agent_history_streams(invocation_id,session_id) VALUES('main-v30-invocation','main-v30-session');
    INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('main-v30-invocation',1,'main-v30-event','main-v30-key','main-v30-turn',1,'session-input-committed','{}',1);
  `)
  return db
}

function createMainV31Database(): DatabaseSync {
  const db = createMainV30Database()
  db.exec(`
    ALTER TABLE turns ADD COLUMN retry_of_message_id TEXT;
    ALTER TABLE turns ADD COLUMN retry_of_invocation_id TEXT;
    CREATE TABLE continuation_intents (
      request_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      route TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_continuation_intents_session ON continuation_intents(session_id, created_at);
    UPDATE schema_meta SET value='31' WHERE key='schema_version';
    INSERT INTO continuation_intents(request_id,session_id,payload_sha256,raw_text,attachments_json,intent_kind,route,status,created_at,updated_at)
      VALUES('main-v31-request','main-v30-session','digest-v31','continue v31','[]','retry','desktop','pending',2,2);
  `)
  return db
}

function createMainV32Database(): DatabaseSync {
  const db = createMainV31Database()
  db.exec(`
    ALTER TABLE continuation_intents ADD COLUMN continuation_context_json TEXT;
    UPDATE schema_meta SET value='32' WHERE key='schema_version';
    UPDATE continuation_intents SET continuation_context_json='{"source":"main-v32"}' WHERE request_id='main-v31-request';
  `)
  return db
}

describe('main v33 schema compatibility', () => {
  it('keeps the main v30 migration semantics when the storage branch uses the same version numbers', () => {
    const db = createMainV30Database()

    expect(() => runMigrations(db)).not.toThrow()

    const turnColumns = new Set((db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(turnColumns.has('retry_of_message_id')).toBe(true)
    expect(turnColumns.has('retry_of_invocation_id')).toBe(true)
    const intentColumns = new Set((db.prepare('PRAGMA table_info(continuation_intents)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(intentColumns.has('request_id')).toBe(true)
    expect(intentColumns.has('continuation_context_json')).toBe(true)
    const sessionColumns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(sessionColumns.has('fixed_work_dir')).toBe(true)
    expect(sessionColumns.has('generation')).toBe(true)
    const taskColumns = new Set((db.prepare('PRAGMA table_info(automation_tasks)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(taskColumns.has('work_dir')).toBe(true)
    expect(taskColumns.has('model_service_id')).toBe(true)
    const usageColumns = new Set((db.prepare('PRAGMA table_info(usage_turn_facts)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(usageColumns.has('provider_model_name')).toBe(true)
    expect(db.prepare('SELECT session_id,event_id,commit_order FROM agent_history_events').all())
      .toEqual([{ session_id: 'main-v30-session', event_id: 'main-v30-event', commit_order: 1 }])

    db.close()
  })

  it.each([
    { version: 31, create: createMainV31Database, context: null },
    { version: 32, create: createMainV32Database, context: '{"source":"main-v32"}' },
  ])('resumes main v$version profiles without losing continuation data', ({ create, context }) => {
    const db = create()

    expect(() => runMigrations(db)).not.toThrow()

    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(db.prepare("SELECT raw_text,continuation_context_json FROM continuation_intents WHERE request_id='main-v31-request'").get())
      .toEqual({ raw_text: 'continue v31', continuation_context_json: context })
    expect(db.prepare('SELECT session_id,event_id,session_seq,commit_order FROM agent_history_events').all())
      .toEqual([{ session_id: 'main-v30-session', event_id: 'main-v30-event', session_seq: 1, commit_order: 1 }])
    expect(db.prepare('SELECT session_id,next_seq FROM session_event_cursor').all())
      .toEqual([{ session_id: 'main-v30-session', next_seq: 1 }])

    db.close()
  })

  it('upgrades main v33 profiles while adding the canonical History and session-generation prerequisites', () => {
    const db = createMainV33Database()

    expect(() => runMigrations(db)).not.toThrow()

    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    const sessionColumns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(sessionColumns.has('fixed_work_dir')).toBe(true)
    expect(sessionColumns.has('generation')).toBe(true)
    expect(db.prepare("SELECT fixed_work_dir FROM sessions WHERE id='main-v33-session'").get())
      .toEqual({ fixed_work_dir: '/tmp/work' })
    expect((db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(['turn_id', 'retry_of_message_id', 'retry_of_invocation_id'])
    expect((db.prepare('PRAGMA table_info(continuation_intents)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain('continuation_context_json')
    expect(db.prepare("SELECT raw_text,continuation_context_json FROM continuation_intents WHERE request_id='main-v33-request'").get())
      .toEqual({ raw_text: 'continue', continuation_context_json: '{"source":"main"}' })
    expect((db.prepare('PRAGMA table_info(automation_tasks)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain('model_service_id')
    expect(db.prepare("SELECT model_service_id,reasoning_effort FROM automation_tasks WHERE task_id='main-v33-task'").get())
      .toEqual({ model_service_id: 'service-id', reasoning_effort: 'high' })
    expect((db.prepare('PRAGMA table_info(automation_task_runs)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain('config_snapshot_json')
    expect(db.prepare("SELECT config_snapshot_json FROM automation_task_runs WHERE run_id='main-v33-run'").get())
      .toEqual({ config_snapshot_json: '{"model":"model-id"}' })
    expect((db.prepare('PRAGMA table_info(usage_turn_facts)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain('provider_model_name')
    expect(db.prepare("SELECT model_id,provider_model_name,route_identity FROM usage_step_facts WHERE id='main-v33-usage'").get())
      .toEqual({ model_id: 'catalog-v33', provider_model_name: 'provider/model-v33', route_identity: 'route-v33' })

    const eventColumns = new Set((db.prepare('PRAGMA table_info(agent_history_events)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(eventColumns.has('session_seq')).toBe(true)
    expect(eventColumns.has('commit_order')).toBe(true)
    expect(db.prepare('SELECT invocation_id,event_id,session_id,session_seq,commit_order FROM agent_history_events').all())
      .toEqual([{ invocation_id: 'main-v33-invocation', event_id: 'main-v33-event', session_id: 'main-v33-session', session_seq: 1, commit_order: 1 }])
    expect(db.prepare('SELECT session_id,next_seq FROM session_event_cursor').all())
      .toEqual([{ session_id: 'main-v33-session', next_seq: 1 }])

    db.close()
  })

  it('upgrades a file-backed main v33 profile and preserves its product and History data after reopen', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceassistant-main-v33-migration-'))
    const databasePath = path.join(root, 'session.sqlite')
    try {
      const db = createMainV33Database(databasePath)
      expect(() => runMigrations(db)).not.toThrow()
      db.close()

      const reopened = new DatabaseSync(databasePath)
      try {
        expect(reopened.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
          .toEqual({ value: String(DB_SCHEMA_VERSION) })
        expect(reopened.prepare("SELECT fixed_work_dir FROM sessions WHERE id='main-v33-session'").get())
          .toEqual({ fixed_work_dir: '/tmp/work' })
        expect(reopened.prepare("SELECT continuation_context_json FROM continuation_intents WHERE request_id='main-v33-request'").get())
          .toEqual({ continuation_context_json: '{"source":"main"}' })
        expect(reopened.prepare("SELECT model_id,provider_model_name,route_identity FROM usage_step_facts WHERE id='main-v33-usage'").get())
          .toEqual({ model_id: 'catalog-v33', provider_model_name: 'provider/model-v33', route_identity: 'route-v33' })
        expect(reopened.prepare('SELECT event_id,session_id,session_seq,commit_order FROM agent_history_events').all())
          .toEqual([{ event_id: 'main-v33-event', session_id: 'main-v33-session', session_seq: 1, commit_order: 1 }])
        expect(reopened.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
        expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        expect(() => runMigrations(reopened)).not.toThrow()
        expect(reopened.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
          .toEqual({ value: String(DB_SCHEMA_VERSION) })
      } finally {
        reopened.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('repairs a v0.2.4 profile whose main schema v33 was stamped as storage v46', () => {
    const db = createMainV33Database()
    // The 0.2.4 candidate treated product-main schema 33 as its own storage
    // migration 33 and advanced the version without applying the skipped DDL.
    db.exec("ALTER TABLE sessions DROP COLUMN fixed_work_dir; UPDATE schema_meta SET value='46' WHERE key='schema_version'")

    expect(() => runMigrations(db)).not.toThrow()

    expect(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get())
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    const sessionColumns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(sessionColumns.has('fixed_work_dir')).toBe(true)
    expect(sessionColumns.has('generation')).toBe(true)
    const eventColumns = new Set((db.prepare('PRAGMA table_info(agent_history_events)').all() as Array<{ name: string }>).map(({ name }) => name))
    expect(eventColumns.has('commit_order')).toBe(true)
    expect(eventColumns.has('session_seq')).toBe(true)
    expect(db.prepare('SELECT session_id,next_seq FROM session_event_cursor').all())
      .toEqual([{ session_id: 'main-v33-session', next_seq: 1 }])
    expect(db.prepare('SELECT id FROM agent_history_commit_cursor').all()).toEqual([{ id: 1 }])

    db.close()
  })
})
