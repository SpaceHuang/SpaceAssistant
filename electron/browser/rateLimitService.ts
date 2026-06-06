import { logAgentEvent } from '../agentLogger/agentLogger'
import type { BrowserConfig } from '../../src/shared/domainTypes'
import { isUserAbortError } from '../tools/toolExecutionResource'
import {
  RateLimiter,
  RateLimitRejectedError,
  RateLimitWaitTimeoutError,
  type RateLimitConfig
} from './rateLimiter'

function toRateLimitConfig(cfg: BrowserConfig): RateLimitConfig {
  return {
    minIntervalMs: cfg.rateLimitMinIntervalMs,
    perMinute: cfg.rateLimitPerMinute,
    perHour: cfg.rateLimitPerHour,
    perDomainPerMinute: cfg.rateLimitPerDomainPerMinute,
    mode: cfg.rateLimitMode,
    maxWaitSec: cfg.rateLimitMaxWaitSec
  }
}

export class RateLimitService {
  private readonly limiters = new Map<string, RateLimiter>()
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupAll(), 10_000)
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref()
    }
  }

  dispose(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    this.limiters.clear()
  }

  private getLimiter(sessionId: string, cfg: BrowserConfig): RateLimiter {
    let limiter = this.limiters.get(sessionId)
    if (!limiter) {
      limiter = new RateLimiter(toRateLimitConfig(cfg))
      this.limiters.set(sessionId, limiter)
    }
    return limiter
  }

  private cleanupAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.cleanupExpired()
    }
  }

  async acquire(
    sessionId: string,
    cfg: BrowserConfig,
    domain: string | null,
    signal: AbortSignal,
    onProgress?: (waitMs: number) => void
  ): Promise<void> {
    if (!cfg.rateLimitEnabled) return

    const limiter = this.getLimiter(sessionId, cfg)
    const started = Date.now()

    const check = limiter.checkLimit(domain)
    if (check.limited && cfg.rateLimitMode === 'reject') {
      logAgentEvent('info', 'browser.rate_limit', {
        sessionId,
        domain,
        limitType: check.limitType,
        waitMs: 0,
        result: 'rejected'
      })
      throw new RateLimitRejectedError(check.limitType ?? 'minute', cfg.rateLimitPerMinute)
    }

    try {
      await limiter.waitForAvailable(domain, signal, (retryAfterMs) => {
        onProgress?.(retryAfterMs)
      })
    } catch (e) {
      const waitMs = Date.now() - started
      if (e instanceof RateLimitRejectedError) {
        logAgentEvent('info', 'browser.rate_limit', {
          sessionId,
          domain,
          limitType: e.limitType,
          waitMs,
          result: 'rejected'
        })
        throw e
      }
      if (e instanceof RateLimitWaitTimeoutError) {
        logAgentEvent('info', 'browser.rate_limit', {
          sessionId,
          domain,
          waitMs,
          result: 'timeout'
        })
        throw e
      }
      if (isUserAbortError(e) || signal.aborted) throw e
      throw e
    }

    limiter.recordRequest(domain)
    const waitMs = Date.now() - started
    if (waitMs > 0) {
      logAgentEvent('info', 'browser.rate_limit', {
        sessionId,
        domain,
        waitMs,
        result: 'waited'
      })
    }
  }
}

export const rateLimitService = new RateLimitService()
