import { describe, expect, it } from 'vitest'
import { appendMessage, createSession, enqueueQueuedUserMessage, enqueueQueuedUserMessageInScope, getNextQueuedMessageInScope, listQueuedUserMessages, claimQueuedTurnAtomically, claimQueuedTurnAtomicallyInScope, updateQueueInputReceiptState, updateQueueInputReceiptStateInScope, reorderQueuedUserMessages, reorderQueuedUserMessagesInScope, getChatMessagePage, getMessageSkeletons, getMessagesPage } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { serializeQueueScope } from '../../src/shared/queueScope'

describe('queue scope queries', () => {
  it('desktop list and get-next return only desktop queued messages', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'desktop-queue-scope' })
    const imMessage = appendMessage(db, {
      id: 'scope-im-message', sessionId: session.id, role: 'user', content: 'im payload', timestamp: 1, status: 'queued'
    })
    appendMessage(db, {
      id: 'scope-desktop-message', sessionId: session.id, role: 'user', content: 'desktop payload', timestamp: 2, status: 'queued'
    })
    getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
      .run(serializeQueueScope({ kind: 'im', channel: 'feishu', sessionId: 'session-x' } as never), imMessage.message.id)

    expect(listQueuedUserMessages(db, { sessionId: session.id, queueScope: { kind: 'desktop' } }).map(({ message }) => message.id))
      .toEqual(['scope-desktop-message'])
    expect(getNextQueuedMessageInScope(db, session.id, { kind: 'desktop' })?.message.id).toBe('scope-desktop-message')
    db.close()
  })

  it('keeps IM pending input out of desktop transcript reads while preserving desktop queue order and claim', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'desktop-transcript-im-isolation' })
    const first = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'desktop-first', content: 'desktop first' })
    const im = appendMessage(db, {
      id: 'transcript-im-pending', sessionId: session.id, role: 'user', content: 'private IM input', timestamp: 2, status: 'queued'
    })
    getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
      .run(serializeQueueScope({ kind: 'im', channel: 'feishu', sessionId: 'remote-transcript' } as never), im.message.id)
    const second = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'desktop-second', content: 'desktop second' })

    expect(getChatMessagePage(db, session.id, null).entries.map(({ message }) => message.id))
      .not.toContain(im.message.id)
    expect(getMessagesPage(db, session.id, 0, 20).messages.map(({ id }) => id))
      .not.toContain(im.message.id)
    expect(getMessageSkeletons(db, session.id).map(({ id }) => id)).not.toContain(im.message.id)
    expect(listQueuedUserMessages(db, { sessionId: session.id, queueScope: { kind: 'desktop' } }).map(({ message }) => message.id))
      .toEqual([first.persisted.message.id, second.persisted.message.id])

    const claimed = claimQueuedTurnAtomically(db, {
      sessionId: session.id, userMessageId: first.persisted.message.id, turnId: 'desktop-transcript-turn',
      assistantMessageId: 'desktop-transcript-assistant', requestId: 'desktop-first'
    })
    expect(claimed.user.message.id).toBe(first.persisted.message.id)
    expect(getNextQueuedMessageInScope(db, session.id, { kind: 'desktop' })?.message.id).toBe(second.persisted.message.id)
    db.close()
  })
})

it('isolates desktop, feishu, and wechat scopes within one session and separates IM sessions', () => {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: 'cross-channel-queue-scope' })
  const entries = [
    { id: 'scope-desktop', scope: { kind: 'desktop' } as const },
    { id: 'scope-feishu-a', scope: { kind: 'im', channel: 'feishu', sessionId: 'remote-a' } as const },
    { id: 'scope-feishu-b', scope: { kind: 'im', channel: 'feishu', sessionId: 'remote-b' } as const },
    { id: 'scope-wechat-a', scope: { kind: 'im', channel: 'wechat', sessionId: 'remote-a' } as const }
  ]
  for (const [index, entry] of entries.entries()) {
    appendMessage(db, { id: entry.id, sessionId: session.id, role: 'user', content: entry.id, timestamp: index + 1, status: 'queued' })
    getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
      .run(serializeQueueScope(entry.scope as never), entry.id)
  }

  for (const entry of entries) {
    expect(listQueuedUserMessages(db, { sessionId: session.id, queueScope: entry.scope as never }).map(({ message }) => message.id))
      .toEqual([entry.id])
    expect(getNextQueuedMessageInScope(db, session.id, entry.scope as never)?.message.id).toBe(entry.id)
  }
  db.close()
})

it('rejects a queue claim with the wrong scope without changing the message, receipt, or turn', () => {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: 'wrong-scope-claim' })
  const queued = appendMessage(db, { id: 'wrong-scope-claim-message', sessionId: session.id, role: 'user', content: 'keep queued', timestamp: 1, status: 'queued' })
  getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?')
    .run(serializeQueueScope({ kind: 'im', channel: 'feishu', sessionId: 'remote-claim' } as never), queued.message.id)
  getDbConnection(db).prepare(`INSERT INTO queue_input_requests(session_id,request_id,fingerprint,queued_message_id,state,created_at,updated_at,queue_scope)
    VALUES(?,?,?,?,?,?,?,?)`).run(session.id, 'wrong-scope-claim', 'fingerprint', queued.message.id, 'queued', 1, 1,
      serializeQueueScope({ kind: 'im', channel: 'feishu', sessionId: 'remote-claim' } as never))

  expect(() => claimQueuedTurnAtomicallyInScope(db, {
    sessionId: session.id, userMessageId: queued.message.id, turnId: 'wrong-scope-turn',
    assistantMessageId: 'wrong-scope-assistant', requestId: 'wrong-scope-claim',
    queueScope: { kind: 'desktop' }
  } as never)).toThrow()
  expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(queued.message.id)).toEqual({ status: 'queued' })
  expect(getDbConnection(db).prepare('SELECT state FROM queue_input_requests WHERE request_id=?').get('wrong-scope-claim')).toEqual({ state: 'queued' })
  expect(getDbConnection(db).prepare('SELECT turn_id FROM turns WHERE turn_id=?').get('wrong-scope-turn')).toBeUndefined()
  db.close()
})

it.each([
  ['ack', 'claimed', 'completed'],
  ['release', 'claimed', 'queued']
])('rejects a wrong-scope receipt %s without changing receipt state', (_operation, initialState, requestedState) => {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: `wrong-scope-receipt-${_operation}` })
  const imScope = serializeQueueScope({ kind: 'im', channel: 'wechat', sessionId: 'remote-receipt' } as never)
  getDbConnection(db).prepare(`INSERT INTO queue_input_requests(session_id,request_id,fingerprint,state,created_at,updated_at,queue_scope)
    VALUES(?,?,?,?,?,?,?)`).run(session.id, 'wrong-scope-receipt', 'fingerprint', initialState, 1, 1, imScope)

  expect(updateQueueInputReceiptStateInScope(db, session.id, 'wrong-scope-receipt', requestedState, { kind: 'desktop' })).toBe(false)
  expect(getDbConnection(db).prepare('SELECT state,queue_scope FROM queue_input_requests WHERE request_id=?').get('wrong-scope-receipt'))
    .toEqual({ state: initialState, queue_scope: imScope })
  db.close()
})

it('rejects cross-scope reorder and leaves every queue sequence unchanged', () => {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: 'wrong-scope-reorder' })
  appendMessage(db, { id: 'reorder-scope-desktop', sessionId: session.id, role: 'user', content: 'desktop', timestamp: 1, status: 'queued' })
  appendMessage(db, { id: 'reorder-scope-im', sessionId: session.id, role: 'user', content: 'im', timestamp: 2, status: 'queued' })
  const imScope = serializeQueueScope({ kind: 'im', channel: 'feishu', sessionId: 'remote-reorder' } as never)
  getDbConnection(db).prepare('UPDATE messages SET queue_scope=? WHERE id=?').run(imScope, 'reorder-scope-im')
  const before = getDbConnection(db).prepare('SELECT id,sequence,queue_scope FROM messages WHERE status=\'queued\' ORDER BY sequence').all()

  expect(reorderQueuedUserMessagesInScope(db, {
    sessionId: session.id, messageIds: ['reorder-scope-im', 'reorder-scope-desktop'], queueScope: { kind: 'desktop' }
  } as never)).toMatchObject({ ok: false })
  expect(getDbConnection(db).prepare('SELECT id,sequence,queue_scope FROM messages WHERE status=\'queued\' ORDER BY sequence').all()).toEqual(before)
  db.close()
})

it('deduplicates request IDs within each scope independently', () => {
  const db = createMemoryAppDb()
  const session = createSession(db, { name: 'scope-local-idempotency' })
  const desktopScope = { kind: 'desktop' } as const
  const feishuScope = { kind: 'im', channel: 'feishu', sessionId: 'remote-same-id' } as const
  const desktopFirst = enqueueQueuedUserMessageInScope(db, { sessionId: session.id, requestId: 'same-provider-id', content: 'desktop body', queueScope: desktopScope })
  const feishuFirst = enqueueQueuedUserMessageInScope(db, { sessionId: session.id, requestId: 'same-provider-id', content: 'feishu body', queueScope: feishuScope as never })

  expect(feishuFirst.duplicate).toBe(false)
  expect(feishuFirst.persisted.message.id).not.toBe(desktopFirst.persisted.message.id)
  expect(enqueueQueuedUserMessageInScope(db, { sessionId: session.id, requestId: 'same-provider-id', content: 'desktop body', queueScope: desktopScope }).persisted.message.id)
    .toBe(desktopFirst.persisted.message.id)
  expect(enqueueQueuedUserMessageInScope(db, { sessionId: session.id, requestId: 'same-provider-id', content: 'feishu body', queueScope: feishuScope as never }).persisted.message.id)
    .toBe(feishuFirst.persisted.message.id)
  db.close()
})
