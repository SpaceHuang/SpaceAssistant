import type { AppDatabase } from '../database'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuTextRaw } from './feishuReply'
import { sendImOutbound } from '../remote/imRemoteOutbound'

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
  await sendImOutbound({
    reply: (text) => replyFeishuTextRaw(runner, messageId, text),
    body,
    sessionId,
    maxLen: FEISHU_REPLY_MAX,
    truncationSuffix: FEISHU_TRUNCATION_SUFFIX,
    touch
  })
}
