import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import type { LarkCliRunner } from './larkCliRunner'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'

const MAX_QUOTED_MESSAGE_CHARS = 12_000

type MgetMessage = {
  message_id?: unknown
  chat_id?: unknown
  msg_type?: unknown
  content?: unknown
  reply_to?: unknown
  sender?: { sender_type?: unknown }
}

/**
 * Reads the exact quoted parent and maps its reply-to source back to a local session.
 * Phase: observed fact only. Callers still enforce current owner/session policy; quoted
 * text is untrusted context and must never be treated as authorization material.
 */
export async function resolveFeishuQuotedReplyContext(input: {
  runner: LarkCliRunner
  db: AppDatabase
  message: FeishuInboundMessage
}): Promise<{ content: string; sessionId?: string } | null> {
  const quotedMessageId = input.message.replyToMessageId
  if (!quotedMessageId || !/^om_[a-zA-Z0-9_-]+$/.test(quotedMessageId)) return null

  const result = await input.runner.run({
    args: ['im', '+messages-mget', '--as', 'user', '--message-ids', quotedMessageId, '--no-reactions', '--format', 'json'],
    timeoutSec: 15
  })
  if (result.exitCode !== 0 || result.timedOut) return null

  let envelope: unknown
  try { envelope = JSON.parse(result.stdout) as unknown } catch { return null }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
  const root = envelope as { ok?: unknown; data?: { messages?: unknown } }
  if (root.ok !== true || !Array.isArray(root.data?.messages)) return null
  const quoted = root.data.messages.find((item): item is MgetMessage => Boolean(item && typeof item === 'object' &&
    !Array.isArray(item) && (item as MgetMessage).message_id === quotedMessageId))
  if (!quoted || quoted.chat_id !== input.message.chatId || quoted.sender?.sender_type !== 'app' ||
    quoted.msg_type !== 'text' || typeof quoted.content !== 'string' || !quoted.content.trim()) return null

  let sessionId: string | undefined
  if (typeof quoted.reply_to === 'string' && quoted.reply_to.trim()) {
    const rows = getDbConnection(input.db).prepare(`SELECT m.session_id FROM im_inbox_message_context AS c
      JOIN messages AS m ON m.id=c.message_id
      WHERE c.channel='feishu' AND c.platform_message_id=? LIMIT 2`).all(quoted.reply_to) as Array<{ session_id: string }>
    if (rows.length === 1) sessionId = rows[0]!.session_id
  }

  return { content: quoted.content.slice(0, MAX_QUOTED_MESSAGE_CHARS), ...(sessionId ? { sessionId } : {}) }
}
