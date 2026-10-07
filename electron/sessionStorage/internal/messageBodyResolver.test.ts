import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../../src/shared/domainTypes'
import { appendMessage, createSession } from '../../database/operations'
import { createMemoryAppDb } from '../../database/testHelpers'
import { getDbConnection } from '../../database/sqliteStore'
import { resolveSelectedMessageBodies } from './messageBodyResolver'

describe('session message body resolver', () => {
  it('uses a matching canonical transcript for canonical-backed rows and rejects missing identities', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'resolver', model: 'test' })
    const selected = appendMessage(db, {
      id: 'resolver-message', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent'
    }).message
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id=?").run(selected.id)
    const canonical = { ...selected, content: 'canonical body' }
    const readTranscript = vi.fn(() => ({ source: 'canonical:L1', messages: [canonical] as Message[] }))

    expect(resolveSelectedMessageBodies(db, [selected], readTranscript)).toEqual([canonical])
    expect(readTranscript).toHaveBeenCalledWith(session.id)
    expect(() => resolveSelectedMessageBodies(db, [selected], () => ({ source: 'canonical:L1', messages: [] })))
      .toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    db.close()
  })
})
