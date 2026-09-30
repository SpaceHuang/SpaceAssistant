import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'

/**
 * v18 → v19：归因扩列（AD23 / AD24 / §7.6.3 方案 B1）。
 * 不新增表、不改 UNIQUE 键；老行新列为 NULL，统计侧按「无归因数据」降级。
 */

/** 最小 v18 库：schema_meta version=18 + v16 已建的两张统计表（含既有行）。 */
function createV18Database(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '18');
    CREATE TABLE usage_step_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      day TEXT NOT NULL,
      model TEXT,
      llm_service_id TEXT,
      app_version TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_semantics TEXT,
      source TEXT NOT NULL DEFAULT 'api',
      UNIQUE(session_id, turn_id, step_id)
    );
    CREATE TABLE usage_turn_facts (
      turn_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      day TEXT NOT NULL,
      model TEXT,
      llm_service_id TEXT,
      app_version TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_error_count INTEGER NOT NULL DEFAULT 0,
      tool_skipped_count INTEGER NOT NULL DEFAULT 0,
      outcome TEXT
    );
    INSERT INTO usage_step_facts (session_id, turn_id, step_id, created_at, day, input_tokens)
      VALUES ('old-sess', 'old-turn', 'old-step', 1, '2026-01-01', 42);
    INSERT INTO usage_turn_facts (turn_id, session_id, created_at, day, step_count, outcome)
      VALUES ('old-turn', 'old-sess', 1, '2026-01-01', 1, 'completed');
  `)
  return conn
}

function columnNames(conn: DatabaseSync, table: string): string[] {
  return (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

describe('v19 归因扩列迁移', () => {
  it('当前 schema version 为 19', () => {
    expect(DB_SCHEMA_VERSION).toBe(19)
  })

  it('v18 库升级后两张表各带归因新列，UNIQUE 键不变，重复迁移幂等', () => {
    const conn = createV18Database()
    runMigrations(conn)

    expect(conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion)).toMatchObject({ value: '19' })
    expect(columnNames(conn, 'usage_step_facts')).toEqual(
      expect.arrayContaining(['system_tokens', 'tools_tokens', 'message_tokens', 'estimator_version', 'attribution_json'])
    )
    expect(columnNames(conn, 'usage_turn_facts')).toEqual(expect.arrayContaining(['tool_attribution_json']))

    const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(tables.filter((t) => t.includes('usage'))).toHaveLength(2)

    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })

  it('存量行的新列为 NULL（无归因数据语义），既有数据不受影响', () => {
    const conn = createV18Database()
    runMigrations(conn)
    const stepRow = conn.prepare("SELECT * FROM usage_step_facts WHERE session_id = 'old-sess'").get() as Record<string, unknown>
    expect(stepRow.input_tokens).toBe(42)
    expect(stepRow.system_tokens).toBeNull()
    expect(stepRow.tools_tokens).toBeNull()
    expect(stepRow.message_tokens).toBeNull()
    expect(stepRow.estimator_version).toBeNull()
    expect(stepRow.attribution_json).toBeNull()
    const turnRow = conn.prepare("SELECT * FROM usage_turn_facts WHERE turn_id = 'old-turn'").get() as Record<string, unknown>
    expect(turnRow.tool_attribution_json).toBeNull()
    conn.close()
  })
})
