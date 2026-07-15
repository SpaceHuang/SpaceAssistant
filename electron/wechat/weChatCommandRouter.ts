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
import { sendWeChatRemoteOutbound } from './weChatRemoteOutbound'
import { runWeChatRemoteAgent } from './weChatRemoteAgent'
import { resolveWeChatSession } from './weChatSessionResolver'
import { tryClaimOrRelease } from '../remote/imCommandRouterHelpers'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import { buildMediaUserMessage, downloadWeChatInboundMedia } from './weChatMediaInbound'
import { inboundSummaryForLog } from './weChatCliLogFields'
import { logWeChatCliEvent } from './weChatCliLogger'
import { auditEntryToLoggerPayload } from '../remote/remoteSessionSwitchAudit'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'
import { resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'
import { createRateLimiter } from '../remote/imRateLimit'
import {
  createWeChatRequestToolConfirm,
  WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE
} from '../remote/remoteConfirmBridge'


const rateLimiter = createRateLimiter()

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
  workDirManager: WorkDirManager
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getMainWebContents: () => WebContents | null
  getModel: () => string
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => import('../../src/shared/domainTypes').BrowserConfig
  getWikiConfig?: () => import('../../src/shared/domainTypes').WikiConfig
  getShellConfig?: () => import('../../src/shared/domainTypes').ShellConfig
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

    if (
      this.deps.confirmManager.tryResolveFromInbound(msg, raw, {
        allowedUserIds: config.remoteSenderAllowlist
      })
    ) {
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

    if (!config.remoteSenderAllowlist?.length) {
      logWeChatCliEvent('warn', 'wechat.reject.non_owner', { userId: msg.userId, reason: 'empty_allowlist' })
      if (bot) await bot.reply(raw, '远程尚未绑定发送者，请在电脑端重新扫码绑定后再试。')
      return
    }
    if (!config.remoteSenderAllowlist.includes(msg.userId)) {
      logWeChatCliEvent('warn', 'wechat.reject.non_owner', { userId: msg.userId })
      if (bot) await bot.reply(raw, '您不是已绑定的远程使用者，无法发送指令。')
      return
    }

    if (!rateLimiter.check(msg.userId, config.remoteRateLimitPerMinute)) {
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

    const { sessionId, isNew } = await resolveWeChatSession(
      this.deps.db,
      msg,
      config,
      this.deps.getModel(),
      undefined,
      () => this.deps.workDirManager.getActiveProfileId()
    )

    const claim = tryClaimOrRelease(sessionId, appCfg.maxParallelChatSessions)
    if (!claim.ok) {
      if (claim.reason === 'session_busy') {
        logWeChatCliEvent('warn', 'wechat.inbound.session_busy', { sessionId })
      } else {
        logWeChatCliEvent('warn', 'wechat.inbound.parallel_full', {
          maxParallel: appCfg.maxParallelChatSessions
        })
      }
      if (bot) {
        await sendWeChatRemoteOutbound({
          bot,
          inbound: inboundRaw,
          body: claim.message,
          sessionId,
          touch: { db: this.deps.db, sessionId }
        })
      }
      return
    }

    try {
      const resolvedWorkDir = resolveWorkDirForSession(
        this.deps.db,
        sessionId,
        () => this.deps.workDirManager.listProfiles(),
        () => this.deps.workDirManager.getActiveProfileId(),
        () => this.deps.workDirManager.getActiveWorkDir()
      )
      const workDir = resolvedWorkDir?.workDir ?? this.deps.getWorkDir()
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
      touchRemoteSessionActivity(this.deps.db, sessionId)

      if (config.remoteAckOnReceive && (isNew || config.remoteNotifyOnReceive) && bot) {
        await sendWeChatRemoteOutbound({
          bot,
          inbound: inboundRaw,
          body: '已收到，正在处理…',
          sessionId,
          touch: { db: this.deps.db, sessionId }
        })
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
        requestToolConfirm: createWeChatRequestToolConfirm({
          confirmManager: this.deps.confirmManager,
          wechatConfig: config,
          userId: msg.userId,
          inboundRaw
        }),
        confirmTimeoutMessage: WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
        sessionId,
        inboundRaw,
        appendWorkDirSwitchAudit: (profileId: string, profileName: string) =>
          this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
        appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) =>
          this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
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
          workDirManager: this.deps.workDirManager,
          getMainWebContents: this.deps.getMainWebContents,
          getApiKey: this.deps.getApiKey,
          getBaseUrl: this.deps.getBaseUrl,
          getModel: this.deps.getModel,
          botService: this.deps.botService,
          confirmManager: this.deps.confirmManager,
          getToolsConfig: this.deps.getToolsConfig,
          getBrowserConfig: this.deps.getBrowserConfig,
          getWikiConfig: this.deps.getWikiConfig,
          getShellConfig: this.deps.getShellConfig,
          userDataDir: this.deps.getUserDataPath(),
          remoteContext,
          inboundRaw,
          userId: msg.userId
        })
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        result = { summary: `执行失败：${err}\n请打开 SpaceAssistant 查看详情`, pendingConfirm: false, ok: false }
      }

      const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)

      if (wc) {
        wc.send('wechat:agent-done', {
          sessionId: outboundSessionId,
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
        touchRemoteSessionActivity(this.deps.db, outboundSessionId)
      }

      if (bot && !result.pendingConfirm) {
        await replyWeChatSummary(bot, inboundRaw, result.summary, {
          sessionId: outboundSessionId,
          touch: { db: this.deps.db, sessionId: outboundSessionId }
        })
        await this.deps.auditLogger.append({
          type: 'reply',
          sessionId: outboundSessionId,
          targetId: msg.userId,
          len: result.summary.length,
          success: result.ok
        })
      }

      await this.deps.auditLogger.append({
        type: 'agent_done',
        sessionId: outboundSessionId,
        success: result.ok && !result.pendingConfirm,
        summaryLen: result.summary.length
      })
    } finally {
      claim.release()
    }
  }
}
