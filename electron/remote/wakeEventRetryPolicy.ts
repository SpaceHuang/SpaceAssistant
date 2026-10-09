export type WakeEventRetryFailure = {
  message: string
  failedAt: number
}

export type WakeEventRetryState = {
  eventId: string
  startedAt: number
  attemptCount: number
  nextAttemptAt: number | null
  shouldRetry: boolean
  lastFailure?: WakeEventRetryFailure
}

export type WakeEventRetryConfig = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  maxElapsedMs: number
  jitterRatio: number
  random?: () => number
}

export type WakeEventRetryClock = { now: () => number }

export function createWakeEventRetryClock(now: () => number = Date.now): WakeEventRetryClock {
  return { now }
}

export function createWakeEventRetryState(input: { eventId: string; startedAt: number }): WakeEventRetryState {
  if (!input.eventId.trim()) throw new TypeError('Wake event retry eventId must not be empty')
  if (!Number.isFinite(input.startedAt) || input.startedAt < 0) throw new TypeError('Wake event retry start time must be non-negative')
  return {
    eventId: input.eventId,
    startedAt: input.startedAt,
    attemptCount: 0,
    nextAttemptAt: input.startedAt,
    shouldRetry: true
  }
}

export function recordWakeEventRetryFailure(
  state: WakeEventRetryState,
  failure: WakeEventRetryFailure,
  config: WakeEventRetryConfig
): WakeEventRetryState {
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) throw new TypeError('Wake retry maxAttempts must be a positive integer')
  if (!Number.isFinite(config.baseDelayMs) || config.baseDelayMs < 0 || !Number.isFinite(config.maxDelayMs) || config.maxDelayMs < 0) {
    throw new TypeError('Wake retry delays must be non-negative finite numbers')
  }
  if (!Number.isFinite(config.maxElapsedMs) || config.maxElapsedMs < 0) throw new TypeError('Wake retry maxElapsedMs must be non-negative')
  if (!Number.isFinite(config.jitterRatio) || config.jitterRatio < 0 || config.jitterRatio > 1) {
    throw new TypeError('Wake retry jitterRatio must be between zero and one')
  }
  if (!Number.isFinite(failure.failedAt) || failure.failedAt < state.startedAt) throw new TypeError('Wake retry failure time is invalid')
  const message = failure.message.trim()
  if (!message) throw new TypeError('Wake retry failure message must not be empty')

  const attemptCount = state.attemptCount + 1
  const elapsed = failure.failedAt - state.startedAt
  const lastFailure = { message, failedAt: failure.failedAt }
  if (attemptCount >= config.maxAttempts || elapsed >= config.maxElapsedMs) {
    return { ...state, attemptCount, nextAttemptAt: null, shouldRetry: false, lastFailure }
  }

  const exponentialDelay = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** (attemptCount - 1)))
  const random = config.random ?? Math.random
  const randomValue = random()
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) throw new TypeError('Wake retry random value must be between zero and one')
  const jitterFactor = 1 - config.jitterRatio + randomValue * config.jitterRatio * 2
  const delay = Math.round(exponentialDelay * jitterFactor)
  const nextAttemptAt = failure.failedAt + delay
  if (nextAttemptAt - state.startedAt > config.maxElapsedMs) {
    return { ...state, attemptCount, nextAttemptAt: null, shouldRetry: false, lastFailure }
  }
  return { ...state, attemptCount, nextAttemptAt, shouldRetry: true, lastFailure }
}

export function isWakeEventRetryDue(state: WakeEventRetryState, now: number): boolean {
  return state.shouldRetry && state.nextAttemptAt != null && state.nextAttemptAt <= now
}
