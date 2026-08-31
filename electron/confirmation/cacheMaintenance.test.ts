import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import type { AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { runStartupCacheCleanup, clearSessionScope } from './cacheMaintenance'
import type { CacheKey } from '../../src/shared/confirmation/types'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

const domainKey = (domain: string): CacheKey => ({ kind: 'domain', domain, level: 'domain-any-action' })

describe('cacheMaintenance（启动/会话清理钩子）', () => {
  it('runStartupCacheCleanup 清空会话级 + 清理过期/休眠', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    cache.record({
      id: 's',
      key: domainKey('session.example.com'),
      decision: 'allow',
      lane: '*',
      scope: 'session',
      createdAt: 1,
      lastHitAt: Date.now(),
      hitCount: 0,
      source: 'migration'
    })
    cache.record({
      id: 'p',
      key: domainKey('persist.example.com'),
      decision: 'allow',
      lane: '*',
      scope: 'persistent',
      createdAt: 1,
      lastHitAt: Date.now() - 181 * 24 * 3600 * 1000,
      hitCount: 0,
      source: 'migration'
    })
    const r = runStartupCacheCleanup(cache)
    expect(r.sessionCleared).toBe(1)
    expect(r.dormantCleared).toBe(1)
    expect(cache.lookup(domainKey('session.example.com'))).toBeNull()
    expect(cache.lookup(domainKey('persist.example.com'))).toBeNull()
  })

  it('clearSessionScope 清空全部会话级条目', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    const cache = new SqliteDecisionCache(getDbConnection(db))
    cache.record({
      id: 's',
      key: domainKey('a.com'),
      decision: 'allow',
      lane: '*',
      scope: 'session',
      createdAt: 1,
      lastHitAt: Date.now(),
      hitCount: 0,
      source: 'migration'
    })
    expect(clearSessionScope(cache)).toBe(1)
    expect(cache.lookup(domainKey('a.com'))).toBeNull()
  })
})
