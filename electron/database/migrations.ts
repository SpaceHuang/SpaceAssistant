import type { DatabaseSync } from 'node:sqlite'
import { CREATE_TABLES_SQL, DB_SCHEMA_VERSION, MIGRATION_V4_TABLES_SQL, MIGRATION_V5_TURN_TABLE_SQL, MIGRATION_V6_TURN_CHECKPOINT_SQL, MIGRATION_V7_QUEUE_RECEIPT_SQL, MIGRATION_V8_TURN_START_TOKEN_SQL, MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL, MIGRATION_V10_TURN_TERMINAL_USAGE_SQL, MIGRATION_V11_TURN_CONTEXT_SQL, MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL, MIGRATION_V13_TURN_ROUTING_INDEXES_SQL, SCHEMA_META_KEYS } from './schema'
import { runInTransaction } from './transaction'

export class DatabaseUpgradeRequiredError extends Error {
  constructor(foundVersion: number) {
    super(`数据库版本 ${foundVersion} 高于当前应用支持的版本 ${DB_SCHEMA_VERSION}；请升级应用后重试。`)
    this.name = 'DatabaseUpgradeRequiredError'
  }
}

function parseSchemaVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid database schema version: ${value}`)
  return Number(value)
}

function readSchemaVersion(conn: DatabaseSync): number | undefined {
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion) as
    | { value: string }
    | undefined
  return parseSchemaVersion(row?.value)
}

export function runMigrations(conn: DatabaseSync): void {
  runInTransaction(conn, () => {
    let version = readSchemaVersion(conn)
    if (version === undefined) {
      version = 1
      conn.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(SCHEMA_META_KEYS.schemaVersion, String(version))
    }
    if (version > DB_SCHEMA_VERSION) {
      throw new DatabaseUpgradeRequiredError(version)
    }
    if (version === 1) {
      conn.exec(CREATE_TABLES_SQL)
      version = 3
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 2) {
      conn.exec('DROP TABLE IF EXISTS artifact_operations')
      conn.exec('DROP TABLE IF EXISTS artifact_references')
      conn.exec('DROP TABLE IF EXISTS session_artifacts')
      version = 3
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 3) {
      // 工具确认机制框架（P3）：决策缓存表 + 用户规则覆盖表
      conn.exec(MIGRATION_V4_TABLES_SQL)
      version = 4
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 4) {
      conn.exec(MIGRATION_V5_TURN_TABLE_SQL)
      version = 5
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 5) {
      conn.exec(MIGRATION_V6_TURN_CHECKPOINT_SQL)
      version = 6
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 6) {
      conn.exec(MIGRATION_V7_QUEUE_RECEIPT_SQL)
      version = 7
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 7) {
      conn.exec(MIGRATION_V8_TURN_START_TOKEN_SQL)
      version = 8
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 8) {
      conn.exec(MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL)
      version = 9
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 9) {
      conn.exec(MIGRATION_V10_TURN_TERMINAL_USAGE_SQL)
      version = 10
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 10) {
      const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'exclude_message_ids_json')) {
        conn.exec(MIGRATION_V11_TURN_CONTEXT_SQL)
      }
      version = 11
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 11) {
      const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'execution_config_json')) {
        conn.exec(MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL)
      }
      version = 12
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
    if (version === 12) {
      conn.exec(MIGRATION_V13_TURN_ROUTING_INDEXES_SQL)
      // 容忍早期开发库元数据与列定义不一致；正式 v12 库都具备该列。
      const columns = conn.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>
      if (columns.some((column) => column.name === 'user_message_id')) {
        conn.exec('CREATE INDEX IF NOT EXISTS idx_turns_session_user ON turns(session_id, user_message_id)')
      }
      version = 13
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
  })
}
