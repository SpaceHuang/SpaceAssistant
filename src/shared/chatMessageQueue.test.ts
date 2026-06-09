import { describe, expect, it } from 'vitest'
import type { Message } from './domainTypes'
import {
  countQueuedUserMessages,
  filterMessagesForChatApi,
  getNextQueuedUserMessage,
  MAX_CHAT_MESSAGE_QUEUE_SIZE
} from './chatMessageQueue'

function userMessage(id: string, status: Message['status'], sessionId = 's1'): Message {
  return {
    id,
    sessionId,
    role: 'user',
    content: `msg-${id}`,
    timestamp: Number(id.replace(/\D/g, '') || 0),
    status,
    schemaVersion: 1
  }
}

describe('chatMessageQueue', () => {
  it('exports queue size limit', () => {
    expect(MAX_CHAT_MESSAGE_QUEUE_SIZE).toBeGreaterThan(0)
  })

  it('filters queued and streaming from api history', () => {
    const rows: Message[] = [
      userMessage('u1', 'sent'),
      userMessage('u2', 'queued'),
      {
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: 'hi',
        timestamp: 3,
        status: 'streaming',
        schemaVersion: 1
      },
      {
        id: 'a2',
        sessionId: 's1',
        role: 'assistant',
        content: 'done',
        timestamp: 4,
        status: 'completed',
        schemaVersion: 1
      }
    ]
    expect(filterMessagesForChatApi(rows).map((m) => m.id)).toEqual(['u1', 'a2'])
  })

  it('lists queued user messages in order', () => {
    const rows = [userMessage('2', 'queued'), userMessage('1', 'queued'), userMessage('3', 'sent')]
    expect(getNextQueuedUserMessage(rows, 's1')?.id).toBe('1')
    expect(countQueuedUserMessages(rows, 's1')).toBe(2)
  })
})
