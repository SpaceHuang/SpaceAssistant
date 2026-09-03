import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { getDbConnection, openSqliteDatabase } from '../database'
import { getSchemaMeta } from './sqliteStore'
import { SCHEMA_META_KEYS } from './schema'
import { DatabaseUpgradeRequiredError, runMigrations } from './migrations'

const V4_TABLES = ['decision_cache', 'policy_rules'] as const
const dirs: string[] = []

function tableNames(conn: ReturnType<typeof getDbConnection>): string[] {
  return (
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((r) => r.name)
}

describe('schema v4 migrations (确认框架表)', () => {
  it('全新库（v1 路径）迁移后落在 v4 并创建 decision_cache / policy_rules', () => {
    const db = openSqliteDatabase(':memory:')
    const conn = getDbConnection(db)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('4')
    const tables = tableNames(conn)
    expect(tables).toContain('decision_cache')
    expect(tables).toContain('policy_rules')
    db.close()
  })

  it('升级 v3 库到 v4：保留会话/配置，补建两表', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v4-upgrade-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    // 手工构造 v3 库（openSqliteDatabase 会直接迁移到 v4，不能用于准备 v3 状态）
    const v3 = new DatabaseSync(dbPath)
    v3.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE configs (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');
    `)
    v3.prepare("INSERT INTO configs (key, value, created_at, updated_at) VALUES ('config.locale', '\"zh-CN\"', 1, 1)").run()
    v3.close()

    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('4')
    expect((conn.prepare('SELECT COUNT(*) AS c FROM configs').get() as { c: number }).c).toBe(1)
    expect(tableNames(conn)).toEqual(expect.arrayContaining([...V4_TABLES]))
    db.close()
  })

  it('重复启动在 v4 库上是幂等 no-op', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v4-idem-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    openSqliteDatabase(dbPath).close()
    const second = openSqliteDatabase(dbPath)
    const conn = getDbConnection(second)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('4')
    expect(tableNames(conn)).toEqual(expect.arrayContaining([...V4_TABLES]))
    second.close()
  })

  it('runMigrations 对 v4 库直接调用为幂等（不报错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v4-runidem-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)
    expect(() => runMigrations(conn)).not.toThrow()
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('4')
    db.close()
  })

  it('高版本库即使包含当前应用依赖的表也必须拒绝打开', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-future-version-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const future = new DatabaseSync(dbPath)
    future.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE configs (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, temperature REAL NOT NULL, max_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, skills_state TEXT NOT NULL, metadata TEXT NOT NULL, schema_version INTEGER NOT NULL, work_dir_profile_id TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, schema_version INTEGER NOT NULL, timestamp INTEGER NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE search_history (id TEXT PRIMARY KEY NOT NULL, query TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE session_usages (session_id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '7');
    `)
    future.close()

    expect(() => openSqliteDatabase(dbPath)).toThrow(DatabaseUpgradeRequiredError)
  })
})

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 文件锁偶发；忽略
    }
  }
})
