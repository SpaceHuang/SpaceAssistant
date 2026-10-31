import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('session history transition state migration', () => {
  it('adds nullable transition state to existing streams and leaves it untrusted until repaired', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-history-transition-state-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'session.db')
    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(String(DB_SCHEMA_VERSION - 1), SCHEMA_META_KEYS.schemaVersion)
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id)
      VALUES('legacy-invocation',3,1,'legacy-session')`).run()
    db.close()

    const upgraded = openSqliteDatabase(dbPath)
    const upgradedConn = getDbConnection(upgraded)
    expect(upgradedConn.prepare('SELECT transition_state_version,transition_state_json FROM agent_history_streams WHERE invocation_id=?')
      .get('legacy-invocation')).toEqual({ transition_state_version: null, transition_state_json: null })
    expect((upgradedConn.prepare('PRAGMA table_info(agent_history_streams)').all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(expect.arrayContaining(['transition_state_version', 'transition_state_json']))
    expect(upgradedConn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion))
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    upgraded.close()
  })
})

describe('session transcript context selection migration', () => {
  it('adds a nullable protocol selection column without rewriting legacy snapshots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-transcript-selection-'))
    dirs.push(dir)
    const db = openSqliteDatabase(path.join(dir, 'session.db'))
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at)
      VALUES('legacy','turn',0,1,'completed','[{"role":"user","content":"legacy"}]',1)`).run()
    conn.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('118', SCHEMA_META_KEYS.schemaVersion)
    db.close()

    const upgraded = openSqliteDatabase(path.join(dir, 'session.db'))
    const upgradedConn = getDbConnection(upgraded)
    expect(upgradedConn.prepare('SELECT messages_json,context_selection_json FROM session_transcript_entries WHERE session_id=?')
      .get('legacy')).toEqual({ messages_json: '[{"role":"user","content":"legacy"}]', context_selection_json: null })
    expect(upgradedConn.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion))
      .toEqual({ value: String(DB_SCHEMA_VERSION) })
    upgraded.close()
  })
})
