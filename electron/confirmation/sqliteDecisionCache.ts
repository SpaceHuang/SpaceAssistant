import type { DatabaseSync } from 'node:sqlite'
import { changesToNumber } from '../database/transaction'
import type {
  CacheKey,
  DecisionCacheEntry,
  DecisionCacheView
} from '../../src/shared/confirmation/types'

/** 休眠阈值：超过 180 天未命中即视为失效（§5.3 / §8-Q1）。 */
export const DORMANT_MS = 180 * 24 * 3600 * 1000

/** 递归按 key 排序，保证相同 CacheKey 序列化结果一致（与构造字段顺序无关）。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

export function canonicalKeyJson(key: CacheKey): string {
  return JSON.stringify(sortDeep(key))
}

export function parseCacheKey(json: string): CacheKey | null {
  try {
    return JSON.parse(json) as CacheKey
  } catch {
    return null
  }
}

interface CacheRow {
  id: string
  key_json: string
  decision: 'allow' | 'deny'
  lane: string
  scope: 'session' | 'persistent'
  source: 'user-confirm' | 'settings' | 'migration'
  created_at: number
  last_hit_at: number
  hit_count: number
  expires_at: number | null
}

/**
 * P3 决策缓存存储实现：以 `decision_cache` 表承载，替换 LegacyExemptionAdapter。
 *
 * - lookup：按规范化签名键查询，过期/休眠条目视为未命中；命中时递增命中数与最近命中时间。
 * - record：幂等 upsert（按规范化键）。
 * - 清理钩子：`clearAllSession`（应用启动时清空会话级条目）、`clearLane`（换绑/重置=清空该链路）、
 *   `clear`（确认记忆管理清除）。
 *
 * 接口与策略层 `DecisionCacheView` 一致：只读视图由策略层消费，写缓存由执行链路完成。
 */
export class SqliteDecisionCache implements DecisionCacheView {
  constructor(private readonly db: DatabaseSync) {}

  lookup(key: CacheKey): DecisionCacheEntry | null {
    const now = Date.now()
    const keyJson = canonicalKeyJson(key)
    const row = this.db
      .prepare('SELECT * FROM decision_cache WHERE key_json = ? ORDER BY created_at DESC LIMIT 1')
      .get(keyJson) as CacheRow | undefined
    if (!row) return null
    if (row.expires_at !== null && row.expires_at <= now) return null
    if (now - row.last_hit_at > DORMANT_MS) return null
    this.db
      .prepare('UPDATE decision_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?')
      .run(now, row.id)
    return this.rowToEntry({ ...row, hit_count: row.hit_count + 1, last_hit_at: now })
  }

  record(entry: DecisionCacheEntry): void {
    const keyJson = canonicalKeyJson(entry.key)
    this.db
      .prepare(
        `INSERT INTO decision_cache (id, key_json, decision, lane, scope, source, created_at, last_hit_at, hit_count, expires_at)
         VALUES (@id, @key_json, @decision, @lane, @scope, @source, @created_at, @last_hit_at, @hit_count, @expires_at)
         ON CONFLICT(id) DO UPDATE SET
           decision = excluded.decision,
           lane = excluded.lane,
           scope = excluded.scope,
           source = excluded.source,
           last_hit_at = excluded.last_hit_at,
           hit_count = excluded.hit_count,
           expires_at = excluded.expires_at`
      )
      .run({
        id: keyJson,
        key_json: keyJson,
        decision: entry.decision,
        lane: entry.lane,
        scope: entry.scope,
        source: entry.source,
        created_at: entry.createdAt,
        last_hit_at: entry.lastHitAt,
        hit_count: entry.hitCount,
        expires_at: entry.expiresAt ?? null
      })
  }

  /** 应用启动时清理所有会话级条目（内存态语义：进程消亡即失效）。 */
  clearAllSession(): number {
    return changesToNumber(this.db.prepare("DELETE FROM decision_cache WHERE scope = 'session'").run().changes)
  }

  /** 换绑/重置：清空指定链路（或键值域）的全部条目。 */
  clearLane(lane: string | '*', scope?: 'session' | 'persistent'): number {
    if (scope) {
      return changesToNumber(
        this.db
          .prepare('DELETE FROM decision_cache WHERE lane = ? AND scope = ?')
          .run(lane, scope).changes
      )
    }
    return changesToNumber(this.db.prepare('DELETE FROM decision_cache WHERE lane = ?').run(lane).changes)
  }

  /** 清除指定规范化键（确认记忆管理：清除即下次再问）。 */
  clear(key: CacheKey): number {
    return changesToNumber(this.db.prepare('DELETE FROM decision_cache WHERE key_json = ?').run(canonicalKeyJson(key)).changes)
  }

  /** 确认记忆管理列表：全量读出（按创建时间倒序），供设置页分组展示。 */
  list(): DecisionCacheEntry[] {
    const rows = this.db.prepare('SELECT * FROM decision_cache ORDER BY created_at DESC').all() as unknown as CacheRow[]
    return rows.map((r) => this.rowToEntry(r))
  }

  /** 清除全部（清空确认记忆）。 */
  clearAll(): number {
    return changesToNumber(this.db.prepare('DELETE FROM decision_cache').run().changes)
  }

  /** 清理过期（expires_at 已过）与休眠（超过 DORMANT_MS 未命中）条目；返回清理数。 */
  expireDormant(now = Date.now()): number {
    const dormantBefore = now - DORMANT_MS
    return changesToNumber(
      this.db
        .prepare('DELETE FROM decision_cache WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR last_hit_at <= ?')
        .run(now, dormantBefore).changes
    )
  }

  private rowToEntry(row: CacheRow): DecisionCacheEntry {
    return {
      id: row.id,
      key: parseCacheKey(row.key_json)!,
      decision: row.decision,
      lane: row.lane as DecisionCacheEntry['lane'],
      scope: row.scope,
      createdAt: row.created_at,
      lastHitAt: row.last_hit_at,
      hitCount: row.hit_count,
      source: row.source,
      ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {})
    }
  }
}
