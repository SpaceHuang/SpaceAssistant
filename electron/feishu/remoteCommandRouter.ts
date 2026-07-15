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
import { tryClaimOrRelease } from '../remote/imCommandRouterHelpers'
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
import { createRateLimiter } from '../remote/imRateLimit'
import {
  createFeishuRequestToolConfirm,
  FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE
} from '../remote/remoteConfirmBridge'
import {
  readOwnerOpenIdFromAllowlist,
  type FeishuOwnerBindController
} from './feishuOwnerBind'

const rateLimiter = createRateLimiter()

/** Workdir disambiguation TTL (also cleared on rebind / remote off). */
const DISAMBIGUATION_TTL_MS = 10 * 60_000

type PendingDisambiguation = {
  profiles: WorkDirProfile[]
  originalMsg: FeishuInboundMessage
  senderOpenId: string
  createdAt: number
  expiresAt: number
}

export type RemoteCommandRouterDeps = {
  db: AppDatabase
  runner: LarkCliRunner
  processedStore: FeishuProcessedStore
  confirmManager: FeishuConfirmManager
  auditLogger: FeishuAuditLogger
  getFeishuConfig: () => FeishuConfig
  ownerBind?: FeishuOwnerBindController
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

export class RemoteCommandRouter {
  private lastInboundAt?: number
  private lastReplyAt?: number
  private pendingDisambiguation = new Map<string, PendingDisambiguation>()

  constructor(private deps: RemoteCommandRouterDeps) {}

  /** Clear workdir disambiguation pending (rebind / clear owner / remote off). */
  clearPendingDisambiguation(): void {
    this.pendingDisambiguation.clear()
  }

  private purgeExpiredDisambiguation(now = Date.now()): void {
    for (const [key, pending] of this.pendingDisambiguation) {
      if (pending.expiresAt <= now) this.pendingDisambiguation.delete(key)
    }
  }

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

    const ownerOpenId = readOwnerOpenIdFromAllowlist(config.remoteSenderAllowlist)
    if (this.deps.confirmManager.tryResolveFromInbound(msg, { ownerOpenId })) return

    const bindingActive = Boolean(this.deps.ownerBind?.isBindingActive())
    const accept = shouldAcceptInbound(msg, config, { bindingActive })
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
      } else if (accept.reason === 'group_disabled') {
        logFeishuCliEvent('info', 'feishu.reject.group', { chatId: msg.chatId })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '飞书远程仅支持私聊。请向 Bot 发送私聊消息。'
        )
      } else if (accept.reason === 'non_owner') {
        logFeishuCliEvent('warn', 'feishu.reject.non_owner', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(this.deps.runner, msg.messageId, '您不是已绑定的远程使用者，无法发送指令。')
      } else if (accept.reason === 'unbound') {
        logFeishuCliEvent('warn', 'feishu.reject.unbound', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '远程尚未完成身份绑定。请在电脑端开启远程监听并完成绑定。'
        )
      }
      return
    }

    // Bind window: only bind, never treat this message as a business command (closes race Critical #1).
    if (accept.reason === 'bind_window' || bindingActive) {
      const bound = Boolean(this.deps.ownerBind?.tryBindFromInbound(msg.senderOpenId))
      if (bound) {
        logFeishuCliEvent('info', 'feishu.bind.success', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '已绑定为远程控制者。本条仅用于绑定，请重新发送指令。之后仅你可向 Bot 发送指令。'
        )
        return
      }

      const fresh = mergeFeishuConfig(this.deps.getFeishuConfig())
      const freshOwner = readOwnerOpenIdFromAllowlist(fresh.remoteSenderAllowlist)
      if (!fresh.remoteEnabled || !freshOwner) {
        logFeishuCliEvent('warn', 'feishu.reject.unbound', {
          senderOpenId: msg.senderOpenId,
          reason: 'bind_failed_or_expired'
        })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '远程尚未完成身份绑定。请在电脑端开启远程监听并完成绑定。'
        )
        return
      }
      if (msg.senderOpenId !== freshOwner) {
        logFeishuCliEvent('warn', 'feishu.reject.non_owner', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(this.deps.runner, msg.messageId, '您不是已绑定的远程使用者，无法发送指令。')
        return
      }
      // Owner already set (e.g. concurrent bind won) — still do not process this bind-window message.
      await replyFeishuText(
        this.deps.runner,
        msg.messageId,
        '已完成绑定。本条不作为指令执行，请重新发送。'
      )
      return
    }

    // Workdir disambiguation only after current owner + p2p accept (prevents rebind bypass).
    this.purgeExpiredDisambiguation()
    const disambigKey = msg.chatId
    const pending = this.pendingDisambiguation.get(disambigKey)
    if (pending) {
      const freshOwner = readOwnerOpenIdFromAllowlist(
        mergeFeishuConfig(this.deps.getFeishuConfig()).remoteSenderAllowlist
      )
      const identityOk =
        Boolean(freshOwner) &&
        msg.senderOpenId === freshOwner &&
        pending.senderOpenId === msg.senderOpenId &&
        pending.expiresAt > Date.now()
      if (!identityOk) {
        this.pendingDisambiguation.delete(disambigKey)
        logFeishuCliEvent('warn', 'feishu.disambiguation.reject', {
          senderOpenId: msg.senderOpenId,
          pendingSender: pending.senderOpenId,
          reason: 'identity_or_expired'
        })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '工作目录选择已失效（身份变更或超时）。请重新发送指令。'
        )
        return
      }
      const chosen = resolveDisambiguationChoice(msg.content, pending.profiles)
      if (chosen) {
        this.pendingDisambiguation.delete(disambigKey)
        await this.processCommand(pending.originalMsg, config, chosen.path, chosen, pending.originalMsg.content)
      }
      return
    }

    const userContent = accept.userMessage ?? msg.content
    logFeishuCliEvent('info', 'feishu.inbound.accept', {
      reason: accept.reason,
      contentLen: userContent.length,
      contentHash: contentHash(userContent)
    })

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
      const now = Date.now()
      this.pendingDisambiguation.set(disambigKey, {
        profiles: workDirResult.ambiguous,
        originalMsg: msg,
        senderOpenId: msg.senderOpenId,
        createdAt: now,
        expiresAt: now + DISAMBIGUATION_TTL_MS
      })
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

    const claim = tryClaimOrRelease(sessionId, appCfg.maxParallelChatSessions)
    if (!claim.ok) {
      if (claim.reason === 'session_busy') {
        logFeishuCliEvent('warn', 'feishu.inbound.session_busy', { sessionId })
      } else {
        logFeishuCliEvent('warn', 'feishu.inbound.parallel_full', { maxParallel: appCfg.maxParallelChatSessions })
      }
      await sendFeishuRemoteOutbound({
        runner: this.deps.runner,
        messageId: msg.messageId,
        body: claim.message,
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
        requestToolConfirm: createFeishuRequestToolConfirm(this.deps.confirmManager),
        confirmTimeoutMessage: FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
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
      claim.release()
    }
  }
}
