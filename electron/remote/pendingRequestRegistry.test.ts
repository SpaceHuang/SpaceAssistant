import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingRequestRegistry } from './pendingRequestRegistry'

type Item = { id: string; sessionId: string; expiresAt: number; label?: string }

function makeItem(partial: Partial<Item> & Pick<Item, 'id' | 'sessionId'>): Item {
  return {
    expiresAt: Date.now() + 60_000,
    ...partial
  }
}

describe('PendingRequestRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists, counts, and tracks pending by session', async () => {
    const registry = new PendingRequestRegistry<Item>()
    const p = registry.register(makeItem({ id: 'a', sessionId: 's1' }), 60_000)
    expect(registry.countPending()).toBe(1)
    expect(registry.hasPendingForSession('s1')).toBe(true)
    expect(registry.hasPendingForSession('s2')).toBe(false)
    expect(registry.listPending()).toEqual([expect.objectContaining({ id: 'a', sessionId: 's1' })])
    expect(registry.get('a')?.sessionId).toBe('s1')

    registry.resolve('a', 'y')
    await expect(p).resolves.toBe('y')
    expect(registry.countPending()).toBe(0)
  })

  it('cancel invokes onCancel then resolves waiter with n', async () => {
    const registry = new PendingRequestRegistry<Item>()
    const onCancel = vi.fn()
    const p = registry.register(makeItem({ id: 'c1', sessionId: 's1', label: 'x' }), 60_000)
    expect(registry.cancel('missing')).toBe(false)
    expect(registry.cancel('c1', onCancel)).toBe(true)
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', label: 'x' }))
    await expect(p).resolves.toBe('n')
    expect(registry.countPending()).toBe(0)
  })

  it('cancelAllPending resolves every waiter without waiting for timeout', async () => {
    const registry = new PendingRequestRegistry<Item>()
    const p1 = registry.register(makeItem({ id: '1', sessionId: 's1' }), 60_000)
    const p2 = registry.register(makeItem({ id: '2', sessionId: 's2' }), 60_000)
    registry.cancelAllPending()
    await expect(p1).resolves.toBe('n')
    await expect(p2).resolves.toBe('n')
    expect(registry.countPending()).toBe(0)
  })

  it('times out and invokes onTimeout after resolve', async () => {
    vi.useFakeTimers()
    const registry = new PendingRequestRegistry<Item>()
    const onTimeout = vi.fn()
    const p = registry.register(makeItem({ id: 't1', sessionId: 's1' }), 5_000, { onTimeout })

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(p).resolves.toBe('timeout')
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
    expect(registry.countPending()).toBe(0)
  })

  it('clearing via resolve prevents timeout callback', async () => {
    vi.useFakeTimers()
    const registry = new PendingRequestRegistry<Item>()
    const onTimeout = vi.fn()
    const p = registry.register(makeItem({ id: 't2', sessionId: 's1' }), 5_000, { onTimeout })
    expect(registry.resolve('t2', 'y')).toBe(true)
    await expect(p).resolves.toBe('y')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('resolve returns false for unknown id', () => {
    const registry = new PendingRequestRegistry<Item>()
    expect(registry.resolve('nope', 'y')).toBe(false)
  })
})
