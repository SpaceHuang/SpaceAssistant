import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import { RateLimitService } from './rateLimitService'

vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

describe('RateLimitService', () => {
  let svc: RateLimitService

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-06T12:00:00.000Z'))
    svc = new RateLimitService()
  })

  afterEach(() => {
    svc.dispose()
    vi.useRealTimers()
  })

  it('no-ops when rateLimitEnabled is false', async () => {
    const cfg = { ...DEFAULT_BROWSER_CONFIG, rateLimitEnabled: false, rateLimitPerMinute: 1 }
    await svc.acquire('s1', cfg, 'example.com', new AbortController().signal)
    await svc.acquire('s1', cfg, 'example.com', new AbortController().signal)
  })

  it('isolates limits per session', async () => {
    const cfg = {
      ...DEFAULT_BROWSER_CONFIG,
      rateLimitEnabled: true,
      rateLimitPerMinute: 1,
      rateLimitMinIntervalMs: 0,
      rateLimitPerDomainPerMinute: 100
    }
    await svc.acquire('a', cfg, null, new AbortController().signal)
    vi.advanceTimersByTime(60_000)
    await expect(
      svc.acquire('a', cfg, null, new AbortController().signal)
    ).resolves.toBeUndefined()
    await expect(
      svc.acquire('b', cfg, null, new AbortController().signal)
    ).resolves.toBeUndefined()
  })

  it('records request after successful acquire', async () => {
    const cfg = {
      ...DEFAULT_BROWSER_CONFIG,
      rateLimitEnabled: true,
      rateLimitPerMinute: 1,
      rateLimitMinIntervalMs: 0,
      rateLimitMode: 'reject' as const
    }
    await svc.acquire('s1', cfg, null, new AbortController().signal)
    await expect(
      svc.acquire('s1', cfg, null, new AbortController().signal)
    ).rejects.toThrow(/BROWSER_RATE_LIMIT_REJECTED/)
  })

  it('runs cleanup on interval', () => {
    const cfg = {
      ...DEFAULT_BROWSER_CONFIG,
      rateLimitEnabled: true,
      rateLimitPerMinute: 10,
      rateLimitMinIntervalMs: 0
    }
    void svc.acquire('s1', cfg, null, new AbortController().signal)
    vi.advanceTimersByTime(11_000)
    expect(() => svc.dispose()).not.toThrow()
  })
})
