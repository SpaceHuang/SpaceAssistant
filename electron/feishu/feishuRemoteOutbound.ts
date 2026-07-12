import type { AppDatabase } from '../database'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuTextRaw } from './feishuReply'
import { formatRemoteOutboundMessage, sessionSuffixLength } from '../../src/shared/remoteOutboundFormat'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'

const FEISHU_REPLY_MAX = 4000
const FEISHU_TRUNCATION_SUFFIX = '…（完整结果请查看桌面会话）'

export async function sendFeishuRemoteOutbound(args: {
  runner: LarkCliRunner
  messageId: string
  body: string
  sessionId?: string
  touch?: { db: AppDatabase; sessionId: string }
}): Promise<void> {
  const { runner, messageId, body, sessionId, touch } = args
  let text: string

  if (sessionId) {
    const suffixLen = sessionSuffixLength(sessionId)
    const maxBody = FEISHU_REPLY_MAX - suffixLen
    let truncatedBody = body
    if (body.length > maxBody) {
      const cut = Math.max(0, maxBody - FEISHU_TRUNCATION_SUFFIX.length)
      truncatedBody = `${body.slice(0, cut)}${FEISHU_TRUNCATION_SUFFIX}`
    }
    text = formatRemoteOutboundMessage(truncatedBody, sessionId)
  } else {
    const maxBody = FEISHU_REPLY_MAX
    text =
      body.length > maxBody
        ? `${body.slice(0, Math.max(0, maxBody - FEISHU_TRUNCATION_SUFFIX.length))}${FEISHU_TRUNCATION_SUFFIX}`
        : body
  }

  await replyFeishuTextRaw(runner, messageId, text)

  if (sessionId && touch) {
    touchRemoteSessionActivity(touch.db, touch.sessionId)
  }
}
