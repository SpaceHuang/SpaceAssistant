import { describe, expect, it } from 'vitest'
import type { ApiContextBaseline, ChatMessagePage, MessageEntry, MessageSearchHit, MessageSkeleton } from './model'

describe('public session storage DTOs', () => {
  it('keeps message identity, ordering, and user-facing page metadata in the DTO contract', () => {
    const entry: MessageEntry = { message: { id: 'm1', sessionId: 's1', role: 'user', content: 'hello', timestamp: 1, status: 'completed', schemaVersion: 1 }, sequence: 3 }
    const page: ChatMessagePage = { entries: [entry], oldestSequence: 3, hasMoreBefore: true }
    const baseline: ApiContextBaseline = { sessionId: 's1', entries: [entry] }
    const hit: MessageSearchHit = { messageId: 'm1', sessionId: 's1', content: 'hello', sessionName: 'Chat' }
    const skeleton: MessageSkeleton = { id: 'm1', sessionId: 's1', role: 'user', timestamp: 1, status: 'completed', sequence: 3 }

    expect({ page, baseline, hit, skeleton }).toEqual({
      page: { entries: [entry], oldestSequence: 3, hasMoreBefore: true },
      baseline: { sessionId: 's1', entries: [entry] },
      hit: { messageId: 'm1', sessionId: 's1', content: 'hello', sessionName: 'Chat' },
      skeleton
    })
  })
})
