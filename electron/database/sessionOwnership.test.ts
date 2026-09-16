import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSession,
  listSessions,
  searchMessages,
  openDatabase
} from '../database'
import { DatabaseSync } from 'node:sqlite'
import { getDbConnection } from './sqliteStore'
import {
  CREATE_TABLES_SQL,
  MIGRATION_V4_TABLES_SQL,
  MIGRATION_V5_TURN_TABLE_SQL,
  MIGRATION_V6_TURN_CHECKPOINT_SQL,
  MIGRATION_V7_QUEUE_RECEIPT_SQL,
  MIGRATION_V8_TURN_START_TOKEN_SQL,
  MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL,
  MIGRATION_V10_TURN_TERMINAL_USAGE_SQL,
  MIGRATION_V11_TURN_CONTEXT_SQL,
  MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL,
  MIGRATION_V13_TURN_ROUTING_INDEXES_SQL,
  SCHEMA_META_KEYS
} from './schema'

const dirs: string[] = []
const dbPaths: string[] = []

afterEach(() => {
  for (const p of dbPaths) {
    try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ }
  }
  dbPaths.length = 0
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ownership-'))
  dirs.push(dir)
  const p = path.join(dir, 'test.db')
  dbPaths.push(p)
  return p
}

/** 构造一个 v13 形状的历史库（v3 基线 + v4..v13 迁移，未含 ownership/visibility 列）。
 *  直接用 node:sqlite 原生打开，绕开 openSqliteDatabase 的自动迁移。 */
function createLegacyV13Database(dbPath: string): void {
  const c = new DatabaseSync(dbPath)
  c.exec(CREATE_TABLES_SQL)
  c.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run(SCHEMA_META_KEYS.schemaVersion, '3')
  c.exec(MIGRATION_V4_TABLES_SQL)
  c.exec(MIGRATION_V5_TURN_TABLE_SQL)
  c.exec(MIGRATION_V6_TURN_CHECKPOINT_SQL)
  c.exec(MIGRATION_V7_QUEUE_RECEIPT_SQL)
  c.exec(MIGRATION_V8_TURN_START_TOKEN_SQL)
  c.exec(MIGRATION_V9_TURN_RECOVERY_FIELDS_SQL)
  c.exec(MIGRATION_V10_TURN_TERMINAL_USAGE_SQL)
  c.exec(MIGRATION_V11_TURN_CONTEXT_SQL)
  c.exec(MIGRATION_V12_TURN_EXECUTION_CONFIG_SQL)
  c.exec(MIGRATION_V13_TURN_ROUTING_INDEXES_SQL)
  c.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('13', SCHEMA_META_KEYS.schemaVersion)
  // 三条历史会话：普通 / 飞书来源 / 微信来源
  const insert = c.prepare(
    `INSERT INTO sessions (id, name, preview, model, llm_service_id, temperature, max_tokens,
      created_at, updated_at, message_count, skills_state, metadata, schema_version, work_dir_profile_id)
     VALUES (?, ?, '', 'm', NULL, 0.7, 4096, 1, 2, 0, '{}', ?, 1, NULL)`
  )
  insert.run('s-user', '普通会话', '{}')
  insert.run('s-feishu', '[飞书] 你好', JSON.stringify({ source: 'feishu', feishuChatId: 'c1' }))
  insert.run('s-wechat', '[微信] 在吗', JSON.stringify({ source: 'wechat', isRemote: true }))
  c.close()
}

describe('偏差 7：sessions 归属与可见性', () => {
  it('v13 → v14 迁移：新增两列、存量默认 user/primary、IM 来源会话回填 remote', () => {
    const dbPath = tempDbPath()
    createLegacyV13Database(dbPath)
    const db = openDatabase(dbPath)
    const conn = getDbConnection(db)
    const cols = (conn.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('ownership')
    expect(cols).toContain('visibility')
    const rows = conn.prepare('SELECT id, ownership, visibility FROM sessions ORDER BY id').all() as Array<{ id: string; ownership: string; visibility: string }>
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('s-user')).toMatchObject({ ownership: 'user', visibility: 'primary' })
    expect(byId.get('s-feishu')).toMatchObject({ ownership: 'remote', visibility: 'primary' })
    expect(byId.get('s-wechat')).toMatchObject({ ownership: 'remote', visibility: 'primary' })
    db.close()
  })

  it('createSession 默认归属 user/primary，显式声明 automation/section 可持久化', () => {
    const db = openDatabase(':memory:')
    const def = createSession(db, { name: '默认' })
    expect(def.ownership).toBe('user')
    expect(def.visibility).toBe('primary')
    const butler = createSession(db, { name: '管家', ownership: 'automation', visibility: 'section' })
    expect(butler.ownership).toBe('automation')
    expect(butler.visibility).toBe('section')
    const internal = createSession(db, { name: '内部', ownership: 'internal', visibility: 'hidden' })
    expect(internal.ownership).toBe('internal')
    db.close()
  })

  it('listSessions 默认全量（内部调用方语义不变），user-visible 视图排除 internal/hidden、保留 section', () => {
    const db = openDatabase(':memory:')
    createSession(db, { name: '用户' })
    createSession(db, { name: '管家', ownership: 'automation', visibility: 'section' })
    createSession(db, { name: '内部', ownership: 'internal', visibility: 'hidden' })
    createSession(db, { name: '隐藏', ownership: 'user', visibility: 'hidden' })
    const all = listSessions(db)
    expect(all.map((s) => s.name).sort()).toEqual(['内部', '用户', '管家', '隐藏'].sort())
    const visible = listSessions(db, { view: 'user-visible' })
    expect(visible.map((s) => s.name).sort()).toEqual(['用户', '管家'].sort())
    db.close()
  })

  it('跨会话搜索排除 ownership=internal 会话', () => {
    const db = openDatabase(':memory:')
    const visible = createSession(db, { name: '可见' })
    const internal = createSession(db, { name: '内部', ownership: 'internal', visibility: 'hidden' })
    const conn = getDbConnection(db)
    const insertMsg = conn.prepare(
      `INSERT INTO messages (id, session_id, role, content, tool_use, tool_calls, thinking, content_segments, skill_hints, attachments, images_delivered_to_api, status, schema_version, timestamp, sequence)
       VALUES (?, ?, 'user', '.secret-keyword-', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'completed', 1, 1, 0)`
    )
    insertMsg.run('m-visible', visible.id)
    insertMsg.run('m-internal', internal.id)
    const hits = searchMessages(db, 'secret-keyword', '', 50)
    expect(hits.map((h) => h.sessionId)).toEqual([visible.id])
    db.close()
  })
})
