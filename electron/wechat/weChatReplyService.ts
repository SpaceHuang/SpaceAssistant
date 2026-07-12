import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { AppDatabase } from '../database'
import { sendWeChatRemoteOutbound } from './weChatRemoteOutbound'

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

export interface WeChatReplyBot {
  reply: (msg: IncomingMessage, content: string | { text: string }) => Promise<void>
  sendTyping: (userId: string) => Promise<void>
  stopTyping?: (userId: string) => Promise<void>
}

export async function replyWeChatSummary(
  bot: WeChatReplyBot,
  inboundMsg: IncomingMessage,
  summary: string,
  opts?: { sessionId?: string; touch?: { db: AppDatabase; sessionId: string } }
): Promise<{ chunksSent: number }> {
  await sendWeChatRemoteOutbound({
    bot,
    inbound: inboundMsg,
    body: summary,
    sessionId: opts?.sessionId,
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
