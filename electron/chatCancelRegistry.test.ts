import { describe, expect, it, vi } from 'vitest'
import {
  cancelAllActiveChats,
  CHAT_CANCELLED_MESSAGE,
  ChatCancelledError,
  clearChatCancel,
  registerChatCancel,
  signalChatCancel,
  throwIfChatCancelled
} from './chatCancelRegistry'
import {
  cancelAllToolConfirmsForRequest,
  cancelAllToolsForRequest,
  registerToolCancel,
  waitForToolConfirm
} from './toolConfirmRegistry'

describe('chatCancelRegistry', () => {
  it('throws when signal is aborted', () => {
    const signal = registerChatCancel('req-1')
    signalChatCancel('req-1')
    expect(() => throwIfChatCancelled(signal)).toThrow(ChatCancelledError)
    expect(() => throwIfChatCancelled(signal)).toThrow(CHAT_CANCELLED_MESSAGE)
    clearChatCancel('req-1')
  })

  it('rejects pending tool confirms for the same request', async () => {
    const p = waitForToolConfirm('req-2', 'tool-1')
    signalChatCancel('req-2')
    await expect(p).resolves.toBe('rejected')
    clearChatCancel('req-2')
  })

  it('signalChatCancel aborts in-flight tool execution signal', () => {
    const signal = registerToolCancel('req-tools', 'tool-nav')
    const onAbort = vi.fn()
    signal.addEventListener('abort', onAbort)
    signalChatCancel('req-tools')
    expect(signal.aborted).toBe(true)
    expect(onAbort).toHaveBeenCalled()
    clearChatCancel('req-tools')
  })

  it('cancelAllToolsForRequest aborts matching tool signals', () => {
    const signal = registerToolCancel('req-t', 'tool-1')
    cancelAllToolsForRequest('req-t')
    expect(signal.aborted).toBe(true)
  })

  it('cancelAllToolConfirmsForRequest resolves only matching request', async () => {
    const p1 = waitForToolConfirm('req-a', 'tool-1')
    const p2 = waitForToolConfirm('req-b', 'tool-1')
    cancelAllToolConfirmsForRequest('req-a')
    await expect(p1).resolves.toBe('rejected')
    signalChatCancel('req-b')
    await expect(p2).resolves.toBe('rejected')
    clearChatCancel('req-a')
    clearChatCancel('req-b')
  })

  it('cancelAllActiveChats aborts all registered requests', () => {
    const s1 = registerChatCancel('req-all-1')
    const s2 = registerChatCancel('req-all-2')
    cancelAllActiveChats()
    expect(s1.aborted).toBe(true)
    expect(s2.aborted).toBe(true)
  })
})
