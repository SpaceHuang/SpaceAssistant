import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { getDbConnection, openSqliteDatabase } from '../database'
import { getSchemaMeta } from './sqliteStore'
import { SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'

const ARTIFACT_TABLES = ['session_artifacts', 'artifact_references', 'artifact_operations'] as const

function artifactTables(conn: ReturnType<typeof getDbConnection>): string[] {
  const rows = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all() as Array<{ name: string }>
  return rows.map((r) => r.name).filter((name) => (ARTIFACT_TABLES as readonly string[]).includes(name))
}

describe('schema v3 migrations (artifact table removal)', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows may transiently hold file locks; ignore cleanup failures.
      }
    }
  })

  it('creates a v3 database directly from v1 without artifact tables', () => {
    const db = openSqliteDatabase(':memory:')
    const conn = getDbConnection(db)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('3')
    expect(artifactTables(conn)).toEqual([])
    expect(
      conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_artifacts%'").all()
    ).toEqual([])
    db.close()
  })

  it('upgrades a v2 database with artifact tables to v3 and drops only the three artifact tables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v3-upgrade-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    // 手工构造 v2 数据库（openSqliteDatabase 会直接迁移，不能用于准备 v2 状态）
    const v2conn = new DatabaseSync(dbPath)
    v2conn.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE configs (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, preview TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
        temperature REAL NOT NULL, max_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL, skills_state TEXT NOT NULL, metadata TEXT NOT NULL, schema_version INTEGER NOT NULL
          , work_dir_profile_id TEXT
      );
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2');
      CREATE TABLE session_artifacts (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        work_dir_profile_id TEXT NOT NULL,
        workspace_root_real TEXT NOT NULL,
        container TEXT NOT NULL,
        role TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        canonical_path TEXT NOT NULL,
        path_identity_key TEXT NOT NULL,
        path_source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE artifact_references (
        artifact_id TEXT PRIMARY KEY NOT NULL,
        source_title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE artifact_operations (
        id TEXT PRIMARY KEY NOT NULL,
        artifact_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    // v2 库带存量数据：一条会话 + 一条配置 + 三张产物表
    v2conn
      .prepare(
        `INSERT INTO sessions (id, name, preview, model, temperature, max_tokens, created_at, updated_at, message_count, skills_state, metadata, schema_version)
         VALUES ('s1', 'keep', '', 'm', 0.7, 4096, 1, 2, 0, '{}', '{}', 1)`
      )
      .run()
    v2conn
      .prepare("INSERT INTO configs (key, value, created_at, updated_at) VALUES ('config.locale', '\"zh-CN\"', 1, 1)")
      .run()
    v2conn
      .prepare(
        `INSERT INTO session_artifacts (id, session_id, work_dir_profile_id, workspace_root_real, container, role, title, canonical_path, path_identity_key, path_source, status, created_at, updated_at)
         VALUES ('a1', 's1', 'default', 'C:/w', 'project', 'primary', 't', 'a.ts', 'k', 'agent-default', 'active', 1, 1)`
      )
      .run()
    v2conn
      .prepare("INSERT INTO artifact_references (artifact_id, source_title, source_url, fetched_at) VALUES ('a1', 't', 'https://x', 1)")
      .run()
    v2conn.close()

    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('3')
    expect(artifactTables(conn)).toEqual([])
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('3')
    expect((conn.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1)
    expect((conn.prepare('SELECT COUNT(*) AS c FROM configs').get() as { c: number }).c).toBe(1)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.migratedFromJsonAt)).toBeUndefined()
    db.close()
  })

  it('repeated startup on a v3 database is a no-op (idempotent)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v3-idem-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    openSqliteDatabase(dbPath).close()
    const second = openSqliteDatabase(dbPath)
    const conn = getDbConnection(second)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('3')
    expect(artifactTables(conn)).toEqual([])
    second.close()
  })

  it('upgrades a v2-marked database that never had artifact tables without error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v3-notables-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const v2 = openSqliteDatabase(dbPath)
    const v2conn = getDbConnection(v2)
    v2conn
      .prepare('DROP TABLE IF EXISTS artifact_references')
      .run()
    v2conn.prepare('DROP TABLE IF EXISTS artifact_operations').run()
    v2conn.prepare('DROP TABLE IF EXISTS session_artifacts').run()
    v2conn.close()

    const db = openSqliteDatabase(dbPath)
    const conn = getDbConnection(db)
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe('3')
    expect(artifactTables(conn)).toEqual([])
    db.close()
  })
})
