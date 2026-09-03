import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import type { AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import {
  clearDecisionCacheOnSessionDelete,
  runStartupDecisionCacheCleanup
} from './cacheMaintenanceHooks'
import type { CacheKey } from '../../src/shared/confirmation/types'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

const domainKey = (domain: string): CacheKey => ({ kind: 'domain', domain, level: 'domain-any-action' })

function seedEntry(
  cache: SqliteDecisionCache,
  id: string,
  domain: string,
  scope: 'session' | 'persistent',
  lastHitAt = Date.now()
): void {
  cache.record({
    id,
    key: domainKey(domain),
    decision: 'allow',
    lane: '*',
    scope,
    createdAt: 1,
    lastHitAt,
    hitCount: 0,
    source: 'migration'
  })
}

describe('cacheMaintenanceHooks（启动/会话删除接线小函数）', () => {
  it('runStartupDecisionCacheCleanup 清空会话级 + 清理休眠条目并返回计数', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    seedEntry(cache, 's', 'session.example.com', 'session')
    seedEntry(cache, 'd', 'dormant.example.com', 'persistent', Date.now() - 181 * 24 * 3600 * 1000)
    seedEntry(cache, 'p', 'keep.example.com', 'persistent')

    const r = runStartupDecisionCacheCleanup(db)
    expect(r).not.toBeNull()
    expect(r!.sessionCleared).toBe(1)
    expect(r!.dormantCleared).toBe(1)
    expect(cache.lookup(domainKey('session.example.com'))).toBeNull()
    expect(cache.lookup(domainKey('dormant.example.com'))).toBeNull()
    expect(cache.lookup(domainKey('keep.example.com'))).not.toBeNull()
  })

  it('clearDecisionCacheOnSessionDelete 清空会话级条目、保留持久条目', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    seedEntry(cache, 's1', 'a.example.com', 'session')
    seedEntry(cache, 's2', 'b.example.com', 'session')
    seedEntry(cache, 'p', 'keep.example.com', 'persistent')

    expect(clearDecisionCacheOnSessionDelete(db, 'session-1')).toBe(2)
    expect(cache.lookup(domainKey('a.example.com'))).toBeNull()
    expect(cache.lookup(domainKey('b.example.com'))).toBeNull()
    expect(cache.lookup(domainKey('keep.example.com'))).not.toBeNull()
  })
})
