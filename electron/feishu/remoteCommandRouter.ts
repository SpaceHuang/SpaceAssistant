import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import { appendMessage, updateMessageContent } from '../database'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/domainTypes'
import type { FeishuConfig, FeishuInboundMessage, WorkDirProfile } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import type { ToolsConfig, PlanConfig } from '../../src/shared/domainTypes'
import { mergePlanConfig } from '../../src/shared/domainTypes'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import { FeishuConfirmManager } from './feishuConfirmManager'
import { shouldAcceptInbound } from './feishuInboundParser'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { resolveFeishuSession } from './feishuSessionResolver'
import { countRunningRemoteAgents } from './runningRemoteAgentRegistry'
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

const senderRateMap = new Map<string, number[]>()

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
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getMainWebContents: () => WebContents | null
  getModel: () => string
  getToolsConfig: () => ToolsConfig
  getWikiConfig?: () => import('../../src/shared/domainTypes').WikiConfig
  getPlanConfig?: () => PlanConfig
}

const pendingDisambiguation = new Map<string, { profiles: WorkDirProfile[]; originalMsg: FeishuInboundMessage }>()

function checkRateLimit(senderOpenId: string, limit: number): boolean {
  const now = Date.now()
  const window = senderRateMap.get(senderOpenId) ?? []
  const recent = window.filter((t) => now - t < 60_000)
  if (recent.length >= limit) {
    senderRateMap.set(senderOpenId, recent)
    return false
  }
  recent.push(now)
  senderRateMap.set(senderOpenId, recent)
  return true
}

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

    if (!checkRateLimit(msg.senderOpenId, config.remoteRateLimitPerMinute)) {
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
    }

    if (profile?.sensitive) {
      logFeishuCliEvent('warn', 'feishu.inbound.sensitive_workdir', { profileId: profile.id })
      await replyFeishuText(this.deps.runner, msg.messageId, '该项目标记为敏感，禁止远程执行，请在桌面端操作。')
      return
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
    if (countRunningRemoteAgents() >= appCfg.maxParallelChatSessions) {
      logFeishuCliEvent('warn', 'feishu.inbound.parallel_full', { maxParallel: appCfg.maxParallelChatSessions })
      await replyFeishuText(this.deps.runner, msg.messageId, '当前并行任务已满，请稍后再试')
      return
    }

    const content = userMessage ?? msg.content.trim()
    const { sessionId, isNew } = await resolveFeishuSession(this.deps.db, msg, config, this.deps.getModel())
    logFeishuCliEvent('info', 'feishu.session.resolved', {
      sessionId,
      isNew,
      chatId: msg.chatId,
      mergeWindowMs: (config.remoteSessionMergeMinutes ?? 0) * 60_000
    })

    if (profile) {
      await this.deps.auditLogger.append({
        type: 'workdir_switch',
        profileId: profile.id,
        profileName: profile.name
      })
    }

    appendMessage(this.deps.db, {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content,
      timestamp: Date.now(),
      status: 'sent'
    })

    if (isNew || config.remoteNotifyOnReceive) {
      await replyFeishuText(this.deps.runner, msg.messageId, '已收到，正在处理…')
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
      chatId: msg.chatId,
      sessionId
    }

    const result = await runFeishuRemoteAgent({
      db: this.deps.db,
      sessionId,
      userMessage: content,
      replyMessageId: msg.messageId,
      requestId,
      feishuConfig: config,
      workDir,
      getMainWebContents: this.deps.getMainWebContents,
      getApiKey: this.deps.getApiKey,
      getBaseUrl: this.deps.getBaseUrl,
      getModel: this.deps.getModel,
      runner: this.deps.runner,
      confirmManager: this.deps.confirmManager,
      getToolsConfig: this.deps.getToolsConfig,
      getWikiConfig: this.deps.getWikiConfig,
      getPlanConfig: this.deps.getPlanConfig,
      userDataDir: this.deps.getUserDataPath(),
      remoteContext
    })

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
    }

    await replyFeishuText(this.deps.runner, msg.messageId, result.summary)
    this.lastReplyAt = Date.now()
    await this.deps.auditLogger.append({
      type: 'agent_done',
      sessionId,
      success: !result.pendingConfirm,
      summaryLen: result.summary.length
    })
    await this.deps.auditLogger.append({ type: 'reply', messageId: msg.messageId, len: result.summary.length })

    if (result.pendingConfirm && wc) {
      wc.send('feishu:pending-confirm', { sessionId, pendingConfirm: true })
    }
  }
}
