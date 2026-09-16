import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import type { CacheKey } from '../../src/shared/confirmation/types'

/** 评审非阻断项：record 以 keyJson 为主键跨 lane upsert——后写覆盖前写。
 *  查询侧已按 lane 隔离（P2），写入侧 (lane, key) 应可共存。 */
const shells: AppDatabase[] = []
afterEach(() => shells.splice(0).forEach((db) => db.close()))

describe('decision_cache 跨 lane 写入共存（评审观察项）', () => {
  it('同 key 不同 lane 的记录互不覆盖，各自可查', () => {
    const db = openSqliteDatabase(':memory:')
    shells.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const key: CacheKey = { kind: 'path', path: 'a.txt', level: 'file' }

    cache.record({ id: 'w1', key, decision: 'allow', lane: 'desktop', scope: 'persistent', createdAt: 1, lastHitAt: Date.now(), hitCount: 0, source: 'user-confirm' })
    cache.record({ id: 'w2', key, decision: 'deny', lane: 'feishu', scope: 'session', createdAt: 2, lastHitAt: Date.now(), hitCount: 0, source: 'user-confirm' })

    expect(cache.lookup(key, 'desktop')?.decision).toBe('allow')
    expect(cache.lookup(key, 'feishu')?.decision).toBe('deny')
  })

  it('同 lane 同 key 仍为 upsert 语义（后写更新前写，不堆行）', () => {
    const db = openSqliteDatabase(':memory:')
    shells.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const key: CacheKey = { kind: 'path', path: 'b.txt', level: 'file' }
    const conn = getDbConnection(db)

    cache.record({ id: 'w3', key, decision: 'deny', lane: 'desktop', scope: 'session', createdAt: 1, lastHitAt: Date.now(), hitCount: 0, source: 'user-confirm' })
    cache.record({ id: 'w4', key, decision: 'allow', lane: 'desktop', scope: 'persistent', createdAt: 2, lastHitAt: Date.now(), hitCount: 0, source: 'user-confirm' })

    expect(cache.lookup(key, 'desktop')?.decision).toBe('allow')
    const rows = conn.prepare('SELECT COUNT(*) AS c FROM decision_cache WHERE key_json = ?').get(JSON.stringify({ kind: 'path', level: 'file', path: 'b.txt' })) as { c: number }
    expect(rows.c).toBe(1)
  })
})
