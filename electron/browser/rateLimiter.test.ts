import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RateLimiter,
  RateLimitRejectedError,
  RateLimitWaitTimeoutError,
  type RateLimitConfig
} from './rateLimiter'

const baseConfig: RateLimitConfig = {
  minIntervalMs: 1000,
  perMinute: 3,
  perHour: 100,
  perDomainPerMinute: 2,
  mode: 'wait',
  maxWaitSec: 30
}

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns not limited when under perMinute cap', () => {
    const limiter = new RateLimiter({ ...baseConfig, minIntervalMs: 0 })
    for (let i = 0; i < 2; i++) {
      limiter.recordRequest(null)
      vi.advanceTimersByTime(1)
    }
    expect(limiter.checkLimit(null)).toEqual({ limited: false })
  })

  it('limits when minute cap reached', () => {
    const limiter = new RateLimiter(baseConfig)
    for (let i = 0; i < 3; i++) limiter.recordRequest(null)
    const result = limiter.checkLimit(null)
    expect(result.limited).toBe(true)
    expect(result.limitType).toBe('minute')
  })

  it('limits when hour cap reached', () => {
    const limiter = new RateLimiter({ ...baseConfig, perMinute: 1000 })
    for (let i = 0; i < 100; i++) limiter.recordRequest(null)
    const result = limiter.checkLimit(null)
    expect(result.limited).toBe(true)
    expect(result.limitType).toBe('hour')
  })

  it('limits when domain minute cap reached', () => {
    const limiter = new RateLimiter(baseConfig)
    limiter.recordRequest('example.com')
    limiter.recordRequest('example.com')
    const result = limiter.checkLimit('example.com')
    expect(result.limited).toBe(true)
    expect(result.limitType).toBe('domain')
  })

  it('limits when min interval not elapsed', () => {
    const limiter = new RateLimiter(baseConfig)
    limiter.recordRequest('example.com')
    const result = limiter.checkLimit('example.com')
    expect(result.limited).toBe(true)
    expect(result.limitType).toBe('interval')
  })

  it('waitForAvailable resolves after window slides', async () => {
    const limiter = new RateLimiter({ ...baseConfig, perMinute: 1, minIntervalMs: 0 })
    limiter.recordRequest(null)
    const wait = limiter.waitForAvailable(null, new AbortController().signal)
    vi.advanceTimersByTime(60_000)
    await wait
  })

  it('waitForAvailable throws timeout when maxWaitSec exceeded', async () => {
    const limiter = new RateLimiter({
      ...baseConfig,
      perMinute: 1,
      minIntervalMs: 0,
      maxWaitSec: 1
    })
    limiter.recordRequest(null)
    const p = limiter.waitForAvailable(null, new AbortController().signal)
    vi.advanceTimersByTime(2_000)
    await expect(p).rejects.toBeInstanceOf(RateLimitWaitTimeoutError)
  })

  it('waitForAvailable throws when aborted', async () => {
    const limiter = new RateLimiter({ ...baseConfig, perMinute: 1, minIntervalMs: 0 })
    limiter.recordRequest(null)
    const ac = new AbortController()
    const p = limiter.waitForAvailable(null, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reject mode throws RateLimitRejectedError', async () => {
    const limiter = new RateLimiter({ ...baseConfig, mode: 'reject', perMinute: 1, minIntervalMs: 0 })
    limiter.recordRequest(null)
    await expect(
      limiter.waitForAvailable(null, new AbortController().signal)
    ).rejects.toBeInstanceOf(RateLimitRejectedError)
  })

  it('cleanupExpired removes old buckets', () => {
    const limiter = new RateLimiter(baseConfig)
    limiter.recordRequest(null)
    vi.advanceTimersByTime(2 * 60_000)
    limiter.cleanupExpired()
    expect(limiter.checkLimit(null).limited).toBe(false)
  })
})
