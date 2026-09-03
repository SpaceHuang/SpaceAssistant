import { describe, expect, it } from 'vitest'
import { AuditedDecisionCache } from './auditedDecisionCache'
import type { AuditSink } from './channels'
import type { CacheKey, DecisionCacheEntry, SecurityAuditEvent } from '../../src/shared/confirmation/types'

const shellKey = (verb = 'ping baidu.com'): CacheKey => ({ kind: 'shell-command', verb, level: 'exact' })

function entry(key: CacheKey): DecisionCacheEntry {
  return {
    id: 'id',
    key,
    decision: 'allow',
    lane: '*',
    scope: 'persistent',
    createdAt: 1,
    lastHitAt: 1,
    hitCount: 0,
    source: 'user-confirm'
  }
}

function audit(): AuditSink & { events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { events, record: (e) => events.push(e) }
}

describe('AuditedDecisionCache（cache.* 审计）', () => {
  it('record 落 cache.write；lookup 命中落 cache.hit', () => {
    const a = audit()
    const store = new Map<string, DecisionCacheEntry>()
    const cache = new AuditedDecisionCache({
      cache: {
        lookup: (k) => store.get(JSON.stringify(k)) ?? null,
        record: (e) => store.set(JSON.stringify(e.key), e),
        clear: (k) => (store.delete(JSON.stringify(k)) ? 1 : 0),
        clearAllSession: () => 0,
        expireDormant: () => 0
      },
      audit: a,
      sessionId: 's1',
      lane: 'wechat'
    })
    cache.record(entry(shellKey()))
    expect(a.events[0]!.event).toBe('cache.write')
    expect(cache.lookup(shellKey())).not.toBeNull()
    expect(a.events[1]!.event).toBe('cache.hit')
  })

  it('clear 落 cache.clear；clearAllSession 落 cache.generation-reset；expireDormant 落 cache.expire-dormant', () => {
    const a = audit()
    const store = new Map<string, DecisionCacheEntry>([[JSON.stringify(shellKey()), entry(shellKey())]])
    const cache = new AuditedDecisionCache({
      cache: {
        lookup: (k) => store.get(JSON.stringify(k)) ?? null,
        record: (e) => store.set(JSON.stringify(e.key), e),
        clear: (k) => (store.delete(JSON.stringify(k)) ? 1 : 0),
        clearAllSession: () => 1,
        expireDormant: () => 2
      },
      audit: a,
      sessionId: 's1',
      lane: 'desktop'
    })
    expect(cache.clear(shellKey())).toBe(1)
    expect(cache.clearAllSession()).toBe(1)
    expect(cache.expireDormant()).toBe(2)
    expect(a.events.map((e) => e.event)).toEqual(['cache.clear', 'cache.generation-reset', 'cache.expire-dormant'])
  })
})
