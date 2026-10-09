import { describe, expect, it } from 'vitest'
import { createWakeEventRetryClock, createWakeEventRetryState, isWakeEventRetryDue, recordWakeEventRetryFailure } from './wakeEventRetryPolicy'

describe('wake event bounded retry policy', () => {
  it('stops after the configured maximum attempts and preserves the last failure fact', () => {
    const config = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 10_000, jitterRatio: 0, random: () => 0.5 }
    let now = 1_000
    const clock = createWakeEventRetryClock(() => now)
    let state = createWakeEventRetryState({ eventId: 'event-retry', startedAt: clock.now() })

    state = recordWakeEventRetryFailure(state, { message: 'provider unavailable', failedAt: clock.now() }, config)
    expect(state).toMatchObject({ attemptCount: 1, nextAttemptAt: 1_100, shouldRetry: true })
    expect(isWakeEventRetryDue(state, clock.now())).toBe(false)
    now = state.nextAttemptAt!
    expect(isWakeEventRetryDue(state, clock.now())).toBe(true)
    state = recordWakeEventRetryFailure(state, { message: 'provider unavailable', failedAt: clock.now() }, config)
    expect(state).toMatchObject({ attemptCount: 2, nextAttemptAt: 1_300, shouldRetry: true })
    now = state.nextAttemptAt!
    state = recordWakeEventRetryFailure(state, { message: 'provider unavailable', failedAt: clock.now() }, config)

    expect(state).toMatchObject({
      attemptCount: 3,
      shouldRetry: false,
      lastFailure: { message: 'provider unavailable', failedAt: 1_300 }
    })
  })

  it('allows a new inbound or recovery event after an earlier event exhausted retries', () => {
    const exhausted = {
      ...createWakeEventRetryState({ eventId: 'old-event', startedAt: 1_000 }),
      attemptCount: 3,
      shouldRetry: false,
      lastFailure: { message: 'provider unavailable', failedAt: 1_500 }
    }
    const newInbound = createWakeEventRetryState({ eventId: 'new-inbound-event', startedAt: 2_000 })
    const newRecovery = createWakeEventRetryState({ eventId: 'new-recovery-event', startedAt: 2_001 })

    expect(exhausted.shouldRetry).toBe(false)
    expect(newInbound).toMatchObject({ eventId: 'new-inbound-event', attemptCount: 0, shouldRetry: true, nextAttemptAt: 2_000 })
    expect(newRecovery).toMatchObject({ eventId: 'new-recovery-event', attemptCount: 0, shouldRetry: true, nextAttemptAt: 2_001 })
  })

  it('bounds exponential jitter by the retry time window', () => {
    const config = { maxAttempts: 8, baseDelayMs: 100, maxDelayMs: 1_000, maxElapsedMs: 150, jitterRatio: 0.25, random: () => 0 }
    const initial = createWakeEventRetryState({ eventId: 'event-time-window', startedAt: 0 })
    const first = recordWakeEventRetryFailure(initial, { message: 'temporary failure', failedAt: 0 }, config)
    expect(first).toMatchObject({ nextAttemptAt: 75, shouldRetry: true })
    const outsideWindow = recordWakeEventRetryFailure(first, { message: 'still unavailable', failedAt: 75 }, config)
    expect(outsideWindow).toMatchObject({ shouldRetry: false, nextAttemptAt: null, attemptCount: 2 })
  })
})
