import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'

export interface InboundAcceptResult {
  accept: boolean
  reason?: string
  userMessage?: string
}

const MAX_COMMAND_LEN = 4000

export function stripCommandPrefix(content: string, prefix: string): string {
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : content.trim()
}

export function shouldAcceptWeChatInbound(msg: WeChatInboundMessage, config: WeChatConfig): InboundAcceptResult {
  if (!msg.text.trim() && msg.type === 'text') return { accept: false, reason: 'empty' }

  if (msg.type !== 'text') {
    return { accept: false, reason: 'unsupported_type' }
  }

  const text = msg.text.trim()
  if (!text) return { accept: false, reason: 'empty' }

  const prefix = config.remoteCommandPrefix?.trim()
  if (prefix) {
    if (!text.startsWith(prefix)) return { accept: false, reason: 'no_prefix' }
    const userMessage = stripCommandPrefix(text, prefix)
    if (!userMessage) return { accept: false, reason: 'empty' }
    if (userMessage.length > MAX_COMMAND_LEN) {
      return { accept: true, userMessage: userMessage.slice(0, MAX_COMMAND_LEN), reason: 'truncated' }
    }
    return { accept: true, userMessage }
  }

  if (text.length > MAX_COMMAND_LEN) {
    return { accept: true, userMessage: text.slice(0, MAX_COMMAND_LEN), reason: 'truncated' }
  }

  return { accept: true, userMessage: text }
}

export function truncateTitle(content: string, max = 30): string {
  const t = content.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

export function parseSdkInboundMessage(raw: IncomingMessage): WeChatInboundMessage {
  const messageId = raw.raw.client_id || `${raw.userId}-${raw.timestamp.getTime()}`
  const contextToken = raw._contextToken || raw.raw.context_token || ''

  return {
    messageId,
    userId: raw.userId,
    text: raw.text ?? '',
    type: raw.type,
    timestamp: raw.timestamp.toISOString(),
    contextToken
  }
}
