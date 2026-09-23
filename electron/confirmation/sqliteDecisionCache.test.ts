import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import type { AppDatabase } from '../database'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
import { clearAllMcpSessionTrust, rememberMcpSessionTrust } from '../mcp/mcpSessionTrust'
import type { CacheKey, DecisionCacheEntry } from '../../src/shared/confirmation/types'

const shells: AppDatabase[] = []

function open(): {
  cache: SqliteDecisionCache
  raw: ReturnType<typeof getDbConnection>
  db: AppDatabase
} {
  const db = openSqliteDatabase(':memory:')
  shells.push(db)
  const raw = getDbConnection(db)
  return { cache: new SqliteDecisionCache(raw), raw, db }
}

afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
  clearAllMcpSessionTrust()
})

const shellKey = (verb = 'ping baidu.com'): CacheKey => ({
  kind: 'shell-command',
  verb,
  level: 'exact'
})

function entry(overrides: Partial<DecisionCacheEntry> = {}): DecisionCacheEntry {
  const now = Date.now()
  return {
    id: shellKey().kind + '-id',
    key: shellKey(),
    decision: 'allow',
    lane: '*',
    scope: 'persistent',
    createdAt: now,
    lastHitAt: now,
    hitCount: 0,
    source: 'user-confirm',
    ...overrides
  }
}

describe('SqliteDecisionCache', () => {
  it('record 后能被 lookup 命中，命中递增 hit_count', () => {
    const { cache } = open()
    cache.record(entry())
    const hit = cache.lookup(shellKey())
    expect(hit).not.toBeNull()
    expect(hit!.decision).toBe('allow')
    expect(hit!.hitCount).toBe(1)
    const again = cache.lookup(shellKey())
    expect(again!.hitCount).toBe(2)
  })

  it('未记录的键 → null', () => {
    const { cache } = open()
    expect(cache.lookup({ kind: 'shell-command', verb: 'rm -rf', level: 'exact' })).toBeNull()
  })

  it('MCP 会话信任只命中绑定的 session/server/tool，且 automation 不继承', () => {
    const { cache } = open()
    const key: CacheKey = { kind: 'mcp-tool', serverId: 'server-1', toolName: 'create_issue', sessionId: 'session-1' }
    rememberMcpSessionTrust('session-1', 'server-1', 'create_issue')
    expect(cache.lookup(key, 'desktop')).toMatchObject({ decision: 'allow', scope: 'session' })
    expect(cache.lookup({ ...key, sessionId: 'session-2' }, 'desktop')).toBeNull()
    expect(cache.lookup({ ...key, toolName: 'delete_issue' }, 'desktop')).toBeNull()
    expect(cache.lookup(key, 'automation')).toBeNull()
  })

  it('过期条目（expires_at 已过）视为未命中', () => {
    const { cache } = open()
    cache.record(entry({ expiresAt: Date.now() - 1000 }))
    expect(cache.lookup(shellKey())).toBeNull()
  })

  it('休眠条目（超过 180 天未命中）视为未命中', () => {
    const { cache } = open()
    cache.record(entry({ lastHitAt: Date.now() - 181 * 24 * 3600 * 1000 }))
    expect(cache.lookup(shellKey())).toBeNull()
  })

  it('canonicalKeyJson 与字段构造顺序无关', () => {
    const a = canonicalKeyJson({ kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' })
    const b = canonicalKeyJson({ level: 'exact', kind: 'shell-command', verb: 'ping baidu.com' })
    expect(a).toBe(b)
  })

  it('clearLane / clearAllSession / clear 生效', () => {
    const { cache } = open()
    cache.record(entry())
    cache.record(entry({ lane: 'desktop', scope: 'session', key: { kind: 'domain', domain: 'e.com', level: 'domain-any-action' } }))
    expect(cache.clearAllSession()).toBe(1)
    expect(cache.lookup({ kind: 'domain', domain: 'e.com', level: 'domain-any-action' })).toBeNull()
    expect(cache.lookup(shellKey())).not.toBeNull()
    expect(cache.clear(shellKey())).toBe(1)
    expect(cache.lookup(shellKey())).toBeNull()
  })

  it('按 lane 清理补偿时不删除其他链路同键记忆', () => {
    const { cache } = open()
    cache.record(entry({ lane: 'desktop' }))
    cache.record(entry({ lane: 'wechat', id: 'wechat-same-key' }))
    expect(cache.clear(shellKey(), 'desktop')).toBe(1)
    expect(cache.lookup(shellKey(), 'desktop')).toBeNull()
    expect(cache.lookup(shellKey(), 'wechat')).not.toBeNull()
  })

  it('expireDormant 清理过期与休眠条目', () => {
    const { cache } = open()
    cache.record(entry()) // 有效持久
    cache.record(entry({ key: shellKey('curl x'), expiresAt: Date.now() - 1000 })) // 过期
    cache.record(entry({ key: shellKey('rm -rf'), lastHitAt: Date.now() - 181 * 24 * 3600 * 1000 })) // 休眠
    const before = cache.lookup(shellKey())
    expect(before).not.toBeNull()
    expect(cache.expireDormant()).toBe(2)
    // 有效条目仍可命中
    expect(cache.lookup(shellKey())).not.toBeNull()
  })
})
