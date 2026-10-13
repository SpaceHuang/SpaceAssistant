import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'

function dbAt94(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES('${SCHEMA_META_KEYS.schemaVersion}','94');
    CREATE TABLE app_config(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
    CREATE TABLE deferred_todos(todo_id TEXT PRIMARY KEY,channel TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO app_config VALUES('config.wechat','{"remoteConfirmPolicy":"remote_read_only","remoteSecurityConfigVersion":1}');`)
  return db
}

describe('IM policy snapshot schema migration', () => {
  it('creates the shared behavior snapshot table and is idempotent', () => {
    const db = dbAt94()
    runMigrations(db)
    const columns = (db.prepare('PRAGMA table_info(policy_behavior_snapshots)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining(['domain', 'policy_behavior_version', 'revision', 'snapshot_json', 'updated_at']))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining(['policy_behavior_snapshot_history', 'policy_authorization_epochs', 'policy_deferred_todos', 'policy_authorizations', 'policy_audit_events']))
    const version = () => db.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)
    expect(version()).toEqual({ value: String(DB_SCHEMA_VERSION) })
    expect(db.prepare("SELECT value FROM app_config WHERE key='config.wechat'").get()).toEqual({ value: '{"remoteConfirmPolicy":"remote_read_only","remoteSecurityConfigVersion":1}' })
    expect(() => runMigrations(db)).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='policy_behavior_snapshots'").get() as { count: number }).count).toBe(1)
    const deferredColumns = (db.prepare('PRAGMA table_info(deferred_todos)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(deferredColumns).toEqual(expect.arrayContaining(['policy_behavior_version', 'policy_revision', 'policy_epoch']))
    db.close()
  })

  it('rolls back schema version and migration DDL when the new index fails', () => {
    const db = dbAt94()
    db.exec('CREATE TABLE policy_behavior_snapshots(unexpected TEXT)')
    expect(() => runMigrations(db)).toThrow()
    expect(db.prepare('SELECT value FROM schema_meta WHERE key=?').get(SCHEMA_META_KEYS.schemaVersion)).toEqual({ value: '94' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_policy_behavior_domain_revision'").get()).toBeUndefined()
    db.close()
  })
})
