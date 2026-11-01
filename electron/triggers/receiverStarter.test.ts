import { describe, expect, it, vi } from 'vitest'
import { createRuntimeTriggerReceiverStarter, runtimeTriggerQueueLane } from './receiverStarter'

describe('runtime trigger receiver starter', () => {
  it('maps the trusted queue scope to the matching policy lane', () => {
    expect(runtimeTriggerQueueLane({ kind: 'desktop' })).toBe('desktop')
    expect(runtimeTriggerQueueLane({ kind: 'im', channel: 'feishu', sessionId: 's' })).toBe('feishu')
    expect(runtimeTriggerQueueLane({ kind: 'im', channel: 'wechat', sessionId: 's' })).toBe('wechat')
  })
  it('reuses the exact queued marker and dispatches through the shared turn preparation path', async () => {
    const prepare = vi.fn(async (intent: unknown) => ({ turnId: 'turn-1', requestId: 'runtime-trigger:t1', sessionId: 'receiver', startToken: 'secret' }))
    const dispatch = vi.fn(async () => undefined)
    const starter = createRuntimeTriggerReceiverStarter({ prepare, dispatch })

    await expect(starter({ sessionId: 'receiver', requestId: 'runtime-trigger:t1', messageId: 'marker-1', queueScope: { kind: 'desktop' } }))
      .resolves.toBe('started')
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ mode: 'reuse-user', requestId: 'runtime-trigger:t1',
      sessionId: 'receiver', userMessageId: 'marker-1', queueScope: { kind: 'desktop' } }))
    expect(dispatch).toHaveBeenCalledWith(null, { requestId: 'runtime-trigger:t1', turnId: 'turn-1', turnStartToken: 'secret', sessionId: 'receiver' })
  })

  it('does not dispatch when preparation fails', async () => {
    const dispatch = vi.fn()
    const starter = createRuntimeTriggerReceiverStarter({ prepare: async () => { throw new Error('busy') }, dispatch })
    await expect(starter({ sessionId: 'receiver', requestId: 'runtime-trigger:t1', messageId: 'marker-1', queueScope: { kind: 'desktop' } }))
      .rejects.toThrow('busy')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reports existing execution ownership as a busy receiver without consuming a delivery attempt', async () => {
    const starter = createRuntimeTriggerReceiverStarter({ prepare: async () => { throw new Error('SESSION_EXECUTION_ACTIVE_OWNER') }, dispatch: vi.fn() })
    await expect(starter({ sessionId: 'receiver', requestId: 'runtime-trigger:t1', messageId: 'marker-1', queueScope: { kind: 'desktop' } }))
      .resolves.toBe('busy')
  })
})
