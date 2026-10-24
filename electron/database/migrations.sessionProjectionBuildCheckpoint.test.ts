import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('session projection durable build checkpoint schema', () => {
  it('adds a checkpoint slot and clears it atomically when the projection is invalidated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-projection-build-checkpoint-'))
    dirs.push(dir)
    const conn = new DatabaseSync(path.join(dir, 'session.db'))
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('${SCHEMA_META_KEYS.schemaVersion}','108');
      CREATE TABLE session_projection_state(session_id TEXT NOT NULL,scope_key TEXT NOT NULL,status TEXT NOT NULL,
        history_watermark_json TEXT,message_revision INTEGER,source_identity_json TEXT,payload_generation TEXT,payload_digest TEXT,
        validated_range_json TEXT,process_generation INTEGER,rebuild_token TEXT,failure_case_json TEXT,attempts INTEGER DEFAULT 0,
        retry_after INTEGER,build_checkpoint_json TEXT,PRIMARY KEY(session_id,scope_key));
      CREATE TABLE session_projection_cache(session_id TEXT NOT NULL,scope_key TEXT NOT NULL,inline_payload TEXT,blob_locator TEXT);`)
    conn.prepare(`INSERT INTO session_projection_state(session_id,scope_key,status,process_generation,rebuild_token)
      VALUES('session-a','scope-a','rebuilding',1,'token-a')`).run()
    conn.prepare(`INSERT INTO session_projection_state(session_id,scope_key,status,history_watermark_json,message_revision,
      source_identity_json,payload_generation,payload_digest,validated_range_json,attempts)
      VALUES('session-b','scope-b','valid','[]',1,'{}','old-payload','${'a'.repeat(64)}','{}',0)`).run()
    conn.prepare('INSERT INTO session_projection_cache(session_id,scope_key,inline_payload,blob_locator) VALUES(?,?,NULL,?)')
      .run('session-b', 'scope-b', 'projection-00000000-0000-4000-8000-000000000001.blob')

    runMigrations(conn)
    expect((conn.prepare('PRAGMA table_info(session_projection_state)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain('build_checkpoint_json')
    expect((conn.prepare('PRAGMA table_info(session_projection_cache)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain('blob_byte_length')
    expect(conn.prepare('SELECT status,payload_generation,payload_digest FROM session_projection_state WHERE session_id=? AND scope_key=?')
      .get('session-b', 'scope-b')).toEqual({ status: 'invalid', payload_generation: null, payload_digest: null })
    expect(conn.prepare('SELECT 1 FROM session_projection_cache WHERE session_id=? AND scope_key=?').get('session-b', 'scope-b')).toBeUndefined()
    conn.prepare(`UPDATE session_projection_state SET build_checkpoint_json=? WHERE session_id=? AND scope_key=?`)
      .run('{"nextSequence":10}', 'session-a', 'scope-a')
    conn.prepare(`UPDATE session_projection_state SET status='invalid',process_generation=NULL,rebuild_token=NULL
      WHERE session_id=? AND scope_key=?`).run('session-a', 'scope-a')
    expect(conn.prepare('SELECT build_checkpoint_json FROM session_projection_state WHERE session_id=? AND scope_key=?')
      .get('session-a', 'scope-a')).toEqual({ build_checkpoint_json: null })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_projection_state_rebuilding'").get())
      .toEqual({ name: 'idx_session_projection_state_rebuilding' })
    expect(conn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '115' })
    conn.close()
  })
})
