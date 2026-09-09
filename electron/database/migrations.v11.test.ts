import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DB_SCHEMA_VERSION, MIGRATION_V6_TURN_CHECKPOINT_SQL, MIGRATION_V11_TURN_CONTEXT_SQL, MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL, SCHEMA_META_KEYS } from './schema'
import { DatabaseUpgradeRequiredError, runMigrations } from './migrations'
import { getSchemaMeta } from './sqliteStore'

function createV10Database(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '10');
    CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return conn
}

describe('schema v11-v13 turn context, execution config, and routing index migrations', () => {
  it('当前 schema version 与最新 DDL 保持一致', () => {
    expect(DB_SCHEMA_VERSION).toBe(13)
  })

  it('将 v10 的 turn context 字段升级到 v11 并更新 metadata', () => {
    const conn = createV10Database()
    runMigrations(conn)

    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('13')
    expect((conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('exclude_message_ids_json')
    expect(() => runMigrations(conn)).not.toThrow()
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('13')
    conn.close()
  })

  it('修复已提前添加 v11 字段但 metadata 仍为 v10 的开发数据库', () => {
    const conn = createV10Database()
    conn.exec(MIGRATION_V6_TURN_CHECKPOINT_SQL)
    conn.exec(MIGRATION_V11_TURN_CONTEXT_SQL)

    expect(() => runMigrations(conn)).not.toThrow()
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('13')
    expect((conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).filter((column) => column.name === 'exclude_message_ids_json')).toHaveLength(1)
    conn.close()
  })

  it('将 v11 数据库升级到 v12 execution config 并保持幂等', () => {
    const conn = createV10Database()
    conn.exec(MIGRATION_V11_TURN_CONTEXT_SQL)
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('11', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('13')
    expect((conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map((column) => column.name)).toContain('execution_config_json')
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('为 v12 数据库添加 turn routing 查询索引', () => {
    const conn = createV10Database()
    conn.exec(MIGRATION_V6_TURN_CHECKPOINT_SQL)
    conn.exec(MIGRATION_V11_TURN_CONTEXT_SQL)
    conn.exec(MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL)
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('12', SCHEMA_META_KEYS.schemaVersion)

    runMigrations(conn)

    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('13')
    const indexNames = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turns'").all() as Array<{ name: string }>).map((index) => index.name)
    expect(indexNames).toContain('idx_turns_session_assistant_state')
    expect(indexNames).toContain('idx_turns_session_user')
    conn.close()
  })

  it('拒绝高于 v13 的数据库', () => {
    const conn = new DatabaseSync(':memory:')
    conn.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '14');
    `)
    expect(() => runMigrations(conn)).toThrow(DatabaseUpgradeRequiredError)
    conn.close()
  })
})
