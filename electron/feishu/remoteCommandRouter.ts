import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import type { FeishuConfig, FeishuInboundMessage, WorkDirProfile } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { readRemoteSessionIdleMinutes } from '../../src/shared/remoteSessionResolve'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import { FeishuImChannel } from './feishuImChannel'
import { shouldAcceptInbound } from './feishuInboundParser'
import { registerInboundFeishuAttachments } from './feishuAttachmentRegistry'
import type { LarkCliRunner } from './larkCliRunner'
import { sendFeishuRemoteOutbound as sendFeishuRemoteOutboundRaw } from './feishuRemoteOutbound'
import { clearRemoteProgressSession } from '../remote/remoteProgressStore'
import { auditEntryToLoggerPayload } from '../remote/remoteSessionSwitchAudit'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'
import type { TurnRuntime } from '../turnRuntime'
import type { SessionStorage } from '../sessionStorage/contracts'
import { resolveFeishuSession } from './feishuSessionResolver'
import { tryClaimOrRelease, createProcessedClaimFinalizer } from '../remote/imCommandRouterHelpers'
import { resolveClarificationControlMessage, type ClarificationResolverInput, type ClarificationResolverResult } from '../remote/clarificationInbound'
import { bindRemoteSessionExecutionId, tryClaimRemoteSession, releaseRemoteSession, getRemoteAgentLease } from '../remote/remoteAgentRegistry'
import { authorizeImInboundMessage, evaluateImInboundGuard, readImPolicyAuthorizationRevision, revalidateImInboundGuard, type ImAuthSnapshot } from '../remote/imInboundGuard'
import { requestImIngressApproval } from '../remote/imIngressApprovalPrompt'
import { loadEffectivePolicyRules } from '../confirmation/policyRulesRuntime'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
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
const FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE = '飞书确认超时（10分钟），工具调用已取消。如需重试，请重新发送原指令。'
import { executeRemoteTurn } from '../remote/turnExecutionAdapter'
import { resolveFrozenImTurnExecutionConfig, resolveTrustedTurnExecutionConfig } from '../turnExecutionConfig'
import { readAcceptedTurn } from '../database/acceptedTurnStorage'
import { createAcceptedTurnFromPrepared } from '../runtime/acceptedTurnContext'
import {
  maskOpenId,
  parseFeishuBindProtocol,
  readOwnerOpenIdFromAllowlist,
  type FeishuOwnerBindController
} from './feishuOwnerBind'
import { CLAIM_LEASE_MS } from '../remote/imProcessedStore'
import { ackImInboxMessage, appendImInboxMessageWithWakeEvent, claimImInboxMessage, getImInboxMessageContext, listImInboxMessages, parkImInboxMessageForClarification, resumeClarificationInboxMessage } from '../database/imInbox'
import { getTurnByRequestId } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { expireDuePendingClarifications, finishClarificationSendAttempt, listPendingClarificationNotices,
  listRecoverableClarificationPrompts, startClarificationSendAttempt, hasPendingClarificationForScope } from '../database/clarificationStore'
import { createImLifecycleOutbox } from '../remote/imLifecycleOutbox'
import { createHostImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
import { sendFeishuTextToTarget } from './feishuReply'
import { formatRemoteOutboundMessage } from '../../src/shared/remoteOutboundFormat'
import { buildClarificationPrompt } from '../remote/clarificationPrompt'
import { canResumePreparedRemoteTurn, inspectRemoteTrackWorkRecovery, isRemoteTrackWorkSettled, settleRemoteTrackWorkFromTurn } from '../remote/remoteTrackWorkRecovery'
import type { WakeEventLoopInput } from '../remote/wakeEventDispatcher'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { isDeferredApprovalReplyCandidate } from '../remote/deferredApprovalIngress'
import type { DeferredApprovalReplyTargetClassification } from '../remote/deferredApprovalNotificationDelivery'
import type { WakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { readDeferredCompletionWake, markDeferredCompletionWakeDelivered } from '../remote/deferredCompletionWake'
import { decideDeferredCompletionWakeRecovery, deliverInterruptedDeferredCompletionNotice } from '../remote/deferredCompletionWakeRecovery'
import type { ImTaskSafetyPort } from '../remote/imTaskControlCoordinator'
import type { RemoteTrackContext, TrackModelInputViewRef } from '../../src/shared/remoteTrack'
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
  sessionStorage?: SessionStorage
  runner: LarkCliRunner
  processedStore: FeishuProcessedStore
  imChannel: FeishuImChannel
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
  turnRuntime?: TurnRuntime
  wakeEventDispatcher?: WakeEventDispatcher
  isRemoteAsyncApprovalEnabled?: () => boolean
  retryDeferredApprovalNotifications?: (scope: { identityKey: string; ownerId: string }) => Promise<unknown>
  handleDeferredApprovalReply?: (input: { message: FeishuInboundMessage; text: string; replyToMessageId?: string }) => Promise<void>
  classifyDeferredApprovalReplyTarget?: (input: { identityKey: string; messageId: string }) => DeferredApprovalReplyTargetClassification
  handleClarificationReply?: (input: ClarificationResolverInput) => Promise<ClarificationResolverResult>
  createDeferredConfirmationAdapter?: (remoteContext: import('../tools/types').RemoteContext) => NonNullable<Parameters<typeof runFeishuRemoteAgent>[0]['confirmationAdapter']>
  resolveAgentSdkGateSupplement?: import('../runtime/invocationAssembler').AgentInvocationMaterials['resolveAgentSdkGateSupplement']
  taskControlSafetyPort?: ImTaskSafetyPort
}

export class RemoteCommandRouter {
  private lastInboundAt?: number
  private lastReplyAt?: number
  private pendingDisambiguation = new Map<string, PendingDisambiguation>()
  private recoveringClarificationLifecycle = false
  private activeClarificationSends = new Set<string>()

  constructor(private deps: RemoteCommandRouterDeps) {}

  async recoverClarificationLifecycle(now = Date.now()): Promise<void> {
    if (this.recoveringClarificationLifecycle) return
    this.recoveringClarificationLifecycle = true
    try {
      expireDuePendingClarifications(this.deps.db, now, 'feishu')
      const outbox = createImLifecycleOutbox(this.deps.db)
      for (const notice of listPendingClarificationNotices(this.deps.db, 'feishu')) {
        await outbox.deliver(notice, (text) => sendFeishuTextToTarget(
          this.deps.runner, notice.ownerId, formatRemoteOutboundMessage(text, notice.sessionId)
        ), () => createHostImOutboundFacts({ channel: 'feishu', body: notice.text, sessionId: notice.sessionId,
          identityKey: notice.identityKey, ownerId: notice.ownerId, recipient: notice.ownerId, chatType: 'p2p' }))
      }
      for (const prompt of listRecoverableClarificationPrompts(this.deps.db, 'feishu', now)) {
        if (this.activeClarificationSends.has(prompt.clarificationId)) continue
        this.activeClarificationSends.add(prompt.clarificationId)
        const sendAttemptId = randomUUID()
        try {
          try {
            startClarificationSendAttempt(this.deps.db, { sendAttemptId, clarificationId: prompt.clarificationId, version: prompt.version, startedAt: now })
          } catch { continue }
          try {
            await sendFeishuTextToTarget(this.deps.runner, prompt.ownerId,
              formatRemoteOutboundMessage(buildClarificationPrompt(prompt.handle, prompt.candidates), prompt.sessionId))
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
    const metadata = session?.metadata as { source?: unknown; feishuChatId?: unknown; feishuSenderOpenId?: unknown } | undefined
    if (!session || metadata?.source !== 'feishu' ||
      typeof metadata.feishuChatId !== 'string' || typeof metadata.feishuSenderOpenId !== 'string') {
      throw new Error('FEISHU_WAKE_SESSION_IDENTITY_INVALID')
    }
    const config = mergeFeishuConfig(this.deps.getFeishuConfig())
    const guard = evaluateImInboundGuard({ channel: 'feishu', senderId: metadata.feishuSenderOpenId, getConfig: () => config,
      getPolicyRules: () => loadEffectivePolicyRules(this.deps.db, 'feishu'), skipIngressPolicy: true })
    if (!guard.ok) throw new Error(`FEISHU_WAKE_AUTH_REJECTED:${guard.reason}`)
    const assertAuthorized = () => {
      const revalidated = revalidateImInboundGuard(guard.snapshot, { getConfig: () => mergeFeishuConfig(this.deps.getFeishuConfig()),
        getPolicyRules: () => loadEffectivePolicyRules(this.deps.db, 'feishu') })
      if (!revalidated.ok) throw new Error(`FEISHU_WAKE_AUTH_REVOKED:${revalidated.reason}`)
    }

    const scope = buildImQueueScope('feishu', input.sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    for (const event of input.events) {
      assertAuthorized()
      if (event.type === 'safety-recovery' && event.payloadRef.kind === 'safety-approval') {
        if (event.sessionId !== input.sessionId) throw new Error('FEISHU_COMPLETION_WAKE_SESSION_MISMATCH')
        const completion = readDeferredCompletionWake(this.deps.db, event.payloadRef.approvalId)
        if (!completion || completion.todo.channel !== 'feishu' || completion.todo.origin_session_id !== input.sessionId ||
          completion.todo.identity_key !== metadata.feishuChatId || completion.todo.owner_id !== metadata.feishuSenderOpenId) {
          throw new Error('FEISHU_COMPLETION_WAKE_BINDING_INVALID')
        }
        const context = completion.envelope.executionContext
        const userMessageId = context.currentUserMessageId
        const messageId = context.messageId
        if (typeof userMessageId !== 'string' || typeof messageId !== 'string') throw new Error('FEISHU_COMPLETION_WAKE_CONTEXT_INVALID')
        const originalMessage = this.deps.sessionStorage.queries.readMessage({ sessionId: input.sessionId, messageId: userMessageId })
        const originalContent = originalMessage?.content ?? listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 })
          .find(({ messageId: queuedId }) => queuedId === userMessageId)?.content
        if (typeof originalContent !== 'string') throw new Error(`FEISHU_COMPLETION_WAKE_SOURCE_MESSAGE_MISSING:${userMessageId}`)
        const sourceAcceptedTurn = readAcceptedTurn(this.deps.db, input.sessionId, completion.envelope.requestId)
        if (!sourceAcceptedTurn || sourceAcceptedTurn.turnId !== completion.envelope.turnId || sourceAcceptedTurn.lane !== 'feishu') {
          throw new Error('FEISHU_COMPLETION_WAKE_FROZEN_CONFIG_MISSING')
        }
        const requestId = `completion:${event.eventId}`
        const recovery = decideDeferredCompletionWakeRecovery({
          read: () => getTurnByRequestId(this.deps.db, input.sessionId, requestId),
          recover: () => this.deps.turnRuntime?.recover()
        })
        if (recovery.kind === 'recovery-pending') throw new Error('FEISHU_COMPLETION_WAKE_RECOVERY_PENDING')
        if (recovery.kind === 'notify-interrupted') {
          const ownerId = metadata.feishuSenderOpenId as string
          await deliverInterruptedDeferredCompletionNotice(this.deps.db, { todoId: event.payloadRef.approvalId, sessionId: input.sessionId,
            channel: 'feishu', identityKey: metadata.feishuChatId as string, ownerId, recipient: ownerId,
            send: (text) => sendFeishuTextToTarget(this.deps.runner, ownerId, formatRemoteOutboundMessage(text, input.sessionId)) })
          continue
        }
        if (recovery.kind === 'start') {
          const currentLease = getRemoteAgentLease(input.sessionId)
          const alreadyHeld = currentLease?.requestId === input.runId
          const lease = alreadyHeld ? 'ok' : tryClaimRemoteSession(input.sessionId, requestId, this.deps.getAppConfig().maxParallelChatSessions)
          if (lease !== 'ok') throw new Error(`FEISHU_COMPLETION_WAKE_SESSION_LEASE_FAILED:${lease}`)
          const leaseRequestId = alreadyHeld ? input.runId : requestId
          if (!alreadyHeld) bindRemoteSessionExecutionId(input.sessionId, requestId, requestId)
          try {
            const profile = this.deps.workDirManager.listProfiles().find((item) => item.id === context.workDirProfileId) ?? null
            await this.executePersistedInboundTurn({ sessionId: input.sessionId, requestId, userMessageId, content: originalContent,
              messageId, chatId: metadata.feishuChatId, senderId: metadata.feishuSenderOpenId, config, profile,
              authSnapshot: guard.snapshot, leaseRequestId, assertAuthorized,
              frozenExecutionConfig: sourceAcceptedTurn.config,
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
          throw new Error('FEISHU_COMPLETION_RESULT_ACK_FAILED')
        }
        continue
      }
      if (event.type !== 'im-inbound' || event.payloadRef.kind !== 'im-inbox-message') throw new Error('FEISHU_WAKE_EVENT_UNSUPPORTED')
      if (event.sessionId !== input.sessionId) throw new Error('FEISHU_WAKE_SESSION_MISMATCH')
      const messageId = event.payloadRef.messageId
      const queued = listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 }).find((item) => item.messageId === messageId)
      if (!queued) throw new Error('FEISHU_WAKE_INBOX_MESSAGE_MISSING')
      const channelContext = getImInboxMessageContext(this.deps.db, messageId)
      if (!channelContext || channelContext.channel !== 'feishu') throw new Error('FEISHU_WAKE_PLATFORM_CONTEXT_MISSING')
      const clarificationWorkState = channelContext.clarificationWorkId
        ? (getDbConnection(this.deps.db).prepare('SELECT state FROM remote_track_work_queue WHERE work_id=?')
          .get(channelContext.clarificationWorkId) as { state: string } | undefined)?.state
        : undefined
      const clarificationWork = channelContext.clarificationWorkId && !isRemoteTrackWorkSettled(clarificationWorkState)
        ? claimRemoteTrackWork(this.deps.db, { workerId: `wake:${input.runId}`, now: Date.now(), leaseMs: 30_000, workId: channelContext.clarificationWorkId })
        : null
      if (channelContext.clarificationWorkId && !isRemoteTrackWorkSettled(clarificationWorkState) &&
        (!clarificationWork || clarificationWork.sessionId !== input.sessionId)) {
        throw new Error('FEISHU_CLARIFICATION_WORK_UNAVAILABLE')
      }
      const lease = claimImInboxMessage(this.deps.db, { queueScope: scope, messageId: queued.messageId, ownerId: input.ownerId })
      if (!lease) throw new Error('FEISHU_WAKE_INBOX_CLAIM_FAILED')
      const requestId = `wake:${event.eventId}`
      let priorTurn = getTurnByRequestId(this.deps.db, session.id, requestId)
      const workRecovery = channelContext.clarificationWorkId
        ? inspectRemoteTrackWorkRecovery(this.deps.db, channelContext.clarificationWorkId) : null
      const acceptedSnapshot = readAcceptedTurn(this.deps.db, session.id, requestId)
      const canResumePrepared = priorTurn !== undefined && (channelContext.clarificationWorkId
        ? workRecovery?.decision.kind === 'resume-prepared-turn'
        : canResumePreparedRemoteTurn({ turnState: priorTurn.state, turnId: priorTurn.turnId, requestId: priorTurn.requestId,
          sessionId: priorTurn.sessionId, userMessageId: priorTurn.userMessageId, turnConfig: priorTurn.executionConfig, accepted: acceptedSnapshot }))
      if (priorTurn && priorTurn.state !== 'terminal' && !canResumePrepared) {
        this.deps.turnRuntime?.recover()
        priorTurn = getTurnByRequestId(this.deps.db, session.id, requestId)
      }
      if (priorTurn) {
        if (priorTurn.state === 'terminal') {
          if (clarificationWork) {
            if (!settleRemoteTrackWorkFromTurn(this.deps.db, { claim: clarificationWork, outcome: priorTurn.outcome, now: Date.now(),
              noticeText: '原始消息未重新执行，以避免重复操作；此前进度或外部调用结果无法确认。请先不要重发，可在此聊天说明要核对的内容。' })) {
              throw new Error('FEISHU_CLARIFICATION_WORK_SETTLE_FAILED')
            }
          }
          if (channelContext.trackId) convergeRemoteTrackTerminal(this.deps.db, { trackId: channelContext.trackId,
            target: priorTurn.outcome === 'completed' || priorTurn.outcome === 'parked' ? 'completed' : priorTurn.outcome === 'cancelled' ? 'cancelled' : 'failed',
            occurredAt: Date.now(), readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
          if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId: queued.messageId, ownerId: input.ownerId })) throw new Error('FEISHU_WAKE_INBOX_ACK_FAILED')
          continue
        }
        if (priorTurn.state !== 'prepared' || !canResumePrepared) throw new Error('FEISHU_WAKE_PRIOR_TURN_INCOMPLETE')
        // A prepared turn may be resumed only with its persisted accepted snapshot.
      }

      const currentLease = getRemoteAgentLease(session.id)
      const alreadyHeldByDispatcher = currentLease?.requestId === input.runId
      const sessionLease = alreadyHeldByDispatcher ? 'ok' : tryClaimRemoteSession(session.id, requestId, this.deps.getAppConfig().maxParallelChatSessions)
      if (sessionLease !== 'ok') throw new Error(`FEISHU_WAKE_SESSION_LEASE_FAILED:${sessionLease}`)
      const executionLeaseRequestId = alreadyHeldByDispatcher ? input.runId : requestId
      if (!alreadyHeldByDispatcher) bindRemoteSessionExecutionId(session.id, requestId, requestId)

      const authSnapshot = guard.snapshot
      const profile = this.deps.workDirManager.listProfiles().find((item) => item.id === session.workDirProfileId) ?? null
      const trackContext = channelContext.trackId ? readRemoteTrackContextForInbound(this.deps.db, messageId, {
        channel: 'feishu', identityKey: metadata.feishuChatId, ownerId: guard.snapshot.owner,
        authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'feishu')
      }) : undefined
      if (channelContext.trackId && !trackContext) throw new Error('FEISHU_WAKE_TRACK_ATTRIBUTION_INVALID')
      try {
        await this.executePersistedInboundTurn({ sessionId: session.id, requestId, userMessageId: queued.messageId,
          content: queued.content, messageId: channelContext.platformMessageId, chatId: metadata.feishuChatId,
          senderId: metadata.feishuSenderOpenId, config, profile, authSnapshot, leaseRequestId: executionLeaseRequestId, assertAuthorized,
          ...(clarificationWork ? { clarificationWork } : {}),
          ...(trackContext ? { trackContext } : {}) })
        if (clarificationWork && !settleRemoteTrackWork(this.deps.db, { workId: clarificationWork.workId, workerId: clarificationWork.workerId,
          attempt: clarificationWork.attempt, state: 'completed', now: Date.now() })) throw new Error('FEISHU_CLARIFICATION_WORK_SETTLE_FAILED')
        if (clarificationWork && channelContext.trackId) convergeRemoteTrackTerminal(this.deps.db, { trackId: channelContext.trackId,
          target: 'completed', occurredAt: Date.now(), readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
        if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId: queued.messageId, ownerId: input.ownerId })) throw new Error('FEISHU_WAKE_INBOX_ACK_FAILED')
      } finally {
        if (!alreadyHeldByDispatcher) releaseRemoteSession(session.id, requestId)
      }
    }
  }

  private async executePersistedInboundTurn(input: {
    sessionId: string; requestId: string; userMessageId: string; content: string; messageId: string
    chatId: string; senderId: string; config: FeishuConfig; profile: WorkDirProfile | null; authSnapshot: ImAuthSnapshot; leaseRequestId: string; assertAuthorized: () => void
    frozenExecutionConfig?: import('../../src/shared/acceptedTurn').AcceptedTurn['config']
    deferredContinuation?: import('../tools/types').RemoteContext['deferredContinuation']
    clarificationWork?: RemoteTrackWorkClaim
    trackContext?: RemoteTrackContext
  }): Promise<void> {
    if (input.deferredContinuation && !input.frozenExecutionConfig) throw new Error('FEISHU_COMPLETION_WAKE_FROZEN_CONFIG_MISSING')
    const acceptedSnapshot = this.deps.sessionStorage?.execution.readAccepted({ sessionId: input.sessionId, requestId: input.requestId })
    const frozenConfig = input.frozenExecutionConfig ?? acceptedSnapshot?.config
    const executionConfig = frozenConfig
      ? await resolveFrozenImTurnExecutionConfig(this.deps.db, 'feishu', frozenConfig)
      : await resolveTrustedTurnExecutionConfig(this.deps.db, this.deps.sessionStorage!.queries, this.deps.sessionStorage!.commands, input.sessionId, 'feishu')
    input.assertAuthorized()
    const queueScope = buildImQueueScope('feishu', input.sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const prepared = this.deps.turnRuntime?.prepare({ mode: 'reuse-user', requestId: input.requestId, sessionId: input.sessionId,
      userMessageId: input.userMessageId, excludeMessageIds: [], config: executionConfig, queueScope })
    if (!prepared) throw new Error('REMOTE_TURN_PREPARE_REQUIRED')
    let trackModelInputView: TrackModelInputViewRef | undefined
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
      if (trackModelInputView.completeness !== 'complete') throw new Error('FEISHU_TRACK_MODEL_INPUT_VIEW_UNAVAILABLE')
    }
    if (input.clarificationWork) bindRemoteTrackWorkExecution(this.deps.db, { workId: input.clarificationWork.workId,
      workerId: input.clarificationWork.workerId, attempt: input.clarificationWork.attempt, sessionId: input.sessionId,
      requestId: input.requestId, turnId: prepared.turnId, userMessageId: input.userMessageId,
      modelViewVersion: trackModelInputView?.viewVersion ?? 'track-model-view-unavailable', now: Date.now() })
    if (!bindRemoteSessionExecutionId(input.sessionId, input.leaseRequestId, prepared.turnId)) throw new Error('REMOTE_SESSION_LEASE_LOST')
    const remoteContext = {
      source: 'feishu' as const, messageId: input.messageId,
      feishuConfig: input.config, feishuAttachments: [], imChannel: this.deps.imChannel,
      confirmTimeoutMessage: FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE, larkCliRunner: this.deps.runner,
      chatId: input.chatId, chatType: 'p2p' as const, userId: input.authSnapshot.owner, authOwner: input.authSnapshot.owner,
      originSessionId: input.sessionId, outboundSessionId: input.sessionId,
      workDirProfileId: input.profile?.id ?? this.deps.workDirManager.getActiveProfileId(),
      ...(input.deferredContinuation ? { deferredContinuation: input.deferredContinuation } : {}),
      authorizationGeneration: input.authSnapshot.authorizationGeneration, requestId: input.requestId, turnId: prepared.turnId,
      ...(input.trackContext ? { trackContext: input.trackContext, trackModelInputView } : {}),
      appendWorkDirSwitchAudit: (profileId: string, profileName: string) => this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
      appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) => this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
    }
    const acceptedTurn = createAcceptedTurnFromPrepared(prepared, 'feishu', executionConfig ?? { lane: 'feishu' }, this.deps.sessionStorage!.execution)
    const result = await executeRemoteTurn({ runtime: this.deps.turnRuntime, prepared, requestId: input.requestId,
      ...(input.trackContext ? { onTerminal: (outcome) => {
        const target = outcome === 'completed' || outcome === 'parked' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed'
        convergeRemoteTrackTerminal(this.deps.db, { trackId: input.trackContext!.trackId, target, occurredAt: Date.now(),
          readActiveConfirmations: (trackId) => this.deps.imChannel.listPendingTrackConfirmations(trackId) })
      } } : {}),
      run: () => { input.assertAuthorized(); return runFeishuRemoteAgent({ db: this.deps.db, sessionStorage: this.deps.sessionStorage!, sessionId: input.sessionId,
        userMessage: input.content, replyMessageId: input.messageId, requestId: input.requestId, turnId: prepared.turnId,
        acceptedTurn, feishuConfig: input.config,
        workDir: input.profile?.path ?? this.deps.getWorkDir(), workDirManager: this.deps.workDirManager,
        runner: this.deps.runner, imChannel: this.deps.imChannel, getToolsConfig: this.deps.getToolsConfig,
        getBrowserConfig: this.deps.getBrowserConfig, getWikiConfig: this.deps.getWikiConfig, getShellConfig: this.deps.getShellConfig,
        userDataDir: this.deps.getUserDataPath(), remoteContext,
        confirmationAdapter: this.deps.createDeferredConfirmationAdapter?.(remoteContext),
        resolveAgentSdkGateSupplement: this.deps.resolveAgentSdkGateSupplement,
        taskControlSafetyPort: this.deps.taskControlSafetyPort,
        emitFactEvent: (event) => { if (!['source-completed', 'source-failed', 'source-cancelled', 'source-timeout'].includes(event.type)) this.deps.turnRuntime!.consumeForRequest(input.requestId, event, prepared.turnId) }
      }) }
    })
    if (!result.ok) throw new Error(`FEISHU_WAKE_TURN_FAILED:${result.summary}`)
    const outcome = getTurnByRequestId(this.deps.db, input.sessionId, input.requestId)?.outcome
    if (result.parked && outcome === 'parked') return
    if (outcome !== 'completed') throw new Error('FEISHU_WAKE_TURN_NOT_DURABLY_COMPLETED')
    const wakeFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body: result.summary,
      sessionId: input.sessionId, identityKey: input.chatId, ownerId: input.authSnapshot.owner,
      recipient: input.authSnapshot.owner, chatType: 'p2p', destinationId: input.messageId })
    await sendFeishuRemoteOutboundRaw({ runner: this.deps.runner, messageId: input.messageId, body: result.summary,
      sessionId: input.sessionId, recipient: input.authSnapshot.owner,
      outboundIdentity: { identityKey: input.chatId, ownerId: input.authSnapshot.owner, chatType: 'p2p' },
      outboundDeliveryFacts: wakeFacts, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: input.sessionId },
      ...(input.trackContext ? { trackDelivery: { db: this.deps.db, track: input.trackContext, requestId: input.requestId, turnId: prepared.turnId } } : {}) })
  }

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

  private persistInboundWake(sessionId: string, message: FeishuInboundMessage, content: string, trackContext?: RemoteTrackContext): boolean {
    try {
      const queueScope = buildImQueueScope('feishu', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
      appendImInboxMessageWithWakeEvent(this.deps.db, {
        sessionId, channel: 'feishu', queueScope, channelMessageId: message.messageId, content,
        ...(trackContext ? { trackId: trackContext.trackId, trackEventId: trackContext.attributionEventId } : {})
      })
      return true
    } catch (error) {
      logFeishuCliEvent('error', 'feishu.inbound.persistence_failed', {
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

  getLastReplyAt(): number | undefined {
    return this.lastReplyAt
  }

  async handleInbound(msg: FeishuInboundMessage): Promise<void> {
    this.lastInboundAt = Date.now()
    const config = mergeFeishuConfig(this.deps.getFeishuConfig())
    logFeishuCliEvent('info', 'feishu.inbound.received', inboundSummaryForLog(msg))

    const ownerOpenId = readOwnerOpenIdFromAllowlist(config.remoteSenderAllowlist)
    const sendScopedReply = (message: FeishuInboundMessage, ownerId: string | undefined, body: string, sessionId = `inbound:${message.messageId}`) => {
      if (!ownerId) return Promise.resolve(undefined)
      const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body,
        sessionId, identityKey: message.chatId, ownerId, recipient: message.senderOpenId,
        chatType: message.chatType === 'p2p' ? 'p2p' : message.chatType === 'group' ? 'group' : 'unknown',
        destinationId: message.messageId })
      return sendFeishuRemoteOutboundRaw({ runner: this.deps.runner, messageId: message.messageId, body,
        sessionId, recipient: message.senderOpenId,
        outboundIdentity: { identityKey: message.chatId, ownerId, chatType: message.chatType === 'p2p' ? 'p2p' : message.chatType === 'group' ? 'group' : 'unknown' },
        outboundDeliveryFacts })
    }
    if (this.deps.imChannel.tryResolveFromInboundMessage(msg, { ownerOpenId })) return

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

    const getGuardConfig = () => {
      const c = mergeFeishuConfig(this.deps.getFeishuConfig())
      return { enabled: c.enabled, remoteEnabled: c.remoteEnabled, remoteSenderAllowlist: c.remoteSenderAllowlist }
    }
    const authorizeIngress = () => authorizeImInboundMessage({
      channel: 'feishu', senderId: msg.senderOpenId, messageId: msg.messageId,
      isGroup: msg.chatType === 'group', getConfig: getGuardConfig,
      getPolicyRules: () => loadEffectivePolicyRules(this.deps.db, 'feishu'),
      getPolicyRevision: () => readImPolicyAuthorizationRevision(this.deps.db),
      subscribePolicyChanges: (listener) => getDefaultAgentRuntime().policyAuthorizationChanges.subscribe(msg.messageId, 'feishu', listener),
      requestApproval: (request, signal) => requestImIngressApproval({ ...request, db: this.deps.db, messageText: msg.content, signal })
    })
    let earlyGuard: Awaited<ReturnType<typeof authorizeIngress>> | undefined
    if (!accept.accept && (accept.reason === 'group_disabled' || accept.reason === 'non_owner')) {
      earlyGuard = await authorizeIngress()
    }

    if (!accept.accept && !earlyGuard?.ok) {
      logFeishuCliEvent('info', 'feishu.inbound.reject', { reason: accept.reason })
      if (accept.reason === 'too_long') {
        await sendScopedReply(msg, ownerOpenId, '消息过长，请控制在 4000 字以内')
      } else if (accept.reason === 'group_disabled') {
        logFeishuCliEvent('info', 'feishu.reject.group', { chatId: msg.chatId })
        await sendScopedReply(msg, ownerOpenId, '飞书远程仅支持私聊。请向 Bot 发送私聊消息。')
      } else if (accept.reason === 'non_owner') {
        logFeishuCliEvent('warn', 'feishu.reject.non_owner', { senderOpenId: msg.senderOpenId })
        await sendScopedReply(msg, ownerOpenId, '您不是已绑定的远程使用者，无法发送指令。')
      } else if (accept.reason === 'unbound') {
        logFeishuCliEvent('warn', 'feishu.reject.unbound', { senderOpenId: msg.senderOpenId })
        await sendScopedReply(msg, ownerOpenId, '远程尚未完成身份绑定。请在电脑端开启远程监听并完成绑定。')
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
        await sendScopedReply(msg, ownerOpenId, '远程尚未完成身份绑定。请在电脑端查看配对码，并发送「绑定 <配对码>」（英文 bind <code>）完成绑定。')
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
        await sendScopedReply(msg, msg.senderOpenId, '已绑定为远程控制者。本条仅用于绑定，请重新发送指令。之后仅你可向 Bot 发送指令。')
        return
      }

      if (result === 'wrong_code') {
        logFeishuCliEvent('warn', 'feishu.bind.wrong_code', { senderOpenId: msg.senderOpenId })
        await sendScopedReply(msg, ownerOpenId, '配对码错误。请核对电脑端显示的配对码后重试。')
        return
      }

      if (result === 'exhausted') {
        logFeishuCliEvent('warn', 'feishu.bind.exhausted', { senderOpenId: msg.senderOpenId })
        await sendScopedReply(msg, ownerOpenId, '配对码尝试次数过多，绑定窗口已关闭，远程已停用。请在电脑端重新发起绑定。')
        return
      }

      // already_bound / expired / no_window: another sender won, or window gone.
      logFeishuCliEvent('warn', 'feishu.reject.unbound', {
        senderOpenId: msg.senderOpenId,
        reason: result
      })
      await sendScopedReply(msg, ownerOpenId, '远程尚未完成身份绑定或配对窗口已失效。请在电脑端重新发起绑定。')
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
      await sendScopedReply(msg, ownerOpenId, '指令过于频繁，请稍后再试。')
      return
    }

    const guard = earlyGuard ?? await authorizeIngress()
    if (!guard.ok) {
      logFeishuCliEvent('warn', 'feishu.inbound.guard_reject', { reason: guard.reason })
      return
    }

    const re1 = revalidateImInboundGuard(guard.snapshot, { getConfig: getGuardConfig })
    if (!re1.ok) {
      logFeishuCliEvent('warn', 'feishu.inbound.guard_revalidate_fail', { reason: re1.reason })
      return
    }

    try {
      await this.deps.retryDeferredApprovalNotifications?.({ identityKey: msg.chatId, ownerId: guard.snapshot.owner })
    } catch (error) {
      logFeishuCliEvent('warn', 'feishu.deferred_approval_notification_retry_failed', {
        messageId: msg.messageId, error: error instanceof Error ? error.message : String(error)
      })
    }

    if (isDeferredApprovalReplyCandidate(userContent) && this.deps.isRemoteAsyncApprovalEnabled?.() === true) {
      try {
        await this.deps.handleDeferredApprovalReply?.({ message: msg, text: userContent, replyToMessageId: msg.replyToMessageId })
      } catch (error) {
        logFeishuCliEvent('error', 'feishu.deferred_approval_ingress_failed', {
          messageId: msg.messageId, error: error instanceof Error ? error.message : String(error)
        })
      }
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

    const clarificationControl = await resolveClarificationControlMessage(userContent, {
      channel: 'feishu', identityKey: msg.chatId, ownerId: guard.snapshot.owner, replyMessageId: msg.messageId,
      legacyBareOptionPending: hasPendingClarificationForScope(this.deps.db, { channel: 'feishu', identityKey: msg.chatId,
        ownerId: guard.snapshot.owner, authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'feishu') }),
      resolve: this.deps.handleClarificationReply ?? (async (input) => {
        const prior = getClarificationResumeIdentity(this.deps.db, input.handle)
        const trackEventId = randomUUID()
        const result = resolveClarificationSelection(this.deps.db, { ...input, authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'feishu'),
          trackEventId, workId: randomUUID(), now: Date.now(), successorTrackId: randomUUID() })
        if (result.kind === 'resolved' || result.kind === 'already-resolved') {
          const effectiveEventId = result.kind === 'already-resolved' ? prior?.trackEventId : trackEventId
          if (!prior || !effectiveEventId) throw new Error('FEISHU_CLARIFICATION_RESUME_EVENT_MISSING')
          const resumed = resumeClarificationInboxMessage(this.deps.db, { clarificationId: prior.clarificationId,
            trackId: result.trackId, trackEventId: effectiveEventId, now: Date.now() })
          await this.deps.wakeEventDispatcher?.dispatchSession(resumed.sessionId)
        }
        return result
      })
    })
    if (clarificationControl.consumed) {
      try {
        recordRemoteTrackDiagnosticEvent(this.deps.db, { channel: 'feishu', platformMessageId: msg.messageId,
          eventKind: 'clarification.reply', reasonCode: clarificationControl.resultKind,
          occurredAt: Date.now() })
      } catch (error) {
        logFeishuCliEvent('error', 'feishu.inbound.clarification_diagnostic_failed', {
          messageId: msg.messageId, error: error instanceof Error ? error.message : String(error)
        })
      }
      logFeishuCliEvent('info', 'feishu.inbound.clarification_reply', { messageId: msg.messageId, result: clarificationControl.resultKind })
      try {
        await sendScopedReply(msg, guard.snapshot.owner, clarificationControl.reply)
      } finally {
        await this.deps.processedStore.markCompleted(msg.messageId, claimResult.claimId, `clarification_${clarificationControl.resultKind}`)
      }
      return
    }

    // Workdir disambiguation only after guard/claim (prevents rebind bypass).
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
        await this.deps.processedStore.markCompleted(
          msg.messageId,
          claimResult.claimId,
          'disambiguation_rejected'
        )
        await this.finalizeDisambiguation(disambigKey, pending, reason)
        logFeishuCliEvent('warn', 'feishu.disambiguation.reject', {
          senderOpenId: msg.senderOpenId,
          pendingSender: pending.senderOpenId,
          reason: 'identity_or_expired'
        })
        await sendScopedReply(msg, freshOwner, '工作目录选择已失效（身份变更或超时）。请重新发送指令。')
        return
      }
      const chosen = resolveDisambiguationChoice(msg.content, pending.profiles)
      if (chosen) {
        this.clearDisambiguationTimer(pending)
        this.pendingDisambiguation.delete(disambigKey)
        await this.deps.processedStore.markCompleted(
          msg.messageId,
          claimResult.claimId,
          'disambiguation_choice'
        )
        await this.processCommand(
          pending.originalMsg,
          config,
          chosen.path,
          chosen,
          pending.originalMsg.content,
          pending.processedClaimId,
          pending.authSnapshot
        )
        return
      }
      await this.deps.processedStore.markCompleted(
        msg.messageId,
        claimResult.claimId,
        'disambiguation_no_match'
      )
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
      const nextPending: PendingDisambiguation = {
        profiles: workDirResult.ambiguous,
        originalMsg: msg,
        senderOpenId: msg.senderOpenId,
        createdAt: now,
        expiresAt: now + DISAMBIGUATION_TTL_MS,
        processedClaimId: claimResult.claimId,
        authSnapshot: guard.snapshot
      }
      this.armDisambiguationTimeout(disambigKey, nextPending)
      this.pendingDisambiguation.set(disambigKey, nextPending)
      await sendScopedReply(msg, guard.snapshot.owner, buildDisambiguationReply(workDirResult.ambiguous))
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
        await sendScopedReply(msg, guard.snapshot.owner, '该项目为敏感项目，不允许远程访问')
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
    authSnapshot?: ImAuthSnapshot,
    replay?: { requestId: string; sessionId: string; userMessageId: string; ownerId: string }
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
    const sendCommandReply = (body: string, sessionId: string) => {
      if (!authSnapshot) return Promise.resolve(undefined)
      const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body,
        sessionId, identityKey: msg.chatId, ownerId: authSnapshot.owner, recipient: msg.senderOpenId,
        chatType: msg.chatType === 'p2p' ? 'p2p' : msg.chatType === 'group' ? 'group' : 'unknown',
        destinationId: msg.messageId })
      return sendFeishuRemoteOutboundRaw({ runner: this.deps.runner, messageId: msg.messageId, body, sessionId,
        recipient: msg.senderOpenId,
        outboundIdentity: { identityKey: msg.chatId, ownerId: authSnapshot.owner,
          chatType: msg.chatType === 'p2p' ? 'p2p' : msg.chatType === 'group' ? 'group' : 'unknown' },
        outboundDeliveryFacts, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId } })
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
      let resolvedSession: { sessionId: string; isNew: boolean } | undefined
      const resolveSession = async () => {
        resolvedSession ??= replay ? { sessionId: replay.sessionId, isNew: false } : await resolveFeishuSession(
          this.deps.sessionStorage!, msg, config, this.deps.getModel())
        return resolvedSession
      }
      let sessionId = ''
      let isNew = false
      const requestId = replay?.requestId ?? randomUUID()

      if (profile?.sensitive) {
        const resolved = await resolveSession()
        sessionId = resolved.sessionId
        isNew = resolved.isNew
        await sendCommandReply('该项目为敏感项目，不允许远程访问', sessionId)
        await claimFinalizer.complete('sensitive_blocked')
        return
      }

      const trackGates = readRemoteTrackFeatureGates(this.deps.db, 'feishu')
      let trackContext: RemoteTrackContext | undefined
      if (trackGates.execution && !this.deps.wakeEventDispatcher) {
        const resolved = await resolveSession()
        await sendCommandReply('远程任务恢复通道暂不可用，本次未执行，请稍后重发。', resolved.sessionId)
        await claimFinalizer.complete('track_execution_recovery_unavailable')
        return
      }
      if (trackGates.shadowAttribution && !trackGates.execution) {
        void observeRemoteMessageAttribution(this.deps.db, {
          channel: 'feishu', identityKey: msg.chatId, ownerId: authSnapshot.owner,
          authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'feishu'), platformMessageId: msg.messageId,
          ...(msg.replyToMessageId ? { replyToPlatformMessageId: msg.replyToMessageId } : {}), text: content
        }, createModelIntentAttributor({ getApiKey: this.deps.getApiKey, getBaseUrl: this.deps.getBaseUrl, getModel: this.deps.getModel,
          estimateCostUsd: createRemoteTrackClassifierCostEstimator(this.deps.db, { baseUrl: this.deps.getBaseUrl(), model: this.deps.getModel() }) }))
          .then(({ decision, created, latencyMs }) => {
            logFeishuCliEvent('info', 'feishu.track_attribution.shadow_observed', {
              decision: decision.kind, created, latencyMs
            })
          }).catch((error) => {
            logFeishuCliEvent('warn', 'feishu.track_attribution.shadow_failed', {
              reason: error instanceof Error ? error.message : String(error)
            })
          })
      }
      if (trackGates.execution) {
        const attribution = await attributeAndPersistRemoteMessage(this.deps.db, {
          channel: 'feishu', identityKey: msg.chatId, ownerId: authSnapshot.owner,
          authorizationEpoch: readDurableRemoteTrackEpoch(this.deps.db, 'feishu'), platformMessageId: msg.messageId,
          ...(msg.replyToMessageId ? { replyToPlatformMessageId: msg.replyToMessageId } : {}), text: content,
          resolveNewTrackSession: async () => (await resolveSession()).sessionId
        }, createModelIntentAttributor({ getApiKey: this.deps.getApiKey, getBaseUrl: this.deps.getBaseUrl, getModel: this.deps.getModel,
          estimateCostUsd: createRemoteTrackClassifierCostEstimator(this.deps.db, { baseUrl: this.deps.getBaseUrl(), model: this.deps.getModel() }) }),
        { semanticEnabled: trackGates.semanticContinuation, shadowObservationEnabled: trackGates.shadowAttribution, onPersisted: (context) => {
          if (!context.originSessionId) throw new Error('FEISHU_TRACK_INBOX_SESSION_MISSING')
          const trackQueueScope = buildImQueueScope('feishu', context.originSessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
          appendImInboxMessageWithWakeEvent(this.deps.db, { sessionId: context.originSessionId, channel: 'feishu', queueScope: trackQueueScope,
            channelMessageId: msg.messageId, content, trackId: context.trackId, trackEventId: context.attributionEventId })
        } })
        if (attribution.kind === 'unresolved') {
          if (attribution.decision.kind === 'ambiguous' && attribution.decision.candidateTrackIds.length <= 5 && trackGates.clarification) {
            const resolved = await resolveSession()
            sessionId = resolved.sessionId
            isNew = resolved.isNew
            const epoch = readDurableRemoteTrackEpoch(this.deps.db, 'feishu')
            const byId = new Map(listRemoteTrackAttributionCandidates(this.deps.db, { channel: 'feishu', identityKey: msg.chatId,
              ownerId: authSnapshot.owner, authorizationEpoch: epoch }).map((candidate) => [candidate.trackId, candidate]))
            const candidates = attribution.decision.candidateTrackIds.flatMap((trackId, index) => {
              const candidate = byId.get(trackId)
              return candidate ? [{ trackId, option: index + 1, label: candidate.summary.trim().slice(0, 120) || '未命名任务', stateAtIssue: candidate.state }] : []
            })
            if (candidates.length !== attribution.decision.candidateTrackIds.length || candidates.length === 0) {
              await sendCommandReply('目前无法安全确认这条消息的任务归属，请重新描述完整指令。', sessionId)
              await claimFinalizer.complete('track_attribution_ambiguous_candidates_unavailable')
              return
            }
            const clarificationId = randomUUID()
            const handle = generateClarificationHandle()
            const now = Date.now()
            const expiresAt = now + 5 * 60_000
            const queueScope = buildImQueueScope('feishu', sessionId)
            parkImInboxMessageForClarification(this.deps.db, { sessionId, channel: 'feishu', queueScope,
              channelMessageId: msg.messageId, content, clarificationId, identityKey: msg.chatId,
              ownerId: authSnapshot.owner, authorizationEpoch: epoch, handle, candidates, expiresAt, now })
            const sendAttemptId = randomUUID()
            startClarificationSendAttempt(this.deps.db, { sendAttemptId, clarificationId, version: 1, startedAt: Date.now() })
            const prompt = buildClarificationPrompt(handle, candidates)
            this.activeClarificationSends.add(clarificationId)
            try {
              await sendCommandReply(prompt, sessionId)
              finishClarificationSendAttempt(this.deps.db, { sendAttemptId, state: 'send-fulfilled', finishedAt: Date.now() })
            } catch (error) {
              finishClarificationSendAttempt(this.deps.db, { sendAttemptId, state: 'send-outcome-unknown', finishedAt: Date.now() })
              logFeishuCliEvent('warn', 'feishu.clarification.prompt_delivery_unknown', {
                messageId: msg.messageId, clarificationId, error: error instanceof Error ? error.message : String(error)
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
          await sendCommandReply(attribution.decision.kind === 'ambiguous'
              ? '暂时无法确定这条消息属于哪项任务。为避免接错任务，本次没有执行；请引用相关提示后重发。'
              : '这条消息引用的任务已失效，本次没有执行。请重新描述要处理的事项。', sessionId)
          await claimFinalizer.complete(`track_attribution_${attribution.decision.kind}`)
          return
        }
        trackContext = attribution.context
        if (trackContext.originSessionId) {
          const origin = this.deps.sessionStorage!.queries.readSession(trackContext.originSessionId)
          const metadata = origin?.metadata as { source?: unknown; feishuChatId?: unknown; feishuSenderOpenId?: unknown } | undefined
          if (!origin || metadata?.source !== 'feishu' || metadata.feishuChatId !== msg.chatId || metadata.feishuSenderOpenId !== msg.senderOpenId) {
            const resolved = await resolveSession()
            sessionId = resolved.sessionId
            isNew = resolved.isNew
            await sendCommandReply('这项任务原来的会话已不可用。为避免丢失上下文，本次没有执行，请重新发送完整指令。', sessionId)
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
        const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
        if (!re.ok) {
          await failAuth(re.reason)
          return
        }
      }
      logFeishuCliEvent('info', 'feishu.session.resolved', {
        sessionId, isNew, chatId: msg.chatId, mergeWindowMs: readRemoteSessionIdleMinutes(config) * 60_000
      })

      const claim = replay ? null : tryClaimOrRelease(sessionId, requestId, appCfg.maxParallelChatSessions)
      if (claim && !claim.ok) {
        if (claim.reason === 'session_busy' && this.deps.wakeEventDispatcher) {
          if (!this.persistInboundWake(sessionId, msg, content, trackContext)) {
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
          if (isNew || config.remoteNotifyOnReceive) {
            await sendCommandReply('已收到，正在处理…', sessionId)
          }
          void this.deps.wakeEventDispatcher.dispatchSession(sessionId).catch((error) => {
            logFeishuCliEvent('error', 'feishu.inbound.dispatch_failed', {
              sessionId, message: error instanceof Error ? error.message : String(error)
            })
          })
          return
        }
        if (claim.reason === 'session_busy') {
          logFeishuCliEvent('warn', 'feishu.inbound.session_busy', { sessionId })
        } else {
          logFeishuCliEvent('warn', 'feishu.inbound.parallel_full', {
            maxParallel: appCfg.maxParallelChatSessions
          })
        }
        await sendCommandReply(claim.message, sessionId)
        await claimFinalizer.complete(claim.reason)
        return
      }

      try {
        if (profile) {
          const bindResult = this.deps.sessionStorage
            ? await bindSessionWorkDir(this.deps.sessionStorage.queries, this.deps.sessionStorage.commands, this.deps.workDirManager, {
            sessionId,
            profileId: profile.id,
            remoteContext: {
              source: 'feishu',
              messageId: msg.messageId,
            },
            source: 'inbound',
            appendAudit: (profileId, profileName) =>
              this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName })
            })
            : { success: false, error: '会话存储查询不可用' }
          {
            const re = revalidateImInboundGuard(authSnapshot, { getConfig: getGuardConfig })
            if (!re.ok) {
              await failAuth(re.reason)
              return
            }
          }
          if (!bindResult.success) {
            await sendCommandReply(bindResult.error ?? SENSITIVE_WORKDIR_ERROR, sessionId)
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

        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, sessionId)

        if (this.deps.wakeEventDispatcher && !replay) {
          if (!this.persistInboundWake(sessionId, msg, content, trackContext)) {
            await claimFinalizer.complete('persistence_failed')
            return
          }
          this.deps.getMainWebContents()?.send('feishu:inbound-message', { sessionId, message: msg })
          if (processedClaimId) {
            const executing = await this.deps.processedStore.markExecuting(msg.messageId, processedClaimId)
            if (!executing) {
              await claimFinalizer.complete('processed_claim_lost')
              return
            }
          }
          await claimFinalizer.complete('durably_accepted')
          if (isNew || config.remoteNotifyOnReceive) {
            await sendCommandReply('已收到，正在处理…', sessionId)
          }
          try {
            claim?.release()
            void this.deps.wakeEventDispatcher.dispatchSession(sessionId).catch((error) => {
              logFeishuCliEvent('error', 'feishu.inbound.dispatch_failed', {
                sessionId,
                message: error instanceof Error ? error.message : String(error)
              })
            })
          } catch (error) {
            logFeishuCliEvent('error', 'feishu.inbound.dispatch_failed', {
              sessionId,
              message: error instanceof Error ? error.message : String(error)
            })
          }
          return
        }

        if (isNew || config.remoteNotifyOnReceive) {
          await sendCommandReply('已收到，正在处理…', sessionId)
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

        const executionConfig = await resolveTrustedTurnExecutionConfig(this.deps.db, this.deps.sessionStorage!.queries, this.deps.sessionStorage!.commands, sessionId, 'feishu')
        const prepared = this.deps.turnRuntime?.prepare({
          ...(replay
            ? { mode: 'reuse-user' as const, requestId, sessionId, userMessageId: replay.userMessageId, excludeMessageIds: [], config: executionConfig }
            : { mode: 'create-user' as const, requestId, sessionId, input: { text: content }, config: executionConfig })
        })
        if (!prepared) throw new Error('REMOTE_TURN_PREPARE_REQUIRED')
        if (!bindRemoteSessionExecutionId(sessionId, requestId, prepared.turnId)) {
          throw new Error('REMOTE_SESSION_LEASE_LOST')
        }
        let trackModelInputView: TrackModelInputViewRef | undefined
        if (trackContext) {
          if (!prepared.userMessage) throw new Error('FEISHU_TRACK_ACCEPTED_USER_MESSAGE_MISSING')
          bindRemoteTrackToTurn(this.deps.db, { trackId: trackContext.trackId, turnId: prepared.turnId, sessionId,
            channel: trackContext.channel, identityKey: trackContext.identityKey, ownerId: trackContext.ownerId,
            authorizationEpoch: trackContext.authorizationEpoch, eventId: remoteTrackTurnBindingEventId(trackContext.trackId, prepared.turnId), occurredAt: Date.now() })
          recordTrackModelMessage(this.deps.db, { trackId: trackContext.trackId, eventId: `track-model:${prepared.turnId}:${prepared.userMessage.id}`,
            idempotencyKey: `track-model:${prepared.turnId}:${prepared.userMessage.id}`, sessionId, messageId: prepared.userMessage.id,
            invocationId: prepared.turnId, occurredAt: Date.now(), parentEventId: trackContext.attributionEventId })
          trackModelInputView = buildTrackModelInputViewRef(this.deps.db, { ...trackContext, sessionId,
            acceptedUserMessageId: prepared.userMessage.id, currentInvocationId: prepared.turnId })
          if (trackModelInputView.completeness !== 'complete') throw new Error('FEISHU_TRACK_MODEL_INPUT_VIEW_UNAVAILABLE')
        }

        const remoteContext = {
          source: 'feishu' as const,
          messageId: msg.messageId,
          feishuConfig: config,
          feishuAttachments: registerInboundFeishuAttachments(msg),
          imChannel: this.deps.imChannel,
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
          turnId: prepared?.turnId ?? requestId,
          ...(trackContext ? { trackContext, trackModelInputView } : {}),
          appendWorkDirSwitchAudit: (profileId: string, profileName: string) =>
            this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
          appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) =>
            this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
        }

        let result: Awaited<ReturnType<typeof runFeishuRemoteAgent>>
        const acceptedTurn = prepared
          ? createAcceptedTurnFromPrepared(prepared, 'feishu', executionConfig ?? { lane: 'feishu' }, this.deps.sessionStorage!.execution)
          : undefined
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
            run: () => runFeishuRemoteAgent({
            db: this.deps.db,
            sessionStorage: this.deps.sessionStorage!,
            sessionId,
            userMessage: content,
            replyMessageId: msg.messageId,
            requestId,
            turnId: prepared?.turnId,
            acceptedTurn,
            feishuConfig: config,
            workDir,
            workDirManager: this.deps.workDirManager,
            runner: this.deps.runner,
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
            emitFactEvent: this.deps.turnRuntime && prepared ? (event) => {
              if (event.type === 'source-completed' || event.type === 'source-failed' || event.type === 'source-cancelled' || event.type === 'source-timeout') return
              this.deps.turnRuntime!.consumeForRequest(requestId, event, prepared!.turnId)
            } : undefined
            })
          })
        } catch (e) {
          result = {
            summary: '执行未完成，当前结果无法确认。请先不要直接重复操作；可以在此聊天说明要核对的内容。',
            pendingConfirm: false,
            ok: false
          }
        }

        await claimFinalizer.complete(result.ok ? 'ok' : 'failed')

        // Completion and tool state are owned by TurnRuntime; only IM continuation follows
        // `outboundSessionId`, which may have moved via switch_session.
        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, outboundSessionId)

        const outboundFacts = createHostImOutboundFacts({ channel: 'feishu', purpose: 'system-reply', body: result.summary,
          sessionId: outboundSessionId, identityKey: msg.chatId, ownerId: authSnapshot.owner,
          recipient: msg.senderOpenId, chatType: msg.chatType === 'p2p' ? 'p2p' : msg.chatType === 'group' ? 'group' : 'unknown',
          destinationId: msg.messageId })
        await sendFeishuRemoteOutboundRaw({
          runner: this.deps.runner,
          messageId: msg.messageId,
          body: result.summary,
          sessionId: outboundSessionId,
          recipient: msg.senderOpenId,
          outboundIdentity: { identityKey: msg.chatId, ownerId: authSnapshot.owner,
            chatType: msg.chatType === 'p2p' ? 'p2p' : msg.chatType === 'group' ? 'group' : 'unknown' },
          outboundDeliveryFacts: outboundFacts,
          touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: outboundSessionId }
        })
        this.lastReplyAt = Date.now()
        clearRemoteProgressSession(sessionId)
        await this.deps.auditLogger.append({
          type: 'agent_done',
          sessionId,
          success: result.ok && !result.pendingConfirm,
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
        claim?.release()
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
