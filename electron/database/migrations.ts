import type Database from 'better-sqlite3'
import { ARTIFACT_V2_SQL, DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'

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

function readSchemaVersion(conn: Database.Database): number | undefined {
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion) as
    | { value: string }
    | undefined
  return parseSchemaVersion(row?.value)
}

export function runMigrations(conn: Database.Database): void {
  conn.transaction(() => {
    let version = readSchemaVersion(conn)
    if (version === undefined) {
      version = 1
      conn.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(SCHEMA_META_KEYS.schemaVersion, String(version))
    }
    if (version > DB_SCHEMA_VERSION) throw new DatabaseUpgradeRequiredError(version)
    if (version === 1) {
      conn.exec(ARTIFACT_V2_SQL)
      version = 2
      conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run(String(version), SCHEMA_META_KEYS.schemaVersion)
    }
  })()
}
