import type { SessionCommands } from '../sessionStorage/contracts'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuTextRaw, replyFeishuTextRawWithId } from './feishuReply'
import { sendImOutbound } from '../remote/imRemoteOutbound'
import { sendRemoteTrackOutbound, type RemoteTrackOutboundDeliveryContext } from '../remote/remoteTrackOutbound'

const FEISHU_REPLY_MAX = 4000
const FEISHU_TRUNCATION_SUFFIX = '…（完整结果请查看桌面会话）'

export async function sendFeishuRemoteOutbound(args: {
  runner: LarkCliRunner
  messageId: string
  body: string
  sessionId?: string
  touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }
  trackDelivery?: RemoteTrackOutboundDeliveryContext
}): Promise<{ messageId: string } | undefined> {
  const { runner, messageId, body, sessionId, touch } = args
  const send = () => sendImOutbound({
    reply: (text) => replyFeishuTextRaw(runner, messageId, text),
    body,
    sessionId,
    maxLen: FEISHU_REPLY_MAX,
    truncationSuffix: FEISHU_TRUNCATION_SUFFIX,
    touch
  })
  if (!args.trackDelivery) return readMessageId(await send())
  const result = await sendRemoteTrackOutbound({
    delivery: args.trackDelivery,
    send,
    readPlatformMessageId: (sent) => readMessageId(sent)?.messageId
  })
  return readMessageId(result)
}

function readMessageId(result: unknown): { messageId: string } | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined
  const messageId = (result as { messageId?: unknown }).messageId
  return typeof messageId === 'string' && messageId.trim() ? { messageId } : undefined
}

export async function sendFeishuRemoteOutboundWithId(args: {
  runner: LarkCliRunner
  messageId: string
  body: string
  sessionId?: string
  touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }
}): Promise<{ messageId: string }> {
  const { runner, messageId, body, sessionId, touch } = args
  const result = await sendImOutbound({
    reply: (text) => replyFeishuTextRawWithId(runner, messageId, text),
    body,
    sessionId,
    maxLen: FEISHU_REPLY_MAX,
    truncationSuffix: FEISHU_TRUNCATION_SUFFIX,
    touch
  })
  if (!result || typeof result !== 'object' || typeof (result as { messageId?: unknown }).messageId !== 'string' || !(result as { messageId: string }).messageId.trim()) {
    throw new Error('FEISHU_DELIVERY_MESSAGE_ID_MISSING')
  }
  return { messageId: (result as { messageId: string }).messageId }
}
