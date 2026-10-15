import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { AppDatabase } from '../database'
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
import { resolveClarificationControlMessage, type ClarificationResolverInput, type ClarificationResolverResult } from '../remote/clarificationInbound'
import { bindRemoteSessionExecutionId, tryClaimRemoteSession, releaseRemoteSession, getRemoteAgentLease } from '../remote/remoteAgentRegistry'
import { evaluateImInboundGuard, revalidateImInboundGuard, type ImAuthSnapshot } from '../remote/imInboundGuard'
import type { IncomingMessage } from '@wechatbot/wechatbot'
import { inboundSummaryForLog, previewText, quoteWireSummaryForLog, WECHAT_CLI_LINE_PREVIEW_MAX } from './weChatCliLogFields'
import { logWeChatCliEvent } from './weChatCliLogger'
import { auditEntryToLoggerPayload } from '../remote/remoteSessionSwitchAudit'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'
import { resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'
import { createRateLimiter } from '../remote/imRateLimit'
const WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE = '用户确认超时（5分钟），工具调用已取消'
import type { TurnRuntime } from '../turnRuntime'
import type { SessionStorage } from '../sessionStorage/contracts'
import { ackImInboxMessage, appendImInboxMessageWithWakeEvent, claimImInboxMessage, getImInboxMessageContext, listImInboxMessages, parkImInboxMessageForClarification, resumeClarificationInboxMessage } from '../database/imInbox'
import { getTurnByRequestId } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { expireDuePendingClarifications, finishClarificationSendAttempt, listPendingClarificationNotices,
  listRecoverableClarificationPrompts, startClarificationSendAttempt, hasPendingClarificationForScope } from '../database/clarificationStore'
import { createImLifecycleOutbox } from '../remote/imLifecycleOutbox'
import { createHostImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
import { formatRemoteOutboundMessage } from '../../src/shared/remoteOutboundFormat'
import { buildClarificationPrompt } from '../remote/clarificationPrompt'
import { canResumePreparedRemoteTurn, inspectRemoteTrackWorkRecovery, isRemoteTrackWorkSettled, settleRemoteTrackWorkFromTurn } from '../remote/remoteTrackWorkRecovery'
import { buildImQueueScope } from '../../src/shared/queueScope'
import type { WakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { isDeferredApprovalReplyCandidate } from '../remote/deferredApprovalIngress'
import { executeRemoteTurn } from '../remote/turnExecutionAdapter'
import { resolveFrozenImTurnExecutionConfig, resolveTrustedTurnExecutionConfig } from '../turnExecutionConfig'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'
import { createAcceptedTurnFromPrepared } from '../runtime/acceptedTurnContext'
import type { WakeEventLoopInput } from '../remote/wakeEventDispatcher'
import { readDeferredCompletionWake, markDeferredCompletionWakeDelivered } from '../remote/deferredCompletionWake'
import { decideDeferredCompletionWakeRecovery, deliverInterruptedDeferredCompletionNotice } from '../remote/deferredCompletionWakeRecovery'
import type { ImTaskSafetyPort } from '../remote/imTaskControlCoordinator'
import type { RemoteTrackContext } from '../../src/shared/remoteTrack'
import { observeRemoteMessageAttribution, readDurableRemoteTrackEpoch, readRemoteTrackContextForInbound } from '../remote/remoteTrackAttributionService'
import { recordTrackModelMessage, buildTrackModelInputViewRef } from '../remote/trackModelInputViewStore'
import { bindRemoteTrackToTurn, bindRemoteTrackWorkExecution, claimRemoteTrackWork, convergeRemoteTrackTerminal, remoteTrackTurnBindingEventId, settleRemoteTrackWork, type RemoteTrackWorkClaim } from '../database/remoteTrackStore'
import { readRemoteTrackFeatureGates } from '../remote/remoteTrackFeatureGates'
import { createModelIntentAttributor } from '../remote/modelIntentAttributor'
import { createRemoteTrackClassifierCostEstimator } from '../remote/remoteTrackClassifierPricing'
import { attributeAndPersistRemoteMessage } from '../remote/remoteTrackAttributionService'
import { listRemoteTrackAttributionCandidates } from '../remote/remoteTrackAttributionService'
import { generateClarificationHandle } from '../remote/clarificationHandle'
import { resolveClarificationSelection, getClarificationResumeIdentity } from '../database/clarificationStore'
import { recordRemoteTrackDiagnosticEvent } from '../database/remoteTrackDiagnosticStore'


const rateLimiter = createRateLimiter()

function createReplayIncomingMessage(input: {
  userId: string
  text: string
  timestamp: number
  messageId: string
  contextToken: string
}): IncomingMessage {
  return {
    userId: input.userId,
    text: input.text,
    type: 'text',
    timestamp: new Date(input.timestamp),
    images: [],
    voices: [],
    files: [],
    videos: [],
    raw: { client_id: input.messageId } as IncomingMessage['raw'],
    _contextToken: input.contextToken
  }
}

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
  handleClarificationReply?: (input: ClarificationResolverInput) => Promise<ClarificationResolverResult>
  createDeferredConfirmationAdapter?: (remoteContext: import('../tools/types').RemoteContext) => NonNullable<Parameters<typeof runWeChatRemoteAgent>[0]['confirmationAdapter']>
  resolveAgentSdkGateSupplement?: import('../runtime/invocationAssembler').AgentInvocationMaterials['resolveAgentSdkGateSupplement']
  taskControlSafetyPort?: ImTaskSafetyPort
}


export class WeChatCommandRouter {
  private lastInboundAt?: number
  private inboundRawMap = new Map<string, IncomingMessage>()
  private sessionInboundMap = new Map<string, IncomingMessage>()
  private recoveringClarificationLifecycle = false
  private activeClarificationSends = new Set<string>()

  constructor(private deps: WeChatCommandRouterDeps) {}

  setWakeEventDispatcher(dispatcher: WakeEventDispatcher): void {
    this.deps.wakeEventDispatcher = dispatcher
  }

  async recoverClarificationLifecycle(now = Date.now()): Promise<void> {
    if (this.recoveringClarificationLifecycle) return
    this.recoveringClarificationLifecycle = true
    try {
      expireDuePendingClarifications(this.deps.db, now, 'wechat')
      const outbox = createImLifecycleOutbox(this.deps.db)
      for (const notice of listPendingClarificationNotices(this.deps.db, 'wechat')) {
        await outbox.deliver(notice, async (text) => {
          const bot = this.deps.botService.getRawBot()
          if (!bot) throw new Error('WECHAT_CLARIFICATION_NOTICE_BOT_UNAVAILABLE')
          await bot.send(notice.ownerId, formatRemoteOutboundMessage(text, notice.sessionId))
        }, () => createHostImOutboundFacts({ channel: 'wechat', body: notice.text, sessionId: notice.sessionId,
          identityKey: notice.identityKey, ownerId: notice.ownerId, recipient: notice.ownerId, chatType: 'p2p' }))
      }
      for (const prompt of listRecoverableClarificationPrompts(this.deps.db, 'wechat', now)) {
        if (this.activeClarificationSends.has(prompt.clarificationId)) continue
        this.activeClarificationSends.add(prompt.clarificationId)
        const sendAttemptId = randomUUID()
        try {
          try {
            startClarificationSendAttempt(this.deps.db, { sendAttemptId, clarificationId: prompt.clarificationId, version: prompt.version, startedAt: now })
          } catch { continue }
          try {
            const bot = this.deps.botService.getRawBot()
            if (!bot) throw new Error('WECHAT_CLARIFICATION_PROMPT_BOT_UNAVAILABLE')
            await bot.send(prompt.ownerId, formatRemoteOutboundMessage(buildClarificationPrompt(prompt.handle, prompt.candidates), prompt.sessionId))
            finishClarificationSendAttempt(this.deps.db, { sendAttemptId, state: 'send-fulfilled', finishedAt: Date.now() })
          } catch {
            finishClarificationSendAttempt(this.deps.db, { sendAttemptId, state: 'send-outcome-unknown', finishedAt: Date.now() })
          }
        } finally {
          this.activeClarificationSends.delete(prompt.clarificationId)
        }
      }
    } finally {
      this.recoveringClarificationLifecycle = false
    }
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
        const recovery = decideDeferredCompletionWakeRecovery({
          read: () => getTurnByRequestId(this.deps.db, input.sessionId, requestId),
          recover: () => this.deps.turnRuntime?.recover()
        })
        if (recovery.kind === 'recovery-pending') throw new Error('WECHAT_COMPLETION_WAKE_RECOVERY_PENDING')
        if (recovery.kind === 'notify-interrupted') {
          const bot = this.deps.botService.getRawBot()
          if (!bot) throw new Error('WECHAT_COMPLETION_WAKE_NOTICE_BOT_UNAVAILABLE')
          const ownerId = metadata.wechatMeta!.userId as string
          await deliverInterruptedDeferredCompletionNotice(this.deps.db, { todoId: event.payloadRef.approvalId, sessionId: input.sessionId,
            channel: 'wechat', identityKey: ownerId, ownerId, recipient: ownerId,
            send: (text) => bot.send(ownerId, formatRemoteOutboundMessage(text, input.sessionId)) })
          continue
        }
        if (recovery.kind === 'start') {
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
            const inboundRaw = createReplayIncomingMessage({ userId: metadata.wechatMeta.userId, text: originalContent,
              timestamp: Date.now(), messageId, contextToken })
            await this.executePersistedInboundTurn({ sessionId: input.sessionId, requestId, userMessageId, content: originalContent,
              messageId, userId: metadata.wechatMeta.userId, contextToken, config, authSnapshot: guard.snapshot,
              workDir: resolved?.workDir ?? this.deps.getWorkDir(), workDirProfileId: resolved?.profileId ?? this.deps.workDirManager.getActiveProfileId(),
              inboundRaw, leaseRequestId, assertAuthorized, frozenExecutionConfig: sourceAcceptedTurn.config,
              ...(completion.trackContext ? { trackContext: completion.trackContext } : {}),
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
        if ((recovery.kind === 'start' || recovery.kind === 'acknowledge') &&
          !markDeferredCompletionWakeDelivered(this.deps.db, event.payloadRef.approvalId)) {
          throw new Error('WECHAT_COMPLETION_RESULT_ACK_FAILED')
        }
        continue
      }
      if (event.type !== 'im-inbound' || event.payloadRef.kind !== 'im-inbox-message') throw new Error('WECHAT_WAKE_EVENT_UNSUPPORTED')
      if (event.sessionId !== input.sessionId) throw new Error('WECHAT_WAKE_SESSION_MISMATCH')
      const messageId = event.payloadRef.messageId
      const requestId = `wake:${event.eventId}`
      let priorTurn = getTurnByRequestId(this.deps.db, session.id, requestId)
      let queued = listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 }).find((item) => item.messageId === messageId)
      const pendingMessageContext = getImInboxMessageContext(this.deps.db, messageId)
      const workRecovery = pendingMessageContext?.clarificationWorkId
        ? inspectRemoteTrackWorkRecovery(this.deps.db, pendingMessageContext.clarificationWorkId) : null
      const acceptedSnapshot = readAcceptedTurn(this.deps.db, session.id, requestId)
      const canResumePrepared = priorTurn !== undefined && (pendingMessageContext?.clarificationWorkId
        ? workRecovery?.decision.kind === 'resume-prepared-turn'
        : canResumePreparedRemoteTurn({ turnState: priorTurn.state, turnId: priorTurn.turnId, requestId: priorTurn.requestId,
          sessionId: priorTurn.sessionId, userMessageId: priorTurn.userMessageId, turnConfig: priorTurn.executionConfig, accepted: acceptedSnapshot }))
      if (priorTurn && priorTurn.state !== 'terminal' && !canResumePrepared) {
        // Prepared turns have not entered the runtime and can resume from their frozen
        // accepted snapshot. Other unfinished turns must first converge through startup recovery.
        this.deps.turnRuntime?.recover()
        priorTurn = getTurnByRequestId(this.deps.db, session.id, requestId)
      }
      if (priorTurn?.state === 'terminal') {
        const completedMessageId = priorTurn.userMessageId
        if (typeof completedMessageId !== 'string') throw new Error('WECHAT_WAKE_TERMINAL_TURN_MESSAGE_MISSING')
        const terminalContext = getImInboxMessageContext(this.deps.db, completedMessageId)
        if (terminalContext?.clarificationWorkId) {
          const work = getDbConnection(this.deps.db).prepare('SELECT state,attempt_count,lease_owner,lease_expires_at FROM remote_track_work_queue WHERE work_id=?')
            .get(terminalContext.clarificationWorkId) as { state: string; attempt_count: number; lease_owner: string | null; lease_expires_at: number | null } | undefined
          if (!work) throw new Error('WECHAT_CLARIFICATION_WORK_MISSING')
          if (work.state === 'queued' || work.state === 'claimed') {
            const work = claimRemoteTrackWork(this.deps.db, { workerId: `wake:${input.runId}`, now: Date.now(), leaseMs: 30_000,
              workId: terminalContext.clarificationWorkId })
            if (!work || work.sessionId !== input.sessionId || !settleRemoteTrackWorkFromTurn(this.deps.db, { claim: work,
              outcome: priorTurn.outcome, now: Date.now(),
              noticeText: '原始消息未重新执行，以避免重复操作；此前进度或外部调用结果无法确认。请先不要重发，可在此聊天说明要核对的内容。' })) {
              throw new Error('WECHAT_CLARIFICATION_WORK_RECOVERY_UNAVAILABLE')
            }
          }
        }
        if (terminalContext?.trackId) convergeRemoteTrackTerminal(this.deps.db, { trackId: terminalContext.trackId,
          target: priorTurn.outcome === 'completed' || priorTurn.outcome === 'parked' ? 'completed' : priorTurn.outcome === 'cancelled' ? 'cancelled' : 'failed',
          occurredAt: Date.now(), readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
        if (priorTurn.outcome === 'failed' && priorTurn.error?.message.includes('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')) {
          const channelContext = getImInboxMessageContext(this.deps.db, completedMessageId)
          const originalMessage = queued ?? listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 })
            .find((item) => item.messageId === completedMessageId)
          if (!channelContext?.contextToken || !originalMessage) throw new Error('WECHAT_WAKE_FAILURE_RECEIPT_CONTEXT_MISSING')
          const bot = this.deps.botService.getBot()
          if (!bot) throw new Error('WECHAT_WAKE_FAILURE_RECEIPT_BOT_UNAVAILABLE')
          const inboundRaw = createReplayIncomingMessage({ userId: metadata.wechatMeta.userId, text: originalMessage.content,
            timestamp: originalMessage.timestamp, messageId: channelContext.platformMessageId, contextToken: channelContext.contextToken })
          await replyWeChatSummary(bot, inboundRaw,
            '这条请求尚未执行，因为历史状态无法安全核对。请先不要重发，可在此聊天说明要核对的内容。',
            { sessionId: input.sessionId, ownerId: input.ownerId, touch: { sessionCommands: this.deps.sessionStorage.commands, sessionId: input.sessionId } })
        }
        if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId: completedMessageId, ownerId: input.ownerId })) {
          const claim = claimImInboxMessage(this.deps.db, { queueScope: scope, messageId: completedMessageId, ownerId: input.ownerId })
          if (claim && !ackImInboxMessage(this.deps.db, { queueScope: scope, messageId: completedMessageId, ownerId: input.ownerId })) {
            throw new Error('WECHAT_WAKE_TERMINAL_INBOX_ACK_FAILED')
          }
        }
        continue
      }
      if (!queued) throw new Error('WECHAT_WAKE_INBOX_MESSAGE_MISSING')
      const channelContext = getImInboxMessageContext(this.deps.db, messageId)
      if (!channelContext || channelContext.channel !== 'wechat' || !channelContext.contextToken) throw new Error('WECHAT_WAKE_PLATFORM_CONTEXT_MISSING')
      const clarificationWorkState = channelContext.clarificationWorkId
        ? (getDbConnection(this.deps.db).prepare('SELECT state FROM remote_track_work_queue WHERE work_id=?')
          .get(channelContext.clarificationWorkId) as { state: string } | undefined)?.state
        : undefined
      const clarificationWork = channelContext.clarificationWorkId && !isRemoteTrackWorkSettled(clarificationWorkState)
        ? claimRemoteTrackWork(this.deps.db, { workerId: `wake:${input.runId}`, now: Date.now(), leaseMs: 30_000, workId: channelContext.clarificationWorkId })
        : null
      if (channelContext.clarificationWorkId && !isRemoteTrackWorkSettled(clarificationWorkState) &&
        (!clarificationWork || clarificationWork.sessionId !== input.sessionId)) {
        throw new Error('WECHAT_CLARIFICATION_WORK_UNAVAILABLE')
      }
      if (!claimImInboxMessage(this.deps.db, { queueScope: scope, messageId, ownerId: input.ownerId })) throw new Error('WECHAT_WAKE_INBOX_CLAIM_FAILED')
      const refreshed = this.deps.sessionStorage.commands.recordRemoteSessionIdentity(session.id, {
        channel: 'wechat', userId: metadata.wechatMeta.userId, messageId: channelContext.platformMessageId,
        contextToken: channelContext.contextToken
      })
      if (!refreshed) throw new Error('WECHAT_WAKE_SESSION_IDENTITY_REFRESH_FAILED')
      if (priorTurn) {
        if (priorTurn.state !== 'prepared' || !canResumePrepared) throw new Error('WECHAT_WAKE_PRIOR_TURN_INCOMPLETE')
        // The exact request/turn identity and accepted config are reused below.
      }
      const alreadyHeldByDispatcher = getRemoteAgentLease(session.id)?.requestId === input.runId
      const remoteLease = alreadyHeldByDispatcher ? 'ok' : tryClaimRemoteSession(session.id, requestId, this.deps.getAppConfig().maxParallelChatSessions)
      if (remoteLease !== 'ok') throw new Error(`WECHAT_WAKE_SESSION_LEASE_FAILED:${remoteLease}`)
      if (!alreadyHeldByDispatcher) bindRemoteSessionExecutionId(session.id, requestId, requestId)
      const executionLeaseRequestId = alreadyHeldByDispatcher ? input.runId : requestId
      try {
        const resolved = resolveWorkDirForSession(this.deps.sessionStorage.queries, session.id,
          () => this.deps.workDirManager.listProfiles(), () => this.deps.workDirManager.getActiveProfileId(), () => this.deps.workDirManager.getActiveWorkDir())
        const inboundRaw = createReplayIncomingMessage({ userId: metadata.wechatMeta.userId, text: queued.content,
          timestamp: queued.timestamp, messageId: channelContext.platformMessageId, contextToken: channelContext.contextToken })
        const trackContext = channelContext.trackId ? readRemoteTrackContextForInbound(this.deps.db, messageId, {
          channel: 'wechat', identityKey: metadata.wechatMeta.userId, ownerId: guard.snapshot.owner,
          authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'wechat')
        }) : undefined
        if (channelContext.trackId && !trackContext) throw new Error('WECHAT_WAKE_TRACK_ATTRIBUTION_INVALID')
        await this.executePersistedInboundTurn({ sessionId: session.id, requestId, userMessageId: messageId, content: queued.content,
          messageId: channelContext.platformMessageId, userId: metadata.wechatMeta.userId, contextToken: channelContext.contextToken,
          config, authSnapshot: guard.snapshot, workDir: resolved?.workDir ?? this.deps.getWorkDir(),
          workDirProfileId: resolved?.profileId ?? this.deps.workDirManager.getActiveProfileId(), inboundRaw, leaseRequestId: executionLeaseRequestId, assertAuthorized,
          ...(clarificationWork ? { clarificationWork } : {}),
          ...(trackContext ? { trackContext } : {}) })
        if (clarificationWork && !settleRemoteTrackWork(this.deps.db, { workId: clarificationWork.workId, workerId: clarificationWork.workerId,
          attempt: clarificationWork.attempt, state: 'completed', now: Date.now() })) throw new Error('WECHAT_CLARIFICATION_WORK_SETTLE_FAILED')
        if (clarificationWork && channelContext.trackId) convergeRemoteTrackTerminal(this.deps.db, { trackId: channelContext.trackId,
          target: 'completed', occurredAt: Date.now(), readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
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
    clarificationWork?: RemoteTrackWorkClaim
    trackContext?: RemoteTrackContext
  }): Promise<void> {
    if (input.deferredContinuation && !input.frozenExecutionConfig) throw new Error('WECHAT_COMPLETION_WAKE_FROZEN_CONFIG_MISSING')
    const acceptedSnapshot = this.deps.sessionStorage?.execution.readAccepted({ sessionId: input.sessionId, requestId: input.requestId })
    const frozenConfig = input.frozenExecutionConfig ?? acceptedSnapshot?.config
    const executionConfig = frozenConfig
      ? await resolveFrozenImTurnExecutionConfig(this.deps.db, 'wechat', frozenConfig)
      : await resolveTrustedTurnExecutionConfig(this.deps.db, this.deps.sessionStorage!.queries, this.deps.sessionStorage!.commands, input.sessionId, 'wechat')
    input.assertAuthorized()
    const queueScope = buildImQueueScope('wechat', input.sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const prepared = this.deps.turnRuntime?.prepare({ mode: 'reuse-user', requestId: input.requestId, sessionId: input.sessionId,
      userMessageId: input.userMessageId, excludeMessageIds: [], config: executionConfig, queueScope })
    if (!prepared) throw new Error('REMOTE_TURN_PREPARE_REQUIRED')
    let trackModelInputView: import('../../src/shared/remoteTrack').TrackModelInputViewRef | undefined
    if (input.trackContext) {
      const track = input.trackContext
      bindRemoteTrackToTurn(this.deps.db, { trackId: track.trackId, turnId: prepared.turnId, sessionId: input.sessionId,
        channel: track.channel, identityKey: track.identityKey, ownerId: track.ownerId, authorizationEpoch: track.authorizationEpoch,
        eventId: remoteTrackTurnBindingEventId(track.trackId, prepared.turnId), occurredAt: Date.now() })
      recordTrackModelMessage(this.deps.db, { trackId: track.trackId, eventId: `track-model:${prepared.turnId}:${input.userMessageId}`,
        idempotencyKey: `track-model:${prepared.turnId}:${input.userMessageId}`, sessionId: input.sessionId, messageId: input.userMessageId,
        invocationId: prepared.turnId, occurredAt: Date.now(), parentEventId: track.attributionEventId })
      trackModelInputView = buildTrackModelInputViewRef(this.deps.db, { ...track, sessionId: input.sessionId,
        acceptedUserMessageId: input.userMessageId, currentInvocationId: prepared.turnId })
      if (trackModelInputView.completeness !== 'complete') throw new Error('WECHAT_TRACK_MODEL_INPUT_VIEW_UNAVAILABLE')
    }
    if (input.clarificationWork) bindRemoteTrackWorkExecution(this.deps.db, { workId: input.clarificationWork.workId,
      workerId: input.clarificationWork.workerId, attempt: input.clarificationWork.attempt, sessionId: input.sessionId,
      requestId: input.requestId, turnId: prepared.turnId, userMessageId: input.userMessageId,
      modelViewVersion: trackModelInputView?.viewVersion ?? 'track-model-view-unavailable', now: Date.now() })
    if (!bindRemoteSessionExecutionId(input.sessionId, input.leaseRequestId, prepared.turnId)) throw new Error('REMOTE_SESSION_LEASE_LOST')
    const remoteContext = { source: 'wechat' as const, messageId: input.messageId, userId: input.userId, authOwner: input.authSnapshot.owner,
      contextToken: input.contextToken, wechatConfig: input.config,
      imChannel: this.deps.imChannel, confirmTimeoutMessage: WECHAT_REMOTE_CONFIRM_TIMEOUT_MESSAGE,
      originSessionId: input.sessionId, outboundSessionId: input.sessionId, workDirProfileId: input.workDirProfileId,
      ...(input.deferredContinuation ? { deferredContinuation: input.deferredContinuation } : {}),
      inboundRaw: input.inboundRaw, authorizationGeneration: input.authSnapshot.authorizationGeneration, requestId: input.requestId,
      turnId: prepared.turnId,
      ...(input.trackContext ? { trackContext: input.trackContext, trackModelInputView } : {}),
      appendWorkDirSwitchAudit: (profileId: string, profileName: string) => this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
      appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) => this.deps.auditLogger.append(auditEntryToLoggerPayload(entry)) }
    let result: { ok: boolean; summary: string; pendingConfirm: boolean; parked?: true; outcome?: 'cancelled' | 'timed-out' }
    try {
      result = await executeRemoteTurn({ runtime: this.deps.turnRuntime, prepared, requestId: input.requestId,
      ...(input.trackContext ? { onTerminal: (outcome) => {
        const target = outcome === 'completed' || outcome === 'parked' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed'
        convergeRemoteTrackTerminal(this.deps.db, { trackId: input.trackContext!.trackId, target, occurredAt: Date.now(),
          readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
      } } : {}),
      run: () => {
        input.assertAuthorized()
        const acceptedTurn = createAcceptedTurnFromPrepared(prepared, 'wechat', executionConfig ?? { lane: 'wechat' }, this.deps.sessionStorage!.execution)
        return runWeChatRemoteAgent({ db: this.deps.db, sessionStorage: this.deps.sessionStorage!, sessionId: input.sessionId,
        userMessage: input.content, replyMessageId: input.messageId, requestId: input.requestId, turnId: prepared.turnId, acceptedTurn,
        wechatConfig: input.config, workDir: input.workDir, workDirManager: this.deps.workDirManager,
        botService: this.deps.botService,
        imChannel: this.deps.imChannel, getToolsConfig: this.deps.getToolsConfig, getBrowserConfig: this.deps.getBrowserConfig,
        getWikiConfig: this.deps.getWikiConfig, getShellConfig: this.deps.getShellConfig, userDataDir: this.deps.getUserDataPath(),
        remoteContext, confirmationAdapter: this.deps.createDeferredConfirmationAdapter?.(remoteContext),
        resolveAgentSdkGateSupplement: this.deps.resolveAgentSdkGateSupplement,
        taskControlSafetyPort: this.deps.taskControlSafetyPort,
        inboundRaw: input.inboundRaw, userId: input.userId,
        emitFactEvent: (event) => { if (!['source-completed', 'source-failed', 'source-cancelled', 'source-timeout'].includes(event.type)) this.deps.turnRuntime!.consumeForRequest(input.requestId, event, prepared.turnId) }
      })
      }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')) {
        const bot = this.deps.botService.getBot()
        if (bot) {
          try {
            await replyWeChatSummary(bot, input.inboundRaw,
            '这条请求尚未执行，因为历史状态无法安全核对。请先不要重发，可在此聊天说明要核对的内容。',
              { sessionId: input.sessionId, ownerId: input.authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: input.sessionId },
                ...(input.trackContext ? { trackDelivery: { db: this.deps.db, track: input.trackContext, requestId: input.requestId, turnId: prepared.turnId } } : {}) })
          } catch { /* Preserve the durable turn failure when the delivery reply itself fails. */ }
        }
      }
      throw error
    }
    if (!result.ok) throw new Error(`WECHAT_WAKE_TURN_FAILED:${result.summary}`)
    const outcome = getTurnByRequestId(this.deps.db, input.sessionId, input.requestId)?.outcome
    if (result.parked && outcome === 'parked') return
    if (outcome !== 'completed') throw new Error('WECHAT_WAKE_TURN_NOT_DURABLY_COMPLETED')
    const bot = this.deps.botService.getBot()
    if (bot) await replyWeChatSummary(bot, input.inboundRaw, result.summary, { sessionId: input.sessionId, ownerId: input.authSnapshot.owner,
      touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: input.sessionId },
      ...(input.trackContext ? { trackDelivery: { db: this.deps.db, track: input.trackContext, requestId: input.requestId, turnId: prepared.turnId } } : {}) })
  }

  private persistInboundWake(sessionId: string, message: WeChatInboundMessage, content: string, trackContext?: RemoteTrackContext): boolean {
    try {
      const queueScope = buildImQueueScope('wechat', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
      appendImInboxMessageWithWakeEvent(this.deps.db, {
        sessionId, channel: 'wechat', queueScope, channelMessageId: message.messageId, content
        ,contextToken: message.contextToken, ...(trackContext ? { trackId: trackContext.trackId, trackEventId: trackContext.attributionEventId } : {})
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
    logWeChatCliEvent('info', 'wechat.inbound.quote_wire', quoteWireSummaryForLog(
      raw.raw as unknown as Parameters<typeof quoteWireSummaryForLog>[0], raw.quotedMessage
    ))
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
      return
    }

    const sendAuthorizedReply = async (body: string): Promise<void> => {
      if (!bot) return
      const sessionId = `inbound:${msg.messageId}`
      const destinationId = raw.raw?.client_id || `${raw.userId}-${raw.timestamp.getTime()}`
      const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'wechat', purpose: 'system-reply', body,
        sessionId, identityKey: guard.snapshot.owner, ownerId: guard.snapshot.owner, recipient: guard.snapshot.owner,
        chatType: 'p2p', destinationId })
      await sendWeChatRemoteOutbound({ bot, inbound: raw, body, sessionId, ownerId: guard.snapshot.owner, outboundDeliveryFacts })
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
      await sendAuthorizedReply('当前指令过于频繁，请稍后再试')
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
    const clarificationControl = await resolveClarificationControlMessage(userContentFinal, {
      channel: 'wechat', identityKey: msg.userId, ownerId: guard.snapshot.owner, replyMessageId: msg.messageId,
      legacyBareOptionPending: hasPendingClarificationForScope(this.deps.db, { channel: 'wechat', identityKey: msg.userId,
        ownerId: guard.snapshot.owner, authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'wechat') }),
      resolve: this.deps.handleClarificationReply ?? (async (input) => {
        const prior = getClarificationResumeIdentity(this.deps.db, input.handle)
        const trackEventId = randomUUID()
        const workId = randomUUID()
        const result = resolveClarificationSelection(this.deps.db, { ...input, authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'wechat'),
          trackEventId, workId, now: Date.now(), successorTrackId: randomUUID() })
        if (result.kind === 'resolved' || result.kind === 'already-resolved') {
          const effectiveEventId = result.kind === 'already-resolved' ? prior?.trackEventId : trackEventId
          if (!prior || !effectiveEventId) throw new Error('WECHAT_CLARIFICATION_RESUME_EVENT_MISSING')
          const resumed = resumeClarificationInboxMessage(this.deps.db, { clarificationId: prior.clarificationId,
            trackId: result.trackId, trackEventId: effectiveEventId, now: Date.now() })
          await this.deps.wakeEventDispatcher?.dispatchSession(resumed.sessionId)
        }
        return result
      })
    })
    if (clarificationControl.consumed) {
      try {
        recordRemoteTrackDiagnosticEvent(this.deps.db, { channel: 'wechat', platformMessageId: msg.messageId,
          eventKind: 'clarification.reply', reasonCode: clarificationControl.resultKind,
          occurredAt: Date.now() })
      } catch (error) {
        logWeChatCliEvent('error', 'wechat.inbound.clarification_diagnostic_failed', {
          messageId: msg.messageId, error: error instanceof Error ? error.message : String(error)
        })
      }
      logWeChatCliEvent('info', 'wechat.inbound.clarification_reply', { messageId: msg.messageId, result: clarificationControl.resultKind })
      try {
        await sendAuthorizedReply(clarificationControl.reply)
      } finally {
        await this.deps.processedStore.markCompleted(msg.messageId, claimResult.claimId, `clarification_${clarificationControl.resultKind}`)
      }
      return
    }

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

      let resolvedSession: { sessionId: string; isNew: boolean } | undefined
      const resolveSession = async () => {
        resolvedSession ??= await resolveWeChatSession(this.deps.sessionStorage!, msg, config, this.deps.getModel(), undefined,
          () => this.deps.workDirManager.getActiveProfileId())
        return resolvedSession
      }
      let sessionId = ''
      let isNew = false
      const trackGates = readRemoteTrackFeatureGates(this.deps.db, 'wechat')
      let trackContext: RemoteTrackContext | undefined
      if (trackGates.execution && !this.deps.wakeEventDispatcher) {
        const resolved = await resolveSession()
        if (bot) await sendWeChatRemoteOutbound({ bot, inbound: inboundRaw,
          body: '远程任务恢复通道暂不可用，本次未执行，请稍后重发。', sessionId: resolved.sessionId,
          ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: resolved.sessionId } })
        await claimFinalizer.complete('track_execution_recovery_unavailable')
        return
      }
      if (trackGates.shadowAttribution && !trackGates.execution) {
        void observeRemoteMessageAttribution(this.deps.db, {
          channel: 'wechat', identityKey: msg.userId, ownerId: authSnapshot.owner,
          authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'wechat'), platformMessageId: msg.messageId,
          ...(msg.quotedMessageId ? { replyToPlatformMessageId: msg.quotedMessageId } : {}), text: content
        }, createModelIntentAttributor({ getApiKey: this.deps.getApiKey, getBaseUrl: this.deps.getBaseUrl, getModel: this.deps.getModel,
          estimateCostUsd: createRemoteTrackClassifierCostEstimator(this.deps.db, { baseUrl: this.deps.getBaseUrl(), model: this.deps.getModel() }) }))
          .then(({ decision, created, latencyMs }) => {
            logWeChatCliEvent('info', 'wechat.track_attribution.shadow_observed', {
              decision: decision.kind, created, latencyMs
            })
          }).catch((error) => {
            logWeChatCliEvent('warn', 'wechat.track_attribution.shadow_failed', {
              reason: error instanceof Error ? error.message : String(error)
            })
          })
      }
      if (trackGates.execution) {
        const attribution = await attributeAndPersistRemoteMessage(this.deps.db, {
          channel: 'wechat', identityKey: msg.userId, ownerId: authSnapshot.owner,
          authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'wechat'), platformMessageId: msg.messageId,
          ...(msg.quotedMessageId ? { replyToPlatformMessageId: msg.quotedMessageId } : {}), text: content,
          resolveNewTrackSession: async () => (await resolveSession()).sessionId
        }, createModelIntentAttributor({ getApiKey: this.deps.getApiKey, getBaseUrl: this.deps.getBaseUrl, getModel: this.deps.getModel,
          estimateCostUsd: createRemoteTrackClassifierCostEstimator(this.deps.db, { baseUrl: this.deps.getBaseUrl(), model: this.deps.getModel() }) }),
        { semanticEnabled: trackGates.semanticContinuation, shadowObservationEnabled: trackGates.shadowAttribution, onPersisted: (context) => {
          if (!context.originSessionId) throw new Error('WECHAT_TRACK_INBOX_SESSION_MISSING')
          const trackQueueScope = buildImQueueScope('wechat', context.originSessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
          appendImInboxMessageWithWakeEvent(this.deps.db, { sessionId: context.originSessionId, channel: 'wechat', queueScope: trackQueueScope,
            channelMessageId: msg.messageId, content: wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content,
            contextToken: msg.contextToken, trackId: context.trackId, trackEventId: context.attributionEventId })
        } })
        if (attribution.kind === 'unresolved') {
          if (attribution.decision.kind === 'ambiguous' && attribution.decision.candidateTrackIds.length <= 5 && trackGates.clarification && bot) {
            const resolved = await resolveSession()
            sessionId = resolved.sessionId
            isNew = resolved.isNew
            const epoch = readDurableRemoteTrackEpoch(this.deps.db, 'wechat')
            const byId = new Map(listRemoteTrackAttributionCandidates(this.deps.db, { channel: 'wechat', identityKey: msg.userId,
              ownerId: authSnapshot.owner, authorizationEpoch: epoch }).map((candidate) => [candidate.trackId, candidate]))
            const candidates = attribution.decision.candidateTrackIds.flatMap((trackId, index) => {
              const candidate = byId.get(trackId)
              return candidate ? [{ trackId, option: index + 1, label: candidate.summary.trim().slice(0, 120) || '未命名任务', stateAtIssue: candidate.state }] : []
            })
            if (candidates.length !== attribution.decision.candidateTrackIds.length || candidates.length === 0) {
              await sendWeChatRemoteOutbound({ bot, inbound: inboundRaw, body: '目前无法安全确认这条消息的任务归属，请重新描述完整指令。', sessionId,
                ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId } })
              await claimFinalizer.complete('track_attribution_ambiguous_candidates_unavailable')
              return
            }
            const clarificationId = randomUUID()
            const handle = generateClarificationHandle()
            const expiresAt = Date.now() + 5 * 60_000
            const queueScope = buildImQueueScope('wechat', sessionId)
            parkImInboxMessageForClarification(this.deps.db, {
              sessionId, channel: 'wechat', queueScope, channelMessageId: msg.messageId, content, contextToken: msg.contextToken,
              clarificationId, identityKey: msg.userId, ownerId: authSnapshot.owner, authorizationEpoch: epoch,
              handle, candidates, expiresAt
            })
            const sendAttemptId = randomUUID()
            startClarificationSendAttempt(this.deps.db, { sendAttemptId, clarificationId, version: 1, startedAt: Date.now() })
            const prompt = buildClarificationPrompt(handle, candidates)
            this.activeClarificationSends.add(clarificationId)
            try {
              await sendWeChatRemoteOutbound({ bot, inbound: inboundRaw, body: prompt, sessionId,
                ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId } })
              finishClarificationSendAttempt(this.deps.db, { sendAttemptId, state: 'send-fulfilled', finishedAt: Date.now() })
            } catch (error) {
              finishClarificationSendAttempt(this.deps.db, { sendAttemptId, state: 'send-outcome-unknown', finishedAt: Date.now() })
              logWeChatCliEvent('warn', 'wechat.clarification.prompt_delivery_unknown', {
                messageId: msg.messageId, clarificationId, errorPreview: previewText(error instanceof Error ? error.message : String(error), WECHAT_CLI_LINE_PREVIEW_MAX)
              })
            } finally {
              this.activeClarificationSends.delete(clarificationId)
            }
            await claimFinalizer.complete('track_attribution_ambiguous_clarification')
            return
          }
          const resolved = await resolveSession()
          sessionId = resolved.sessionId
          isNew = resolved.isNew
          const message = attribution.decision.kind === 'ambiguous'
            ? '暂时无法确定这条消息属于哪项任务。为避免接错任务，本次没有执行；请引用相关提示后重发。'
            : '这条消息引用的任务已失效，本次没有执行。请重新描述要处理的事项。'
          if (bot) await sendWeChatRemoteOutbound({ bot, inbound: inboundRaw, body: message, sessionId,
            ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId } })
          await claimFinalizer.complete(`track_attribution_${attribution.decision.kind}`)
          return
        }
        trackContext = attribution.context
        if (trackContext.originSessionId) {
          const origin = this.deps.sessionStorage!.queries.readSession(trackContext.originSessionId)
          const metadata = origin?.metadata as { source?: unknown; wechatMeta?: { userId?: unknown } } | undefined
          if (!origin || metadata?.source !== 'wechat' || metadata.wechatMeta?.userId !== msg.userId) {
            const resolved = await resolveSession()
            sessionId = resolved.sessionId
            isNew = resolved.isNew
            if (bot) await sendWeChatRemoteOutbound({ bot, inbound: inboundRaw,
              body: '这项任务原来的会话已不可用。为避免丢失上下文，本次没有执行，请重新发送完整指令。', sessionId,
              ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId } })
            await claimFinalizer.complete('track_origin_session_unavailable')
            return
          }
          sessionId = origin.id
          isNew = resolvedSession?.sessionId === origin.id ? resolvedSession.isNew : false
          if (resolvedSession?.isNew && resolvedSession.sessionId !== origin.id) {
            this.deps.sessionStorage!.commands.deleteSession(resolvedSession.sessionId)
          }
        }
      }
      if (!sessionId) {
        const resolved = await resolveSession()
        sessionId = resolved.sessionId
        isNew = resolved.isNew
      }
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
          if (!this.persistInboundWake(sessionId, msg, wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content, trackContext)) {
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
              ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
            })
          }
          void this.deps.wakeEventDispatcher.dispatchSession(sessionId, { retryExhausted: true }).catch((error) => {
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
            ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
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
          if (!this.persistInboundWake(sessionId, msg, wasTruncated ? `${content}\n\n（指令过长，已截断处理）` : content, trackContext)) {
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
              ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
            })
          }
          try {
            claim?.release()
            void this.deps.wakeEventDispatcher.dispatchSession(sessionId, { retryExhausted: true }).catch((error) => {
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
            ownerId: authSnapshot.owner, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
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
        let trackModelInputView: import('../../src/shared/remoteTrack').TrackModelInputViewRef | undefined
        if (trackContext) {
          if (!prepared.userMessage) throw new Error('WECHAT_TRACK_ACCEPTED_USER_MESSAGE_MISSING')
          bindRemoteTrackToTurn(this.deps.db, { trackId: trackContext.trackId, turnId: prepared.turnId, sessionId,
            channel: trackContext.channel, identityKey: trackContext.identityKey, ownerId: trackContext.ownerId,
            authorizationEpoch: trackContext.authorizationEpoch, eventId: remoteTrackTurnBindingEventId(trackContext.trackId, prepared.turnId), occurredAt: Date.now() })
          recordTrackModelMessage(this.deps.db, { trackId: trackContext.trackId, eventId: `track-model:${prepared.turnId}:${prepared.userMessage.id}`,
            idempotencyKey: `track-model:${prepared.turnId}:${prepared.userMessage.id}`, sessionId, messageId: prepared.userMessage.id,
            invocationId: prepared.turnId, occurredAt: Date.now(), parentEventId: trackContext.attributionEventId })
          trackModelInputView = buildTrackModelInputViewRef(this.deps.db, { ...trackContext, sessionId,
            acceptedUserMessageId: prepared.userMessage.id, currentInvocationId: prepared.turnId })
          if (trackModelInputView.completeness !== 'complete') throw new Error('WECHAT_TRACK_MODEL_INPUT_VIEW_UNAVAILABLE')
        }

        const remoteContext = {
          source: 'wechat' as const,
          messageId: msg.messageId,
          userId: msg.userId,
          authOwner: authSnapshot.owner,
          contextToken: msg.contextToken,
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
          ...(trackContext ? { trackContext, trackModelInputView } : {}),
          appendWorkDirSwitchAudit: (profileId: string, profileName: string) =>
            this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
          appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) =>
            this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
        }

        let result: { summary: string; pendingConfirm: boolean; ok: boolean }
        try {
          result = await executeRemoteTurn({
            runtime: this.deps.turnRuntime,
            prepared,
            requestId,
            ...(trackContext ? { onTerminal: (outcome) => {
              const target = outcome === 'completed' || outcome === 'parked' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed'
              convergeRemoteTrackTerminal(this.deps.db, { trackId: trackContext.trackId, target, occurredAt: Date.now(),
                readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
            } } : {}),
            run: () => {
            const acceptedTurn = prepared
              ? createAcceptedTurnFromPrepared(prepared, 'wechat', executionConfig ?? { lane: 'wechat' }, this.deps.sessionStorage!.execution)
              : undefined
            return runWeChatRemoteAgent({
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
            resolveAgentSdkGateSupplement: this.deps.resolveAgentSdkGateSupplement,
            taskControlSafetyPort: this.deps.taskControlSafetyPort,
            inboundRaw,
            userId: msg.userId
            ,emitFactEvent: this.deps.turnRuntime && prepared ? (event) => {
              if (event.type === 'source-completed' || event.type === 'source-failed' || event.type === 'source-cancelled' || event.type === 'source-timeout') return
              this.deps.turnRuntime!.consumeForRequest(requestId, event, prepared!.turnId)
            } : undefined
            })
            }
          })
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          result = {
            summary: '执行未完成，当前结果无法确认。请先不要直接重复操作；可以在此聊天说明要核对的内容。',
            pendingConfirm: false,
            ok: false
          }
        }

        await claimFinalizer.complete(result.ok ? 'ok' : 'failed')

        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)

        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, outboundSessionId)

        if (bot && !result.pendingConfirm) {
          await replyWeChatSummary(bot, inboundRaw, result.summary, {
            sessionId: outboundSessionId, ownerId: authSnapshot.owner,
            touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: outboundSessionId },
            ...(trackContext && prepared ? { trackDelivery: { db: this.deps.db, track: trackContext, requestId, turnId: prepared.turnId } } : {})
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
