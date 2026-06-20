import { describe, expect, it } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  messageHasConfirmingTool,
  resolveMessageToolsInteractive,
  resolveRequestIdForConfirmingMessage
} from './resolveMessageToolsInteractive'
import type { PendingConfirmItem } from './pendingConfirmStore'

const confirmingMessage: Message = {
  id: 'msg-1',
  sessionId: 'sess-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  status: 'streaming',
  toolCalls: [
    {
      id: 'tool-1',
      toolName: 'browser',
      input: { action: 'act', instruction: 'click' },
      status: 'confirming',
      riskLevel: 'medium'
    }
  ]
}

const pendingItem: PendingConfirmItem = {
  sessionId: 'sess-1',
  requestId: 'req-pending',
  toolUseId: 'tool-1',
  toolName: 'browser',
  input: { action: 'act' },
  riskLevel: 'medium',
  createdAt: Date.now()
}

describe('resolveMessageToolsInteractive', () => {
  it('detects confirming tools on message', () => {
    expect(messageHasConfirmingTool(confirmingMessage)).toBe(true)
    expect(messageHasConfirmingTool({ ...confirmingMessage, toolCalls: [] })).toBe(false)
  })

  it('uses streaming request id for active streaming assistant', () => {
    expect(
      resolveRequestIdForConfirmingMessage({
        sessionId: 'sess-1',
        message: confirmingMessage,
        pendingItems: [pendingItem],
        streamingAssistantId: 'msg-1',
        streamingRequestId: 'req-live'
      })
    ).toBe('req-live')
  })

  it('falls back to pending store when streaming request id is missing', () => {
    expect(
      resolveRequestIdForConfirmingMessage({
        sessionId: 'sess-1',
        message: confirmingMessage,
        pendingItems: [pendingItem],
        streamingAssistantId: 'msg-1',
        streamingRequestId: null
      })
    ).toBe('req-pending')
  })

  it('returns tools interactive props for confirming message', () => {
    const onToolConfirm = () => {}
    const onToolCancel = () => {}
    const interactive = resolveMessageToolsInteractive({
      message: confirmingMessage,
      sessionId: 'sess-1',
      toolsEnabled: true,
      confirmMode: 'diff',
      pendingItems: [pendingItem],
      streamingAssistantId: 'msg-2',
      streamingRequestId: null,
      onToolConfirm,
      onToolCancel
    })
    expect(interactive?.requestId).toBe('req-pending')
    expect(interactive?.onToolConfirm).toBe(onToolConfirm)
  })
})
