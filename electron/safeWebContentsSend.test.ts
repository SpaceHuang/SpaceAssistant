import { describe, expect, it, vi } from 'vitest'
import { isWebContentsAlive, safeWebContentsSend } from './safeWebContentsSend'

describe('safeWebContentsSend', () => {
  it('returns false when sender is destroyed', () => {
    const sender = {
      isDestroyed: () => true,
      send: vi.fn()
    }
    expect(isWebContentsAlive(sender as never)).toBe(false)
    expect(safeWebContentsSend(sender as never, 'claude-chat-done', { requestId: 'r1' })).toBe(false)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('sends when sender is alive', () => {
    const sender = {
      isDestroyed: () => false,
      send: vi.fn()
    }
    expect(safeWebContentsSend(sender as never, 'claude-chat-error', { requestId: 'r1', message: 'x' })).toBe(true)
    expect(sender.send).toHaveBeenCalledWith('claude-chat-error', { requestId: 'r1', message: 'x' })
  })

  it('returns false when send throws', () => {
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error('Object has been destroyed')
      })
    }
    expect(safeWebContentsSend(sender as never, 'tool:progress', {})).toBe(false)
  })
})
