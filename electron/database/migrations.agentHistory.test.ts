import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

describe('agent canonical history migration', () => {
  it('upgrades an existing v24 database with the durable queue, reconciliation audit, and AcceptedTurn ledger', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    conn.prepare('INSERT INTO schema_meta(key, value) VALUES(?, ?)').run('schema_version', '24')
    runMigrations(conn)
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_execution_queue'").get()).toEqual({ name: 'session_execution_queue' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_transcript_reconciliations'").get()).toEqual({ name: 'session_transcript_reconciliations' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accepted_turn_contexts'").get()).toEqual({ name: 'accepted_turn_contexts' })
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '27' })
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

    expect(DB_SCHEMA_VERSION).toBe(27)
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

  it('upgrades v19 streams while retaining unknown owner and creating the session index', () => {
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
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: '27' })
    expect(conn.prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id = ?').get('old-invocation')).toEqual({ session_id: null })
    expect((conn.prepare("PRAGMA index_list('agent_history_streams')").all() as Array<{ name: string }>).map(({ name }) => name)).toContain('idx_agent_history_streams_session')
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
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: '27' })
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })
})
