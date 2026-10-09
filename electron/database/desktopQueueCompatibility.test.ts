import { describe, expect, it } from 'vitest'
import { appendMessage, createSession, desktopQueueCompatibility, getChatMessagePage } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { serializeQueueScope } from '../../src/shared/queueScope'

describe('desktop queue compatibility after IM scope support', () => {
  it('preserves desktop FIFO, atomic claim, reorder and transcript reads alongside IM work', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'desktop-compatibility' })
    const first = desktopQueueCompatibility.enqueue(db, { sessionId: session.id, requestId: 'desktop-1', content: 'first' })
    const second = desktopQueueCompatibility.enqueue(db, { sessionId: session.id, requestId: 'desktop-2', content: 'second' })
    const im = appendMessage(db, { id: 'compat-im', sessionId: session.id, role: 'user', content: 'private remote work', timestamp: 3, status: 'queued' })
    getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
      .run(serializeQueueScope({ kind: 'im', channel: 'wechat', sessionId: 'remote-session' } as never), im.message.id)

    expect(desktopQueueCompatibility.getNext(db, session.id)?.message.id).toBe(first.persisted.message.id)
    const claimed = desktopQueueCompatibility.claim(db, { sessionId: session.id, userMessageId: first.persisted.message.id,
      turnId: 'desktop-claim', assistantMessageId: 'desktop-assistant', requestId: 'desktop-1' })
    expect(claimed.user.message.id).toBe(first.persisted.message.id)
    expect(desktopQueueCompatibility.getNext(db, session.id)?.message.id).toBe(second.persisted.message.id)
    expect(getChatMessagePage(db, session.id, null).entries.map(({ message }) => message.id)).not.toContain(im.message.id)

    expect(desktopQueueCompatibility.reorder(db, { sessionId: session.id, messageIds: [second.persisted.message.id] })).toMatchObject({ ok: true })
    expect(desktopQueueCompatibility.getNext(db, session.id)?.message.id).toBe(second.persisted.message.id)
    db.close()
  })
})
