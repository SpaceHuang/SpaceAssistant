import type { IncomingMessage } from '@wechatbot/wechatbot'
import { assertImOutboundAllowed, createHostImOutboundFacts, type ImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
import type { SessionCommands } from '../sessionStorage/contracts'
import { formatRemoteOutboundMessage, sessionSuffixLength } from '../../src/shared/remoteOutboundFormat'
import { maybeTouchOutboundActivity } from '../remote/imRemoteOutbound'
import { formatWeChatSummary, type WeChatReplyBot } from './weChatReplyService'
import { logWeChatCliEvent } from './weChatCliLogger'
import { sendRemoteTrackOutbound, type RemoteTrackOutboundDeliveryContext } from '../remote/remoteTrackOutbound'

const WECHAT_SUMMARY_MAX = 2000

export async function sendWeChatRemoteOutbound(args: {
  bot: WeChatReplyBot
  inbound: IncomingMessage
  body: string
  sessionId?: string
  touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }
  trackDelivery?: RemoteTrackOutboundDeliveryContext
  outboundDeliveryFacts?: ImOutboundFacts
  ownerId?: string
}): Promise<void> {
  const { bot, inbound, body, sessionId, touch } = args
  const destinationId = inbound.raw?.client_id || (inbound.userId && inbound.timestamp ? `${inbound.userId}-${inbound.timestamp.getTime()}` : 'inbound-message')
  if (!sessionId) throw new Error('WECHAT_OUTBOUND_FINAL_CHECK_REQUIRED')
  const outboundFacts = args.outboundDeliveryFacts ?? (args.ownerId ? createHostImOutboundFacts({ channel: 'wechat', purpose: 'system-reply',
    body, sessionId, identityKey: inbound.userId, ownerId: args.ownerId, recipient: inbound.userId, chatType: 'p2p', destinationId }) : undefined)
  if (!outboundFacts) throw new Error('WECHAT_OUTBOUND_FINAL_CHECK_REQUIRED')
  assertImOutboundAllowed(outboundFacts, { channel: 'wechat', body, sessionId, recipient: inbound.userId, destinationId })
  const base = formatWeChatSummary(body)
  let text: string

  if (sessionId) {
    const suffixLen = sessionSuffixLength(sessionId)
    if (base.length + suffixLen > WECHAT_SUMMARY_MAX) {
      const maxBase = WECHAT_SUMMARY_MAX - suffixLen
      let truncated = base.slice(0, Math.max(0, maxBase - 1))
      const lastPara = truncated.lastIndexOf('\n\n')
      if (lastPara > truncated.length * 0.6) truncated = truncated.slice(0, lastPara)
      const rebuilt = `${truncated}…`
      text = formatRemoteOutboundMessage(rebuilt, sessionId)
    } else {
      text = formatRemoteOutboundMessage(base, sessionId)
    }
  } else {
    text = base
  }

  const send = async () => {
    await bot.reply(inbound, text)
    const chunks = Math.ceil(text.length / WECHAT_SUMMARY_MAX)
    logWeChatCliEvent('info', 'wechat.reply.send', { textLen: text.length, chunksSent: Math.max(1, chunks) })
    maybeTouchOutboundActivity(sessionId, touch)
  }
  if (!args.trackDelivery) return send()
  await sendRemoteTrackOutbound({ delivery: args.trackDelivery, send, readPlatformMessageId: () => undefined })
}
