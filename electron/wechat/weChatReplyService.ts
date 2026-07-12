const SUMMARY_MAX = 2000
const FOOTER = '\n\n完整过程请查看 SpaceAssistant 桌面会话'

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
  const withFooter = stripped + FOOTER
  if (withFooter.length <= SUMMARY_MAX) return withFooter
  const budget = SUMMARY_MAX - FOOTER.length - 1
  let truncated = stripped.slice(0, budget)
  const lastPara = truncated.lastIndexOf('\n\n')
  if (lastPara > budget * 0.6) truncated = truncated.slice(0, lastPara)
  return `${truncated}…${FOOTER}`
}

import type { IncomingMessage } from '@wechatbot/wechatbot'
import { logWeChatCliEvent } from './weChatCliLogger'

export interface WeChatReplyBot {
  reply: (msg: IncomingMessage, content: string | { text: string }) => Promise<void>
  sendTyping: (userId: string) => Promise<void>
  stopTyping?: (userId: string) => Promise<void>
}

export async function replyWeChatSummary(
  bot: WeChatReplyBot,
  inboundMsg: IncomingMessage,
  summary: string
): Promise<{ chunksSent: number }> {
  const text = formatWeChatSummary(summary)
  await bot.reply(inboundMsg, text)
  const chunks = Math.ceil(text.length / 2000)
  logWeChatCliEvent('info', 'wechat.reply.send', {
    textLen: text.length,
    chunksSent: Math.max(1, chunks)
  })
  return { chunksSent: Math.max(1, chunks) }
}

export async function sendWeChatTyping(bot: WeChatReplyBot, userId: string): Promise<void> {
  try {
    await bot.sendTyping(userId)
  } catch {
    /* non-fatal */
  }
}
