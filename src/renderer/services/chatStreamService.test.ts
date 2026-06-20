import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { runClaudeChatStream } from './chatStreamService'

describe('runClaudeChatStream', () => {
  const unsub = vi.fn()
  const handlers: Record<string, (d: unknown) => void> = {}

  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        claudeChatSendStream: vi.fn(async () => ({ ok: true as const })),
        claudeChatOnDelta: vi.fn((cb: (d: { requestId: string; text: string }) => void) => {
          handlers.delta = cb
          return unsub
        }),
        claudeChatOnThinkingDelta: vi.fn(() => unsub),
        claudeChatOnDone: vi.fn((cb: (d: { requestId: string }) => void) => {
          handlers.done = cb
          return unsub
        }),
        claudeChatOnError: vi.fn((cb: (d: { requestId: string; message: string }) => void) => {
          handlers.error = cb
          return unsub
        })
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ignores deltas for stale requestId', async () => {
    const onDelta = vi.fn()
    const p = runClaudeChatStream(
      { requestId: 'r1', sessionId: 's1', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      {
        onDelta,
        onDone: vi.fn(),
        onError: vi.fn()
      }
    )
    handlers.delta?.({ requestId: 'other', text: 'x' })
    expect(onDelta).not.toHaveBeenCalled()
    handlers.done?.({ requestId: 'r1' })
    await p
  })

  it('surfaces send failure', async () => {
    vi.mocked(window.api.claudeChatSendStream).mockResolvedValueOnce({ ok: false, error: 'bad' })
    const onError = vi.fn()
    await runClaudeChatStream(
      { requestId: 'r2', sessionId: 's2', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { onDelta: vi.fn(), onDone: vi.fn(), onError }
    )
    expect(onError).toHaveBeenCalledWith('bad')
  })

  it('forwards usage from claudeChatOnDone to onDone callback', async () => {
    const onDone = vi.fn()
    const usage = { input_tokens: 100, output_tokens: 20 }
    const p = runClaudeChatStream(
      { requestId: 'r3', sessionId: 's3', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { onDelta: vi.fn(), onDone, onError: vi.fn() }
    )
    handlers.done?.({ requestId: 'r3', usage })
    await p
    expect(onDone).toHaveBeenCalledWith({ usage })
  })
})
