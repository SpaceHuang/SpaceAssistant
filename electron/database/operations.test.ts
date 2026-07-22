import { describe, expect, it, beforeEach } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import {
  appendMessage,
  createSession,
  getApiContextBaseline,
  getChatMessagePage,
  getContextHistorySummaryBaseline,
  getMessagesPage,
  getNextQueuedMessage,
  getSearchCorpusPage,
  resolveRetryContext
} from './operations'
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

    appendMessage(db, {
      id: 'm-new',
      sessionId,
      role: 'user',
      content: 'new',
      timestamp: 99,
      status: 'sent'
    })

    const secondPage = getMessagesPage(db, sessionId, firstPage.nextSequence, 10)
    expect(secondPage.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm-new'])
  })

  it('returns sequence ack from appendMessage', () => {
    const ack = appendMessage(db, {
      id: 'a1',
      sessionId,
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'sent'
    })
    expect(ack.sequence).toBe(0)
    expect(ack.message.id).toBe('a1')
  })
})

describe('getApiContextBaseline', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('returns earliest 500 messages with sequences ASC', () => {
    for (let i = 0; i < 600; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i,
        status: i % 2 === 0 ? 'sent' : 'completed'
      })
    }
    const baseline = getApiContextBaseline(db, sessionId)
    expect(baseline.sessionId).toBe(sessionId)
    expect(baseline.entries).toHaveLength(500)
    expect(baseline.entries[0]).toMatchObject({ sequence: 0, message: { id: 'm0' } })
    expect(baseline.entries[499]).toMatchObject({ sequence: 499, message: { id: 'm499' } })
  })
})

describe('getChatMessagePage', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('loads latest page ASC with hasMoreBefore', () => {
    for (let i = 0; i < 100; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }
    const page = getChatMessagePage(db, sessionId, null, 60)
    expect(page.entries).toHaveLength(60)
    expect(page.entries[0]?.message.id).toBe('m40')
    expect(page.entries[59]?.message.id).toBe('m99')
    expect(page.oldestSequence).toBe(40)
    expect(page.hasMoreBefore).toBe(true)

    const prev = getChatMessagePage(db, sessionId, page.oldestSequence!, 60)
    expect(prev.entries[0]?.message.id).toBe('m0')
    expect(prev.hasMoreBefore).toBe(false)
  })
})

describe('queued and retry queries', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('returns next queued by sequence', () => {
    appendMessage(db, {
      id: 'q1',
      sessionId,
      role: 'user',
      content: 'first',
      timestamp: 1,
      status: 'queued'
    })
    appendMessage(db, {
      id: 'q2',
      sessionId,
      role: 'user',
      content: 'second',
      timestamp: 2,
      status: 'queued'
    })
    const next = getNextQueuedMessage(db, sessionId)
    expect(next?.message.id).toBe('q1')
    expect(next?.sequence).toBe(0)
  })

  it('resolves retry context to prior eligible user', () => {
    appendMessage(db, {
      id: 'u1',
      sessionId,
      role: 'user',
      content: 'ask',
      timestamp: 1,
      status: 'sent'
    })
    appendMessage(db, {
      id: 'a1',
      sessionId,
      role: 'assistant',
      content: 'fail',
      timestamp: 2,
      status: 'failed'
    })
    const target = resolveRetryContext(db, sessionId, 'a1')
    expect(target?.currentUser.message.id).toBe('u1')
    expect(target?.failedAssistant.message.id).toBe('a1')
  })
})

describe('getContextHistorySummaryBaseline', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('includes image and thinking rows after sequence 500, not only earliest 500', () => {
    for (let i = 0; i < 600; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `c${i}`,
        timestamp: i,
        status: i % 2 === 0 ? 'sent' : 'completed'
      })
    }
    appendMessage(db, {
      id: 'img-late',
      sessionId,
      role: 'user',
      content: 'pic',
      timestamp: 1000,
      status: 'sent',
      attachments: [
        {
          id: 'a',
          stagingKey: 'chat-attachments/s/a.png',
          fileName: 'a.png',
          mimeType: 'image/png',
          byteLength: 4000,
          width: 512,
          height: 512
        }
      ]
    })
    appendMessage(db, {
      id: 'think-late',
      sessionId,
      role: 'assistant',
      content: 'ok',
      timestamp: 1001,
      status: 'completed',
      thinking: {
        content: 'deep thought about tokens',
        isVisible: true,
        startTime: 1,
        segments: [{ content: 'deep thought about tokens', startTime: 1, endTime: 2 }]
      }
    })

    const api = getApiContextBaseline(db, sessionId)
    expect(api.entries.some((e) => e.message.id === 'img-late')).toBe(false)

    const summary = getContextHistorySummaryBaseline(db, sessionId)
    expect(summary.entries.some((e) => e.messageId === 'img-late' && e.imageTokens > 0)).toBe(true)
    expect(summary.entries.some((e) => e.messageId === 'think-late' && e.thinkingTokens > 0)).toBe(
      true
    )
  })
})

describe('getSearchCorpusPage', () => {
  let db: AppDatabase
  let sessionId: string

  beforeEach(() => {
    db = createMemoryAppDb()
    sessionId = createSession(db, { name: 'S' }).id
  })

  it('pages ASC without UI latest-page truncation', () => {
    for (let i = 0; i < 150; i++) {
      appendMessage(db, {
        id: `m${i}`,
        sessionId,
        role: 'user',
        content: `c${i}`,
        timestamp: i,
        status: 'sent'
      })
    }
    const first = getSearchCorpusPage(db, sessionId, 0, 100)
    expect(first.entries).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(first.entries[0]?.sequence).toBe(0)
    const second = getSearchCorpusPage(db, sessionId, first.nextSequence, 100)
    expect(second.entries[0]?.message.id).toBe('m100')
    expect(second.hasMore).toBe(false)
  })
})
