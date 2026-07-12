import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { appendMessage, updateMessageContent } from '../database'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/domainTypes'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { mergeWeChatConfig } from '../../src/shared/wechatTypes'
import type { WeChatAuditLogger } from './weChatAuditLogger'
import type { WeChatBotService } from './weChatBotService'
import type { WeChatConfirmManager } from './weChatConfirmManager'
import { shouldAcceptWeChatInbound, parseSdkInboundMessage } from './weChatInboundParser'
import type { WeChatProcessedStore } from './weChatProcessedStore'
import { replyWeChatSummary } from './weChatReplyService'
import { runWeChatRemoteAgent } from './weChatRemoteAgent'
import { resolveWeChatSession, touchWeChatSessionReply } from './weChatSessionResolver'
import { countRunningRemoteAgents } from '../feishu/runningRemoteAgentRegistry'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import { buildMediaUserMessage, downloadWeChatInboundMedia } from './weChatMediaInbound'
import { inboundSummaryForLog } from './weChatCliLogFields'
import { logWeChatCliEvent } from './weChatCliLogger'

const senderRateMap = new Map<string, number[]>()

export type WeChatCommandRouterDeps = {
  db: AppDatabase
  botService: WeChatBotService
  processedStore: WeChatProcessedStore
  confirmManager: WeChatConfirmManager
  auditLogger: WeChatAuditLogger
  getWeChatConfig: () => WeChatConfig
  getAppConfig: () => {
    defaultModel: string
    maxParallelChatSessions: number
  }
  getWorkDir: () => string
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getMainWebContents: () => WebContents | null
  getModel: () => string
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => import('../../src/shared/domainTypes').BrowserConfig
  getWikiConfig?: () => import('../../src/shared/domainTypes').WikiConfig
}

function checkRateLimit(senderId: string, limit: number): boolean {
  const now = Date.now()
  const window = senderRateMap.get(senderId) ?? []
  const recent = window.filter((t) => now - t < 60_000)
  if (recent.length >= limit) {
    senderRateMap.set(senderId, recent)
    return false
  }
  recent.push(now)
  senderRateMap.set(senderId, recent)
  return true
}

export class WeChatCommandRouter {
  private lastInboundAt?: number
  private inboundRawMap = new Map<string, IncomingMessage>()
  private sessionInboundMap = new Map<string, IncomingMessage>()

  constructor(private deps: WeChatCommandRouterDeps) {}

  getLastInboundAt(): number | undefined {
    return this.lastInboundAt
  }

  getInboundForSession(sessionId: string): IncomingMessage | undefined {
    return this.sessionInboundMap.get(sessionId)
  }

  async handleSdkInbound(raw: IncomingMessage): Promise<void> {
    const msg = parseSdkInboundMessage(raw)
    this.inboundRawMap.set(msg.messageId, raw)
    await this.handleInbound(msg, raw)
  }

  async handleInbound(msg: WeChatInboundMessage, inboundRaw?: IncomingMessage): Promise<void> {
    this.lastInboundAt = Date.now()
    logWeChatCliEvent('info', 'wechat.inbound.received', inboundSummaryForLog(msg))
    const config = mergeWeChatConfig(this.deps.getWeChatConfig())
    const raw = inboundRaw ?? this.inboundRawMap.get(msg.messageId)
    if (!raw) {
      logWeChatCliEvent('warn', 'wechat.inbound.reject', { reason: 'missing_raw', messageId: msg.messageId })
      return
    }
    const bot = this.deps.botService.getBot()

    if (this.deps.confirmManager.tryResolveFromInbound(msg, raw)) {
      logWeChatCliEvent('info', 'wechat.inbound.confirm_resolved', { userId: msg.userId })
      return
    }

    let userContent: string | undefined
    let acceptReason: string | undefined
    const accept = shouldAcceptWeChatInbound(msg, config)

    if (!accept.accept && accept.reason === 'unsupported_type' && (msg.type === 'image' || msg.type === 'file')) {
      const rawBot = this.deps.botService.getRawBot()
      if (rawBot) {
        const media = await downloadWeChatInboundMedia(rawBot, raw, this.deps.getWorkDir())
        if (media) {
          userContent = buildMediaUserMessage(msg, media)
          acceptReason = 'media'
        }
      }
    }

    await this.deps.auditLogger.append({
      type: 'inbound',
      messageId: msg.messageId,
      chatId: msg.userId,
      senderId: msg.userId,
      accepted: accept.accept || Boolean(userContent),
      reason: accept.reason ?? acceptReason
    })

    if (!accept.accept && !userContent) {
      logWeChatCliEvent('info', 'wechat.inbound.reject', {
        reason: accept.reason ?? 'not_accepted',
        messageId: msg.messageId
      })
      if (accept.reason === 'unsupported_type' && bot) {
        await bot.reply(raw, '暂仅支持文本指令，媒体已收到')
      }
      return
    }

    logWeChatCliEvent('info', 'wechat.inbound.accept', {
      ...inboundSummaryForLog(msg),
      acceptReason: accept.reason ?? acceptReason
    })

    if (config.remoteSenderAllowlist?.length && !config.remoteSenderAllowlist.includes(msg.userId)) {
      logWeChatCliEvent('warn', 'wechat.inbound.allowlist_reject', { userId: msg.userId })
      if (bot) await bot.reply(raw, '您暂无权限向此 Bot 发送指令。')
      return
    }

    if (!checkRateLimit(msg.userId, config.remoteRateLimitPerMinute)) {
      logWeChatCliEvent('warn', 'wechat.inbound.rate_limit', { userId: msg.userId })
      await this.deps.auditLogger.append({ type: 'rate_limit', senderId: msg.userId })
      if (bot) await bot.reply(raw, '当前指令过于频繁，请稍后再试')
      return
    }

    if (await this.deps.processedStore.has(msg.messageId)) {
      logWeChatCliEvent('info', 'wechat.inbound.duplicate', { messageId: msg.messageId })
      return
    }
    await this.deps.processedStore.mark(msg.messageId)

    const userContentFinal =
      userContent ?? accept.userMessage ?? msg.text.trim()
    await this.processCommand(msg, config, userContentFinal, raw, accept.reason === 'truncated')
  }

  private async processCommand(
    msg: WeChatInboundMessage,
    config: WeChatConfig,
    content: string,
    inboundRaw: IncomingMessage,
    wasTruncated: boolean
  ): Promise<void> {
    const appCfg = this.deps.getAppConfig()
    const bot = this.deps.botService.getBot()

    if (countRunningRemoteAgents() >= appCfg.maxParallelChatSessions) {
      logWeChatCliEvent('warn', 'wechat.inbound.parallel_full', {
        maxParallel: appCfg.maxParallelChatSessions
      })
      if (bot) await bot.reply(inboundRaw, '当前会话繁忙，请稍后再试')
      return
    }

    const workDir = this.deps.getWorkDir()
    const { sessionId, isNew } = await resolveWeChatSession(
      this.deps.db,
      msg,
      config,
      this.deps.getModel()
    )
    logWeChatCliEvent('info', 'wechat.session.resolved', { sessionId, isNew, userId: msg.userId })
    this.sessionInboundMap.set(sessionId, inboundRaw)

    appendMessage(this.deps.db, {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content: wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content,
      timestamp: Date.now(),
      status: 'sent'
    })

    if (config.remoteAckOnReceive && (isNew || config.remoteNotifyOnReceive) && bot) {
      await bot.reply(inboundRaw, '已收到，正在处理…')
    }

    const wc = this.deps.getMainWebContents()
    wc?.send('wechat:inbound-message', { sessionId, message: msg })

    await this.deps.auditLogger.append({ type: 'agent_start', sessionId, messageId: msg.messageId })

    const requestId = randomUUID()
    const assistantMessageId = randomUUID()
    appendMessage(this.deps.db, {
      id: assistantMessageId,
      sessionId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      schemaVersion: CURRENT_SCHEMA_VERSION
    })
    wc?.send('wechat:remote-agent-start', { sessionId, assistantMessageId, requestId })

    const remoteContext = {
      source: 'wechat' as const,
      messageId: msg.messageId,
      userId: msg.userId,
      contextToken: msg.contextToken,
      confirmPolicy: config.remoteConfirmPolicy,
      wechatConfig: config,
      confirmManager: this.deps.confirmManager,
      sessionId,
      inboundRaw
    }

    let result: { summary: string; pendingConfirm: boolean; ok: boolean }
    try {
      result = await runWeChatRemoteAgent({
        db: this.deps.db,
        sessionId,
        userMessage: content,
        replyMessageId: msg.messageId,
        requestId,
        wechatConfig: config,
        workDir,
        getMainWebContents: this.deps.getMainWebContents,
        getApiKey: this.deps.getApiKey,
        getBaseUrl: this.deps.getBaseUrl,
        getModel: this.deps.getModel,
        botService: this.deps.botService,
        confirmManager: this.deps.confirmManager,
        getToolsConfig: this.deps.getToolsConfig,
        getBrowserConfig: this.deps.getBrowserConfig,
        getWikiConfig: this.deps.getWikiConfig,
        userDataDir: this.deps.getUserDataPath(),
        remoteContext,
        inboundRaw,
        userId: msg.userId,
        onProgressHeartbeat: bot
          ? () => {
              void bot.reply(inboundRaw, '仍在处理中，请稍候…').catch(() => undefined)
            }
          : undefined
      })
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      result = { summary: `执行失败：${err}\n请打开 SpaceAssistant 查看详情`, pendingConfirm: false, ok: false }
    }

    if (wc) {
      wc.send('wechat:agent-done', {
        sessionId,
        messageId: assistantMessageId,
        requestId,
        ok: result.ok,
        summary: result.summary
      })
    } else {
      updateMessageContent(this.deps.db, assistantMessageId, {
        content: result.summary,
        status: result.ok ? 'completed' : 'failed'
      })
    }

    if (bot && !result.pendingConfirm) {
      await replyWeChatSummary(bot, inboundRaw, result.summary)
      touchWeChatSessionReply(this.deps.db, sessionId)
      await this.deps.auditLogger.append({
        type: 'reply',
        sessionId,
        targetId: msg.userId,
        len: result.summary.length,
        success: result.ok
      })
    } else if (result.pendingConfirm && bot) {
      await bot.reply(inboundRaw, '该操作需在桌面端确认，请打开 SpaceAssistant')
    }

    await this.deps.auditLogger.append({
      type: 'agent_done',
      sessionId,
      success: result.ok && !result.pendingConfirm,
      summaryLen: result.summary.length
    })
  }
}
