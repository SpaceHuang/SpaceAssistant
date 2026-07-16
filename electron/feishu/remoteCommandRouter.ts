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
import { tryClaimOrRelease, createProcessedClaimFinalizer } from '../remote/imCommandRouterHelpers'
import { evaluateImInboundGuard, revalidateImInboundGuard, type ImAuthSnapshot } from '../remote/imInboundGuard'
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
  maskOpenId,
  parseFeishuBindProtocol,
  readOwnerOpenIdFromAllowlist,
  type FeishuOwnerBindController
} from './feishuOwnerBind'
import { CLAIM_LEASE_MS } from '../remote/imProcessedStore'

const rateLimiter = createRateLimiter()

/**
 * Workdir disambiguation TTL must stay under the processed-claim lease so a
 * timed-out pending cannot outlive a reclaimable `claimed` entry.
 */
const DISAMBIGUATION_TTL_MS = CLAIM_LEASE_MS - 15_000

type DisambiguationFinalReason =
  | 'disambiguation_timeout'
  | 'disambiguation_cleared'
  | 'disambiguation_identity_revoked'

type PendingDisambiguation = {
  profiles: WorkDirProfile[]
  originalMsg: FeishuInboundMessage
  senderOpenId: string
  createdAt: number
  expiresAt: number
  processedClaimId: string
  authSnapshot: ImAuthSnapshot
  timer?: ReturnType<typeof setTimeout>
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

  /**
   * Clear workdir disambiguation pending (rebind / clear owner / remote off).
   * Map deletion is synchronous; claim finalization is awaited.
   */
  async clearPendingDisambiguation(): Promise<void> {
    const entries = [...this.pendingDisambiguation.entries()]
    this.pendingDisambiguation.clear()
    await Promise.all(
      entries.map(([, pending]) => this.finalizeDisambiguationClaim(pending, 'disambiguation_cleared'))
    )
  }

  private clearDisambiguationTimer(pending: PendingDisambiguation): void {
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = undefined
    }
  }

  /** Mark claim terminal and clear timer; does not touch the pending map. */
  private async finalizeDisambiguationClaim(
    pending: PendingDisambiguation,
    reason: DisambiguationFinalReason
  ): Promise<void> {
    this.clearDisambiguationTimer(pending)
    await this.deps.processedStore.markCompleted(
      pending.originalMsg.messageId,
      pending.processedClaimId,
      reason
    )
    logFeishuCliEvent('info', 'feishu.disambiguation.finalized', {
      messageId: pending.originalMsg.messageId,
      reason
    })
  }

  /**
   * Drop a pending entry (by object identity) and finalize its claim.
   * Safe if the map already holds a newer pending for the same chat.
   */
  private async finalizeDisambiguation(
    key: string,
    pending: PendingDisambiguation,
    reason: DisambiguationFinalReason
  ): Promise<void> {
    if (this.pendingDisambiguation.get(key) === pending) {
      this.pendingDisambiguation.delete(key)
    }
    await this.finalizeDisambiguationClaim(pending, reason)
  }

  private purgeExpiredDisambiguation(now = Date.now()): void {
    for (const [key, pending] of this.pendingDisambiguation) {
      if (pending.expiresAt <= now) {
        void this.finalizeDisambiguation(key, pending, 'disambiguation_timeout')
      }
    }
  }

  private armDisambiguationTimeout(key: string, pending: PendingDisambiguation): void {
    this.clearDisambiguationTimer(pending)
    pending.timer = setTimeout(() => {
      void this.finalizeDisambiguation(key, pending, 'disambiguation_timeout')
    }, Math.max(0, pending.expiresAt - Date.now()))
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

    // Bind window: only the exact pairing protocol may consume the code. Bind-window messages
    // are ALWAYS consumed here and never enter the Agent (closes bind-race + hijack gaps).
    // Skip shared inbound guard here — owner may not exist yet during pairing.
    if (accept.reason === 'bind_window' || bindingActive) {
      const parsed = parseFeishuBindProtocol(msg.content)
      if (!parsed) {
        // Not a bind command. Reply generic usage hint; do not leak pairing state, no attempt spent.
        logFeishuCliEvent('info', 'feishu.bind.non_protocol', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '远程尚未完成身份绑定。请在电脑端查看配对码，并发送「绑定 <配对码>」（英文 bind <code>）完成绑定。'
        )
        return
      }

      const result = this.deps.ownerBind
        ? this.deps.ownerBind.tryConsumeBindCode(msg.senderOpenId, parsed.code)
        : 'no_window'

      if (result === 'bound') {
        logFeishuCliEvent('info', 'feishu.bind.success', { senderOpenId: msg.senderOpenId })
        await this.deps.auditLogger.append({
          type: 'inbound',
          messageId: msg.messageId,
          chatId: msg.chatId,
          senderOpenId: msg.senderOpenId,
          accepted: true,
          reason: 'bind_success'
        })
        this.deps.getMainWebContents()?.send('feishu:owner-bound', {
          maskedOwnerOpenId: msg.senderOpenId ? maskOpenId(msg.senderOpenId) : undefined,
          boundAt: Date.now()
        })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '已绑定为远程控制者。本条仅用于绑定，请重新发送指令。之后仅你可向 Bot 发送指令。'
        )
        return
      }

      if (result === 'wrong_code') {
        logFeishuCliEvent('warn', 'feishu.bind.wrong_code', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(this.deps.runner, msg.messageId, '配对码错误。请核对电脑端显示的配对码后重试。')
        return
      }

      if (result === 'exhausted') {
        logFeishuCliEvent('warn', 'feishu.bind.exhausted', { senderOpenId: msg.senderOpenId })
        await replyFeishuText(
          this.deps.runner,
          msg.messageId,
          '配对码尝试次数过多，绑定窗口已关闭，远程已停用。请在电脑端重新发起绑定。'
        )
        return
      }

      // already_bound / expired / no_window: another sender won, or window gone.
      logFeishuCliEvent('warn', 'feishu.reject.unbound', {
        senderOpenId: msg.senderOpenId,
        reason: result
      })
      await replyFeishuText(
        this.deps.runner,
        msg.messageId,
        '远程尚未完成身份绑定或配对窗口已失效。请在电脑端重新发起绑定。'
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
        const reason: DisambiguationFinalReason =
          pending.expiresAt <= Date.now()
            ? 'disambiguation_timeout'
            : 'disambiguation_identity_revoked'
        await this.finalizeDisambiguation(disambigKey, pending, reason)
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
        this.clearDisambiguationTimer(pending)
        this.pendingDisambiguation.delete(disambigKey)
        await this.processCommand(
          pending.originalMsg,
          config,
          chosen.path,
          chosen,
          pending.originalMsg.content,
          pending.processedClaimId,
          pending.authSnapshot
        )
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

    const getGuardConfig = () => {
      const c = mergeFeishuConfig(this.deps.getFeishuConfig())
      return {
        enabled: c.enabled,
        remoteEnabled: c.remoteEnabled,
        remoteSenderAllowlist: c.remoteSenderAllowlist
      }
    }
    const guard = evaluateImInboundGuard({
      channel: 'feishu',
      senderId: msg.senderOpenId,
      getConfig: getGuardConfig
    })
    if (!guard.ok) {
      logFeishuCliEvent('warn', 'feishu.inbound.guard_reject', { reason: guard.reason })
      return
    }

    const re1 = revalidateImInboundGuard(guard.snapshot, { getConfig: getGuardConfig })
    if (!re1.ok) {
      logFeishuCliEvent('warn', 'feishu.inbound.guard_revalidate_fail', { reason: re1.reason })
      return
    }

    const claimResult = await this.deps.processedStore.tryClaim(msg.messageId)
    if (!claimResult.ok) {
      logFeishuCliEvent('info', 'feishu.inbound.duplicate', { messageId: msg.messageId })
      return
    }

    const re2 = revalidateImInboundGuard(guard.snapshot, { getConfig: getGuardConfig })
    if (!re2.ok) {
      await this.deps.processedStore.markCompleted(msg.messageId, claimResult.claimId, 'guard_revoked')
      return
    }

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
      const pending: PendingDisambiguation = {
        profiles: workDirResult.ambiguous,
        originalMsg: msg,
        senderOpenId: msg.senderOpenId,
        createdAt: now,
        expiresAt: now + DISAMBIGUATION_TTL_MS,
        processedClaimId: claimResult.claimId,
        authSnapshot: guard.snapshot
      }
      this.armDisambiguationTimeout(disambigKey, pending)
      this.pendingDisambiguation.set(disambigKey, pending)
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
        await this.deps.processedStore.markCompleted(msg.messageId, claimResult.claimId, 'sensitive_blocked')
        await replyFeishuText(this.deps.runner, msg.messageId, '该项目为敏感项目，不允许远程访问')
        return
      }
    }

    const workDir = profile?.path ?? this.deps.getWorkDir()
    await this.processCommand(
      msg,
      config,
      workDir,
      profile,
      accept.userMessage ?? msg.content.trim(),
      claimResult.claimId,
      guard.snapshot
    )
  }

  private async processCommand(
    msg: FeishuInboundMessage,
    config: FeishuConfig,
    workDir: string,
    profile?: WorkDirProfile | null,
    userMessage?: string,
    processedClaimId?: string,
    authSnapshot?: ImAuthSnapshot
  ): Promise<void> {
    const claimFinalizer = createProcessedClaimFinalizer({
      messageId: msg.messageId,
      claimId: processedClaimId,
      markCompleted: (messageId, claimId, resultSummary) =>
        this.deps.processedStore.markCompleted(messageId, claimId, resultSummary)
    })

    const getGuardConfig = () => {
      const c = mergeFeishuConfig(this.deps.getFeishuConfig())
      return {
        enabled: c.enabled,
        remoteEnabled: c.remoteEnabled,
        remoteSenderAllowlist: c.remoteSenderAllowlist
      }
    }

    const failAuth = async (reason: string) => {
      logFeishuCliEvent('warn', 'feishu.inbound.guard_revalidate_fail', { reason })
      await claimFinalizer.complete('authorization_revoked')
    }

    try {
      if (!authSnapshot) {
        await failAuth('missing_auth_snapshot')
        return
      }
      {
        const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
        if (!re.ok) {
          await failAuth(re.reason)
          return
        }
      }

      const appCfg = this.deps.getAppConfig()
      const content = userMessage ?? msg.content.trim()
      const { sessionId, isNew } = await resolveFeishuSession(
        this.deps.db,
        msg,
        config,
        this.deps.getModel()
      )
      {
        const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
        if (!re.ok) {
          await failAuth(re.reason)
          return
        }
      }
      const requestId = randomUUID()
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
        await claimFinalizer.complete('sensitive_blocked')
        return
      }

      const claim = tryClaimOrRelease(sessionId, requestId, appCfg.maxParallelChatSessions)
      if (!claim.ok) {
        if (claim.reason === 'session_busy') {
          logFeishuCliEvent('warn', 'feishu.inbound.session_busy', { sessionId })
        } else {
          logFeishuCliEvent('warn', 'feishu.inbound.parallel_full', {
            maxParallel: appCfg.maxParallelChatSessions
          })
        }
        await sendFeishuRemoteOutbound({
          runner: this.deps.runner,
          messageId: msg.messageId,
          body: claim.message,
          sessionId,
          touch: { db: this.deps.db, sessionId }
        })
        await claimFinalizer.complete(claim.reason)
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
          {
            const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
            if (!re.ok) {
              await failAuth(re.reason)
              return
            }
          }
          if (!bindResult.success) {
            await sendFeishuRemoteOutbound({
              runner: this.deps.runner,
              messageId: msg.messageId,
              body: bindResult.error ?? SENSITIVE_WORKDIR_ERROR,
              sessionId,
              touch: { db: this.deps.db, sessionId }
            })
            await claimFinalizer.complete('workdir_bind_failed')
            return
          }
        }

        {
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
          if (!re.ok) {
            await failAuth(re.reason)
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
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
          if (!re.ok) {
            await failAuth(re.reason)
            return
          }
        }

        const wc = this.deps.getMainWebContents()
        wc?.send('feishu:inbound-message', { sessionId, message: msg })

        {
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
          if (!re.ok) {
            await failAuth(re.reason)
            return
          }
        }

        if (processedClaimId) {
          const executing = await this.deps.processedStore.markExecuting(
            msg.messageId,
            processedClaimId
          )
          if (!executing) {
            logFeishuCliEvent('warn', 'feishu.inbound.claim_transition_failed', {
              messageId: msg.messageId,
              reason: 'processed_claim_lost'
            })
            await this.deps.auditLogger.append({
              type: 'agent_start_rejected',
              sessionId,
              messageId: msg.messageId,
              reason: 'processed_claim_lost'
            })
            await claimFinalizer.complete('processed_claim_lost')
            return
          }
        }

        await this.deps.auditLogger.append({ type: 'agent_start', sessionId, messageId: msg.messageId })
        {
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
          if (!re.ok) {
            await failAuth(re.reason)
            return
          }
        }

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
          userId: authSnapshot.owner,
          authOwner: authSnapshot.owner,
          originSessionId: sessionId,
          outboundSessionId: sessionId,
          workDirProfileId: profile?.id ?? this.deps.workDirManager.getActiveProfileId(),
          authorizationGeneration: authSnapshot.authorizationGeneration,
          requestId,
          appendWorkDirSwitchAudit: (profileId: string, profileName: string) =>
            this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
          appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) =>
            this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
        }

        let result: Awaited<ReturnType<typeof runFeishuRemoteAgent>>
        try {
          result = await runFeishuRemoteAgent({
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
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          result = {
            summary: `执行失败：${err}\n请打开 SpaceAssistant 查看详情`,
            pendingConfirm: false,
            ok: false
          }
        }

        await claimFinalizer.complete(result.ok ? 'ok' : 'failed')

        // Completion (agent-done payload -> renderer DB patch + backup), progress cleanup, audit
        // and pending-confirm all key off the *origin* session, which owns the assistant message
        // and tool-call state for this request. Only IM continuation (outbound reply + activity
        // touch) follows `outboundSessionId`, which may have moved via switch_session.
        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
        if (wc) {
          wc.send('feishu:agent-done', {
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
          touchRemoteSessionActivity(this.deps.db, outboundSessionId)
        }

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
          sessionId,
          success: !result.pendingConfirm,
          summaryLen: result.summary.length
        })
        await this.deps.auditLogger.append({
          type: 'reply',
          messageId: msg.messageId,
          len: result.summary.length
        })

        if (result.pendingConfirm && wc) {
          wc.send('feishu:pending-confirm', { sessionId, pendingConfirm: true })
        }
      } finally {
        claim.release()
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      logFeishuCliEvent('error', 'feishu.inbound.process_error', { error: err })
      await claimFinalizer.complete('process_error')
    } finally {
      // Any early return that forgot to finalize still gets a terminal state (not crash recovery).
      if (!claimFinalizer.done) {
        await claimFinalizer.complete('aborted')
      }
    }
  }
}
