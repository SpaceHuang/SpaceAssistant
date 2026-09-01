import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase, type AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { getDbConnection } from '../database'
import { recordUserAnswerToCache } from './decisionCacheWriter'
import type { CacheKey } from '../../src/shared/confirmation/types'
import type { AuditSink } from './channels'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

const shells: AppDatabase[] = []

function open(): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  shells.push(db)
  return db
}

afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
})

function fakeAudit(): { sink: AuditSink; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { sink: { record: (e) => events.push(e) }, events }
}

describe('recordUserAnswerToCache', () => {
  it('shell-command 键带 90 天 TTL 写入，可 lookup 命中', () => {
    const db = open()
    const key: CacheKey = { kind: 'shell-command', verb: 'npm test', level: 'exact' }
    recordUserAnswerToCache({
      db,
      lane: 'desktop',
      sessionId: 's1',
      key,
      decision: 'allow',
      scope: 'persistent',
      source: 'user-confirm'
    })
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const hit = cache.lookup(key)
    expect(hit).not.toBeNull()
    expect(hit!.expiresAt).toBeTypeOf('number')
    // 90 天 ± 1 分钟容差
    const expected = Date.now() + 90 * 24 * 3600 * 1000
    expect(Math.abs(hit!.expiresAt! - expected)).toBeLessThan(60_000)
  })

  it('非 shell 键无 TTL', () => {
    const db = open()
    const key: CacheKey = { kind: 'domain', domain: 'example.com', level: 'domain-any-action' }
    recordUserAnswerToCache({
      db,
      lane: 'desktop',
      sessionId: 's1',
      key,
      decision: 'allow',
      scope: 'persistent',
      source: 'user-confirm'
    })
    const hit = new SqliteDecisionCache(getDbConnection(db)).lookup(key)
    expect(hit).not.toBeNull()
    expect(hit!.expiresAt).toBeUndefined()
  })

  it('经 AuditedDecisionCache 落 cache.write 审计事件', () => {
    const db = open()
    const { sink, events } = fakeAudit()
    const key: CacheKey = {
      kind: 'mcp-tool',
      serverId: 'srv',
      toolName: 'tool',
      sessionId: 's1'
    }
    recordUserAnswerToCache({
      db,
      audit: sink,
      lane: 'desktop',
      sessionId: 's1',
      key,
      decision: 'allow',
      scope: 'session',
      source: 'user-confirm'
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('cache.write')
    expect(events[0]!.sessionId).toBe('s1')
    expect(events[0]!.lane).toBe('desktop')
  })

  it('deny 决定也能写入（IM 拒绝记忆预留）', () => {
    const db = open()
    const key: CacheKey = { kind: 'domain', domain: 'evil.com', level: 'domain+action' }
    recordUserAnswerToCache({
      db,
      lane: 'feishu',
      sessionId: 's2',
      key,
      decision: 'deny',
      scope: 'persistent',
      source: 'user-confirm'
    })
    const hit = new SqliteDecisionCache(getDbConnection(db)).lookup(key)
    expect(hit!.decision).toBe('deny')
    expect(hit!.lane).toBe('feishu')
  })
})
