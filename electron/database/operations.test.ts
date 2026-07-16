import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { appendMessage, createSession, getMessagesPage } from './operations'
import type { AppDatabase } from './sqliteStore'

describe('getMessagesPage', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('returns an empty page for a session with no messages', () => {
    const page = getMessagesPage(db, sessionId, 0, 10)
    expect(page).toEqual({ messages: [], nextSequence: 0 })
  })

  it('paginates strictly by sequence order across multiple pages until exhausted', () => {
    const total = 25
    for (let i = 0; i < total; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }

    const collected: string[] = []
    let cursor = 0
    for (;;) {
      const page = getMessagesPage(db, sessionId, cursor, 7)
      if (page.messages.length === 0) break
      collected.push(...page.messages.map((m) => m.id))
      cursor = page.nextSequence
    }

    expect(collected).toEqual(Array.from({ length: total }, (_, i) => `m${i}`))
  })

  it('does not skip or duplicate rows when a message is appended between page reads', () => {
    for (let i = 0; i < 5; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }

    const firstPage = getMessagesPage(db, sessionId, 0, 3)
    expect(firstPage.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])

    // Simulate a concurrent append that happens between two page reads.
    appendMessage(db, {
      id: 'm-new',
      sessionId,
      role: 'user',
      content: 'new',
      timestamp: 99,
      status: 'sent'
    })

    const secondPage = getMessagesPage(db, sessionId, firstPage.nextSequence, 10)
    // The cursor is based on sequence, so already-read rows are never re-returned,
    // and the newly appended row (higher sequence) is included exactly once.
    expect(secondPage.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm-new'])
  })
})
