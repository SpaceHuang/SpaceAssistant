import { beforeEach, describe, expect, it } from 'vitest'
import { appendMessage, createSession, enqueueQueuedUserMessage, getMessage, getNextQueuedMessage, getSearchCorpusPage, reorderQueuedUserMessages, updateQueuedUserMessageContent } from './operations'
import { createMemoryAppDb } from './testHelpers'
import type { AppDatabase } from './sqliteStore'

describe('queued message editing and search corpus', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'queued message test' }).id
  })

  it('rejects an edit scoped to a different session without changing the queued message', () => {
    const queued = enqueueQueuedUserMessage(db, { sessionId, requestId: 'wrong-session', content: 'original' })
    expect(updateQueuedUserMessageContent(db, { sessionId: 'another-session', messageId: queued.persisted.message.id, content: 'replacement' }))
      .toEqual({ ok: false, error: 'message_not_queued' })
    expect(getMessage(db, queued.persisted.message.id)?.content).toBe('original')
  })

  it('persists the requested order and makes the new first item the next queued message', () => {
    const first = enqueueQueuedUserMessage(db, { sessionId, requestId: 'first', content: 'first' })
    const second = enqueueQueuedUserMessage(db, { sessionId, requestId: 'second', content: 'second' })
    const third = enqueueQueuedUserMessage(db, { sessionId, requestId: 'third', content: 'third' })
    const result = reorderQueuedUserMessages(db, { sessionId, messageIds: [third.persisted.message.id, first.persisted.message.id, second.persisted.message.id] })
    expect(result.ok).toBe(true)
    expect(result.ok && result.entries.map((entry) => entry.message.id)).toEqual([third.persisted.message.id, first.persisted.message.id, second.persisted.message.id])
    expect(getNextQueuedMessage(db, sessionId)?.message.id).toBe(third.persisted.message.id)
  })

  it('rejects a stale or incomplete order without changing the queue', () => {
    const first = enqueueQueuedUserMessage(db, { sessionId, requestId: 'first', content: 'first' })
    const second = enqueueQueuedUserMessage(db, { sessionId, requestId: 'second', content: 'second' })
    const result = reorderQueuedUserMessages(db, { sessionId, messageIds: [second.persisted.message.id] })
    expect(result).toEqual({ ok: false, error: 'queue_changed' })
    expect(getNextQueuedMessage(db, sessionId)?.message.id).toBe(first.persisted.message.id)
  })

  it('excludes queued user messages before applying a sequence cursor and advances across pages', () => {
    appendMessage(db, { id: 'queued-search', sessionId, role: 'user', content: 'hidden', timestamp: 1, status: 'queued' })
    for (let index = 1; index <= 55; index++) {
      appendMessage(db, { id: `sent-search-${index}`, sessionId, role: 'user', content: `visible ${index}`, timestamp: index, status: 'sent' })
    }

    const first = getSearchCorpusPage(db, sessionId, 0, 50)
    expect(first.entries).toHaveLength(50)
    expect(first.entries.some(({ message }) => message.status === 'queued')).toBe(false)
    expect(first.hasMore).toBe(true)

    const second = getSearchCorpusPage(db, sessionId, first.nextSequence, 50)
    expect(second.entries.map(({ message }) => message.id)).toEqual([
      'sent-search-51', 'sent-search-52', 'sent-search-53', 'sent-search-54', 'sent-search-55'
    ])
    expect(second.hasMore).toBe(false)
  })
})
