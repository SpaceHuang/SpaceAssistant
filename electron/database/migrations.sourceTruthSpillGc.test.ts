import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'

describe('source-truth spill GC migrations v39-v48', () => {
  it('upgrades v38 with a durable queue and resumable directory scan state', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
      INSERT INTO schema_meta(key,value) VALUES('schema_version','38');`)

    runMigrations(conn)

    expect(DB_SCHEMA_VERSION).toBe(82)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare('PRAGMA table_info(source_truth_spill_gc_queue)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'locator', pk: 1 }),
      expect.objectContaining({ name: 'session_id' }),
      expect.objectContaining({ name: 'generation' }),
      expect.objectContaining({ name: 'status' }),
      expect.objectContaining({ name: 'attempts' }),
      expect.objectContaining({ name: 'last_error' })
    ]))
    expect(conn.prepare('PRAGMA foreign_key_list(source_truth_spill_gc_queue)').all()).toEqual([])
    expect(conn.prepare('SELECT root_key,status,after_name,attempts FROM source_truth_spill_gc_scan_state').all()).toEqual([
      { root_key: 'user-data-spill', status: 'pending', after_name: null, attempts: 0 }
    ])

    conn.prepare(`INSERT INTO source_truth_spill_gc_queue(locator,session_id,generation,created_at,updated_at)
      VALUES('01234567-89ab-cdef-0123-456789abcdef.spill','deleted-session','generation-1',1,1)`).run()
    runMigrations(conn)
    expect(conn.prepare('SELECT session_id,generation,locator,status,attempts FROM source_truth_spill_gc_queue').all()).toEqual([{
      session_id: 'deleted-session', generation: 'generation-1', locator: '01234567-89ab-cdef-0123-456789abcdef.spill', status: 'pending', attempts: 0
    }])
    conn.prepare("UPDATE source_truth_spill_gc_scan_state SET after_name='resume-here.spill' WHERE root_key='user-data-spill'").run()
    runMigrations(conn)
    expect(conn.prepare('SELECT status,after_name FROM source_truth_spill_gc_scan_state').get()).toEqual({ status: 'pending', after_name: 'resume-here.spill' })
    conn.close()
  })
})
