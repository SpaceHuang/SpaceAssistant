import { describe, expect, it, vi } from 'vitest'
import { ToolCallDetailsCache } from './toolCallDetailsCache'

describe('ToolCallDetailsCache', () => {
  it('命中缓存，过期后重新读取', () => {
    vi.useFakeTimers()
    const cache = new ToolCallDetailsCache<string>({ ttlMs: 100, maxEntries: 2 })
    cache.set('a', 'detail')
    expect(cache.get('a')).toBe('detail')
    vi.advanceTimersByTime(101)
    expect(cache.get('a')).toBeUndefined()
    vi.useRealTimers()
  })

  it('超过容量淘汰最久未使用条目，清理不影响主进程事实', () => {
    const cache = new ToolCallDetailsCache<number>({ ttlMs: 1000, maxEntries: 2 })
    cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
    cache.clear()
    expect(cache.get('a')).toBeUndefined()
  })
})
