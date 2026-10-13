import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { runMigrations } from './migrations'
import { DB_SCHEMA_VERSION } from './schema'
import { isRemoteAsyncApprovalGateEnabled, CURRENT_REMOTE_ASYNC_APPROVAL_BEHAVIOR_VERSION } from '../confirmation/remoteAsyncApprovalGate'

describe('deferred resume request migration', () => {
  it('adds per-message IM platform context from schema version 80', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE im_inbox_message_context')
    conn.prepare("UPDATE schema_meta SET value='80' WHERE key='schema_version'").run()

    runMigrations(conn)

    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='im_inbox_message_context'").get())
      .toEqual({ name: 'im_inbox_message_context' })
    db.close()
  })

  it('migrates version 74 to a durable, scoped resume request journal', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE deferred_resume_requests')
    conn.prepare("UPDATE schema_meta SET value='74' WHERE key='schema_version'").run()
    runMigrations(conn)

    expect(DB_SCHEMA_VERSION).toBe(97)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare("SELECT state,close_required FROM remote_async_approval_gate_state WHERE singleton=1").get())
      .toEqual({ state: 'disabled', close_required: 0 })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_resume_requests'").get())
      .toEqual({ name: 'deferred_resume_requests' })
    const columns = conn.prepare('PRAGMA table_info(deferred_resume_requests)').all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toContain('reason_key')
    expect(columns.map(({ name }) => name)).toContain('notification_version')
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_approval_ingress_receipts'").get())
      .toEqual({ name: 'deferred_approval_ingress_receipts' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_approval_code_counters'").get())
      .toEqual({ name: 'deferred_approval_code_counters' })
    db.close()
  })

  it('migrates version 77 to a durable approval notification delivery ledger', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE deferred_approval_notifications')
    conn.prepare("UPDATE schema_meta SET value='77' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    const columns = conn.prepare('PRAGMA table_info(deferred_approval_notifications)').all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'todo_id', 'notification_version', 'short_code', 'trusted_message_id', 'expires_at', 'dto_json', 'state'
    ]))
    db.close()
  })

  it('migrates version 78 to a disabled durable async approval gate', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.prepare("UPDATE schema_meta SET value='78' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(conn.prepare("SELECT state,close_required FROM remote_async_approval_gate_state WHERE singleton=1").get())
      .toEqual({ state: 'disabled', close_required: 0 })
    db.close()
  })

  it('migrates version 96 gate state without trusting an enabled row that lacks a behavior version', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.prepare("UPDATE remote_async_approval_gate_state SET state='enabled' WHERE singleton=1").run()
    conn.exec('ALTER TABLE remote_async_approval_gate_state DROP COLUMN behavior_version')
    conn.prepare("UPDATE schema_meta SET value='96' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '97' })
    expect(conn.prepare('SELECT state,close_required,behavior_version FROM remote_async_approval_gate_state WHERE singleton=1').get())
      .toEqual({ state: 'enabled', close_required: 0, behavior_version: '' })
    expect(isRemoteAsyncApprovalGateEnabled(db, CURRENT_REMOTE_ASYNC_APPROVAL_BEHAVIOR_VERSION)).toBe(false)
    db.close()
  })
})
