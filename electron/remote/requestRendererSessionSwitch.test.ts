import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  completeRendererSessionSwitch,
  requestRendererSessionSwitch,
  resetRendererSessionSwitchForTests
} from './requestRendererSessionSwitch'

function makeWebContents() {
  const send = vi.fn()
  return {
    id: Math.floor(Math.random() * 100_000),
    send,
    isDestroyed: () => false
  }
}

describe('requestRendererSessionSwitch', () => {
  beforeEach(() => {
    resetRendererSessionSwitchForTests()
  })

  afterEach(() => {
    resetRendererSessionSwitchForTests()
  })

  it('resolves when complete ACK received', async () => {
    const wc = makeWebContents()
    const promise = requestRendererSessionSwitch(wc as never, 'session-1')
    await Promise.resolve()
    expect(wc.send).toHaveBeenCalledOnce()
    const payload = wc.send.mock.calls[0]![1] as { requestId: string; sessionId: string }
    expect(payload.sessionId).toBe('session-1')
    completeRendererSessionSwitch({
      requestId: payload.requestId,
      desktopSwitched: true,
      viewChanged: true
    })
    await expect(promise).resolves.toEqual({ desktopSwitched: true, viewChanged: true })
  })

  it('times out without ACK', async () => {
    vi.useFakeTimers()
    try {
      const wc = makeWebContents()
      const promise = requestRendererSessionSwitch(wc as never, 'session-1')
      const rejection = expect(promise).rejects.toThrow('桌面会话切换超时')
      await vi.advanceTimersByTimeAsync(5001)
      await rejection
    } finally {
      vi.useRealTimers()
      resetRendererSessionSwitchForTests()
    }
  })
})
