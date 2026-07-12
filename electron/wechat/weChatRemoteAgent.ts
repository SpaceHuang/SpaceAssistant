import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { getMessages } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import type { BrowserConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { WeChatConfig } from '../../src/shared/wechatTypes'
import { buildWeChatRemoteSystemAppendix } from '../../src/shared/wechatPrompts'
import { resolveFeishuBrowserRemoteHint } from '../../src/shared/browserRemotePolicy'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import { registerRunningRemoteAgent, unregisterRunningRemoteAgent } from '../feishu/runningRemoteAgentRegistry'
import type { WeChatConfirmManager } from './weChatConfirmManager'
import type { WeChatRemoteContext } from '../tools/types'
import type { WeChatBotService } from './weChatBotService'
import { sendWeChatTyping } from './weChatReplyService'
import { logWeChatCliEvent } from './weChatCliLogger'

export async function runWeChatRemoteAgent(ctx: {
  db: AppDatabase
  sessionId: string
  userMessage: string
  replyMessageId: string
  requestId: string
  wechatConfig: WeChatConfig
  workDir: string
  userDataDir: string
  getMainWebContents: () => WebContents | null
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  botService: WeChatBotService
  confirmManager: WeChatConfirmManager
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getWikiConfig?: () => WikiConfig
  remoteContext: WeChatRemoteContext
  inboundRaw: IncomingMessage
  userId: string
  onProgressHeartbeat?: () => void
}): Promise<{ summary: string; pendingConfirm: boolean; ok: boolean }> {
  const requestId = ctx.requestId
  const sender = ctx.getMainWebContents()
  const noopSender = { send: () => undefined } as unknown as WebContents
  const effectiveSender = sender ?? noopSender

  registerRunningRemoteAgent(ctx.sessionId)

  logWeChatCliEvent('info', 'wechat.agent.remote.start', {
    sessionId: ctx.sessionId,
    messageId: ctx.replyMessageId,
    requestId
  })

  const bot = ctx.botService.getBot()
  let typingTimer: ReturnType<typeof setInterval> | undefined
  if (ctx.wechatConfig.remoteTypingEnabled && bot) {
    void sendWeChatTyping(bot, ctx.userId)
    typingTimer = setInterval(() => {
      void sendWeChatTyping(bot, ctx.userId)
      ctx.onProgressHeartbeat?.()
    }, 15_000)
  }

  const heartbeatSec = ctx.wechatConfig.remoteProgressHeartbeatSec ?? 60
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  if (heartbeatSec > 0 && bot) {
    heartbeatTimer = setInterval(() => {
      ctx.onProgressHeartbeat?.()
    }, heartbeatSec * 1000)
  }

  try {
    const toolsConfig = ctx.getToolsConfig()
    const rawMessages = getMessages(ctx.db, ctx.sessionId)
    const built = buildClaudeToolChatMessages(rawMessages)
    const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)
    const { messages } = ensureToolResultPairing(trimmed)

    const browserConfig = ctx.getBrowserConfig?.()
    const appendix = buildWeChatRemoteSystemAppendix({
      userId: ctx.userId,
      confirmPolicy: ctx.wechatConfig.remoteConfirmPolicy,
      browserRemoteHint: resolveFeishuBrowserRemoteHint(
        browserConfig?.enabled,
        browserConfig?.allowRemoteSessions
      )
    })

    const res = await runToolChatSession({
      sender: effectiveSender,
      requestId,
      sessionId: ctx.sessionId,
      model: ctx.getModel(),
      baseUrl: ctx.getBaseUrl(),
      messages,
      system: appendix,
      options: { maxTokens: 8192 },
      toolsConfig,
      browserConfig: ctx.getBrowserConfig?.(),
      wikiConfig: ctx.getWikiConfig?.(),
      workDir: ctx.workDir,
      userDataDir: ctx.userDataDir,
      getApiKey: ctx.getApiKey,
      appDb: ctx.db,
      wechatConfig: ctx.wechatConfig,
      remoteContext: ctx.remoteContext
    })

    if (!res.ok) {
      const pending = res.error.includes('桌面') || res.error.includes('确认')
      logWeChatCliEvent('warn', 'wechat.agent.remote.done', {
        sessionId: ctx.sessionId,
        ok: false,
        pendingConfirm: pending,
        error: res.error
      })
      return { summary: res.error, pendingConfirm: pending, ok: false }
    }

    const text = extractTextFromContent(res.content)
    logWeChatCliEvent('info', 'wechat.agent.remote.done', {
      sessionId: ctx.sessionId,
      ok: true,
      summaryLen: text.length
    })
    return { summary: text || '任务已完成。', pendingConfirm: false, ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logWeChatCliEvent('error', 'wechat.agent.remote.error', { sessionId: ctx.sessionId, error })
    throw new Error(error)
  } finally {
    if (typingTimer) clearInterval(typingTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    const b = ctx.botService.getBot()
    if (b?.stopTyping) void b.stopTyping(ctx.userId).catch(() => undefined)
    unregisterRunningRemoteAgent(ctx.sessionId)
  }
}

function extractTextFromContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s.trim()
}
