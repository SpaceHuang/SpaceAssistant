import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter } from './imRateLimit'

describe('createRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to limit within the window then rejects', () => {
    const limiter = createRateLimiter()
    expect(limiter.check('u1', 2)).toBe(true)
    expect(limiter.check('u1', 2)).toBe(true)
    expect(limiter.check('u1', 2)).toBe(false)
  })

  it('tracks senders independently', () => {
    const limiter = createRateLimiter()
    expect(limiter.check('a', 1)).toBe(true)
    expect(limiter.check('a', 1)).toBe(false)
    expect(limiter.check('b', 1)).toBe(true)
  })

  it('recovers after the 60s window expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const limiter = createRateLimiter()
    expect(limiter.check('u1', 1)).toBe(true)
    expect(limiter.check('u1', 1)).toBe(false)

    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))
    expect(limiter.check('u1', 1)).toBe(true)
  })

  it('resetForTests clears state', () => {
    const limiter = createRateLimiter()
    expect(limiter.check('u1', 1)).toBe(true)
    expect(limiter.check('u1', 1)).toBe(false)
    limiter.resetForTests()
    expect(limiter.check('u1', 1)).toBe(true)
  })
})
