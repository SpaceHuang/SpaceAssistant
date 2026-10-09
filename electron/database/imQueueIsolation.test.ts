import { describe, expect, it } from 'vitest'
import { appendImInboxMessageWithWakeEvent, claimImInboxMessage } from './imInbox'
import { createSession, enqueueQueuedUserMessage, listQueuedUserMessages } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { buildImQueueScope } from '../../src/shared/queueScope'

describe('desktop and IM queue isolation', () => {
  it('isolates Feishu, WeChat, and desktop list/claim through the real database operations', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'cross-channel-isolation' }).id
    const feishuScope = buildImQueueScope('feishu', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const wechatScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const feishu = appendImInboxMessageWithWakeEvent(db, {
      sessionId, channel: 'feishu', queueScope: feishuScope,
      channelMessageId: 'same-channel-id', content: 'Feishu work'
    })
    const wechat = appendImInboxMessageWithWakeEvent(db, {
      sessionId, channel: 'wechat', queueScope: wechatScope,
      channelMessageId: 'same-channel-id', content: 'WeChat work'
    })
    const desktop = enqueueQueuedUserMessage(db, {
      sessionId, requestId: 'desktop-request', content: 'desktop work'
    })

    expect(listQueuedUserMessages(db, { sessionId, queueScope: feishuScope }).map(({ message }) => message.id))
      .toEqual([feishu.messageId])
    expect(listQueuedUserMessages(db, { sessionId, queueScope: wechatScope }).map(({ message }) => message.id))
      .toEqual([wechat.messageId])
    expect(listQueuedUserMessages(db, { sessionId, queueScope: { kind: 'desktop' } }).map(({ message }) => message.id))
      .toEqual([desktop.persisted.message.id])

    expect(claimImInboxMessage(db, { queueScope: wechatScope, messageId: feishu.messageId, ownerId: 'wechat-owner' })).toBeNull()
    expect(claimImInboxMessage(db, { queueScope: feishuScope, messageId: feishu.messageId, ownerId: 'feishu-owner' })).not.toBeNull()
    expect(listQueuedUserMessages(db, { sessionId, queueScope: wechatScope }).map(({ message }) => message.id))
      .toEqual([wechat.messageId])
    expect(listQueuedUserMessages(db, { sessionId, queueScope: { kind: 'desktop' } }).map(({ message }) => message.id))
      .toEqual([desktop.persisted.message.id])
    db.close()
  })
})
