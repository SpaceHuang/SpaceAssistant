import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { appendImInboxMessageWithWakeEvent } from '../database/imInbox'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { resolveFeishuQuotedReplyContext } from './feishuQuotedReplyContext'

describe('Feishu quoted reply context', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it('reads the quoted app text and resolves the original local session from its reply chain', async () => {
    const temp = createTempDatabase('feishu-quoted-context-')
    cleanups.push(temp.cleanup)
    const session = createSession(temp.db, { name: 'proposal', metadata: { source: 'feishu', feishuChatId: 'chat-1' } })
    appendImInboxMessageWithWakeEvent(temp.db, {
      sessionId: session.id, channel: 'feishu', queueScope: buildImQueueScope('feishu', session.id),
      channelMessageId: 'om_original_inbound', content: 'create proposal'
    })
    const runner = { run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, data: { messages: [{
      message_id: 'om_quoted_app_reply', chat_id: 'chat-1', msg_type: 'text', sender: { sender_type: 'app' },
      content: 'Proposal remains pending.', reply_to: 'om_original_inbound'
    }] } }), stderr: '', timedOut: false })) }

    await expect(resolveFeishuQuotedReplyContext({ runner: runner as never, queries: createSqliteSessionStorage(temp.db).queries,
      message: { messageId: 'om_current_reply', replyToMessageId: 'om_quoted_app_reply', chatId: 'chat-1', chatType: 'p2p',
        senderOpenId: 'owner-1', content: '拒绝该提案', createTime: 'now', mentionsBot: false } }))
      .resolves.toEqual({ content: 'Proposal remains pending.', sessionId: session.id })
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      args: ['im', '+messages-mget', '--as', 'user', '--message-ids', 'om_quoted_app_reply', '--no-reactions', '--format', 'json']
    }))
  })

  it.each([
    ['wrong chat', { chat_id: 'other-chat' }],
    ['non app sender', { sender: { sender_type: 'user' } }],
    ['wrong message id', { message_id: 'om_other' }]
  ])('rejects quoted content with %s', async (_label, override) => {
    const temp = createTempDatabase('feishu-quoted-context-invalid-')
    cleanups.push(temp.cleanup)
    const message = { message_id: 'om_quoted_app_reply', chat_id: 'chat-1', msg_type: 'text',
      sender: { sender_type: 'app' }, content: 'untrusted quoted body', ...override }
    const runner = { run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, data: { messages: [message] } }), stderr: '', timedOut: false })) }

    await expect(resolveFeishuQuotedReplyContext({ runner: runner as never, queries: createSqliteSessionStorage(temp.db).queries,
      message: { messageId: 'om_current_reply', replyToMessageId: 'om_quoted_app_reply', chatId: 'chat-1', chatType: 'p2p',
        senderOpenId: 'owner-1', content: '拒绝该提案', createTime: 'now', mentionsBot: false } })).resolves.toBeNull()
  })
})
