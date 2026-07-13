import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import { appendMessage, updateMessageContent } from '../database'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/domainTypes'
import type { FeishuConfig, FeishuInboundMessage, WorkDirProfile } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { readRemoteSessionIdleMinutes } from '../../src/shared/remoteSessionResolve'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import { FeishuConfirmManager } from './feishuConfirmManager'
import { shouldAcceptInbound } from './feishuInboundParser'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'
import { clearRemoteProgressSession } from '../remote/remoteProgressStore'
import { auditEntryToLoggerPayload } from '../remote/remoteSessionSwitchAudit'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'
import { resolveFeishuSession } from './feishuSessionResolver'
import {
  releaseRemoteSession,
  tryClaimRemoteSession
} from '../remote/remoteAgentRegistry'
import { runFeishuRemoteAgent } from './feishuRemoteAgent'
import {
  buildDisambiguationReply,
  resolveDisambiguationChoice,
  resolveWorkDirFromFeishuCommand
} from './feishuWorkDirResolver'
import type { FeishuProcessedStore } from './feishuProcessedStore'
import type { WebContents } from 'electron'
import { logFeishuCliEvent } from './feishuCliLogger'
import { contentHash, inboundSummaryForLog } from './feishuCliLogFields'
import type { WorkDirManager } from '../workDirManager'
import { bindSessionWorkDir, SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'
import {
  REMOTE_PARALLEL_FULL_MESSAGE,
  REMOTE_SESSION_BUSY_MESSAGE
} from '../remote/remoteSessionGuardMessages'
import { createRateLimiter } from '../remote/imRateLimit'


const rateLimiter = createRateLimiter()

export type RemoteCommandRouterDeps = {
  db: AppDatabase
  runner: LarkCliRunner
  processedStore: FeishuProcessedStore
  confirmManager: FeishuConfirmManager
  auditLogger: FeishuAuditLogger
  getFeishuConfig: () => FeishuConfig
  getAppConfig: () => {
    defaultModel: string
    maxParallelChatSessions: number
    workDirProfiles: WorkDirProfile[]
    activeWorkDirProfileId: string
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

const pendingDisambiguation = new Map<string, { profiles: WorkDirProfile[]; originalMsg: FeishuInboundMessage }>()


export class RemoteCommandRouter {
  private lastInboundAt?: number
  private lastReplyAt?: number

  constructor(private deps: RemoteCommandRouterDeps) {}

  getLastInboundAt(): number | undefined {
    return this.lastInboundAt
  }

  getLastReplyAt(): number | undefined {
    return this.lastReplyAt
  }

  async handleInbound(msg: FeishuInboundMessage): Promise<void> {
    this.lastInboundAt = Date.now()
    const config = mergeFeishuConfig(this.deps.getFeishuConfig())
    logFeishuCliEvent('info', 'feishu.inbound.received', inboundSummaryForLog(msg))

    if (this.deps.confirmManager.tryResolveFromInbound(msg)) return

    const disambigKey = msg.chatId
    const pending = pendingDisambiguation.get(disambigKey)
    if (pending) {
      const chosen = resolveDisambiguationChoice(msg.content, pending.profiles)
      if (chosen) {
        pendingDisambiguation.delete(disambigKey)
        await this.processCommand(pending.originalMsg, config, chosen.path, chosen, pending.originalMsg.content)
      }
      return
    }

    const accept = shouldAcceptInbound(msg, config)
    await this.deps.auditLogger.append({
      type: 'inbound',
      messageId: msg.messageId,
      chatId: msg.chatId,
      senderOpenId: msg.senderOpenId,
      accepted: accept.accept,
      reason: accept.reason
    })

    if (!accept.accept) {
      logFeishuCliEvent('info', 'feishu.inbound.reject', { reason: accept.reason })
      if (accept.reason === 'too_long') {
        await replyFeishuText(this.deps.runner, msg.messageId, '消息过长，请控制在 4000 字以内')
      }
      return
    }

    const userContent = accept.userMessage ?? msg.content
    logFeishuCliEvent('info', 'feishu.inbound.accept', {
      reason: accept.reason,
      contentLen: userContent.length,
      contentHash: contentHash(userContent)
    })

    if (config.remoteSenderAllowlist?.length && !config.remoteSenderAllowlist.includes(msg.senderOpenId)) {
      logFeishuCliEvent('warn', 'feishu.inbound.allowlist_reject', { senderOpenId: msg.senderOpenId })
      await replyFeishuText(this.deps.runner, msg.messageId, '您暂无权限向此 Bot 发送指令。')
      return
    }

    if (!rateLimiter.check(msg.senderOpenId, config.remoteRateLimitPerMinute)) {
      await this.deps.auditLogger.append({ type: 'rate_limit', senderOpenId: msg.senderOpenId })
      logFeishuCliEvent('warn', 'feishu.inbound.rate_limit', { senderOpenId: msg.senderOpenId })
      await replyFeishuText(this.deps.runner, msg.messageId, '指令过于频繁，请稍后再试。')
      return
    }

    if (await this.deps.processedStore.has(msg.messageId)) {
      logFeishuCliEvent('info', 'feishu.inbound.duplicate', { messageId: msg.messageId })
      return
    }
    await this.deps.processedStore.mark(msg.messageId)

    const appCfg = this.deps.getAppConfig()
    const workDirResult = resolveWorkDirFromFeishuCommand(
      accept.userMessage ?? msg.content,
      appCfg.workDirProfiles ?? [],
      appCfg.activeWorkDirProfileId
    )

    if (workDirResult.ambiguous?.length) {
      logFeishuCliEvent('info', 'feishu.inbound.disambiguation', {
        profileIds: workDirResult.ambiguous.map((p) => p.id),
        chatId: msg.chatId
      })
      pendingDisambiguation.set(disambigKey, { profiles: workDirResult.ambiguous, originalMsg: msg })
      await replyFeishuText(this.deps.runner, msg.messageId, buildDisambiguationReply(workDirResult.ambiguous))
      return
    }

    const profile = workDirResult.profile
    if (profile) {
      logFeishuCliEvent('info', 'feishu.workdir.resolved', {
        profileId: profile.id,
        profileName: profile.name,
        ambiguousCount: 0
      })
      if (profile.sensitive) {
        await replyFeishuText(this.deps.runner, msg.messageId, '该项目为敏感项目，不允许远程访问')
        return
      }
    }

    const workDir = profile?.path ?? this.deps.getWorkDir()
    await this.processCommand(msg, config, workDir, profile, accept.userMessage ?? msg.content.trim())
  }

  private async processCommand(
    msg: FeishuInboundMessage,
    config: FeishuConfig,
    workDir: string,
    profile?: WorkDirProfile | null,
    userMessage?: string
  ): Promise<void> {
    const appCfg = this.deps.getAppConfig()
    const content = userMessage ?? msg.content.trim()
    const { sessionId, isNew } = await resolveFeishuSession(this.deps.db, msg, config, this.deps.getModel())
    logFeishuCliEvent('info', 'feishu.session.resolved', {
      sessionId,
      isNew,
      chatId: msg.chatId,
      mergeWindowMs: readRemoteSessionIdleMinutes(config) * 60_000
    })

    if (profile?.sensitive) {
      await sendFeishuRemoteOutbound({
        runner: this.deps.runner,
        messageId: msg.messageId,
        body: '该项目为敏感项目，不允许远程访问',
        sessionId,
        touch: { db: this.deps.db, sessionId }
      })
      return
    }

    const claim = tryClaimRemoteSession(sessionId, appCfg.maxParallelChatSessions)
    if (claim === 'session_busy') {
      logFeishuCliEvent('warn', 'feishu.inbound.session_busy', { sessionId })
      await sendFeishuRemoteOutbound({
        runner: this.deps.runner,
        messageId: msg.messageId,
        body: REMOTE_SESSION_BUSY_MESSAGE,
        sessionId,
        touch: { db: this.deps.db, sessionId }
      })
      return
    }
    if (claim === 'parallel_full') {
      logFeishuCliEvent('warn', 'feishu.inbound.parallel_full', { maxParallel: appCfg.maxParallelChatSessions })
      await sendFeishuRemoteOutbound({
        runner: this.deps.runner,
        messageId: msg.messageId,
        body: REMOTE_PARALLEL_FULL_MESSAGE,
        sessionId,
        touch: { db: this.deps.db, sessionId }
      })
      return
    }

    try {
      if (profile) {
        const bindResult = await bindSessionWorkDir(this.deps.db, this.deps.workDirManager, {
          sessionId,
          profileId: profile.id,
          remoteContext: {
            source: 'feishu',
            messageId: msg.messageId,
            confirmPolicy: config.remoteConfirmPolicy
          },
          source: 'inbound',
          appendAudit: (profileId, profileName) =>
            this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName })
        })
        if (!bindResult.success) {
          await sendFeishuRemoteOutbound({
            runner: this.deps.runner,
            messageId: msg.messageId,
            body: bindResult.error ?? SENSITIVE_WORKDIR_ERROR,
            sessionId,
            touch: { db: this.deps.db, sessionId }
          })
          return
        }
      }

      appendMessage(this.deps.db, {
        id: randomUUID(),
        sessionId,
        role: 'user',
        content,
        timestamp: Date.now(),
        status: 'sent'
      })
      touchRemoteSessionActivity(this.deps.db, sessionId)

      if (isNew || config.remoteNotifyOnReceive) {
        await sendFeishuRemoteOutbound({
          runner: this.deps.runner,
          messageId: msg.messageId,
          body: '已收到，正在处理…',
          sessionId,
          touch: { db: this.deps.db, sessionId }
        })
      }

      const wc = this.deps.getMainWebContents()
      wc?.send('feishu:inbound-message', { sessionId, message: msg })

      await this.deps.auditLogger.append({ type: 'agent_start', sessionId, messageId: msg.messageId })

      const requestId = randomUUID()
      const assistantMessageId = randomUUID()
      const assistantTimestamp = Date.now()
      appendMessage(this.deps.db, {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content: '',
        timestamp: assistantTimestamp,
        status: 'streaming',
        schemaVersion: CURRENT_SCHEMA_VERSION
      })
      wc?.send('feishu:remote-agent-start', { sessionId, assistantMessageId, requestId })

      const remoteContext = {
        source: 'feishu' as const,
        messageId: msg.messageId,
        confirmPolicy: config.remoteConfirmPolicy,
        feishuConfig: config,
        confirmManager: this.deps.confirmManager,
        larkCliRunner: this.deps.runner,
        chatId: msg.chatId,
        sessionId,
        appendWorkDirSwitchAudit: (profileId: string, profileName: string) =>
          this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
        appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) =>
          this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
      }

      const result = await runFeishuRemoteAgent({
        db: this.deps.db,
        sessionId,
        userMessage: content,
        replyMessageId: msg.messageId,
        requestId,
        feishuConfig: config,
        workDir,
        workDirManager: this.deps.workDirManager,
        getMainWebContents: this.deps.getMainWebContents,
        getApiKey: this.deps.getApiKey,
        getBaseUrl: this.deps.getBaseUrl,
        getModel: this.deps.getModel,
        runner: this.deps.runner,
        confirmManager: this.deps.confirmManager,
        getToolsConfig: this.deps.getToolsConfig,
        getBrowserConfig: this.deps.getBrowserConfig,
        getWikiConfig: this.deps.getWikiConfig,
        getShellConfig: this.deps.getShellConfig,
        userDataDir: this.deps.getUserDataPath(),
        remoteContext
      })

      if (wc) {
        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
        wc.send('feishu:agent-done', {
          sessionId: outboundSessionId,
          messageId: assistantMessageId,
          requestId,
          ok: result.ok,
          summary: result.summary
        })
      } else {
        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
        updateMessageContent(this.deps.db, assistantMessageId, {
          content: result.summary,
          status: result.ok ? 'completed' : 'failed'
        })
        touchRemoteSessionActivity(this.deps.db, outboundSessionId)
      }

      const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
      await sendFeishuRemoteOutbound({
        runner: this.deps.runner,
        messageId: msg.messageId,
        body: result.summary,
        sessionId: outboundSessionId,
        touch: { db: this.deps.db, sessionId: outboundSessionId }
      })
      this.lastReplyAt = Date.now()
      clearRemoteProgressSession(sessionId)
      await this.deps.auditLogger.append({
        type: 'agent_done',
        sessionId: outboundSessionId,
        success: !result.pendingConfirm,
        summaryLen: result.summary.length
      })
      await this.deps.auditLogger.append({ type: 'reply', messageId: msg.messageId, len: result.summary.length })

      if (result.pendingConfirm && wc) {
        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
        wc.send('feishu:pending-confirm', { sessionId: outboundSessionId, pendingConfirm: true })
      }
    } finally {
      releaseRemoteSession(sessionId)
    }
  }
}
