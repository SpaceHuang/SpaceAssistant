import { describe, expect, it } from 'vitest'
import { decideOverflowRecovery } from './overflowRecovery'

describe('provider overflow recovery', () => {
  it('retries only the provider after a safe boundary', () => {
    expect(decideOverflowRecovery({ error: new Error('prompt token limit exceeded'), retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true })).toEqual({ action: 'reset_and_retry_provider', nextRetry: 1 })
  })
  it('waits while tools are in flight and never retries tools', () => {
    expect(decideOverflowRecovery({ error: 'context window exceeded', retries: 0, maxRetries: 1, inFlightToolCount: 1, safeBoundary: false })).toEqual({ action: 'wait_for_tools', reason: 'in_flight' })
  })
  it('does not retry unrelated errors or exceed the retry budget', () => {
    expect(decideOverflowRecovery({ error: 'network unavailable', retries: 0, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true }).action).toBe('ignore')
    expect(decideOverflowRecovery({ error: 'context length exceeded', retries: 1, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true })).toEqual({ action: 'ignore', reason: 'retry_limit' })
  })
})
