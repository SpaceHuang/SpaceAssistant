import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  CREATE_TABLES_SQL,
  DB_SCHEMA_VERSION,
  MIGRATION_V11_TURN_CONTEXT_SQL,
  MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL,
  MIGRATION_V13_TURN_ROUTING_INDEXES_SQL,
  MIGRATION_V14_SESSION_OWNERSHIP_BACKFILL_SQL,
  MIGRATION_V15_BUTLER_TABLES_SQL,
  MIGRATION_V16_USAGE_STATS_SQL,
  MIGRATION_V17_SESSION_THINKING_EFFORT_SQL,
  MIGRATION_V4_TABLES_SQL,
  MIGRATION_V5_TURN_TABLE_SQL,
  MIGRATION_V6_TURN_CHECKPOINT_SQL,
  MIGRATION_V7_QUEUE_RECEIPT_SQL,
  MIGRATION_V8_TURN_START_TOKEN_SQL,
  MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL,
  SCHEMA_META_KEYS
} from './schema'
import { runMigrations } from './migrations'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from './sqliteStore'
import { createSession, getSession, updateSession, setConfigValue } from './operations'

const dirs: string[] = []
const dbPaths: string[] = []

afterEach(() => {
  for (const p of dbPaths) {
    try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ }
  }
  dbPaths.length = 0
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟，忽略 */ }
  }
  dirs.length = 0
})

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-effort-'))
  dirs.push(dir)
  const p = path.join(dir, 'test.db')
  dbPaths.push(p)
  return p
}

/** 构造一个 v16 形状的历史库（v3 基线 + v4..v16 迁移，未含 thinking_effort 列）。
 *  直接用 node:sqlite 原生打开，绕开 openSqliteDatabase 的自动迁移。 */
function createLegacyV16Database(dbPath: string): DatabaseSync {
  const c = new DatabaseSync(dbPath)
  c.exec(CREATE_TABLES_SQL)
  c.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run(SCHEMA_META_KEYS.schemaVersion, '3')
  c.exec(MIGRATION_V4_TABLES_SQL)
  c.exec(MIGRATION_V5_TURN_TABLE_SQL)
  c.exec(MIGRATION_V6_TURN_CHECKPOINT_SQL)
  c.exec(MIGRATION_V7_QUEUE_RECEIPT_SQL)
  c.exec(MIGRATION_V8_TURN_START_TOKEN_SQL)
  c.exec(MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL)
  c.exec(MIGRATION_V11_TURN_CONTEXT_SQL)
  c.exec(MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL)
  c.exec(MIGRATION_V13_TURN_ROUTING_INDEXES_SQL)
  c.exec('ALTER TABLE sessions ADD COLUMN ownership TEXT NOT NULL DEFAULT \'user\'')
  c.exec('ALTER TABLE sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT \'primary\'')
  c.exec(MIGRATION_V14_SESSION_OWNERSHIP_BACKFILL_SQL)
  c.exec(MIGRATION_V15_BUTLER_TABLES_SQL)
  c.exec(MIGRATION_V16_USAGE_STATS_SQL)
  c.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('16', SCHEMA_META_KEYS.schemaVersion)
  return c
}

function sessionColumns(db: AppDatabase): string[] {
  return (getDbConnection(db).prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name)
}

describe('V17 schema migration (sessions.thinking_effort)', () => {
  it('declares the new schema version 17', () => {
    expect(DB_SCHEMA_VERSION).toBe(17)
  })

  it('adds a nullable thinking_effort column when upgrading a v16 database', () => {
    const dbPath = tempDbPath()
    createLegacyV16Database(dbPath)
    const db = openSqliteDatabase(dbPath)
    expect(sessionColumns(db)).toContain('thinking_effort')
    const meta = getDbConnection(db).prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion) as { value: string }
    expect(meta.value).toBe('17')
    db.close()
  })

  it('leaves legacy sessions untouched (NULL = inherit global, no backfill)', () => {
    const dbPath = tempDbPath()
    const legacy = createLegacyV16Database(dbPath)
    legacy.prepare(
      'INSERT INTO sessions (id, name, preview, model, temperature, max_tokens, created_at, updated_at, message_count, skills_state, metadata, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('s1', '旧会话', '', 'm', 0.7, 4096, 1, 1, 0, '{}', '{}', 5)
    legacy.close()

    const db = openSqliteDatabase(dbPath)
    const row = getDbConnection(db).prepare('SELECT thinking_effort FROM sessions WHERE id = ?').get('s1') as { thinking_effort: string | null }
    expect(row.thinking_effort).toBeNull()
    expect(getSession(db, 's1')?.thinkingEffort).toBeUndefined()
    db.close()
  })

  it('is idempotent: a fresh database passes the full chain and reruns safely', () => {
    const dbPath = tempDbPath()
    const db = openSqliteDatabase(dbPath)
    expect(sessionColumns(db)).toContain('thinking_effort')
    expect(() => runMigrations(getDbConnection(db))).not.toThrow()
    db.close()
  })
})

describe('session thinkingEffort persistence', () => {
  it('createSession persists a draft effort (composer 草稿带入场景)', () => {
    const db = openSqliteDatabase(':memory:')
    const s = createSession(db, { name: 'n', thinkingEffort: 'low' })
    expect(getSession(db, s.id)?.thinkingEffort).toBe('low')
    db.close()
  })

  it('createSession without effort leaves the column NULL', () => {
    const db = openSqliteDatabase(':memory:')
    const s = createSession(db, { name: 'n' })
    expect(getSession(db, s.id)?.thinkingEffort).toBeUndefined()
    db.close()
  })

  it('updateSession persists the effort (whitelist must not silently drop it)', () => {
    const db = openSqliteDatabase(':memory:')
    const s = createSession(db, { name: 'n' })
    const updated = updateSession(db, s.id, { thinkingEffort: 'high' })
    expect(updated?.thinkingEffort).toBe('high')
    expect(getSession(db, s.id)?.thinkingEffort).toBe('high')
    db.close()
  })

  it('updateSession with null clears the override (清除覆盖 = 回到继承)', () => {
    const db = openSqliteDatabase(':memory:')
    const s = createSession(db, { name: 'n', thinkingEffort: 'low' })
    const updated = updateSession(db, s.id, { thinkingEffort: null })
    expect(updated?.thinkingEffort).toBeUndefined()
    const row = getDbConnection(db).prepare('SELECT thinking_effort FROM sessions WHERE id = ?').get(s.id) as { thinking_effort: string | null }
    expect(row.thinking_effort).toBeNull()
    db.close()
  })

  it('updateSession keeps the stored effort when the patch omits it', () => {
    const db = openSqliteDatabase(':memory:')
    const s = createSession(db, { name: 'n', thinkingEffort: 'high' })
    updateSession(db, s.id, { name: 'renamed' })
    expect(getSession(db, s.id)?.thinkingEffort).toBe('high')
    db.close()
  })

  it('normalizes a corrupted stored value to undefined instead of failing', () => {
    const dbPath = tempDbPath()
    const db = openSqliteDatabase(dbPath)
    const s = createSession(db, { name: 'n' })
    getDbConnection(db).prepare('UPDATE sessions SET thinking_effort = ? WHERE id = ?').run('bogus', s.id)
    expect(getSession(db, s.id)?.thinkingEffort).toBeUndefined()
    db.close()
  })

  it('independent sessions keep independent overrides (会话 A 低、会话 B 默认互不串)', () => {
    const db = openSqliteDatabase(':memory:')
    const a = createSession(db, { name: 'a', thinkingEffort: 'low' })
    const b = createSession(db, { name: 'b' })
    expect(getSession(db, a.id)?.thinkingEffort).toBe('low')
    expect(getSession(db, b.id)?.thinkingEffort).toBeUndefined()
    db.close()
  })

  it('setConfigValue round-trips the global effort key', () => {
    const db = openSqliteDatabase(':memory:')
    setConfigValue(db, 'config.thinkingEffort', 'high')
    const raw = getDbConnection(db).prepare('SELECT value FROM configs WHERE key = ?').get('config.thinkingEffort') as { value: string }
    expect(raw.value).toBe('high')
    db.close()
  })
})

describe('MIGRATION_V17_SESSION_THINKING_EFFORT_SQL shape', () => {
  it('is exported for the migration chain', () => {
    expect(MIGRATION_V17_SESSION_THINKING_EFFORT_SQL).toContain('thinking_effort')
  })
})
