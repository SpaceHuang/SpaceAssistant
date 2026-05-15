import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { combineUserAbortAndTimeout, FILE_TOOL_TIMEOUT_REASON, outcomeFromFileToolSignal } from './toolExecutionResource'

describe('toolExecutionResource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('times out with FILE_TOOL_TIMEOUT_REASON', async () => {
    const user = new AbortController()
    const { signal: op, dispose } = combineUserAbortAndTimeout(user.signal, 50)
    const done = new Promise<void>((resolve) => {
      op.addEventListener('abort', () => resolve(), { once: true })
    })
    vi.advanceTimersByTime(60)
    await done
    expect(outcomeFromFileToolSignal(op)).toBe('timeout')
    expect(op.reason).toBe(FILE_TOOL_TIMEOUT_REASON)
    dispose()
  })

  it('user abort yields cancel outcome', () => {
    const user = new AbortController()
    const { signal: op, dispose } = combineUserAbortAndTimeout(user.signal, 60_000)
    user.abort()
    expect(outcomeFromFileToolSignal(op)).toBe('cancel')
    dispose()
  })
})
