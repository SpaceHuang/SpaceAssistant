import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/domainTypes'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { WeChatConfig, WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { mergeWeChatConfig } from '../../src/shared/wechatTypes'
import type { WeChatAuditLogger } from './weChatAuditLogger'
import type { WeChatBotService } from './weChatBotService'
import type { WeChatImChannel } from './weChatImChannel'
import { shouldAcceptWeChatInbound, parseSdkInboundMessage } from './weChatInboundParser'
import type { WeChatProcessedStore } from './weChatProcessedStore'
import { replyWeChatSummary } from './weChatReplyService'
import { sendWeChatRemoteOutbound } from './weChatRemoteOutbound'
import { runWeChatRemoteAgent } from './weChatRemoteAgent'
import { resolveWeChatSession } from './weChatSessionResolver'
import { tryClaimOrRelease, createProcessedClaimFinalizer } from '../remote/imCommandRouterHelpers'
import { bindRemoteSessionExecutionId, tryClaimRemoteSession, releaseRemoteSession, getRemoteAgentLease } from '../remote/remoteAgentRegistry'
import { evaluateImInboundGuard, revalidateImInboundGuard, type ImAuthSnapshot } from '../remote/imInboundGuard'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import { inboundSummaryForLog, previewText, WECHAT_CLI_LINE_PREVIEW_MAX } from './weChatCliLogFields'
import { logWeChatCliEvent } from './weChatCliLogger'
import { auditEntryToLoggerPayload } from '../remote/remoteSessionSwitchAudit'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'
import { resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'
import { createRateLimiter } from '../remote/imRateLimit'
import { WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE } from '../remote/remoteConfirmPolicy'
import type { TurnRuntime } from '../turnRuntime'
import type { SessionStorage } from '../sessionStorage/contracts'
import { ackImInboxMessage, appendImInboxMessageWithWakeEvent, claimImInboxMessage, getImInboxMessageContext, listImInboxMessages } from '../database/imInbox'
import { getTurnByRequestId } from '../database'
import { buildImQueueScope } from '../../src/shared/queueScope'
import type { WakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { isDeferredApprovalReplyCandidate } from '../remote/deferredApprovalIngress'
import { executeRemoteTurn } from '../remote/turnExecutionAdapter'
import { resolveFrozenImTurnExecutionConfig, resolveTrustedTurnExecutionConfig } from '../turnExecutionConfig'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'
import { createAcceptedTurnFromPrepared } from '../runtime/acceptedTurnContext'
import type { WakeEventLoopInput } from '../remote/wakeEventDispatcher'
import { readDeferredCompletionWake, markDeferredCompletionWakeDelivered } from '../remote/deferredCompletionWake'
import type { ImTaskSafetyPort } from '../remote/imTaskControlCoordinator'


const rateLimiter = createRateLimiter()

export type WeChatCommandRouterDeps = {
  db: AppDatabase
  sessionStorage?: SessionStorage
  botService: WeChatBotService
  processedStore: WeChatProcessedStore
  imChannel: WeChatImChannel
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
  turnRuntime?: TurnRuntime
  wakeEventDispatcher?: WakeEventDispatcher
  setWakeEventDispatcher?: (dispatcher: WakeEventDispatcher) => void
  isRemoteAsyncApprovalEnabled?: () => boolean
  retryDeferredApprovalNotifications?: (scope: { identityKey: string; ownerId: string }) => Promise<unknown>
  handleDeferredApprovalReply?: (input: { message: WeChatInboundMessage; text: string; replyToMessageId?: string }) => Promise<void>
  createDeferredConfirmationAdapter?: (remoteContext: import('../tools/types').RemoteContext) => NonNullable<Parameters<typeof runWeChatRemoteAgent>[0]['confirmationAdapter']>
  taskControlSafetyPort?: ImTaskSafetyPort
}


export class WeChatCommandRouter {
  private lastInboundAt?: number
  private inboundRawMap = new Map<string, IncomingMessage>()
  private sessionInboundMap = new Map<string, IncomingMessage>()

  constructor(private deps: WeChatCommandRouterDeps) {}

  setWakeEventDispatcher(dispatcher: WakeEventDispatcher): void {
    this.deps.wakeEventDispatcher = dispatcher
  }

  async dispatchWakeEventSet(input: WakeEventLoopInput): Promise<void> {
    if (!this.deps.sessionStorage) throw new Error('REMOTE_SESSION_STORAGE_REQUIRED')
    const session = this.deps.sessionStorage.queries.readSession(input.sessionId)
    const metadata = session?.metadata as { source?: unknown; wechatMeta?: { userId?: unknown; lastContextToken?: unknown } } | undefined
    if (!session || metadata?.source !== 'wechat' || typeof metadata.wechatMeta?.userId !== 'string') throw new Error('WECHAT_WAKE_SESSION_IDENTITY_INVALID')
    const config = mergeWeChatConfig(this.deps.getWeChatConfig())
    const guard = evaluateImInboundGuard({ channel: 'wechat', senderId: metadata.wechatMeta.userId,
      getConfig: () => config, isLoggedIn: () => Boolean(config.loggedIn) })
    if (!guard.ok) throw new Error(`WECHAT_WAKE_AUTH_REJECTED:${guard.reason}`)
    const assertAuthorized = () => {
      const current = mergeWeChatConfig(this.deps.getWeChatConfig())
      const revalidated = revalidateImInboundGuard(guard.snapshot, {
        getConfig: () => current, isLoggedIn: () => Boolean(current.loggedIn)
      })
      if (!revalidated.ok) throw new Error(`WECHAT_WAKE_AUTH_REVOKED:${revalidated.reason}`)
    }
    const scope = buildImQueueScope('wechat', input.sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    for (const event of input.events) {
      assertAuthorized()
      if (event.type === 'safety-recovery' && event.payloadRef.kind === 'safety-approval') {
        if (event.sessionId !== input.sessionId) throw new Error('WECHAT_COMPLETION_WAKE_SESSION_MISMATCH')
        const completion = readDeferredCompletionWake(this.deps.db, event.payloadRef.approvalId)
        if (!completion || completion.todo.channel !== 'wechat' || completion.todo.origin_session_id !== input.sessionId ||
          completion.todo.identity_key !== metadata.wechatMeta.userId || completion.todo.owner_id !== metadata.wechatMeta.userId) {
          throw new Error('WECHAT_COMPLETION_WAKE_BINDING_INVALID')
        }
        const context = completion.envelope.executionContext
        const userMessageId = context.currentUserMessageId
        const messageId = context.messageId
        if (typeof userMessageId !== 'string' || typeof messageId !== 'string') throw new Error('WECHAT_COMPLETION_WAKE_CONTEXT_INVALID')
        const originalMessage = this.deps.sessionStorage.queries.readMessage({ sessionId: input.sessionId, messageId: userMessageId })
        const originalContent = originalMessage?.content ?? listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 })
          .find(({ messageId: queuedId }) => queuedId === userMessageId)?.content
        if (typeof originalContent !== 'string') throw new Error('WECHAT_COMPLETION_WAKE_SOURCE_MESSAGE_MISSING')
        const sourceAcceptedTurn = readAcceptedTurn(this.deps.db, input.sessionId, completion.envelope.requestId)
        if (!sourceAcceptedTurn || sourceAcceptedTurn.turnId !== completion.envelope.turnId || sourceAcceptedTurn.lane !== 'wechat') {
          throw new Error('WECHAT_COMPLETION_WAKE_FROZEN_CONFIG_MISSING')
        }
        const requestId = `completion:${event.eventId}`
        const prior = getTurnByRequestId(this.deps.db, input.sessionId, requestId)
        if (prior && (prior.state !== 'terminal' || !['completed', 'parked'].includes(prior.outcome ?? ''))) throw new Error('WECHAT_COMPLETION_WAKE_PRIOR_TURN_INCOMPLETE')
        if (!prior) {
          const currentLease = getRemoteAgentLease(input.sessionId)
          const alreadyHeld = currentLease?.requestId === input.runId
          const lease = alreadyHeld ? 'ok' : tryClaimRemoteSession(input.sessionId, requestId, this.deps.getAppConfig().maxParallelChatSessions)
          if (lease !== 'ok') throw new Error(`WECHAT_COMPLETION_WAKE_SESSION_LEASE_FAILED:${lease}`)
          const leaseRequestId = alreadyHeld ? input.runId : requestId
          if (!alreadyHeld) bindRemoteSessionExecutionId(input.sessionId, requestId, requestId)
          try {
            const resolved = resolveWorkDirForSession(this.deps.sessionStorage.queries, input.sessionId,
              () => this.deps.workDirManager.listProfiles(), () => this.deps.workDirManager.getActiveProfileId(), () => this.deps.workDirManager.getActiveWorkDir())
            const contextToken = typeof context.contextToken === 'string' ? context.contextToken
              : typeof metadata.wechatMeta.lastContextToken === 'string' ? metadata.wechatMeta.lastContextToken : ''
            const inboundRaw = { userId: metadata.wechatMeta.userId, text: originalContent, type: 'text', timestamp: String(Date.now()),
              contextToken, raw: { client_id: messageId } } as unknown as IncomingMessage
            await this.executePersistedInboundTurn({ sessionId: input.sessionId, requestId, userMessageId, content: originalContent,
              messageId, userId: metadata.wechatMeta.userId, contextToken, config, authSnapshot: guard.snapshot,
              workDir: resolved?.workDir ?? this.deps.getWorkDir(), workDirProfileId: resolved?.profileId ?? this.deps.workDirManager.getActiveProfileId(),
              inboundRaw, leaseRequestId, assertAuthorized, frozenExecutionConfig: sourceAcceptedTurn.config,
              deferredContinuation: { todoId: completion.todo.todo_id, invocationId: completion.todo.invocation_id,
                workflowId: completion.todo.workflow_id, taskId: completion.todo.task_id, stepId: completion.todo.step_id,
                planRevision: completion.todo.plan_revision,
                ...(completion.todo.checkpoint_id ? { checkpointId: completion.todo.checkpoint_id } : {}),
                dispatchKey: completion.execution.dispatchKey, toolCallId: completion.envelope.toolCallId, toolName: completion.envelope.toolName,
                canonicalArgs: completion.envelope.canonicalArgs, result: completion.execution.result ?? {},
                outputRef: typeof completion.execution.result?.outputRef === 'string' ? completion.execution.result.outputRef : '' } })
          } finally {
            if (!alreadyHeld) releaseRemoteSession(input.sessionId, requestId)
          }
        }
        if (!markDeferredCompletionWakeDelivered(this.deps.db, event.payloadRef.approvalId)) throw new Error('WECHAT_COMPLETION_RESULT_ACK_FAILED')
        continue
      }
      if (event.type !== 'im-inbound' || event.payloadRef.kind !== 'im-inbox-message') throw new Error('WECHAT_WAKE_EVENT_UNSUPPORTED')
      if (event.sessionId !== input.sessionId) throw new Error('WECHAT_WAKE_SESSION_MISMATCH')
      const messageId = event.payloadRef.messageId
      const queued = listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 }).find((item) => item.messageId === messageId)
      if (!queued) throw new Error('WECHAT_WAKE_INBOX_MESSAGE_MISSING')
      const channelContext = getImInboxMessageContext(this.deps.db, messageId)
      if (!channelContext || channelContext.channel !== 'wechat' || !channelContext.contextToken) throw new Error('WECHAT_WAKE_PLATFORM_CONTEXT_MISSING')
      if (!claimImInboxMessage(this.deps.db, { queueScope: scope, messageId, ownerId: input.ownerId })) throw new Error('WECHAT_WAKE_INBOX_CLAIM_FAILED')
      const requestId = `wake:${event.eventId}`
      const refreshed = this.deps.sessionStorage.commands.recordRemoteSessionIdentity(session.id, {
        channel: 'wechat', userId: metadata.wechatMeta.userId, messageId: channelContext.platformMessageId,
        contextToken: channelContext.contextToken
      })
      if (!refreshed) throw new Error('WECHAT_WAKE_SESSION_IDENTITY_REFRESH_FAILED')
      const priorTurn = getTurnByRequestId(this.deps.db, session.id, requestId)
      if (priorTurn) {
        if (priorTurn.state !== 'terminal' || !['completed', 'parked'].includes(priorTurn.outcome ?? '')) throw new Error('WECHAT_WAKE_PRIOR_TURN_INCOMPLETE')
        if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId, ownerId: input.ownerId })) throw new Error('WECHAT_WAKE_INBOX_ACK_FAILED')
        continue
      }
      const alreadyHeldByDispatcher = getRemoteAgentLease(session.id)?.requestId === input.runId
      const remoteLease = alreadyHeldByDispatcher ? 'ok' : tryClaimRemoteSession(session.id, requestId, this.deps.getAppConfig().maxParallelChatSessions)
      if (remoteLease !== 'ok') throw new Error(`WECHAT_WAKE_SESSION_LEASE_FAILED:${remoteLease}`)
      if (!alreadyHeldByDispatcher) bindRemoteSessionExecutionId(session.id, requestId, requestId)
      const executionLeaseRequestId = alreadyHeldByDispatcher ? input.runId : requestId
      try {
        const resolved = resolveWorkDirForSession(this.deps.sessionStorage.queries, session.id,
          () => this.deps.workDirManager.listProfiles(), () => this.deps.workDirManager.getActiveProfileId(), () => this.deps.workDirManager.getActiveWorkDir())
        const inboundRaw = { userId: metadata.wechatMeta.userId, text: queued.content, type: 'text', timestamp: String(queued.timestamp),
          contextToken: channelContext.contextToken, raw: { client_id: channelContext.platformMessageId } } as unknown as IncomingMessage
        await this.executePersistedInboundTurn({ sessionId: session.id, requestId, userMessageId: messageId, content: queued.content,
          messageId: channelContext.platformMessageId, userId: metadata.wechatMeta.userId, contextToken: channelContext.contextToken,
          config, authSnapshot: guard.snapshot, workDir: resolved?.workDir ?? this.deps.getWorkDir(),
          workDirProfileId: resolved?.profileId ?? this.deps.workDirManager.getActiveProfileId(), inboundRaw, leaseRequestId: executionLeaseRequestId, assertAuthorized })
        if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId, ownerId: input.ownerId })) throw new Error('WECHAT_WAKE_INBOX_ACK_FAILED')
      } finally {
        if (!alreadyHeldByDispatcher) releaseRemoteSession(session.id, requestId)
      }
    }
  }

  private async executePersistedInboundTurn(input: {
    sessionId: string; requestId: string; userMessageId: string; content: string; messageId: string; userId: string;
    contextToken: string; config: WeChatConfig; authSnapshot: ImAuthSnapshot; workDir: string; workDirProfileId: string; inboundRaw: IncomingMessage; leaseRequestId: string; assertAuthorized: () => void
    frozenExecutionConfig?: import('../../src/shared/acceptedTurn').AcceptedTurn['config']
    deferredContinuation?: import('../tools/types').RemoteContext['deferredContinuation']
  }): Promise<void> {
    if (input.deferredContinuation && !input.frozenExecutionConfig) throw new Error('WECHAT_COMPLETION_WAKE_FROZEN_CONFIG_MISSING')
    const executionConfig = input.frozenExecutionConfig
      ? await resolveFrozenImTurnExecutionConfig(this.deps.db, 'wechat', input.frozenExecutionConfig)
      : await resolveTrustedTurnExecutionConfig(this.deps.db, this.deps.sessionStorage!.queries, this.deps.sessionStorage!.commands, input.sessionId, 'wechat')
    input.assertAuthorized()
    const queueScope = buildImQueueScope('wechat', input.sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const prepared = this.deps.turnRuntime?.prepare({ mode: 'reuse-user', requestId: input.requestId, sessionId: input.sessionId,
      userMessageId: input.userMessageId, excludeMessageIds: [], config: executionConfig, queueScope })
    if (!prepared) throw new Error('REMOTE_TURN_PREPARE_REQUIRED')
    if (!bindRemoteSessionExecutionId(input.sessionId, input.leaseRequestId, prepared.turnId)) throw new Error('REMOTE_SESSION_LEASE_LOST')
    const remoteContext = { source: 'wechat' as const, messageId: input.messageId, userId: input.userId, authOwner: input.authSnapshot.owner,
      contextToken: input.contextToken, confirmPolicy: input.config.remoteConfirmPolicy, wechatConfig: input.config,
      imChannel: this.deps.imChannel, confirmTimeoutMessage: WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
      originSessionId: input.sessionId, outboundSessionId: input.sessionId, workDirProfileId: input.workDirProfileId,
      ...(input.deferredContinuation ? { deferredContinuation: input.deferredContinuation } : {}),
      inboundRaw: input.inboundRaw, authorizationGeneration: input.authSnapshot.authorizationGeneration, requestId: input.requestId,
      turnId: prepared.turnId,
      appendWorkDirSwitchAudit: (profileId: string, profileName: string) => this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
      appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) => this.deps.auditLogger.append(auditEntryToLoggerPayload(entry)) }
    const acceptedTurn = createAcceptedTurnFromPrepared(prepared, 'wechat', executionConfig ?? { lane: 'wechat' }, this.deps.sessionStorage!.execution)
    const result = await executeRemoteTurn({ runtime: this.deps.turnRuntime, prepared, requestId: input.requestId,
      run: () => { input.assertAuthorized(); return runWeChatRemoteAgent({ db: this.deps.db, sessionStorage: this.deps.sessionStorage!, sessionId: input.sessionId,
        userMessage: input.content, replyMessageId: input.messageId, requestId: input.requestId, turnId: prepared.turnId, acceptedTurn,
        wechatConfig: input.config, workDir: input.workDir, workDirManager: this.deps.workDirManager,
        botService: this.deps.botService,
        imChannel: this.deps.imChannel, getToolsConfig: this.deps.getToolsConfig, getBrowserConfig: this.deps.getBrowserConfig,
        getWikiConfig: this.deps.getWikiConfig, getShellConfig: this.deps.getShellConfig, userDataDir: this.deps.getUserDataPath(),
        remoteContext, confirmationAdapter: this.deps.createDeferredConfirmationAdapter?.(remoteContext),
        taskControlSafetyPort: this.deps.taskControlSafetyPort,
        inboundRaw: input.inboundRaw, userId: input.userId,
        emitFactEvent: (event) => { if (!['source-completed', 'source-failed', 'source-cancelled', 'source-timeout'].includes(event.type)) this.deps.turnRuntime!.consumeForRequest(input.requestId, event, prepared.turnId) }
      }) }
    })
    if (!result.ok) throw new Error(`WECHAT_WAKE_TURN_FAILED:${result.summary}`)
    const outcome = getTurnByRequestId(this.deps.db, input.sessionId, input.requestId)?.outcome
    if (result.parked && outcome === 'parked') return
    if (outcome !== 'completed') throw new Error('WECHAT_WAKE_TURN_NOT_DURABLY_COMPLETED')
    const bot = this.deps.botService.getBot()
    if (bot) await replyWeChatSummary(bot, input.inboundRaw, result.summary, { sessionId: input.sessionId,
      touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: input.sessionId } })
  }

  private persistInboundWake(sessionId: string, message: WeChatInboundMessage, content: string): boolean {
    try {
      const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
      appendImInboxMessageWithWakeEvent(this.deps.db, {
        sessionId, channel: 'wechat', queueScope, channelMessageId: message.messageId, content
        ,contextToken: message.contextToken
      })
      return true
    } catch (error) {
      logWeChatCliEvent('error', 'wechat.inbound.persistence_failed', {
        sessionId,
        messageId: message.messageId,
        message: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

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
    // 入站处理链含多处 `await bot.reply(...)` 与 auditLogger.append（session 过期/凭据缺失、磁盘故障时
    // reject）。本链路被 fire-and-forget 分发调用，任何 rejection 都会沿链逃逸并崩溃主进程（评审 1.1）——
    // 顶层兜底记日志并吞掉；分发层的 .catch 仅作为防御纵深保留。
    try {
      await this.handleInboundUnchecked(msg, inboundRaw)
    } catch (error) {
      logWeChatCliEvent('error', 'wechat.inbound.handler_failed', {
        messageId: msg.messageId,
        errorPreview: previewText(error instanceof Error ? error.message : String(error), WECHAT_CLI_LINE_PREVIEW_MAX)
      })
    }
  }

  private async handleInboundUnchecked(msg: WeChatInboundMessage, inboundRaw?: IncomingMessage): Promise<void> {
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
      this.deps.imChannel.tryResolveFromInboundMessage(msg, {
        allowedUserIds: config.remoteSenderAllowlist
      })
    ) {
      logWeChatCliEvent('info', 'wechat.inbound.confirm_resolved', { userId: msg.userId })
      return
    }

    const accept = shouldAcceptWeChatInbound(msg, config)

    // Remote WeChat is text-only — never download media.
    if (!accept.accept && accept.reason === 'unsupported_type' && (msg.type === 'image' || msg.type === 'file')) {
      if (bot) await bot.reply(raw, '远程仅支持文本指令')
      logWeChatCliEvent('info', 'wechat.inbound.reject', { reason: 'media_text_only', type: msg.type })
      return
    }

    const getGuardConfig = () => {
      const c = mergeWeChatConfig(this.deps.getWeChatConfig())
      return {
        enabled: c.enabled,
        remoteEnabled: c.remoteEnabled,
        loggedIn: c.loggedIn,
        remoteSenderAllowlist: c.remoteSenderAllowlist
      }
    }
    const guard = evaluateImInboundGuard({
      channel: 'wechat',
      senderId: msg.userId,
      getConfig: getGuardConfig,
      isLoggedIn: () => Boolean(mergeWeChatConfig(this.deps.getWeChatConfig()).loggedIn)
    })
    if (!guard.ok) {
      logWeChatCliEvent('warn', 'wechat.inbound.guard_reject', { reason: guard.reason, userId: msg.userId })
      if (guard.reason === 'not_owner' && bot) {
        await bot.reply(raw, '您不是已绑定的远程使用者，无法发送指令。')
      }
      return
    }

    await this.deps.auditLogger.append({
      type: 'inbound',
      messageId: msg.messageId,
      chatId: msg.userId,
      senderId: msg.userId,
      accepted: accept.accept,
      reason: accept.reason
    })

    if (!accept.accept) {
      logWeChatCliEvent('info', 'wechat.inbound.reject', {
        reason: accept.reason ?? 'not_accepted',
        messageId: msg.messageId
      })
      return
    }

    logWeChatCliEvent('info', 'wechat.inbound.accept', {
      ...inboundSummaryForLog(msg),
      acceptReason: accept.reason
    })

    if (!rateLimiter.check(msg.userId, config.remoteRateLimitPerMinute)) {
      logWeChatCliEvent('warn', 'wechat.inbound.rate_limit', { userId: msg.userId })
      await this.deps.auditLogger.append({ type: 'rate_limit', senderId: msg.userId })
      if (bot) await bot.reply(raw, '当前指令过于频繁，请稍后再试')
      return
    }

    const isLoggedIn = () => Boolean(mergeWeChatConfig(this.deps.getWeChatConfig()).loggedIn)

    const re1 = revalidateImInboundGuard(guard.snapshot, { getConfig: getGuardConfig, isLoggedIn })
    if (!re1.ok) {
      logWeChatCliEvent('warn', 'wechat.inbound.guard_revalidate_fail', { reason: re1.reason })
      return
    }

    try {
      await this.deps.retryDeferredApprovalNotifications?.({ identityKey: msg.userId, ownerId: guard.snapshot.owner })
    } catch (error) {
      logWeChatCliEvent('warn', 'wechat.deferred_approval_notification_retry_failed', {
        messageId: msg.messageId, errorPreview: previewText(error instanceof Error ? error.message : String(error), WECHAT_CLI_LINE_PREVIEW_MAX)
      })
    }

    const acceptedText = accept.userMessage ?? msg.text
    if (isDeferredApprovalReplyCandidate(acceptedText) && this.deps.isRemoteAsyncApprovalEnabled?.() === true) {
      try {
        await this.deps.handleDeferredApprovalReply?.({ message: msg, text: acceptedText, replyToMessageId: msg.quotedMessageId })
      } catch (error) {
        logWeChatCliEvent('error', 'wechat.deferred_approval_ingress_failed', {
          messageId: msg.messageId, errorPreview: previewText(error instanceof Error ? error.message : String(error), WECHAT_CLI_LINE_PREVIEW_MAX)
        })
      }
      return
    }

    const claimResult = await this.deps.processedStore.tryClaim(msg.messageId)
    if (!claimResult.ok) {
      logWeChatCliEvent('info', 'wechat.inbound.duplicate', { messageId: msg.messageId })
      return
    }

    const re2 = revalidateImInboundGuard(guard.snapshot, { getConfig: getGuardConfig, isLoggedIn })
    if (!re2.ok) {
      await this.deps.processedStore.markCompleted(msg.messageId, claimResult.claimId, 'guard_revoked')
      return
    }

    const userContentFinal = accept.userMessage ?? msg.text.trim()
    await this.processCommand(
      msg,
      config,
      userContentFinal,
      raw,
      accept.reason === 'truncated',
      claimResult.claimId,
      guard.snapshot
    )
  }

  private async processCommand(
    msg: WeChatInboundMessage,
    config: WeChatConfig,
    content: string,
    inboundRaw: IncomingMessage,
    wasTruncated: boolean,
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
      const c = mergeWeChatConfig(this.deps.getWeChatConfig())
      return {
        enabled: c.enabled,
        remoteEnabled: c.remoteEnabled,
        loggedIn: c.loggedIn,
        remoteSenderAllowlist: c.remoteSenderAllowlist
      }
    }
    const isLoggedIn = () => Boolean(mergeWeChatConfig(this.deps.getWeChatConfig()).loggedIn)

    const failAuth = async (reason: string) => {
      logWeChatCliEvent('warn', 'wechat.inbound.guard_revalidate_fail', { reason })
      await claimFinalizer.complete('authorization_revoked')
    }

    try {
      if (!authSnapshot) {
        await failAuth('missing_auth_snapshot')
        return
      }
      {
        const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig, isLoggedIn })
        if (!re.ok) {
          await failAuth(re.reason)
          return
        }
      }

      const appCfg = this.deps.getAppConfig()
      const bot = this.deps.botService.getBot()

      const { sessionId, isNew } = await resolveWeChatSession(
        this.deps.sessionStorage!,
        msg,
        config,
        this.deps.getModel(),
        undefined,
        () => this.deps.workDirManager.getActiveProfileId()
      )
      {
        const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig, isLoggedIn })
        if (!re.ok) {
          await failAuth(re.reason)
          return
        }
      }
      const requestId = randomUUID()

      const claim = tryClaimOrRelease(sessionId, requestId, appCfg.maxParallelChatSessions)
      if (!claim.ok) {
        if (claim.reason === 'session_busy' && this.deps.wakeEventDispatcher) {
          if (!this.persistInboundWake(sessionId, msg, wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content)) {
            await claimFinalizer.complete('persistence_failed')
            return
          }
          if (processedClaimId) {
            const executing = await this.deps.processedStore.markExecuting(msg.messageId, processedClaimId)
            if (!executing) {
              await claimFinalizer.complete('processed_claim_lost')
              return
            }
          }
          await claimFinalizer.complete('durably_accepted')
          if (config.remoteAckOnReceive && (isNew || config.remoteNotifyOnReceive) && bot) {
            await sendWeChatRemoteOutbound({
              bot, inbound: inboundRaw, body: '已收到，正在处理…', sessionId,
              touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
            })
          }
          void this.deps.wakeEventDispatcher.dispatchSession(sessionId).catch((error) => {
            logWeChatCliEvent('error', 'wechat.inbound.dispatch_failed', {
              sessionId, message: error instanceof Error ? error.message : String(error)
            })
          })
          return
        }
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
            touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
          })
        }
        await claimFinalizer.complete(claim.reason)
        return
      }

      try {
        const resolvedWorkDir = resolveWorkDirForSession(
          this.deps.sessionStorage!.queries,
          sessionId,
          () => this.deps.workDirManager.listProfiles(),
          () => this.deps.workDirManager.getActiveProfileId(),
          () => this.deps.workDirManager.getActiveWorkDir()
        )
        const workDir = resolvedWorkDir?.workDir ?? this.deps.getWorkDir()
        const workDirProfileId =
          resolvedWorkDir?.profileId ?? this.deps.workDirManager.getActiveProfileId()
        logWeChatCliEvent('info', 'wechat.session.resolved', { sessionId, isNew, userId: msg.userId })
        this.sessionInboundMap.set(sessionId, inboundRaw)

        {
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig, isLoggedIn })
          if (!re.ok) {
            await failAuth(re.reason)
            return
          }
        }

        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, sessionId)

        if (this.deps.wakeEventDispatcher) {
          if (!this.persistInboundWake(sessionId, msg, wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content)) {
            await claimFinalizer.complete('persistence_failed')
            return
          }
          const wc = this.deps.getMainWebContents()
          wc?.send('wechat:inbound-message', { sessionId, message: msg })
          if (processedClaimId) {
            const executing = await this.deps.processedStore.markExecuting(msg.messageId, processedClaimId)
            if (!executing) {
              await claimFinalizer.complete('processed_claim_lost')
              return
            }
          }
          await claimFinalizer.complete('durably_accepted')
          if (config.remoteAckOnReceive && (isNew || config.remoteNotifyOnReceive) && bot) {
            await sendWeChatRemoteOutbound({
              bot,
              inbound: inboundRaw,
              body: '已收到，正在处理…',
              sessionId,
              touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
            })
          }
          try {
            claim?.release()
            void this.deps.wakeEventDispatcher.dispatchSession(sessionId).catch((error) => {
              logWeChatCliEvent('error', 'wechat.inbound.dispatch_failed', {
                sessionId,
                message: error instanceof Error ? error.message : String(error)
              })
            })
          } catch (error) {
            logWeChatCliEvent('error', 'wechat.inbound.dispatch_failed', {
              sessionId,
              message: error instanceof Error ? error.message : String(error)
            })
          }
          return
        }

        if (config.remoteAckOnReceive && (isNew || config.remoteNotifyOnReceive) && bot) {
          await sendWeChatRemoteOutbound({
            bot,
            inbound: inboundRaw,
            body: '已收到，正在处理…',
            sessionId,
            touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
          })
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig, isLoggedIn })
          if (!re.ok) {
            await failAuth(re.reason)
            return
          }
        }

        const wc = this.deps.getMainWebContents()
        wc?.send('wechat:inbound-message', { sessionId, message: msg })

        {
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig, isLoggedIn })
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
            logWeChatCliEvent('warn', 'wechat.inbound.claim_transition_failed', {
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
          const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig, isLoggedIn })
          if (!re.ok) {
            await failAuth(re.reason)
            return
          }
        }

        const executionConfig = await resolveTrustedTurnExecutionConfig(this.deps.db, this.deps.sessionStorage!.queries, this.deps.sessionStorage!.commands, sessionId, 'wechat')
        const prepared = this.deps.turnRuntime?.prepare({
          mode: 'create-user',
          requestId,
          sessionId,
          input: { text: wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content },
          config: executionConfig
        })
        if (!prepared) throw new Error('REMOTE_TURN_PREPARE_REQUIRED')
        if (!bindRemoteSessionExecutionId(sessionId, requestId, prepared.turnId)) {
          throw new Error('REMOTE_SESSION_LEASE_LOST')
        }
        const assistantMessageId = prepared.assistantMessage.id

        const remoteContext = {
          source: 'wechat' as const,
          messageId: msg.messageId,
          userId: msg.userId,
          authOwner: authSnapshot.owner,
          contextToken: msg.contextToken,
          confirmPolicy: config.remoteConfirmPolicy,
          wechatConfig: config,
          imChannel: this.deps.imChannel,
          confirmTimeoutMessage: WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
          originSessionId: sessionId,
          outboundSessionId: sessionId,
          workDirProfileId,
          inboundRaw,
          authorizationGeneration: authSnapshot.authorizationGeneration,
          requestId,
          turnId: prepared.turnId,
          appendWorkDirSwitchAudit: (profileId: string, profileName: string) =>
            this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
          appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) =>
            this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
        }

        let result: { summary: string; pendingConfirm: boolean; ok: boolean }
        const acceptedTurn = prepared
          ? createAcceptedTurnFromPrepared(prepared, 'wechat', executionConfig ?? { lane: 'wechat' }, this.deps.sessionStorage!.execution)
          : undefined
        try {
          result = await executeRemoteTurn({
            runtime: this.deps.turnRuntime,
            prepared,
            requestId,
            run: () => runWeChatRemoteAgent({
            db: this.deps.db,
            sessionStorage: this.deps.sessionStorage!,
            sessionId,
            userMessage: content,
            replyMessageId: msg.messageId,
            requestId,
            turnId: prepared?.turnId,
            acceptedTurn,
            wechatConfig: config,
            workDir,
            workDirManager: this.deps.workDirManager,
            botService: this.deps.botService,
            imChannel: this.deps.imChannel,
            getToolsConfig: this.deps.getToolsConfig,
            getBrowserConfig: this.deps.getBrowserConfig,
            getWikiConfig: this.deps.getWikiConfig,
            getShellConfig: this.deps.getShellConfig,
            userDataDir: this.deps.getUserDataPath(),
            remoteContext,
            confirmationAdapter: this.deps.createDeferredConfirmationAdapter?.(remoteContext),
            taskControlSafetyPort: this.deps.taskControlSafetyPort,
            inboundRaw,
            userId: msg.userId
            ,emitFactEvent: this.deps.turnRuntime && prepared ? (event) => {
              if (event.type === 'source-completed' || event.type === 'source-failed' || event.type === 'source-cancelled' || event.type === 'source-timeout') return
              this.deps.turnRuntime!.consumeForRequest(requestId, event, prepared!.turnId)
            } : undefined
            })
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

        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)

        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, outboundSessionId)

        if (bot && !result.pendingConfirm) {
          await replyWeChatSummary(bot, inboundRaw, result.summary, {
            sessionId: outboundSessionId,
            touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: outboundSessionId }
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
          sessionId,
          success: result.ok && !result.pendingConfirm,
          summaryLen: result.summary.length
        })
      } finally {
        claim.release()
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      logWeChatCliEvent('error', 'wechat.inbound.process_error', { error: err })
      await claimFinalizer.complete('process_error')
    } finally {
      if (!claimFinalizer.done) {
        await claimFinalizer.complete('aborted')
      }
    }
  }
}

/**
 * fire-and-forget 分发微信 SDK 入站消息（评审 1.1）：handleSdkInbound 的 parse 与处理链中任何
 * rejection 都不得逃逸——Node ≥15 默认 throw 模式下逃逸 rejection 会直接崩溃主进程。
 * 处理链失败由 handleInbound 顶层兜底记日志；此处 .catch 是防御纵深（兜 parse 阶段与兜底自身
 * 失效的场景），对齐飞书侧 feishu.event.inbound_dispatch_failed 写法。
 */
export function dispatchWeChatSdkInbound(router: WeChatCommandRouter | null | undefined, msg: IncomingMessage): void {
  void router?.handleSdkInbound(msg).catch((error) => {
    // messageId 是 parse 后的字段；dispatch 层拿到的是 SDK raw——用同款推导兜底（parse 失败时 client_id 可能缺席）。
    const messageIdHint = typeof msg.raw?.client_id === 'string' && msg.raw.client_id ? msg.raw.client_id : 'unparsed'
    logWeChatCliEvent('error', 'wechat.event.inbound_dispatch_failed', {
      messageId: messageIdHint,
      errorPreview: previewText(error instanceof Error ? error.message : String(error), WECHAT_CLI_LINE_PREVIEW_MAX)
    })
  })
}
