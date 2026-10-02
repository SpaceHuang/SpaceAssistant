import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

describe('agent canonical history migration', () => {
  it('v36 installs fail-closed transcript eligibility invalidation triggers', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','36');
      CREATE TABLE sessions(id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL);
      INSERT INTO sessions(id,generation) VALUES('s','generation-1');
      INSERT INTO messages(id,session_id,content) VALUES('m','s','body');`)

    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    const markEligible = conn.prepare('INSERT OR REPLACE INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES(?,?,?)')
    expect(conn.prepare('SELECT name FROM sqlite_master WHERE type=\'trigger\' AND name LIKE \'invalidate_session_projection_%\'').all()).toHaveLength(3)

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

    expect(DB_SCHEMA_VERSION).toBe(37)
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
