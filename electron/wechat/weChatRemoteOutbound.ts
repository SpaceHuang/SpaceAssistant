import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { AppDatabase } from '../database'
import { formatRemoteOutboundMessage, sessionSuffixLength } from '../../src/shared/remoteOutboundFormat'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'
import { formatWeChatSummary, type WeChatReplyBot } from './weChatReplyService'
import { logWeChatCliEvent } from './weChatCliLogger'

const WECHAT_SUMMARY_MAX = 2000

export async function sendWeChatRemoteOutbound(args: {
  bot: WeChatReplyBot
  inbound: IncomingMessage
  body: string
  sessionId?: string
  touch?: { db: AppDatabase; sessionId: string }
}): Promise<void> {
  const { bot, inbound, body, sessionId, touch } = args
  const base = formatWeChatSummary(body)
  let text: string

  if (sessionId) {
    const suffixLen = sessionSuffixLength(sessionId)
    if (base.length + suffixLen > WECHAT_SUMMARY_MAX) {
      const maxBase = WECHAT_SUMMARY_MAX - suffixLen
      const footer = '\n\n完整过程请查看 SpaceAssistant 桌面会话'
      const stripped = base.endsWith(footer) ? base.slice(0, -footer.length) : base
      let truncated = stripped.slice(0, Math.max(0, maxBase - footer.length - 1))
      const lastPara = truncated.lastIndexOf('\n\n')
      if (lastPara > truncated.length * 0.6) truncated = truncated.slice(0, lastPara)
      const rebuilt = `${truncated}…${footer}`
      text = formatRemoteOutboundMessage(rebuilt, sessionId)
    } else {
      text = formatRemoteOutboundMessage(base, sessionId)
    }
  } else {
    text = base
  }

  await bot.reply(inbound, text)
  const chunks = Math.ceil(text.length / WECHAT_SUMMARY_MAX)
  logWeChatCliEvent('info', 'wechat.reply.send', {
    textLen: text.length,
    chunksSent: Math.max(1, chunks)
  })

  if (sessionId && touch) {
    touchRemoteSessionActivity(touch.db, touch.sessionId)
  }
}
