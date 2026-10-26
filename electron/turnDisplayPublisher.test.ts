import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTurnDisplayPublisher } from './turnDisplayPublisher'

type Turn = { turnId: string; version: number }
type Event = { type: string; value?: string }

describe('createTurnDisplayPublisher', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces streaming deltas to the latest snapshot', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const publisher = createTurnDisplayPublisher<Turn, Event>(publish, 33)

    publisher.enqueue({ turnId: 'turn-1', version: 1 }, { type: 'content-delta', value: 'a' })
    publisher.enqueue({ turnId: 'turn-1', version: 2 }, { type: 'content-delta', value: 'ab' })
    publisher.enqueue({ turnId: 'turn-1', version: 3 }, { type: 'thinking-delta', value: 'thinking' })

    expect(publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(33)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ turnId: 'turn-1', version: 3 }, { type: 'thinking-delta', value: 'thinking' })
  })

  it('flushes pending deltas before publishing a critical event immediately', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const publisher = createTurnDisplayPublisher<Turn, Event>(publish, 33)
    const turn1 = { turnId: 'turn-1', version: 1 }
    const turn2 = { turnId: 'turn-1', version: 2 }

    publisher.enqueue(turn1, { type: 'content-delta', value: 'partial' })
    publisher.enqueue(turn2, { type: 'source-completed' })

    expect(publish.mock.calls).toEqual([
      [turn1, { type: 'content-delta', value: 'partial' }],
      [turn2, { type: 'source-completed' }]
    ])
  })

  it('discards pending snapshots when disposed', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const publisher = createTurnDisplayPublisher<Turn, Event>(publish, 33)
    publisher.enqueue({ turnId: 'turn-1', version: 1 }, { type: 'content-delta' })

    publisher.dispose()
    vi.advanceTimersByTime(100)

    expect(publish).not.toHaveBeenCalled()
  })
})
