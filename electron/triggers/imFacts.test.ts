import { describe, expect, it } from 'vitest'
import { appendImInboxMessage, captureImFactFrontier, readImFactPage } from '../database/imInbox'
import { createSession } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database/index'
import { getDbConnection } from '../database/sqliteStore'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { createSessionQueries } from '../sessionStorage/queries'

describe('accepted IM fact cursor and coverage', () => {
  it('pages beyond 100 in acceptance order regardless of queue status and uses a stable watermark', () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'im-fact-pages' }).id
      const scope = { channel: 'feishu' as const, accountId: 'account', conversationId: 'chat' }
      const queueScope = buildImQueueScope('feishu', sessionId)
      const ids: string[] = []
      for (let index = 0; index < 105; index += 1) ids.push(appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope,
        channelMessageId: `platform-${index}`, accountId: scope.accountId, conversationId: scope.conversationId, senderId: 'sender', content: `body-${index}` }).messageId)
      const factPort = createSessionQueries(db).imAcceptedFacts
      const frontier = factPort.captureFrontier(scope)
      getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(ids[0])
      const first = factPort.readPage({ ...scope, after: 0, ...frontier, limit: 100 })
      expect(first.items).toHaveLength(100)
      expect(first.nextAfter).toBe(100)
      const second = factPort.readPage({ ...scope, after: first.nextAfter!, ...frontier, limit: 100 })
      expect(second.items).toHaveLength(5)
      expect(second.items[0]?.platformMessageId).toBe('platform-100')
      expect(factPort.readBody({ ...scope, messageId: second.items[0]!.messageId })).toBe('body-100')
    } finally { db.close() }
  })

  it('detects deletion during pagination only in the affected stream and never reuses its watermark', () => {
    const db = createMemoryAppDb()
    try {
      const sessionId = createSession(db, { name: 'im-fact-coverage' }).id
      const feishu = { channel: 'feishu' as const, accountId: 'account-a', conversationId: 'chat-a' }
      const wechat = { channel: 'wechat' as const, accountId: 'account-b', conversationId: 'chat-b' }
      const first = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope: buildImQueueScope('feishu', sessionId),
        channelMessageId: 'delete-tail', ...feishu, senderId: 'sender', content: 'one' })
      appendImInboxMessage(db, { sessionId, channel: 'wechat', queueScope: buildImQueueScope('wechat', sessionId),
        channelMessageId: 'other-stream', ...wechat, senderId: 'sender', content: 'other' })
      const feishuFrontier = captureImFactFrontier(db, feishu)
      const wechatFrontier = captureImFactFrontier(db, wechat)
      getDbConnection(db).prepare('DELETE FROM messages WHERE id=?').run(first.messageId)
      expect(() => readImFactPage(db, { scope: feishu, after: 0, ...feishuFrontier, limit: 10 })).toThrow('TRIGGER_SOURCE_GAP:im-coverage-changed')
      expect(readImFactPage(db, { scope: wechat, after: 0, ...wechatFrontier, limit: 10 }).items).toHaveLength(1)
      const later = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope: buildImQueueScope('feishu', sessionId),
        channelMessageId: 'after-delete', ...feishu, senderId: 'sender', content: 'later' })
      expect(getDbConnection(db).prepare('SELECT accepted_seq FROM im_inbox_message_context WHERE message_id=?').get(later.messageId)).toEqual({ accepted_seq: 3 })
    } finally { db.close() }
  })

  it('preserves the accepted frontier across reopen and satisfies deterministic append/delete page invariants', () => {
    const temp = createTempDatabase('runtime-trigger-fact-sequence-')
    let db = temp.db
    try {
      const sessionId = createSession(db, { name: 'im-fact-randomized' }).id
      const scope = { channel: 'feishu' as const, accountId: 'account', conversationId: 'chat' }
      const queueScope = buildImQueueScope('feishu', sessionId)
      let seed = 0x51a7
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed }
      const accepted: Array<{ id: string; seq: number }> = []
      for (let index = 0; index < 60; index += 1) {
        if (index % 7 === 6 && accepted.length > 4) {
          const removeAt = rand() % accepted.length
          const [removed] = accepted.splice(removeAt, 1)
          getDbConnection(db).prepare('DELETE FROM messages WHERE id=?').run(removed!.id)
        }
        const saved = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope, channelMessageId: `random-${index}`,
          ...scope, senderId: `sender-${rand() % 3}`, content: `body-${index}` })
        const seq = (getDbConnection(db).prepare('SELECT accepted_seq FROM im_inbox_message_context WHERE message_id=?').get(saved.messageId) as { accepted_seq: number }).accepted_seq
        accepted.push({ id: saved.messageId, seq })
      }
      const before = captureImFactFrontier(db, scope)
      db.close()
      db = openDatabase(temp.dbPath)
      const after = captureImFactFrontier(db, scope)
      expect(after.through).toBe(before.through)
      expect(after.coverageRevision).toBe(before.coverageRevision)
      const actual = [] as number[]
      let cursor = 0
      while (true) {
        const page = readImFactPage(db, { scope, after: cursor, ...after, limit: 9 })
        actual.push(...page.items.map((item) => item.acceptedSeq))
        if (page.nextAfter === undefined) break
        cursor = page.nextAfter
      }
      expect(actual).toEqual(accepted.map(({ seq }) => seq).sort((a, b) => a - b))
      expect(new Set(actual).size).toBe(actual.length)
      expect(actual.every((seq) => seq > 0 && seq <= after.through)).toBe(true)
    } finally { temp.cleanup(db) }
  })
})
