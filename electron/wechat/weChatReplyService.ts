import type { IncomingMessage, WeChatBot } from '@wechatbot/wechatbot'
import type { SessionCommands } from '../sessionStorage/public/ports'
import { sendWeChatRemoteOutbound } from './weChatRemoteOutbound'
import type { PromptSendResult } from '../confirmation/promptSend'
import type { RemoteTrackOutboundDeliveryContext } from '../remote/remoteTrackOutbound'

const SUMMARY_MAX = 2000

/** 简易 Markdown 清理（链接保留可读 URL） */
export function stripMarkdownForWeChat(text: string): string {
  let s = text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  s = s.replace(/^#{1,6}\s+/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
  return s.trim()
}

export function formatWeChatSummary(raw: string): string {
  const stripped = stripMarkdownForWeChat(raw)
  if (stripped.length <= SUMMARY_MAX) return stripped
  const budget = SUMMARY_MAX - 1
  let truncated = stripped.slice(0, budget)
  const lastPara = truncated.lastIndexOf('\n\n')
  if (lastPara > budget * 0.6) truncated = truncated.slice(0, lastPara)
  return `${truncated}…`
}

/** Send an automation result to the configured stable WeChat user ID. */
export async function sendWeChatTextToUser(bot: Pick<WeChatBot, 'send'>, userId: string, text: string): Promise<void> {
  const target = userId.trim()
  if (!target) throw new Error('WECHAT_DELIVERY_TARGET_REQUIRED')
  await bot.send(target, formatWeChatSummary(text))
}

export interface WeChatReplyBot {
  reply: (msg: IncomingMessage, content: string | { text: string }) => Promise<void>
  /** Sends one prompt; WeChat confirmations bind replies through quoted prompt content. */
  sendToUser?: (userId: string, content: string, signal?: AbortSignal) => Promise<PromptSendResult | { messageId: string }>
  sendTyping: (userId: string) => Promise<void>
  stopTyping?: (userId: string) => Promise<void>
}

export function requireWeChatSentMessageId(result: unknown): { messageId: string } {
  if (typeof result === 'string' && result.trim()) return { messageId: result }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const value = result as { messageId?: unknown; message_id?: unknown; id?: unknown; data?: { message_id?: unknown };
      kind?: unknown; delivery?: unknown; binding?: { kind?: unknown; value?: unknown } }
    if (value.kind === 'sent' && value.delivery === 'bound' && value.binding?.kind === 'message-id' &&
      typeof value.binding.value === 'string' && value.binding.value.trim()) return { messageId: value.binding.value }
    const messageId = value.messageId ?? value.message_id ?? value.id ?? value.data?.message_id
    if (typeof messageId === 'string' && messageId.trim()) return { messageId }
  }
  throw new Error('WECHAT_DELIVERY_MESSAGE_ID_MISSING')
}

/** Sends through the channel's receipt-aware adapter so callers can bind replies to the trusted message. */
export async function sendWeChatTextToUserWithReceipt(
  bot: Pick<WeChatReplyBot, 'sendToUser'>,
  userId: string,
  content: string
): Promise<{ messageId: string }> {
  const target = userId.trim()
  if (!target) throw new Error('WECHAT_DELIVERY_TARGET_REQUIRED')
  if (!bot.sendToUser) throw new Error('WECHAT_DELIVERY_UNAVAILABLE')
  return requireWeChatSentMessageId(await bot.sendToUser(target, content))
}

export async function replyWeChatSummary(
  bot: WeChatReplyBot,
  inboundMsg: IncomingMessage,
  summary: string,
  opts?: { sessionId?: string; ownerId?: string; outboundDeliveryFacts?: import('../../src/shared/confirmation/outboundClassification').ImOutboundFacts; touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }; trackDelivery?: RemoteTrackOutboundDeliveryContext }
): Promise<{ chunksSent: number }> {
  await sendWeChatRemoteOutbound({
    bot,
    inbound: inboundMsg,
    body: summary,
    sessionId: opts?.sessionId,
    ownerId: opts?.ownerId, outboundDeliveryFacts: opts?.outboundDeliveryFacts,
    trackDelivery: opts?.trackDelivery,
    touch: opts?.touch
  })
  return { chunksSent: 1 }
}

export async function sendWeChatTyping(bot: WeChatReplyBot, userId: string): Promise<void> {
  try {
    await bot.sendTyping(userId)
  } catch {
    /* non-fatal */
  }
}
