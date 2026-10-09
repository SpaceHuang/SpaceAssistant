import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { CREATE_TABLES_SQL, DB_SCHEMA_VERSION } from './schema'

describe('session content cutover schema', () => {
  function makeV37Database() {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','37');
      CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, tool_use TEXT, tool_calls TEXT,
        thinking TEXT, content_segments TEXT, skill_hints TEXT, attachments TEXT,
        images_delivered_to_api INTEGER, status TEXT NOT NULL, schema_version INTEGER NOT NULL,
        timestamp INTEGER NOT NULL, sequence INTEGER NOT NULL,
        content_storage_state TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE TABLE canonical_session_projection_eligibility (
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        session_generation TEXT NOT NULL, validated_at INTEGER NOT NULL
      );
      CREATE TABLE agent_history_streams (
        invocation_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL, session_id TEXT
      );
      CREATE TABLE agent_history_events (
        invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        session_id TEXT, session_seq INTEGER, commit_order INTEGER,
        PRIMARY KEY(invocation_id,sequence)
      );
      INSERT INTO sessions(id,generation) VALUES('legacy-session','gen-1'),('second-session','gen-2');
      INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
        VALUES('legacy-message','legacy-session','user','preserve this body','sent',1,1,1);
      INSERT INTO canonical_session_projection_eligibility VALUES('legacy-session','gen-1',1);
    `)
    return conn
  }

  it('v37 upgrade adds independent API fence and per-session cutover state without changing legacy rows', () => {
    const conn = makeV37Database()
    runMigrations(conn)

    expect(DB_SCHEMA_VERSION).toBe(82)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare('SELECT content, content_storage_state FROM messages WHERE id=?').get('legacy-message'))
      .toEqual({ content: 'preserve this body', content_storage_state: 'legacy' })
    expect(conn.prepare('SELECT session_id, session_generation, message_revision, api_read_mode, write_mode, cleanup_state FROM session_message_content_cutover ORDER BY session_id').all())
      .toEqual([
        { session_id: 'legacy-session', session_generation: 'gen-1', message_revision: 0, api_read_mode: 'legacy', write_mode: 'legacy', cleanup_state: 'retained' },
        { session_id: 'second-session', session_generation: 'gen-2', message_revision: 0, api_read_mode: 'legacy', write_mode: 'legacy', cleanup_state: 'retained' }
      ])
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    conn.close()
  })

  it('v43 upgrade preserves every cutover row while adding the persisted write-stopped state', () => {
    const upgrade = new DatabaseSync(':memory:')
    // A sparse v43 fixture contains the objects touched by the migration and preserves a real row.
    upgrade.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE sessions(id TEXT PRIMARY KEY,generation TEXT NOT NULL);
      CREATE TABLE canonical_session_projection_eligibility(session_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_session_api_context_eligibility(session_id TEXT PRIMARY KEY);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT NOT NULL DEFAULT '', tool_use TEXT, tool_calls TEXT, thinking TEXT, content_segments TEXT, skill_hints TEXT, attachments TEXT, images_delivered_to_api INTEGER, status TEXT, schema_version INTEGER, timestamp INTEGER, sequence INTEGER, content_storage_state TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE agent_history_streams(invocation_id TEXT PRIMARY KEY,session_id TEXT);
      CREATE TABLE agent_history_events(event_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_session_projection_cache(session_id TEXT PRIMARY KEY);
      CREATE TABLE session_message_content_cutover(
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        session_generation TEXT NOT NULL,message_revision INTEGER NOT NULL DEFAULT 0,
        api_read_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(api_read_mode IN ('legacy','canonical','revalidation-required')),
        write_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(write_mode IN ('legacy','dual-write','canonical')),
        cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK(cleanup_state IN ('retained','write-stopped','pending','complete')),updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version','43');
      INSERT INTO sessions VALUES('s','g');
      INSERT INTO session_message_content_cutover VALUES('s','g',7,'canonical','canonical','retained',123);
      INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence,content_storage_state) VALUES('m','s','user','body','sent',1,1,1,'canonical-backed-dual-write');
    `)
    runMigrations(upgrade)
    expect(upgrade.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(upgrade.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='guard_session_content_cleanup_complete_ledger_immutable'").get())
      .toEqual({ name: 'guard_session_content_cleanup_complete_ledger_immutable' })
    expect(upgrade.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='guard_session_content_cleanup_complete_ledger_delete'").get())
      .toEqual({ name: 'guard_session_content_cleanup_complete_ledger_delete' })
    expect(upgrade.prepare('SELECT session_id,session_generation,message_revision,api_read_mode,write_mode,cleanup_state,updated_at FROM session_message_content_cutover').get())
      .toEqual({ session_id: 's',session_generation: 'g',message_revision: 7,api_read_mode: 'canonical',write_mode: 'canonical',cleanup_state: 'retained',updated_at: 123 })
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='unknown' WHERE session_id='s'").run()).toThrow()
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='write-stopped' WHERE session_id='s'").run()).not.toThrow()
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='pending' WHERE session_id='s'").run())
      .toThrow('session content cleanup progress missing')
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='complete' WHERE session_id='s'").run())
      .toThrow('invalid session content cleanup state transition')
    upgrade.prepare(`INSERT INTO session_message_content_cleanup_progress(
      session_id,session_generation,session_message_revision,canonical_session_seq,canonical_commit_order,
      watermark_event_id,watermark_invocation_id,next_sequence,cleaned_message_count,scan_complete,source_manifest_sha256,updated_at
    ) VALUES('s','g',7,0,0,NULL,NULL,1,0,0,'manifest',123)`).run()
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='pending' WHERE session_id='s'").run()).not.toThrow()
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='complete' WHERE session_id='s'").run())
      .toThrow('session content cleanup incomplete')
    upgrade.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id='m'").run()
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='complete' WHERE session_id='s'").run())
      .toThrow('session content cleanup incomplete')
    upgrade.prepare("UPDATE session_message_content_cleanup_progress SET scan_complete=1,verified_at=124,verification_sha256='sha256' WHERE session_id='s'").run()
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='complete' WHERE session_id='s'").run()).not.toThrow()
    expect(() => upgrade.prepare("UPDATE session_message_content_cleanup_progress SET verification_sha256='forged' WHERE session_id='s'").run())
      .toThrow('complete session cleanup ledger is immutable')
    expect(() => upgrade.prepare("DELETE FROM session_message_content_cleanup_progress WHERE session_id='s'").run())
      .toThrow('complete session cleanup ledger is immutable')
    expect(upgrade.prepare("SELECT verification_sha256 FROM session_message_content_cleanup_progress WHERE session_id='s'").get())
      .toEqual({ verification_sha256: 'sha256' })
    expect(() => upgrade.prepare("UPDATE session_message_content_cutover SET cleanup_state='retained' WHERE session_id='s'").run())
      .toThrow('invalid session content cleanup state transition')
    expect(() => upgrade.prepare(`DELETE FROM sessions WHERE id='s'`).run()).not.toThrow()
    expect(upgrade.prepare("SELECT session_id FROM session_message_content_cleanup_progress WHERE session_id='s'").get()).toBeUndefined()
    expect(upgrade.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    upgrade.close()
  })

  it('v44 upgrade installs the complete cleanup ledger immutability trigger without rewriting session data', () => {
    const conn = makeV37Database()
    runMigrations(conn)
    conn.exec(`DROP TRIGGER IF EXISTS guard_session_content_cleanup_complete_ledger_immutable;
      UPDATE schema_meta SET value='44' WHERE key='schema_version';`)

    runMigrations(conn)

    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='guard_session_content_cleanup_complete_ledger_immutable'").get())
      .toEqual({ name: 'guard_session_content_cleanup_complete_ledger_immutable' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='guard_session_content_cleanup_complete_ledger_delete'").get())
      .toEqual({ name: 'guard_session_content_cleanup_complete_ledger_delete' })
    expect(conn.prepare('SELECT id,generation FROM sessions ORDER BY id').all())
      .toEqual([{ id: 'legacy-session', generation: 'gen-1' }, { id: 'second-session', generation: 'gen-2' }])
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('legacy-message'))
      .toEqual({ content: 'preserve this body', content_storage_state: 'legacy' })
    conn.close()
  })

  it('direct canonical History event and stream mutations revoke API eligibility in the same transaction', () => {
    const conn = makeV37Database()
    runMigrations(conn)
    conn.exec(`
      INSERT INTO agent_history_streams(invocation_id,schema_version,session_id) VALUES('inv-1',1,'legacy-session');
      INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id,session_seq,commit_order)
        VALUES('inv-1',1,'event-1','key-1','turn-1',1,'transcript-compacted','{}',1,'legacy-session',1,1);
    `)
    const grant = () => {
      conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id='legacy-session'").run()
      conn.prepare('INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('legacy-session','gen-1',0,1,1,'event-1','inv-1',10,1)
    }
    const assertRevoked = () => {
      expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
      expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get('legacy-session'))
        .toEqual({ api_read_mode: 'revalidation-required' })
    }
    grant()
    conn.prepare("UPDATE agent_history_events SET payload_json='changed' WHERE event_id='event-1'").run()
    assertRevoked()
    grant()
    conn.prepare("INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at) VALUES('inv-1',2,'event-2','key-2','turn-1',1,'replay-message','{}',2)").run()
    assertRevoked()
    grant()
    conn.prepare("DELETE FROM agent_history_events WHERE event_id='event-2'").run()
    assertRevoked()
    grant()
    conn.prepare("UPDATE agent_history_streams SET session_id='second-session' WHERE invocation_id='inv-1'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(conn.prepare("SELECT api_read_mode FROM session_message_content_cutover WHERE session_id='legacy-session'").get())
      .toEqual({ api_read_mode: 'revalidation-required' })
    expect(conn.prepare("SELECT api_read_mode FROM session_message_content_cutover WHERE session_id='second-session'").get())
      .toEqual({ api_read_mode: 'legacy' })
    conn.close()
  })

  it('message INSERT/UPDATE/DELETE atomically advances the skeleton revision and revokes both read eligibilities', () => {
    const conn = makeV37Database()
    runMigrations(conn)
    const grant = conn.prepare('INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,?)')
    const regrant = (revision: number) => {
      conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id='legacy-session'").run()
      grant.run('legacy-session', 'gen-1', revision, 3, 7, 'event-7', 'invocation-1', 10, 1)
      conn.prepare('INSERT OR REPLACE INTO canonical_session_projection_eligibility VALUES(?,?,?)').run('legacy-session', 'gen-1', 10)
    }
    const state = () => conn.prepare('SELECT message_revision,api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get('legacy-session')
    regrant(0)
    conn.exec('BEGIN IMMEDIATE')
    conn.prepare("UPDATE messages SET content='rolled back body' WHERE id='legacy-message'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(state()).toMatchObject({ message_revision: 1, api_read_mode: 'revalidation-required' })
    conn.exec('ROLLBACK')
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([{ session_id: 'legacy-session' }])
    expect(state()).toMatchObject({ message_revision: 0, api_read_mode: 'canonical' })

    conn.prepare("UPDATE messages SET content='edited body' WHERE id='legacy-message'").run()
    expect(state()).toMatchObject({ message_revision: 1, api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])

    regrant(1)
    conn.prepare("INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES('new-message','legacy-session','assistant','new body','completed',1,2,2)").run()
    expect(state()).toMatchObject({ message_revision: 2, api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])

    regrant(2)
    conn.prepare("DELETE FROM messages WHERE id='new-message'").run()
    expect(state()).toMatchObject({ message_revision: 3, api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])

    regrant(3)
    conn.prepare("UPDATE messages SET attachments='[{\"id\":\"edited-attachment\"}]' WHERE id='legacy-message'").run()
    expect(state()).toMatchObject({ message_revision: 4, api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])
    conn.close()
  })

  it('session generation change revokes old-generation eligibility; new sessions start in legacy mode', () => {
    const conn = makeV37Database()
    runMigrations(conn)
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical' WHERE session_id='legacy-session'").run()
    conn.prepare('INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('legacy-session', 'gen-1', 0, 3, 7, 'event-7', 'invocation-1', 10, 1)
    conn.prepare('INSERT OR REPLACE INTO canonical_session_projection_eligibility VALUES(?,?,?)').run('legacy-session', 'gen-1', 10)

    conn.prepare("UPDATE sessions SET generation='gen-3' WHERE id='legacy-session'").run()
    expect(conn.prepare('SELECT session_generation,message_revision FROM session_message_content_cutover WHERE session_id=?').get('legacy-session'))
      .toEqual({ session_generation: 'gen-3', message_revision: 1 })
    expect(conn.prepare('SELECT api_read_mode FROM session_message_content_cutover WHERE session_id=?').get('legacy-session'))
      .toEqual({ api_read_mode: 'revalidation-required' })
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility').all()).toEqual([])
    expect(conn.prepare('SELECT session_id FROM canonical_session_projection_eligibility').all()).toEqual([])

    conn.prepare("INSERT INTO sessions(id,generation) VALUES('new-session','gen-new')").run()
    expect(conn.prepare('SELECT session_generation,api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get('new-session'))
      .toEqual({ session_generation: 'gen-new', api_read_mode: 'legacy', write_mode: 'legacy', cleanup_state: 'retained' })
    conn.close()
  })

  it('explicit body state preserves real empty legacy messages and the new fences obey session foreign keys', () => {
    const conn = makeV37Database()
    runMigrations(conn)
    conn.prepare("INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence) VALUES('empty-message','legacy-session','user','','sent',1,2,2)").run()
    expect(conn.prepare('SELECT content,content_storage_state FROM messages WHERE id=?').get('empty-message'))
      .toEqual({ content: '', content_storage_state: 'legacy' })
    // Sparse v37 fixture adds the body-state column without its production CHECK constraint.

    conn.prepare('INSERT INTO canonical_session_api_context_eligibility(session_id,session_generation,skeleton_revision,canonical_session_seq,canonical_commit_order,watermark_event_id,watermark_invocation_id,validated_at,protocol_version) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('legacy-session', 'gen-1', 0, 3, 7, 'event-7', 'invocation-1', 10, 1)
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    conn.prepare("DELETE FROM sessions WHERE id='legacy-session'").run()
    expect(conn.prepare('SELECT session_id FROM canonical_session_api_context_eligibility WHERE session_id=?').all('legacy-session')).toEqual([])
    expect(conn.prepare('SELECT session_id FROM session_message_content_cutover WHERE session_id=?').all('legacy-session')).toEqual([])
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    conn.close()
  })

  it('rerunning migration preserves generation, revision, and already-recorded rollout state', () => {
    const conn = makeV37Database()
    runMigrations(conn)
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='canonical',write_mode='dual-write',message_revision=9 WHERE session_id='legacy-session'").run()
    conn.exec(`DROP TRIGGER IF EXISTS reject_message_insert_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_message_content_update_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_message_content_update_after_write_stop;
      DROP TRIGGER IF EXISTS reject_history_event_insert_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_history_event_update_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_history_event_delete_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_history_stream_insert_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_history_stream_update_after_content_write_stop;
      DROP TRIGGER IF EXISTS reject_history_stream_delete_after_content_write_stop;
      DROP TRIGGER IF EXISTS guard_session_content_cleanup_state_transition;
      DROP TRIGGER IF EXISTS guard_session_content_cleanup_progress_baseline;
      DROP TRIGGER IF EXISTS guard_session_content_cleanup_complete_ledger_immutable;
      DROP TRIGGER IF EXISTS guard_session_content_cleanup_complete_ledger_delete;
      DROP TRIGGER IF EXISTS prepare_session_content_cleanup_for_session_delete;
      DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_cleanup_state_update;
      DROP TRIGGER IF EXISTS ensure_session_message_content_cutover_after_session_insert;
      DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_generation_update;
      DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_message_insert;
      DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_message_update;
      DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_message_delete;
      DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_insert;
      DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_update;
      DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_delete;
      DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_stream_session_update;
      DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_stream_delete;
      DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_event_update;
      DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_event_delete;
      DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_stream_session_update;
      DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_stream_delete;
      DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_update;
      DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_delete;
      DROP TRIGGER IF EXISTS guard_session_content_cleanup_state_transition;
      DROP TRIGGER IF EXISTS invalidate_session_content_eligibility_after_cleanup_state_update;
      DROP TRIGGER IF EXISTS track_pending_history_cursor_allocation;
      DROP TRIGGER IF EXISTS settle_pending_history_cursor_allocation;
      DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_update;
      DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_delete;
      CREATE TABLE session_message_content_cutover_v43 (
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        session_generation TEXT NOT NULL,message_revision INTEGER NOT NULL DEFAULT 0,
        api_read_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(api_read_mode IN ('legacy','canonical','revalidation-required')),
        write_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(write_mode IN ('legacy','dual-write','canonical')),
        cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK(cleanup_state IN ('retained','write-stopped','pending','complete')),updated_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO session_message_content_cutover_v43 SELECT * FROM session_message_content_cutover;
      DROP TABLE session_message_content_cutover;
      ALTER TABLE session_message_content_cutover_v43 RENAME TO session_message_content_cutover;`)
    conn.prepare("UPDATE session_message_content_cutover SET cleanup_state='write-stopped' WHERE session_id='legacy-session'").run()
    conn.prepare(`INSERT INTO session_message_content_cleanup_progress(
      session_id,session_generation,session_message_revision,canonical_session_seq,canonical_commit_order,
      next_sequence,cleaned_message_count,source_manifest_sha256,updated_at
    ) VALUES('legacy-session','gen-1',9,0,0,1,0,'manifest',1)`).run()
    conn.prepare("UPDATE session_message_content_cutover SET cleanup_state='pending' WHERE session_id='legacy-session'").run()
    runMigrations(conn)
    expect(conn.prepare('SELECT session_generation,message_revision,api_read_mode,write_mode,cleanup_state FROM session_message_content_cutover WHERE session_id=?').get('legacy-session'))
      .toEqual({ session_generation: 'gen-1', message_revision: 9, api_read_mode: 'canonical', write_mode: 'dual-write', cleanup_state: 'pending' })
    conn.close()
  })

  it('v45 upgrade makes canonical-only message bodies immutable even after cutover-row loss', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version','45');
      CREATE TABLE sessions(id TEXT PRIMARY KEY NOT NULL,generation TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL,content TEXT NOT NULL,
        content_storage_state TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE session_message_content_cutover(session_id TEXT PRIMARY KEY NOT NULL,write_mode TEXT NOT NULL);
      INSERT INTO sessions VALUES('s','g');
      INSERT INTO session_message_content_cutover VALUES('s','canonical');
      INSERT INTO messages VALUES('m','s','','canonical-backed-only');
    `)
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    conn.prepare("DELETE FROM session_message_content_cutover WHERE session_id='s'").run()
    expect(() => conn.prepare("UPDATE messages SET content='legacy fallback' WHERE id='m'").run())
      .toThrow('canonical-backed-only message content is immutable')
    expect(() => conn.prepare("UPDATE messages SET content_storage_state='legacy' WHERE id='m'").run())
      .toThrow('canonical-backed-only message content is immutable')
    expect(conn.prepare("SELECT content,content_storage_state FROM messages WHERE id='m'").get())
      .toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
    conn.close()
  })

  it('v46 reconstructs pending and invalid History allocator state from existing v45 rows', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL); INSERT INTO schema_meta VALUES('schema_version','1');")
    runMigrations(conn)
    const cursor = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)').run(1) as { lastInsertRowid: number | bigint }
    conn.exec(`
      DROP TRIGGER track_pending_history_cursor_allocation;
      DROP TRIGGER settle_pending_history_cursor_allocation;
      DROP TRIGGER invalidate_session_projections_after_history_cursor_update;
      DROP TRIGGER invalidate_session_projections_after_history_cursor_delete;
      DROP TABLE agent_history_pending_commit_cursor;
      DROP TABLE agent_history_cursor_integrity;
      UPDATE schema_meta SET value='45' WHERE key='schema_version';
    `)

    runMigrations(conn)

    expect(conn.prepare('SELECT invalid FROM agent_history_cursor_integrity WHERE singleton_id=1').get())
      .toEqual({ invalid: 1 })
    expect(conn.prepare('SELECT cursor_id FROM agent_history_pending_commit_cursor').all())
      .toEqual([{ cursor_id: Number(cursor.lastInsertRowid) }])
    conn.close()
  })

  it.each([
    { name: 'an internal commit-order gap', eventOrders: [1, 3], cursorIds: [1, 2, 3] },
    { name: 'an unpaired trailing allocator cursor', eventOrders: [1, 2], cursorIds: [1, 2, 3] }
  ])('v46 marks existing $name as invalid during upgrade', ({ eventOrders, cursorIds }) => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version','45');
      CREATE TABLE agent_history_commit_cursor (id INTEGER PRIMARY KEY AUTOINCREMENT, allocated_at INTEGER NOT NULL);
      CREATE TABLE agent_history_events (
        invocation_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, turn_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        session_id TEXT, session_seq INTEGER, commit_order INTEGER,
        PRIMARY KEY(invocation_id,sequence), UNIQUE(commit_order)
      );
      CREATE TABLE canonical_session_projection_cache (session_id TEXT NOT NULL,cache_key TEXT NOT NULL,PRIMARY KEY(session_id,cache_key));
      CREATE TABLE canonical_session_projection_eligibility (session_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_session_api_context_eligibility (session_id TEXT PRIMARY KEY);
      CREATE TABLE session_message_content_cutover (session_id TEXT PRIMARY KEY,api_read_mode TEXT NOT NULL,write_mode TEXT NOT NULL,updated_at INTEGER NOT NULL);
    `)
    const insertCursor = conn.prepare('INSERT INTO agent_history_commit_cursor(id,allocated_at) VALUES(?,?)')
    for (const id of cursorIds) insertCursor.run(id, id)
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(
      invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,commit_order
    ) VALUES(?,?,?,?,?,1,'test-event','{}',?,?)`)
    for (const order of eventOrders) insertEvent.run(`inv-${order}`, 1, `event-${order}`, `key-${order}`, `turn-${order}`, order, order)

    runMigrations(conn)

    expect(conn.prepare('SELECT invalid FROM agent_history_cursor_integrity WHERE singleton_id=1').get()).toEqual({ invalid: 1 })
    const pendingCursorIds = cursorIds.filter((id) => !eventOrders.includes(id)).map((cursor_id) => ({ cursor_id }))
    expect(conn.prepare('SELECT cursor_id FROM agent_history_pending_commit_cursor ORDER BY cursor_id').all())
      .toEqual(pendingCursorIds)
    conn.close()
  })

  it('preserves current allocator triggers when a replay migration fails before v46 is reapplied', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(CREATE_TABLES_SQL)
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
      'track_pending_history_cursor_allocation','settle_pending_history_cursor_allocation',
      'invalidate_session_projections_after_history_cursor_update','invalidate_session_projections_after_history_cursor_delete'
    )`).all()).toHaveLength(4)
    conn.exec(`
      UPDATE schema_meta SET value='40' WHERE key='schema_version';
      CREATE TRIGGER fail_replayed_v41_version_update BEFORE UPDATE OF value ON schema_meta
        WHEN NEW.key='schema_version' AND NEW.value='41'
        BEGIN SELECT RAISE(ABORT,'injected replay migration failure'); END;
    `)

    expect(() => runMigrations(conn)).toThrow('injected replay migration failure')
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '40' })
    expect(conn.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
      'track_pending_history_cursor_allocation','settle_pending_history_cursor_allocation',
      'invalidate_session_projections_after_history_cursor_update','invalidate_session_projections_after_history_cursor_delete'
    ) ORDER BY name`).all()).toHaveLength(4)

    conn.exec('DROP TRIGGER fail_replayed_v41_version_update')
    expect(() => runMigrations(conn)).not.toThrow()
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    conn.close()
  })

  it('a failed v44 rebuild rolls back its schema version and preserves the v43 table for retry', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES('schema_version','43');
      CREATE TABLE sessions(id TEXT PRIMARY KEY NOT NULL,generation TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', content_storage_state TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE agent_history_streams(invocation_id TEXT PRIMARY KEY,session_id TEXT);
      CREATE TABLE agent_history_events(event_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_session_projection_cache(session_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_session_projection_eligibility(session_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_session_api_context_eligibility(session_id TEXT PRIMARY KEY);
      CREATE TABLE session_message_content_cutover(
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        session_generation TEXT NOT NULL,message_revision INTEGER NOT NULL DEFAULT 0,
        api_read_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(api_read_mode IN ('legacy','canonical','revalidation-required')),
        write_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(write_mode IN ('legacy','dual-write','canonical')),
        cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK(cleanup_state IN ('retained','pending','complete')),updated_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO sessions VALUES('s','g');
      INSERT INTO session_message_content_cutover VALUES('s','g',0,'legacy','legacy','retained',1);
      CREATE TABLE session_message_content_cutover_v44(session_id TEXT PRIMARY KEY);
    `)
    expect(() => runMigrations(conn)).toThrow()
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '43' })
    expect(() => conn.prepare("UPDATE session_message_content_cutover SET cleanup_state='write-stopped'").run()).toThrow()
    conn.exec('DROP TABLE session_message_content_cutover_v44')
    expect(() => runMigrations(conn)).not.toThrow()
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare("UPDATE session_message_content_cutover SET cleanup_state='write-stopped'").run().changes).toBe(1)
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    conn.close()
  })
})
