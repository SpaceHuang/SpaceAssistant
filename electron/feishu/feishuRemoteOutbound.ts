import type { SessionCommands } from '../sessionStorage/contracts'
import { assertImOutboundAllowed, createHostImOutboundFacts, type ImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
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
  outboundDeliveryFacts?: ImOutboundFacts
  recipient?: string
  outboundIdentity?: { identityKey: string; ownerId: string; chatType: 'p2p' | 'group' | 'unknown' }
}): Promise<{ messageId: string } | undefined> {
  const { runner, messageId, body, sessionId, touch } = args
  if (!sessionId || !args.recipient || (!args.outboundIdentity && !args.outboundDeliveryFacts)) throw new Error('FEISHU_OUTBOUND_FINAL_CHECK_REQUIRED')
  const outboundFacts = args.outboundDeliveryFacts ?? createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body,
    sessionId, identityKey: args.outboundIdentity!.identityKey, ownerId: args.outboundIdentity!.ownerId,
    recipient: args.recipient, chatType: args.outboundIdentity!.chatType, destinationId: messageId })
  assertImOutboundAllowed(outboundFacts, { channel: 'feishu', body, sessionId, recipient: args.recipient, destinationId: messageId })
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
  sessionId: string
  recipient: string
  outboundDeliveryFacts: ImOutboundFacts
  touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }
}): Promise<{ messageId: string }> {
  const { runner, messageId, body, sessionId, touch } = args
  assertImOutboundAllowed(args.outboundDeliveryFacts, { channel: 'feishu', body, sessionId, recipient: args.recipient, destinationId: messageId })
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
