import { ErrorCodes } from '../../src/shared/errorCodes'
import { throwIfAborted } from '../tools/toolExecutionResource'

export type RateLimitType = 'minute' | 'hour' | 'domain' | 'interval'

export interface RateLimitConfig {
  minIntervalMs: number
  perMinute: number
  perHour: number
  perDomainPerMinute: number
  mode: 'wait' | 'reject'
  maxWaitSec: number
}

export interface RateLimitResult {
  limited: boolean
  limitType?: RateLimitType
  retryAfterMs?: number
}

interface RateLimitState {
  minuteWindow: Map<number, number>
  hourWindow: Map<number, number>
  domainMinuteWindows: Map<string, Map<number, number>>
  lastRequestAt: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const POLL_MS = 100

export class RateLimitRejectedError extends Error {
  readonly limitType: RateLimitType
  readonly perMinute: number

  constructor(limitType: RateLimitType, perMinute: number) {
    super(`${ErrorCodes.BROWSER_RATE_LIMIT_REJECTED}|${perMinute}`)
    this.name = 'RateLimitRejectedError'
    this.limitType = limitType
    this.perMinute = perMinute
  }
}

export class RateLimitWaitTimeoutError extends Error {
  readonly maxWaitSec: number

  constructor(maxWaitSec: number) {
    super(`${ErrorCodes.BROWSER_RATE_LIMIT_WAIT_TIMEOUT}|${maxWaitSec}`)
    this.name = 'RateLimitWaitTimeoutError'
    this.maxWaitSec = maxWaitSec
  }
}

function sumWindowCounts(window: Map<number, number>, now: number, windowMs: number): number {
  const minBucket = Math.floor((now - windowMs) / windowMs)
  let total = 0
  for (const [bucket, count] of window) {
    if (bucket > minBucket) total += count
  }
  return total
}

function incrementBucket(window: Map<number, number>, now: number, windowMs: number): void {
  const bucket = Math.floor(now / windowMs)
  window.set(bucket, (window.get(bucket) ?? 0) + 1)
}

function pruneWindow(window: Map<number, number>, now: number, windowMs: number): void {
  const minBucket = Math.floor((now - windowMs) / windowMs)
  for (const bucket of [...window.keys()]) {
    if (bucket <= minBucket) window.delete(bucket)
  }
}

function getDomainWindow(
  state: RateLimitState,
  domain: string
): Map<number, number> {
  let w = state.domainMinuteWindows.get(domain)
  if (!w) {
    w = new Map()
    state.domainMinuteWindows.set(domain, w)
  }
  return w
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class RateLimiter {
  private state: RateLimitState
  private readonly config: RateLimitConfig

  constructor(config: RateLimitConfig) {
    this.config = config
    this.state = {
      minuteWindow: new Map(),
      hourWindow: new Map(),
      domainMinuteWindows: new Map(),
      lastRequestAt: 0
    }
  }

  checkLimit(domain: string | null): RateLimitResult {
    const now = Date.now()

    const minuteCount = sumWindowCounts(this.state.minuteWindow, now, MINUTE_MS)
    if (minuteCount >= this.config.perMinute) {
      return {
        limited: true,
        limitType: 'minute',
        retryAfterMs: this.retryAfterForWindow(this.state.minuteWindow, now, MINUTE_MS)
      }
    }

    const hourCount = sumWindowCounts(this.state.hourWindow, now, HOUR_MS)
    if (hourCount >= this.config.perHour) {
      return {
        limited: true,
        limitType: 'hour',
        retryAfterMs: this.retryAfterForWindow(this.state.hourWindow, now, HOUR_MS)
      }
    }

    if (domain) {
      const domainWindow = getDomainWindow(this.state, domain)
      const domainCount = sumWindowCounts(domainWindow, now, MINUTE_MS)
      if (domainCount >= this.config.perDomainPerMinute) {
        return {
          limited: true,
          limitType: 'domain',
          retryAfterMs: this.retryAfterForWindow(domainWindow, now, MINUTE_MS)
        }
      }
    }

    if (this.state.lastRequestAt > 0) {
      const elapsed = now - this.state.lastRequestAt
      if (elapsed < this.config.minIntervalMs) {
        return {
          limited: true,
          limitType: 'interval',
          retryAfterMs: this.config.minIntervalMs - elapsed
        }
      }
    }

    return { limited: false }
  }

  recordRequest(domain: string | null): void {
    const now = Date.now()
    incrementBucket(this.state.minuteWindow, now, MINUTE_MS)
    incrementBucket(this.state.hourWindow, now, HOUR_MS)
    if (domain) {
      incrementBucket(getDomainWindow(this.state, domain), now, MINUTE_MS)
    }
    this.state.lastRequestAt = now
  }

  async waitForAvailable(
    domain: string | null,
    signal: AbortSignal,
    onTick?: (retryAfterMs: number) => void
  ): Promise<void> {
    const maxWaitMs = this.config.maxWaitSec * 1000
    const started = Date.now()

    while (true) {
      throwIfAborted(signal)
      const result = this.checkLimit(domain)
      if (!result.limited) return

      if (this.config.mode === 'reject') {
        throw new RateLimitRejectedError(result.limitType ?? 'minute', this.config.perMinute)
      }

      const elapsed = Date.now() - started
      if (elapsed >= maxWaitMs) {
        throw new RateLimitWaitTimeoutError(this.config.maxWaitSec)
      }

      const retryAfterMs = result.retryAfterMs ?? POLL_MS
      onTick?.(retryAfterMs)
      const waitMs = Math.min(POLL_MS, retryAfterMs, maxWaitMs - elapsed)
      await sleep(Math.max(1, waitMs), signal)
    }
  }

  cleanupExpired(): void {
    const now = Date.now()
    pruneWindow(this.state.minuteWindow, now, MINUTE_MS)
    pruneWindow(this.state.hourWindow, now, HOUR_MS)
    for (const [domain, window] of this.state.domainMinuteWindows) {
      pruneWindow(window, now, MINUTE_MS)
      if (window.size === 0) this.state.domainMinuteWindows.delete(domain)
    }
  }

  private retryAfterForWindow(
    window: Map<number, number>,
    now: number,
    windowMs: number
  ): number {
    if (window.size === 0) return windowMs
    const oldestBucket = Math.min(...window.keys())
    const windowEnd = (oldestBucket + 1) * windowMs
    return Math.max(0, windowEnd - now)
  }
}
