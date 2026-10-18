import { describe, expect, it } from 'vitest'
import { getDbConnection, getSchemaMeta, type AppDatabase } from './sqliteStore'
import { openDatabase } from './index'
import { DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'
import { runMigrations } from './migrations'

function createMigratedDb(): AppDatabase {
  return openDatabase(':memory:')
}

describe('wiki_projects 表迁移（v83，T0.3）', () => {
  it('当前 schema 包含 wiki_projects v83 迁移', () => {
    expect(DB_SCHEMA_VERSION).toBe(104)
  })

  it('v82 旧库升级后 wiki_projects 表结构正确且幂等', () => {
    const db = createMigratedDb()
    const conn = getDbConnection(db)

    // 模拟 v82 存量库：表尚未创建、版本标记回退
    conn.exec('DROP TABLE IF EXISTS wiki_projects;')
    conn.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('82', SCHEMA_META_KEYS.schemaVersion)

    expect(() => runMigrations(conn)).not.toThrow()
    expect(getSchemaMeta(conn, SCHEMA_META_KEYS.schemaVersion)).toBe(String(DB_SCHEMA_VERSION))

    const columns = (conn.prepare('PRAGMA table_info(wiki_projects)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['project_id', 'work_dir', 'display_name', 'profile_id', 'first_seen_at', 'orphan']))

    const pk = (conn.prepare('PRAGMA table_info(wiki_projects)').all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0)
    expect(pk.map((c) => c.name)).toEqual(['project_id'])

    // work_dir UNIQUE 约束存在
    const indexes = conn.prepare('PRAGMA index_list(wiki_projects)').all() as Array<{ name: string; unique: number }>
    const uniqueIndex = indexes.find((idx) => idx.unique === 1)
    expect(uniqueIndex).toBeDefined()
    const uniqueColumns = (
      conn.prepare(`PRAGMA index_info(${uniqueIndex!.name})`).all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(uniqueColumns).toEqual(['work_dir'])

    // 幂等：重复执行不抛错
    expect(() => runMigrations(conn)).not.toThrow()
    conn.close()
  })
})
