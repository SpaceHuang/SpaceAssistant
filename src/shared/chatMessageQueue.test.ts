import { describe, expect, it } from 'vitest'
import type { Message } from './domainTypes'
import {
  countQueuedUserMessages,
  filterOutQueuedUserMessages,
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
    expect(getNextQueuedUserMessage(rows, 's1')?.id).toBe('2')
    expect(countQueuedUserMessages(rows, 's1')).toBe(2)
  })

  it('保持传入数组顺序（不按 timestamp 重排）', () => {
    const rows = [userMessage('later', 'queued'), userMessage('earlier', 'queued')]
    rows[0].timestamp = 20
    rows[1].timestamp = 10
    expect(getNextQueuedUserMessage(rows, 's1')?.id).toBe('later')
  })

  it('剔除当前会话排队项并保持其余顺序', () => {
    const rows = [userMessage('1', 'queued'), userMessage('2', 'sent'), userMessage('3', 'queued', 's2')]
    expect(filterOutQueuedUserMessages(rows, 's1').map((row) => row.id)).toEqual(['2', '3'])
  })
})
