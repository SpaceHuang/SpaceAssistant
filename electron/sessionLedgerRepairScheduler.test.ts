import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionLedgerRepairScheduler } from './sessionLedgerRepairScheduler'

describe('session ledger repair scheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('retries with capped backoff and keeps probing after recovery without a new request', async () => {
    vi.useFakeTimers()
    const repair = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const onAttempt = vi.fn()
    const scheduler = createSessionLedgerRepairScheduler({ repair, onAttempt, initialDelayMs: 100, maxDelayMs: 200 })

    scheduler.request({ workDir: '/workspace', sessionId: 's1', createdAt: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(repair).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(99)
    expect(repair).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(repair).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(repair).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(repair).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(200)
    expect(repair).toHaveBeenCalledTimes(4)
    expect(onAttempt.mock.calls.map(([result]) => result)).toEqual([
      { status: 'retrying', attempt: 1, retryInMs: 100 },
      { status: 'retrying', attempt: 2, retryInMs: 200 },
      { status: 'retrying', attempt: 3, retryInMs: 200 },
      { status: 'recovered', attempt: 4, retryInMs: 0 }
    ])
    expect(scheduler.pendingCount()).toBe(0)
    scheduler.stop()
  })

  it('coalesces concurrent requests for the same location', async () => {
    vi.useFakeTimers()
    let finish!: (result: boolean) => void
    const repair = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const scheduler = createSessionLedgerRepairScheduler({ repair, initialDelayMs: 100, maxDelayMs: 200 })
    const location = { workDir: '/workspace', sessionId: 's1', createdAt: 1 }

    scheduler.request(location)
    scheduler.request(location)
    await vi.advanceTimersByTimeAsync(0)
    expect(repair).toHaveBeenCalledTimes(1)
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.pendingCount()).toBe(0)
    scheduler.stop()
  })

  it('does not lose a new invalidation that arrives while a repair is completing', async () => {
    vi.useFakeTimers()
    let finishFirst!: (result: boolean) => void
    const repair = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve }))
      .mockResolvedValueOnce(true)
    const scheduler = createSessionLedgerRepairScheduler({ repair, initialDelayMs: 100, maxDelayMs: 200 })
    const location = { workDir: '/workspace', sessionId: 's1', createdAt: 1 }

    scheduler.request(location, { generation: 1 })
    await vi.advanceTimersByTimeAsync(0)
    scheduler.request(location, { generation: 2 })
    finishFirst(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(repair).toHaveBeenCalledTimes(2)
    expect(scheduler.pendingCount()).toBe(0)
    scheduler.stop()
  })

  it('retires only the writer that failed and preserves a replacement across retry delays', async () => {
    vi.useFakeTimers()
    const repair = vi.fn<(_location: { workDir: string; sessionId: string; createdAt: number }, retireSink: boolean) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const scheduler = createSessionLedgerRepairScheduler({ repair, initialDelayMs: 100, maxDelayMs: 200 })
    const location = { workDir: '/workspace', sessionId: 's1', createdAt: 1 }

    scheduler.request(location, { retireSink: true, generation: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(repair.mock.calls[0]?.[1]).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(repair.mock.calls[1]?.[1]).toBe(false)
    expect(scheduler.pendingCount()).toBe(0)
    scheduler.stop()
  })

  it('reports an unauthorized repair as skipped instead of recovered or retrying forever', async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const scheduler = createSessionLedgerRepairScheduler({
      repair: async () => ({ status: 'skipped', reason: 'location-not-authorized' }),
      onAttempt: ({ status }) => statuses.push(status),
      initialDelayMs: 100,
      maxDelayMs: 200
    })
    scheduler.request({ workDir: '/outside', sessionId: 'unmanaged', createdAt: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses).toEqual(['skipped'])
    expect(scheduler.pendingCount()).toBe(0)
    scheduler.stop()
  })

  it('converges a fixed-seed interleaving of invalidations without losing a requested generation', async () => {
    vi.useFakeTimers()
    const desired = new Map<string, number>()
    const repaired = new Map<string, number>()
    const repair = vi.fn(async (location: { workDir: string; sessionId: string; createdAt: number }) => {
      const generation = desired.get(location.sessionId) ?? 0
      repaired.set(location.sessionId, generation)
      return true
    })
    const scheduler = createSessionLedgerRepairScheduler({ repair })
    const locations = ['seed-a', 'seed-b', 'seed-c'].map((sessionId) => ({ workDir: '/workspace', sessionId, createdAt: 1 }))
    let seed = 0x6d2b79f5
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const operationLocations = [0, 1, 2, ...Array.from({ length: 37 }, () => next() % locations.length)]

    for (const index of operationLocations) {
      const location = locations[index]!
      const generation = (desired.get(location.sessionId) ?? 0) + 1
      desired.set(location.sessionId, generation)
      scheduler.request(location, { generation })
    }
    await vi.advanceTimersByTimeAsync(0)

    expect([...desired.keys()]).toHaveLength(3)
    for (const [sessionId, generation] of desired) expect(repaired.get(sessionId)).toBe(generation)
    expect(scheduler.pendingCount()).toBe(0)
    expect(repair.mock.calls.length).toBeLessThanOrEqual(operationLocations.length)
    scheduler.stop()
  })
})
