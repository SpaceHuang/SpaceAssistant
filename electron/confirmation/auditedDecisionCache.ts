import type {
  CacheKey,
  DecisionCacheEntry,
  ExecutionLane,
  OriginInfo
} from '../../src/shared/confirmation/types'
import { canonicalKeyJson } from './sqliteDecisionCache'
import type { AuditSink } from './channels'

export interface AuditedDecisionCacheDeps {
  cache: {
    lookup: (key: CacheKey) => DecisionCacheEntry | null
    record: (entry: DecisionCacheEntry) => void
    clear: (key: CacheKey) => number
    clearAllSession: () => number
    expireDormant: (now?: number) => number
  }
  audit: AuditSink
  sessionId: string
  lane: ExecutionLane
  origin?: OriginInfo
}

/**
 * 带审计的决策缓存（执行链路侧）：把所有 cache.* 事件（hit/write/clear/expire-dormant/generation-reset）
 * 落安全审计日志，与"写缓存在执行链路"同侧（§5.6-4/§5.6-5）。
 */
export class AuditedDecisionCache {
  constructor(private readonly deps: AuditedDecisionCacheDeps) {}

  lookup(key: CacheKey): DecisionCacheEntry | null {
    const entry = this.deps.cache.lookup(key)
    if (entry) {
      this.deps.audit.record({
        ts: Date.now(),
        event: 'cache.hit',
        lane: this.deps.lane,
        sessionId: this.deps.sessionId,
        origin: this.deps.origin,
        cacheKey: canonicalKeyJson(key),
        actor: 'system'
      })
    }
    return entry
  }

  record(entry: DecisionCacheEntry): void {
    this.deps.cache.record(entry)
    this.deps.audit.record({
      ts: Date.now(),
      event: 'cache.write',
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      origin: this.deps.origin,
      cacheKey: canonicalKeyJson(entry.key),
      memoryTier: entry.scope,
      actor: entry.source === 'migration' ? 'migration' : 'user'
    })
  }

  clear(key: CacheKey): number {
    const n = this.deps.cache.clear(key)
    this.deps.audit.record({
      ts: Date.now(),
      event: 'cache.clear',
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      cacheKey: canonicalKeyJson(key),
      actor: 'user'
    })
    return n
  }

  clearAllSession(): number {
    const n = this.deps.cache.clearAllSession()
    this.deps.audit.record({
      ts: Date.now(),
      event: 'cache.generation-reset',
      lane: this.deps.lane,
      sessionId: this.deps.sessionId,
      actor: 'system'
    })
    return n
  }

  expireDormant(now = Date.now()): number {
    const n = this.deps.cache.expireDormant(now)
    if (n > 0) {
      this.deps.audit.record({
        ts: Date.now(),
        event: 'cache.expire-dormant',
        lane: this.deps.lane,
        sessionId: this.deps.sessionId,
        actor: 'system'
      })
    }
    return n
  }
}
