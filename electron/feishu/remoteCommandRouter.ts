import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import { CURRENT_SCHEMA_VERSION } from '../../src/shared/domainTypes'
import type { FeishuConfig, FeishuInboundMessage, WorkDirProfile } from '../../src/shared/feishuTypes'
import { mergeFeishuConfig } from '../../src/shared/feishuTypes'
import { readRemoteSessionIdleMinutes } from '../../src/shared/remoteSessionResolve'
import type { ToolsConfig } from '../../src/shared/domainTypes'
import type { FeishuAuditLogger } from './feishuAuditLogger'
import { FeishuImChannel } from './feishuImChannel'
import { shouldAcceptInbound } from './feishuInboundParser'
import { registerInboundFeishuAttachments } from './feishuAttachmentRegistry'
import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'
import { clearRemoteProgressSession } from '../remote/remoteProgressStore'
import { auditEntryToLoggerPayload } from '../remote/remoteSessionSwitchAudit'
import type { SessionSwitchAuditEntry } from '../remote/remoteSessionSwitchAudit'
import { resolveRemoteOutboundSessionId } from '../remote/remoteSessionSwitchFollow'
import type { TurnRuntime } from '../turnRuntime'
import type { SessionStorage } from '../sessionStorage/contracts'
import { resolveFeishuSession } from './feishuSessionResolver'
import { tryClaimOrRelease, createProcessedClaimFinalizer } from '../remote/imCommandRouterHelpers'
import { bindRemoteSessionExecutionId, tryClaimRemoteSession, releaseRemoteSession, isRequestLeaseOwner, getRemoteAgentLease } from '../remote/remoteAgentRegistry'
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
import { FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE } from '../remote/remoteConfirmPolicy'
import { executeRemoteTurn } from '../remote/turnExecutionAdapter'
import { resolveTrustedTurnExecutionConfig } from '../turnExecutionConfig'
import { createAcceptedTurnFromPrepared } from '../runtime/acceptedTurnContext'
import {
  maskOpenId,
  parseFeishuBindProtocol,
  readOwnerOpenIdFromAllowlist,
  type FeishuOwnerBindController
} from './feishuOwnerBind'
import { CLAIM_LEASE_MS } from '../remote/imProcessedStore'
import { ackImInboxMessage, appendImInboxMessageWithWakeEvent, claimImInboxMessage, getImInboxMessageContext, listImInboxMessages } from '../database/imInbox'
import { getSession, getTurnByRequestId } from '../database'
import type { WakeEventLoopInput } from '../remote/wakeEventDispatcher'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { isDeferredApprovalReplyCandidate } from '../remote/deferredApprovalIngress'
import type { WakeEventDispatcher } from '../remote/wakeEventDispatcher'
import { readDeferredCompletionWake, markDeferredCompletionWakeDelivered } from '../remote/deferredCompletionWake'
import type { ImTaskSafetyPort } from '../remote/imTaskControlCoordinator'

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
  createDeferredConfirmationAdapter?: (remoteContext: import('../tools/types').RemoteContext) => NonNullable<Parameters<typeof runFeishuRemoteAgent>[0]['confirmationAdapter']>
  taskControlSafetyPort?: ImTaskSafetyPort
}

export class RemoteCommandRouter {
  private lastInboundAt?: number
  private lastReplyAt?: number
  private pendingDisambiguation = new Map<string, PendingDisambiguation>()

  constructor(private deps: RemoteCommandRouterDeps) {}

  async dispatchWakeEventSet(input: WakeEventLoopInput): Promise<void> {
    if (!this.deps.sessionStorage) throw new Error('REMOTE_SESSION_STORAGE_REQUIRED')
    const session = getSession(this.deps.db, input.sessionId)
    const metadata = session?.metadata as { source?: unknown; feishuChatId?: unknown; feishuSenderOpenId?: unknown } | undefined
    if (!session || metadata?.source !== 'feishu' ||
      typeof metadata.feishuChatId !== 'string' || typeof metadata.feishuSenderOpenId !== 'string') {
      throw new Error('FEISHU_WAKE_SESSION_IDENTITY_INVALID')
    }
    const config = mergeFeishuConfig(this.deps.getFeishuConfig())
    const guard = evaluateImInboundGuard({ channel: 'feishu', senderId: metadata.feishuSenderOpenId, getConfig: () => config })
    if (!guard.ok) throw new Error(`FEISHU_WAKE_AUTH_REJECTED:${guard.reason}`)
    const assertAuthorized = () => {
      const revalidated = revalidateImInboundGuard(guard.snapshot, { getConfig: () => mergeFeishuConfig(this.deps.getFeishuConfig()) })
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
        const requestId = `completion:${event.eventId}`
        const prior = getTurnByRequestId(this.deps.db, input.sessionId, requestId)
        if (prior && prior.state !== 'terminal') throw new Error('FEISHU_COMPLETION_WAKE_PRIOR_TURN_INCOMPLETE')
        if (!prior) {
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
        if (!markDeferredCompletionWakeDelivered(this.deps.db, event.payloadRef.approvalId)) throw new Error('FEISHU_COMPLETION_RESULT_ACK_FAILED')
        continue
      }
      if (event.type !== 'im-inbound' || event.payloadRef.kind !== 'im-inbox-message') throw new Error('FEISHU_WAKE_EVENT_UNSUPPORTED')
      if (event.sessionId !== input.sessionId) throw new Error('FEISHU_WAKE_SESSION_MISMATCH')
      const messageId = event.payloadRef.messageId
      const queued = listImInboxMessages(this.deps.db, { queueScope: scope, limit: 100 }).find((item) => item.messageId === messageId)
      if (!queued) throw new Error('FEISHU_WAKE_INBOX_MESSAGE_MISSING')
      const channelContext = getImInboxMessageContext(this.deps.db, messageId)
      if (!channelContext || channelContext.channel !== 'feishu') throw new Error('FEISHU_WAKE_PLATFORM_CONTEXT_MISSING')
      const lease = claimImInboxMessage(this.deps.db, { queueScope: scope, messageId: queued.messageId, ownerId: input.ownerId })
      if (!lease) throw new Error('FEISHU_WAKE_INBOX_CLAIM_FAILED')
      const requestId = `wake:${event.eventId}`
      const priorTurn = getTurnByRequestId(this.deps.db, session.id, requestId)
      if (priorTurn) {
        if (priorTurn.state !== 'terminal' || priorTurn.outcome !== 'completed') throw new Error('FEISHU_WAKE_PRIOR_TURN_INCOMPLETE')
        if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId: queued.messageId, ownerId: input.ownerId })) throw new Error('FEISHU_WAKE_INBOX_ACK_FAILED')
        continue
      }

      const currentLease = getRemoteAgentLease(session.id)
      const alreadyHeldByDispatcher = currentLease?.requestId === input.runId
      const sessionLease = alreadyHeldByDispatcher ? 'ok' : tryClaimRemoteSession(session.id, requestId, this.deps.getAppConfig().maxParallelChatSessions)
      if (sessionLease !== 'ok') throw new Error(`FEISHU_WAKE_SESSION_LEASE_FAILED:${sessionLease}`)
      const executionLeaseRequestId = alreadyHeldByDispatcher ? input.runId : requestId
      if (!alreadyHeldByDispatcher) bindRemoteSessionExecutionId(session.id, requestId, requestId)

      const authSnapshot = guard.snapshot
      const profile = this.deps.workDirManager.listProfiles().find((item) => item.id === session.workDirProfileId) ?? null
      try {
        await this.executePersistedInboundTurn({ sessionId: session.id, requestId, userMessageId: queued.messageId,
          content: queued.content, messageId: channelContext.platformMessageId, chatId: metadata.feishuChatId,
          senderId: metadata.feishuSenderOpenId, config, profile, authSnapshot, leaseRequestId: executionLeaseRequestId, assertAuthorized })
        if (!ackImInboxMessage(this.deps.db, { queueScope: scope, messageId: queued.messageId, ownerId: input.ownerId })) throw new Error('FEISHU_WAKE_INBOX_ACK_FAILED')
      } finally {
        if (!alreadyHeldByDispatcher) releaseRemoteSession(session.id, requestId)
      }
    }
  }

  private async executePersistedInboundTurn(input: {
    sessionId: string; requestId: string; userMessageId: string; content: string; messageId: string
    chatId: string; senderId: string; config: FeishuConfig; profile: WorkDirProfile | null; authSnapshot: ImAuthSnapshot; leaseRequestId: string; assertAuthorized: () => void
    deferredContinuation?: import('../tools/types').RemoteContext['deferredContinuation']
  }): Promise<void> {
    const executionConfig = await resolveTrustedTurnExecutionConfig(this.deps.db, this.deps.sessionStorage!.queries, this.deps.sessionStorage!.commands, input.sessionId, 'feishu')
    input.assertAuthorized()
    const queueScope = buildImQueueScope('feishu', input.sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
    const prepared = this.deps.turnRuntime?.prepare({ mode: 'reuse-user', requestId: input.requestId, sessionId: input.sessionId,
      userMessageId: input.userMessageId, excludeMessageIds: [], config: executionConfig, queueScope })
    if (!prepared) throw new Error('REMOTE_TURN_PREPARE_REQUIRED')
    if (!bindRemoteSessionExecutionId(input.sessionId, input.leaseRequestId, prepared.turnId)) throw new Error('REMOTE_SESSION_LEASE_LOST')
    const remoteContext = {
      source: 'feishu' as const, messageId: input.messageId, confirmPolicy: input.config.remoteConfirmPolicy,
      feishuConfig: input.config, feishuAttachments: [], imChannel: this.deps.imChannel,
      confirmTimeoutMessage: FEISHU_REMOTE_CONFIRM_TIMEOUT_MESSAGE, larkCliRunner: this.deps.runner,
      chatId: input.chatId, userId: input.authSnapshot.owner, authOwner: input.authSnapshot.owner,
      originSessionId: input.sessionId, outboundSessionId: input.sessionId,
      workDirProfileId: input.profile?.id ?? this.deps.workDirManager.getActiveProfileId(),
      ...(input.deferredContinuation ? { deferredContinuation: input.deferredContinuation } : {}),
      authorizationGeneration: input.authSnapshot.authorizationGeneration, requestId: input.requestId, turnId: prepared.turnId,
      appendWorkDirSwitchAudit: (profileId: string, profileName: string) => this.deps.auditLogger.append({ type: 'workdir_switch', profileId, profileName }),
      appendSessionSwitchAudit: (entry: SessionSwitchAuditEntry) => this.deps.auditLogger.append(auditEntryToLoggerPayload(entry))
    }
    const acceptedTurn = createAcceptedTurnFromPrepared(prepared, 'feishu', executionConfig ?? { lane: 'feishu' }, this.deps.sessionStorage!.execution)
    const result = await executeRemoteTurn({ runtime: this.deps.turnRuntime, prepared, requestId: input.requestId,
      run: () => { input.assertAuthorized(); return runFeishuRemoteAgent({ db: this.deps.db, sessionStorage: this.deps.sessionStorage!, sessionId: input.sessionId,
        userMessage: input.content, replyMessageId: input.messageId, requestId: input.requestId, turnId: prepared.turnId,
        acceptedTurn, llmServiceId: executionConfig?.llmServiceId, feishuConfig: input.config,
        workDir: input.profile?.path ?? this.deps.getWorkDir(), workDirManager: this.deps.workDirManager,
        getApiKey: this.deps.getApiKey, getBaseUrl: this.deps.getBaseUrl, getModel: this.deps.getModel,
        runner: this.deps.runner, imChannel: this.deps.imChannel, getToolsConfig: this.deps.getToolsConfig,
        getBrowserConfig: this.deps.getBrowserConfig, getWikiConfig: this.deps.getWikiConfig, getShellConfig: this.deps.getShellConfig,
        userDataDir: this.deps.getUserDataPath(), remoteContext,
        confirmationAdapter: this.deps.createDeferredConfirmationAdapter?.(remoteContext),
        taskControlSafetyPort: this.deps.taskControlSafetyPort,
        emitFactEvent: (event) => { if (!['source-completed', 'source-failed', 'source-cancelled', 'source-timeout'].includes(event.type)) this.deps.turnRuntime!.consumeForRequest(input.requestId, event, prepared.turnId) }
      }) }
    })
    if (!result.ok) throw new Error(`FEISHU_WAKE_TURN_FAILED:${result.summary}`)
    if (getTurnByRequestId(this.deps.db, input.sessionId, input.requestId)?.outcome !== 'completed') throw new Error('FEISHU_WAKE_TURN_NOT_DURABLY_COMPLETED')
    await sendFeishuRemoteOutbound({ runner: this.deps.runner, messageId: input.messageId, body: result.summary,
      sessionId: input.sessionId, touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId: input.sessionId } })
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

  private persistInboundWake(sessionId: string, message: FeishuInboundMessage, content: string): boolean {
    try {
      const queueScope = buildImQueueScope('feishu', sessionId) as Extract<ReturnType<typeof buildImQueueScope>, { kind: 'im' }>
      appendImInboxMessageWithWakeEvent(this.deps.db, {
        sessionId, channel: 'feishu', queueScope, channelMessageId: message.messageId, content
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
      const resolved = replay ? { sessionId: replay.sessionId, isNew: false } : await resolveFeishuSession(
        this.deps.sessionStorage!,
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
      const sessionId = resolved.sessionId
      const isNew = resolved.isNew
      const requestId = replay?.requestId ?? randomUUID()
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
          touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
        })
        await claimFinalizer.complete('sensitive_blocked')
        return
      }

      const claim = replay ? null : tryClaimOrRelease(sessionId, requestId, appCfg.maxParallelChatSessions)
      if (claim && !claim.ok) {
        if (claim.reason === 'session_busy' && this.deps.wakeEventDispatcher) {
          if (!this.persistInboundWake(sessionId, msg, content)) {
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
            await sendFeishuRemoteOutbound({
              runner: this.deps.runner, messageId: msg.messageId, body: '已收到，正在处理…', sessionId,
              touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
            })
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
        await sendFeishuRemoteOutbound({
          runner: this.deps.runner,
          messageId: msg.messageId,
          body: claim.message,
          sessionId,
          touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
        })
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
              confirmPolicy: config.remoteConfirmPolicy
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
            await sendFeishuRemoteOutbound({
              runner: this.deps.runner,
              messageId: msg.messageId,
              body: bindResult.error ?? SENSITIVE_WORKDIR_ERROR,
              sessionId,
              touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
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

        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, sessionId)

        if (this.deps.wakeEventDispatcher && !replay) {
          if (!this.persistInboundWake(sessionId, msg, content)) {
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
            await sendFeishuRemoteOutbound({
              runner: this.deps.runner,
              messageId: msg.messageId,
              body: '已收到，正在处理…',
              sessionId,
              touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
            })
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
          await sendFeishuRemoteOutbound({
            runner: this.deps.runner,
            messageId: msg.messageId,
            body: '已收到，正在处理…',
            sessionId,
            touch: { sessionCommands: this.deps.sessionStorage!.commands, sessionId }
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
        const assistantMessageId = prepared.assistantMessage.id

        const remoteContext = {
          source: 'feishu' as const,
          messageId: msg.messageId,
          confirmPolicy: config.remoteConfirmPolicy,
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
            run: () => runFeishuRemoteAgent({
            db: this.deps.db,
            sessionStorage: this.deps.sessionStorage!,
            sessionId,
            userMessage: content,
            replyMessageId: msg.messageId,
            requestId,
            turnId: prepared?.turnId,
            acceptedTurn,
            llmServiceId: executionConfig?.llmServiceId,
            feishuConfig: config,
            workDir,
            workDirManager: this.deps.workDirManager,
            getApiKey: this.deps.getApiKey,
            getBaseUrl: this.deps.getBaseUrl,
            getModel: this.deps.getModel,
            runner: this.deps.runner,
            imChannel: this.deps.imChannel,
            getToolsConfig: this.deps.getToolsConfig,
            getBrowserConfig: this.deps.getBrowserConfig,
            getWikiConfig: this.deps.getWikiConfig,
            getShellConfig: this.deps.getShellConfig,
            userDataDir: this.deps.getUserDataPath(),
            remoteContext,
            confirmationAdapter: this.deps.createDeferredConfirmationAdapter?.(remoteContext),
            taskControlSafetyPort: this.deps.taskControlSafetyPort,
            emitFactEvent: this.deps.turnRuntime && prepared ? (event) => {
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

        // Completion and tool state are owned by TurnRuntime; only IM continuation follows
        // `outboundSessionId`, which may have moved via switch_session.
        const outboundSessionId = resolveRemoteOutboundSessionId(remoteContext, sessionId)
        touchRemoteSessionActivity(this.deps.sessionStorage!.commands, outboundSessionId)

        await sendFeishuRemoteOutbound({
          runner: this.deps.runner,
          messageId: msg.messageId,
          body: result.summary,
          sessionId: outboundSessionId,
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
