import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendMessage,
  createSession,
  deleteQueuedUserMessage,
  getMessages,
  openDatabase,
  type AppDatabase
} from './database'

describe('deleteQueuedUserMessage', () => {
  let dbPath: string
  let db: AppDatabase

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sa-queue-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    db = openDatabase(dbPath)
  })

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      /* ignore */
    }
  })

  it('removes queued user message and updates session preview', () => {
    const session = createSession(db, { name: 'test' })
    appendMessage(db, {
      id: 'u-sent',
      sessionId: session.id,
      role: 'user',
      content: 'first message',
      timestamp: 1,
      status: 'sent'
    })
    appendMessage(db, {
      id: 'u-queued',
      sessionId: session.id,
      role: 'user',
      content: 'queued follow-up',
      timestamp: 2,
      status: 'queued'
    })

    const result = deleteQueuedUserMessage(db, 'u-queued')
    expect(result).toEqual({ ok: true, sessionId: session.id })
    expect(getMessages(db, session.id).map((m) => m.id)).toEqual(['u-sent'])

    const updated = db.data.sessions.find((s) => s.id === session.id)
    expect(updated?.messageCount).toBe(1)
    expect(updated?.preview).toBe('first message')
  })

  it('rejects non-queued messages', () => {
    const session = createSession(db, { name: 'test' })
    appendMessage(db, {
      id: 'u-sent',
      sessionId: session.id,
      role: 'user',
      content: 'sent',
      timestamp: 1,
      status: 'sent'
    })

    expect(deleteQueuedUserMessage(db, 'u-sent')).toEqual({ ok: false, error: 'message_not_queued' })
    expect(getMessages(db, session.id)).toHaveLength(1)
  })
})
