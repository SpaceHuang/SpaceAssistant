import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_CANCELLED_MESSAGE,
  ChatCancelledError,
  clearChatCancel,
  registerChatCancel,
  signalChatCancel,
  throwIfChatCancelled
} from './chatCancelRegistry'
import { cancelAllToolConfirmsForRequest, waitForToolConfirm } from './toolConfirmRegistry'

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
})
