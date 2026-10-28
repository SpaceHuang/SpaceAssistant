import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { prepareChatBodiesForSessions, readChatMessageAfterPreparation, readChatMessagesAfterPreparation } from '../sessionStorage/public/readMessages'
import { getConfigValue } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { assembleInvocation, type AgentInvocationMaterials } from '../runtime/invocationAssembler'
import { buildResolveWorkDirCallback, resolveWorkDirForSession, type WorkDirManager } from '../workDirManager'
import { SENSITIVE_WORKDIR_ERROR } from '../workDirBinding'
import type { BrowserConfig, ShellConfig, ToolsConfig, WikiConfig } from '../../src/shared/domainTypes'
import type { ModelEntry } from '../../src/shared/domainTypes'
import { resolveModelContextWindow } from '../../src/shared/llmModelConfig'
import { buildClaudeToolChatMessages, trimClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import { MAX_CHAT_API_MESSAGES } from '../../src/shared/chatApiMessageLimits'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import type { RemoteContext } from '../tools/types'
import { getCallAdmissionGate } from '../runtime/callAdmissionGate'
import { readAppLocale } from '../appIpc'
import { resolveLlmCredentialsForPair } from '../llmServiceResolver'
import { logHistoryOversizedToolResult } from '../oversizedToolResultLog'
import {
  startRemoteProgressSession,
  stopRemoteProgressSession,
  type RemoteProgressAdapter
} from './remoteProgressCoordinator'
import { clearRemoteProgressSession } from './remoteProgressStore'
import type { RemoteProgressConfig } from '../../src/shared/remoteProgressTypes'
import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import {
  resolveFeishuBrowserRemoteHint,
  type FeishuBrowserRemoteHint
} from '../../src/shared/browserRemotePolicy'
import { resolveRemoteOutboundSessionId } from './remoteSessionSwitchFollow'
import { requireInvocationAnthropicRoute } from '../runtime/invocationProviderRoute'
import { createHostedTurnHandoff } from '../runtime/hostedTurnHandoff'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { getSessionEventSink } from '../sessionEvents'
import { HostedTurnFinalizedError, hostedTerminalSessionEventReason } from '../runtime/hostedTurnFinalization'
import { buildRemoteProgressHookContext } from './buildRemoteProgressContext'
import { onRemoteTextSegmentClosed } from './remoteProgressHooks'
import type { AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { SessionStorage } from '../sessionStorage/host/ports'
import { createImOrchestrationToolRegistry } from './imOrchestrationTools'
import { ensureImTurnTaskControl, getTaskControlRecord } from '../database/taskControl'
import { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredTodoTaskControlSafetyPort } from './deferredTodoTaskControlAdapter'
import type { ImTaskSafetyPort } from './imTaskControlCoordinator'
import { appendConfirmationFailureProjection, projectConfirmationSendFailures, type ConfirmationFailureProjection } from './confirmationFailureReceipt'
import { filterTrackModelInputMessages } from './trackModelInputView'
import { createCrossSessionTrackScopedHistoryPort } from './trackScopedHistoryPort'
import { buildTrackModelInputViewRef } from './trackModelInputViewStore'
import { bindRemoteTrackToTurn, readRemoteTrackSourceChildren, remoteTrackTurnBindingEventId, requestRemoteTrackTerminal } from '../database/remoteTrackStore'
import { recordTrackModelMessage } from './trackModelInputViewStore'
import { readRemoteTrackFeatureGates } from './remoteTrackFeatureGates'
import { recordRemoteTrackRuntimeDiagnostic } from '../database/remoteTrackRuntimeDiagnosticStore'
import { readImPromptPolicySnapshot } from './imPromptPolicySnapshot'
import { estimateTokensFromUtf8Text } from '../../src/shared/contextUsageEstimate'

export function extractTextFromContent(content: unknown[]): string {
  let s = ''
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s.trim()
}

async function readConfirmationFailureProjection(storage: SessionStorage, sessionId: string, invocationId: string): Promise<ConfirmationFailureProjection | undefined> {
  try {
    const history = await storage.execution.historyFor({ sessionId }).read(invocationId)
    return projectConfirmationSendFailures(history.events)
  } catch {
    return undefined
  }
}

export type ImRemoteAgentResult = { summary: string; pendingConfirm: boolean; ok: boolean; parked?: true; outcome?: 'cancelled' | 'timed-out' }

export function trackTerminalTargetFromAgentResult(result: { ok: boolean; outcome?: string }): 'completed' | 'cancelled' | 'failed' {
  if (result.outcome === 'cancelled') return 'cancelled'
  return result.ok ? 'completed' : 'failed'
}

export async function runImRemoteAgent(args: {
  /** B1(偏差 23):准入门注入(测试);缺省全局默认门。 */
  admissionGate?: import('../runtime/callAdmissionGate').CallAdmissionGate
  db: AppDatabase
  sessionStorage?: SessionStorage
  sessionId: string
  requestId: string
  /** 本回合真实 Turn ID（C17）：由 router 的 prepared.turnId 下传，供用量统计落库。 */
  turnId?: string
  acceptedTurn?: AcceptedTurn
  workDir: string
  workDirManager: WorkDirManager
  userDataDir: string
  remoteContext: RemoteContext
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getWikiConfig?: () => WikiConfig
  getShellConfig?: () => ShellConfig
  createProgressAdapter: (getSessionId: () => string) => RemoteProgressAdapter
  buildSystemAppendix: (args: {
    browserRemoteHint?: FeishuBrowserRemoteHint
    policySnapshot?: import('../../src/shared/policy/policyPromptContext').ImPolicyPromptSnapshot
  }) => string
  progressDefaults: Required<RemoteProgressConfig>
  progressConfig: RemoteProgressConfig
  toolChatExtras?: Pick<AgentInvocationMaterials, 'feishuConfig' | 'wechatConfig' | 'larkCliRunner' | 'resolveAgentSdkGateSupplement'>
  onFinally?: () => void
  /** WeChat historically rethrows as `new Error(message)`. */
  rethrowAsError?: boolean
  logSensitiveBlocked?: () => void
  logDone?: (result: ImRemoteAgentResult & { error?: string }) => void
  logError?: (error: string) => void
  emitFactEvent?: (event: AssistantFactEvent) => void
  confirmationAdapter?: NonNullable<Parameters<typeof createHostedTurnHandoff>[0]['confirmationAdapter']>
  taskControlSafetyPort?: ImTaskSafetyPort
}): Promise<ImRemoteAgentResult> {
  const requestId = args.requestId
  const injectedStorage = args.sessionStorage
  if (!injectedStorage) return { summary: '会话存储不可用。', pendingConfirm: false, ok: false }
  const storage: SessionStorage = injectedStorage
  const remoteTrackChannel = args.remoteContext.source === 'wechat' || args.remoteContext.source === 'feishu'
    ? args.remoteContext.source : undefined
  if (!args.remoteContext.trackContext && remoteTrackChannel && readRemoteTrackFeatureGates(args.db, remoteTrackChannel).execution) {
    try { recordRemoteTrackRuntimeDiagnostic(args.db, { channel: args.remoteContext.source, platformMessageId: args.remoteContext.messageId,
      eventKind: 'untracked-runtime-invocation', reasonCode: 'track-context-missing', occurredAt: Date.now() }) } catch { /* preserve fail-closed runtime error */ }
    throw new Error('TRACK_CONTEXT_REQUIRED')
  }
  const settleTrack = (turnId: string | undefined, target: 'completed' | 'cancelled' | 'failed') => {
    const track = args.remoteContext.trackContext
    if (!track) return
    if (!turnId) throw new Error('TRACK_TERMINAL_TURN_ID_REQUIRED')
    const turn = storage.queries.readTurnById({ turnId })
    if (!turn || turn.trackId !== track.trackId) throw new Error('TRACK_TERMINAL_TURN_BINDING_MISSING')
    const assistant = storage.queries.readMessageSkeleton({ sessionId: turn.sessionId, messageId: turn.assistantMessageId })
    if (assistant?.role === 'assistant') {
      recordTrackModelMessage(args.db, { trackId: track.trackId, eventId: `track-model:${turnId}:${assistant.id}`,
        idempotencyKey: `track-model:${turnId}:${assistant.id}`, sessionId: turn.sessionId, messageId: assistant.id,
        invocationId: turnId, occurredAt: Date.now(), parentEventId: track.attributionEventId }, storage.queries)
    }
    requestRemoteTrackTerminal(args.db, {
      trackId: track.trackId,
      target,
      eventId: `track:${track.trackId}:turn:${turnId}:terminal:${target}`,
      occurredAt: Date.now(),
      readSourceChildren: (conn, trackId) => readRemoteTrackSourceChildren(conn, trackId, (requestedTrackId) =>
        args.remoteContext.imChannel?.listPendingTrackConfirmations(requestedTrackId) ?? null)
    })
  }

  // B1(偏差 23):调用级准入——远端发起入口(四处之一)。票据覆盖整回合,拒绝即答复「资源忙」。
  const admissionGate = args.admissionGate ?? getCallAdmissionGate()
  const admission = await admissionGate.acquire({
    lane: args.remoteContext.source,
    priority: 'interactive',
    role: 'top-level',
    disposition: 'reject',
    requestId,
    turnId: args.turnId ?? requestId
  })
  if (!admission.ok) {
    return {
      summary: admission.verdict === 'rejected' ? '当前调用并发已达上限，请稍后再试。' : '当前调用已被限流，请稍后再试。',
      pendingConfirm: false,
      ok: false
    }
  }


  try {
    const getOutboundSessionId = () => resolveRemoteOutboundSessionId(args.remoteContext, args.sessionId)
    const adapter = args.createProgressAdapter(getOutboundSessionId)
    // P2(评审):progress session 启动在票据持有窗口内——挪进 try,同步抛出也走 release
    startRemoteProgressSession(args.sessionId, adapter, args.progressConfig, args.progressDefaults)
    return await runAdmittedTurn()
  } finally {
    admission.ticket.release()
  }

  async function runAdmittedTurn(): Promise<ImRemoteAgentResult> {
  let sessionEventReason = 'failed'
  let sessionEventError: string | undefined
  let sessionEventStarted = false
  let turnIdForEvents = args.turnId ?? requestId
  let confirmationFailureProjection: ConfirmationFailureProjection | undefined
  let sessionEventLocation: { workDir: string; sessionId: string; createdAt: number } | undefined
  let sessionEventSink: ReturnType<typeof getSessionEventSink> | undefined
  try {
    const resolved = resolveWorkDirForSession(
      storage.queries,
      args.sessionId,
      () => args.workDirManager.listProfiles(),
      () => args.workDirManager.getActiveProfileId(),
      () => args.workDirManager.getActiveWorkDir()
    )
    if (resolved?.isSensitive) {
      args.logSensitiveBlocked?.()
      return { summary: SENSITIVE_WORKDIR_ERROR, pendingConfirm: false, ok: false }
    }

    const persistedSession = storage.queries.readSession(args.sessionId)
    sessionEventLocation = persistedSession && resolved?.workDir
      ? { workDir: resolved.workDir, sessionId: args.sessionId, createdAt: persistedSession.createdAt }
      : undefined
    let ledgerReady = true
    if (sessionEventLocation && storage.ensureLedgerReady) {
      try { ledgerReady = await storage.ensureLedgerReady(args.sessionId) }
      catch (error) {
        ledgerReady = false
        try { args.logError?.(`session ledger readiness unavailable: ${error instanceof Error ? error.message : String(error)}`) }
        catch { /* diagnostics must not block the accepted turn */ }
      }
    }
    sessionEventSink = sessionEventLocation && ledgerReady
      ? getSessionEventSink(sessionEventLocation.workDir, sessionEventLocation.sessionId, sessionEventLocation.createdAt)
      : undefined
    if (sessionEventSink) {
      await sessionEventSink.appendCritical({ type: 'turn_start', payload: { turnId: turnIdForEvents } })
      await sessionEventSink.appendCritical({ type: 'step_start', payload: { turnId: turnIdForEvents, stepId: requestId } })
      sessionEventStarted = true
    }

    const toolsConfig = args.getToolsConfig()
    let rawMessages: import('../../src/shared/domainTypes').Message[]
    let acceptedUserMessageId: string | undefined
    if (args.turnId) {
      const persisted = storage.execution.readTurn({ sessionId: args.sessionId, turnId: args.turnId })
      if (!persisted || persisted.sessionId !== args.sessionId || persisted.requestId !== requestId) {
        throw new Error('TURN_EXECUTION_CREDENTIALS_INVALID')
      }
      if (persisted.state === 'configuring') throw new Error('TURN_EXECUTION_CONFIGURING')
      rawMessages = await storage.execution.loadAcceptedMessagesAsync({ sessionId: args.sessionId, turnId: args.turnId })
      acceptedUserMessageId = persisted.userMessageId
    } else {
      rawMessages = await readChatMessagesAfterPreparation(storage, { sessionId: args.sessionId })
    }
    let historyForSession = (sessionId: string) => storage.execution.historyFor({ sessionId })
    if (args.remoteContext.trackContext) {
      const track = args.remoteContext.trackContext
      const view = args.remoteContext.trackModelInputView
      if (!view) throw new Error('TRACK_MODEL_INPUT_VIEW_REQUIRED')
      if (track.trackId !== view.trackId || view.sessionId !== args.sessionId) throw new Error('TRACK_MODEL_INPUT_SCOPE_MISMATCH')
      const identityKey = args.remoteContext.source === 'wechat' ? args.remoteContext.userId : args.remoteContext.chatId
      const durableEpoch = getDbConnection(args.db).prepare('SELECT epoch FROM remote_authorization_epochs WHERE channel=?')
        .get(track.channel) as { epoch: number } | undefined
      if (track.channel !== args.remoteContext.source || !identityKey || track.identityKey !== identityKey ||
        !args.remoteContext.authOwner || track.ownerId !== args.remoteContext.authOwner || !durableEpoch || durableEpoch.epoch !== track.authorizationEpoch) {
        try { recordRemoteTrackRuntimeDiagnostic(args.db, { channel: args.remoteContext.source, platformMessageId: args.remoteContext.messageId,
          eventKind: 'track-owner-epoch-mismatch', reasonCode: 'authorization-scope-mismatch', occurredAt: Date.now() }) } catch { /* preserve auth failure */ }
        throw new Error('TRACK_MODEL_INPUT_AUTH_SCOPE_MISMATCH')
      }
      if (!acceptedUserMessageId) throw new Error('TRACK_MODEL_INPUT_ACCEPTED_MESSAGE_REQUIRED')
      const currentInvocationId = args.acceptedTurn?.turnId ?? args.turnId
      if (!currentInvocationId) throw new Error('TRACK_MODEL_INPUT_CURRENT_INVOCATION_REQUIRED')
      const persistedView = buildTrackModelInputViewRef(args.db, {
        trackId: track.trackId, sessionId: args.sessionId, acceptedUserMessageId, currentInvocationId,
        channel: track.channel, identityKey: track.identityKey, ownerId: track.ownerId, authorizationEpoch: track.authorizationEpoch,
        rootMessageId: track.rootMessageId, attributionEventId: track.attributionEventId
      }, storage.queries)
      if (persistedView.completeness !== 'complete' || persistedView.viewVersion !== view.viewVersion || persistedView.contentHash !== view.contentHash ||
        JSON.stringify(persistedView.includedMessageIds) !== JSON.stringify(view.includedMessageIds) ||
        JSON.stringify(persistedView.includedEventIds) !== JSON.stringify(view.includedEventIds) ||
        JSON.stringify(persistedView.includedInvocationIds) !== JSON.stringify(view.includedInvocationIds) ||
        JSON.stringify(persistedView.includedSessionIds) !== JSON.stringify(view.includedSessionIds) ||
        JSON.stringify(persistedView.messageSessionMap) !== JSON.stringify(view.messageSessionMap) ||
        JSON.stringify(persistedView.permittedParentTrackIds) !== JSON.stringify(view.permittedParentTrackIds) ||
        JSON.stringify(persistedView.invocationSessionMap) !== JSON.stringify(view.invocationSessionMap)) {
        throw new Error('TRACK_MODEL_INPUT_VIEW_STALE_OR_UNTRUSTED')
      }
      try {
        bindRemoteTrackToTurn(args.db, {
          trackId: track.trackId, turnId: currentInvocationId, sessionId: args.sessionId, channel: track.channel,
          identityKey: track.identityKey, ownerId: track.ownerId, authorizationEpoch: track.authorizationEpoch,
          eventId: remoteTrackTurnBindingEventId(track.trackId, currentInvocationId), occurredAt: Date.now()
        })
      } catch (error) {
        try { recordRemoteTrackRuntimeDiagnostic(args.db, { channel: args.remoteContext.source, platformMessageId: args.remoteContext.messageId,
          eventKind: 'track-association-write-failed', reasonCode: 'turn-association-write-failed', occurredAt: Date.now() }) } catch { /* preserve association failure */ }
        throw error
      }
      await prepareChatBodiesForSessions(storage, [args.sessionId, ...persistedView.includedSessionIds])
      const acceptedSnapshotMessage = rawMessages.find((message) => message.id === acceptedUserMessageId)
      const acceptedPersistedMessage = await readChatMessageAfterPreparation(storage, { sessionId: args.sessionId, messageId: acceptedUserMessageId })
      if (!acceptedSnapshotMessage || !acceptedPersistedMessage || acceptedSnapshotMessage.sessionId !== acceptedPersistedMessage.sessionId ||
        acceptedSnapshotMessage.role !== acceptedPersistedMessage.role || acceptedSnapshotMessage.content !== acceptedPersistedMessage.content) {
        throw new Error('TRACK_ACCEPTED_INPUT_SNAPSHOT_MISMATCH')
      }
      const trackMessages = await Promise.all(persistedView.includedMessageIds.map((messageId) => {
        const sourceSessionId = persistedView.messageSessionMap[messageId]
        if (!sourceSessionId || !persistedView.includedSessionIds.includes(sourceSessionId)) return undefined
        return readChatMessageAfterPreparation(storage, { sessionId: sourceSessionId, messageId })
      }))
      if (trackMessages.some((message) => !message)) throw new Error('TRACK_MODEL_INPUT_MESSAGE_MISSING')
      rawMessages = filterTrackModelInputMessages(trackMessages as import('../../src/shared/domainTypes').Message[], persistedView, acceptedUserMessageId)
      // Hosted's current turn is durably bound to Track by turnId, while the loop first
      // probes its History under requestId. Permit that exact accepted request as a
      // same-session alias; all historical invocations still come only from the frozen view.
      const requestInvocationId = args.acceptedTurn?.requestId ?? requestId
      const scopedInvocationSessionMap = { ...persistedView.invocationSessionMap, [requestInvocationId]: args.sessionId }
      const scopedInvocationIds = [...new Set([...persistedView.includedInvocationIds, requestInvocationId])]
      const scopedHistory = createCrossSessionTrackScopedHistoryPort(
        (sessionId) => storage.execution.historyFor({ sessionId }),
        { currentSessionId: args.sessionId, allowedInvocationIds: scopedInvocationIds,
          invocationSessionMap: scopedInvocationSessionMap }
      )
      historyForSession = (sessionId: string) => {
        if (sessionId !== args.sessionId) throw new Error('TRACK_HISTORY_SESSION_MISMATCH')
        return scopedHistory
      }
    }
    const built = buildClaudeToolChatMessages(rawMessages, {
      workspaceRoot: resolved?.workDir,
      onOversizedToolResult: (info) => {
        logHistoryOversizedToolResult({
          sessionId: args.sessionId,
          toolUseId: info.toolUseId,
          originalLength: info.originalLength,
          compactedLength: info.compactedLength,
          source: 'im-remote'
        })
      }
    })
    const trimmed = trimClaudeToolChatMessages(built, MAX_CHAT_API_MESSAGES)
    const currentUserMessageId = acceptedUserMessageId ?? [...rawMessages].reverse().find((message) => message.role === 'user')?.id
    const paired = ensureToolResultPairing(trimmed, { requiredUserMessageId: currentUserMessageId })
    const deferredContinuation = args.remoteContext.deferredContinuation
    const messages = deferredContinuation ? [...paired.messages,
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: deferredContinuation.toolCallId,
        name: deferredContinuation.toolName, input: deferredContinuation.canonicalArgs }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: deferredContinuation.toolCallId,
        content: JSON.stringify(deferredContinuation.result.value ?? deferredContinuation.result), is_error: deferredContinuation.result.kind === 'failed' }] }
    ] : paired.messages
    // `history.read` is a bounded lookup over persisted conversation facts. Remote
    // invocations used to omit this capability entirely, so a valid prior IM turn
    // looked like missing context whenever no compaction checkpoint existed.
    const historyFacts = rawMessages
      .filter((message) => message.status !== 'streaming' && message.status !== 'sending' && message.status !== 'queued')
      .map((message) => {
        const details = { toolCalls: message.toolCalls, toolUse: message.toolUse, attachments: message.attachments }
        const serializedDetails = JSON.stringify(details)
        const boundedDetails = serializedDetails.length > 8_000 ? `${serializedDetails.slice(0, 7_999)}…` : serializedDetails
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content) ?? ''
        const detailText = message.toolCalls?.length || message.toolUse || message.attachments?.length ? `\n[结构化详情] ${boundedDetails}` : ''
        const text = `${content}${detailText}`
        return {
          id: message.id, sessionId: message.sessionId, windowId: `remote-session:${message.sessionId}`,
          role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
          text, tokens: estimateTokensFromUtf8Text(text), details
        }
      })
    const remoteContext = args.remoteContext
    const currentUserMessage = currentUserMessageId ? rawMessages.find((message) => message.id === currentUserMessageId && message.role === 'user') : undefined
    if ((remoteContext.source === 'feishu' || remoteContext.source === 'wechat') && remoteContext.authOwner && currentUserMessageId) {
      if (deferredContinuation) {
        const continuation = deferredContinuation
        const record = getTaskControlRecord(args.db, { sessionId: args.sessionId, ownerId: remoteContext.authOwner,
          workflowId: continuation.workflowId, taskId: continuation.taskId })
        const intent = createSecurityActionIntentStore(args.db).get(continuation.invocationId)
        const steps = Array.isArray(record?.data.steps) ? record.data.steps as Array<{ stepId?: unknown }> : []
        const invocations = Array.isArray(record?.data.outstandingInvocations)
          ? record.data.outstandingInvocations as Array<{ invocationId?: unknown; todoId?: unknown; stepId?: unknown }> : []
        const checkpoint = record?.data.deferredCheckpoints && typeof record.data.deferredCheckpoints === 'object'
          ? (record.data.deferredCheckpoints as Record<string, { todoId?: unknown; stepId?: unknown; checkpointId?: unknown; workflowRevision?: unknown }>)[continuation.invocationId]
          : undefined
        if (!record || record.controlState !== 'active' || record.data.status !== 'active' || record.planRevision !== continuation.planRevision ||
          !steps.some((step) => step.stepId === continuation.stepId) ||
          !invocations.some((entry) => entry.invocationId === continuation.invocationId && entry.todoId === continuation.todoId && entry.stepId === continuation.stepId) ||
          !checkpoint || checkpoint.todoId !== continuation.todoId || checkpoint.stepId !== continuation.stepId ||
          checkpoint.checkpointId !== continuation.checkpointId || !Number.isInteger(checkpoint.workflowRevision) ||
          !intent || intent.sessionId !== args.sessionId || intent.workflowId !== continuation.workflowId || intent.taskId !== continuation.taskId ||
          intent.stepId !== continuation.stepId || intent.planRevision !== continuation.planRevision || intent.todoId !== continuation.todoId ||
          intent.checkpointId !== continuation.checkpointId || intent.checkpointWorkflowRevision !== checkpoint.workflowRevision ||
          !['checkpoint_committed', 'notified'].includes(intent.state)) throw new Error('IM_DEFERRED_CONTINUATION_TASK_FENCED')
        remoteContext.taskBinding = { workflowId: record.workflowId, taskId: record.taskId, stepId: continuation.stepId,
          planRevision: record.planRevision, revision: record.revision }
      } else {
        const ensured = ensureImTurnTaskControl(args.db, {
          sessionId: args.sessionId, ownerId: remoteContext.authOwner, requestId, userMessageId: currentUserMessageId
        })
        if (!ensured.ok) throw new Error('IM_TURN_TASK_IDENTITY_CONFLICT')
        remoteContext.taskBinding = ensured.taskBinding
      }
      remoteContext.currentUserMessageId = currentUserMessageId
    }

    const browserConfig = args.getBrowserConfig?.()
    const policySnapshot = readImPromptPolicySnapshot(args.db)
    const baseAppendix = args.buildSystemAppendix({
      browserRemoteHint: resolveFeishuBrowserRemoteHint(
        browserConfig?.enabled,
        browserConfig?.allowRemoteSessions
      ),
      policySnapshot
    })
    const continuation = args.remoteContext.deferredContinuation
    const appendix = continuation ? `${baseAppendix}\n\nDeferred action completion (already executed; do not repeat it):\n${JSON.stringify(continuation)}` : baseAppendix

    // accepted turn 是 IM Agent Loop 的唯一模型/服务来源；禁止通过可变回调补齐快照。
    const frozenConfig = args.acceptedTurn?.config
    if (!frozenConfig?.model?.trim() || !frozenConfig.llmServiceId?.trim() || !frozenConfig.thinkingEffort) {
      throw new Error('IM_ACCEPTED_TURN_EXECUTION_CONFIG_REQUIRED')
    }
    const routeModelName = frozenConfig.model
    remoteContext.model = routeModelName
    let contextWindow: number | undefined
    let contextWindowTrusted = false
    try {
      const models = JSON.parse(getConfigValue(args.db, 'config.models') ?? '[]') as ModelEntry[]
      const modelWindow = resolveModelContextWindow(routeModelName, models)
      contextWindow = modelWindow.contextWindow
      contextWindowTrusted = modelWindow.trusted
    } catch { /* use adapter fallback */ }
    const modelEntry = (() => {
      try { return (JSON.parse(getConfigValue(args.db, 'config.models') ?? '[]') as ModelEntry[]).find((entry) => entry.name === routeModelName) }
      catch { return undefined }
    })()
    if (!modelEntry?.id) throw new Error(`IM_TURN_MODEL_NOT_FOUND: ${routeModelName}`)
    const resolvedPair = await resolveLlmCredentialsForPair(args.db, modelEntry.id, frozenConfig.llmServiceId)
    if ('error' in resolvedPair) {
      throw new Error(`IM_FROZEN_MODEL_SERVICE_UNAVAILABLE: 当前回合绑定的模型服务不可用（${resolvedPair.error}）。请在“大模型服务”中恢复该服务，或调整设置后重新发送任务。`)
    }
    const creds = {
      serviceId: resolvedPair.serviceId,
      baseUrl: resolvedPair.baseUrl,
      getApiKey: resolvedPair.getApiKey
    }
    const baseUrl = creds.baseUrl
    const getApiKey = creds.getApiKey
    const providerRouteId = requireInvocationAnthropicRoute({
      // MODEL_BASELINE 以 provider 模型名为键；ModelEntry.id 是本地目录身份，不能传给 provider route。
      modelId: routeModelName,
      endpoint: baseUrl,
      credentialRef: `llm-service:${creds.serviceId}`
    }, getDefaultAgentRuntime().modelProviders)
    remoteContext.providerRouteId = providerRouteId
    const remoteProgressContext = buildRemoteProgressHookContext(args.sessionId, readAppLocale(args.db))

    const { invocation, ports, agentSdk } = assembleInvocation({
      requestId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      acceptedTurn: args.acceptedTurn,
      // 该值来自精确冻结服务解析；失败已在上方 fail-fast。
      llmServiceId: creds.serviceId,
      model: routeModelName,
      ...(modelEntry?.id ? { modelId: modelEntry.id } : {}),
      effort: frozenConfig.thinkingEffort,
      ...(frozenConfig.requestedThinkingEffort ? { requestedThinkingEffort: frozenConfig.requestedThinkingEffort } : {}),
      providerRouteId,
      contextWindow,
      contextWindowTrusted,
      baseUrl,
      messages,
      system: appendix,
      options: { maxTokens: 8192 },
      currentUserMessageId,
      toolsConfig,
      resolveToolsConfig: args.getToolsConfig,
      resolveBrowserConfig: args.getBrowserConfig,
      resolveShellConfig: args.getShellConfig,
      resolveWikiConfig: args.getWikiConfig,
      browserConfig: args.getBrowserConfig?.(),
      wikiConfig: args.getWikiConfig?.(),
      shellConfig: args.getShellConfig?.(),
      workDir: args.workDir,
      workDirManager: args.workDirManager,
      resolveWorkDir: buildResolveWorkDirCallback(
        storage.queries,
        args.sessionId,
        args.workDirManager,
        args.workDir
      ),
      userDataDir: args.userDataDir,
      getApiKey,
      appDb: args.db,
      sessionStorage: storage,
      historyForSession,
      historyFacts,
      ...(sessionEventLocation ? { sessionEventLocation } : {}),
      remoteContext,
      ...(currentUserMessage?.content ? { approvalTaskDigest: currentUserMessage.content } : {}),
      ...(args.remoteContext.source === 'feishu' || args.remoteContext.source === 'wechat'
        ? { imOrchestrationToolRegistry: createImOrchestrationToolRegistry(args.db, args.taskControlSafetyPort ?? createDeferredTodoTaskControlSafetyPort({
            todoStore: createDeferredTodoStore(args.db), dispatchDeferred: async () => ({ dispatched: false })
          })) }
        : {}),
      onRemoteTextActivity: (text) => onRemoteTextSegmentClosed(remoteProgressContext, text),
      locale: readAppLocale(args.db),
      ...args.toolChatExtras
      ,emitFactEvent: args.emitFactEvent ?? (() => undefined)
      ,emitSessionEvent: async (event) => { await sessionEventSink?.appendCritical(event) }
    })
    const res = await runToolChatSession(invocation, ports, {
      onHostedTurnHandoff: createHostedTurnHandoff({
        agentSdk, history: ports.history!, invocationId: args.acceptedTurn?.turnId ?? args.turnId ?? requestId, turnId: args.acceptedTurn?.turnId ?? args.turnId ?? requestId, acceptedTurn: args.acceptedTurn,
        sessionQueries: storage.queries, sessionExecution: storage.execution, routeId: providerRouteId, sessionId: args.sessionId, maxToolRounds: invocation.limits.maxToolRounds,
        ...(args.remoteContext.trackContext ? { trackScopedModelInput: true } : {}),
        ...(args.confirmationAdapter ? { confirmationAdapter: args.confirmationAdapter } : {})
      })
    })

    confirmationFailureProjection = await readConfirmationFailureProjection(storage, args.sessionId, args.acceptedTurn?.turnId ?? args.turnId ?? requestId)

    if (!res.ok) {
      settleTrack(args.acceptedTurn?.turnId ?? args.turnId, trackTerminalTargetFromAgentResult(res))
      sessionEventReason = res.cancelled ? 'cancelled' : 'failed'
      const pending = res.error.includes('确认')
      const result = { summary: appendConfirmationFailureProjection(res.error, confirmationFailureProjection), pendingConfirm: pending, ok: false as const, ...(res.cancelled ? { outcome: 'cancelled' as const } : {}) }
      args.logDone?.({ ...result, error: res.error })
      return result
    }

    if (res.parked) {
      settleTrack(args.acceptedTurn?.turnId ?? args.turnId, trackTerminalTargetFromAgentResult(res))
      sessionEventReason = 'interrupted'
      const result = confirmationFailureProjection
        ? { summary: confirmationFailureProjection.summary, pendingConfirm: false, ok: true as const, parked: true as const }
        : { summary: '', pendingConfirm: true, ok: true as const, parked: true as const }
      args.logDone?.(result)
      return result
    }

    const text = extractTextFromContent(res.content)
    settleTrack(args.acceptedTurn?.turnId ?? args.turnId, trackTerminalTargetFromAgentResult(res))
    sessionEventReason = 'completed'
    const result = { summary: confirmationFailureProjection?.summary ?? (text || '任务已完成。'), pendingConfirm: false, ok: true as const }
    args.logDone?.(result)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    try { settleTrack(args.acceptedTurn?.turnId ?? args.turnId, trackTerminalTargetFromAgentResult({ ok: false,
      ...(e instanceof HostedTurnFinalizedError ? { outcome: e.outcome } : {}) })) }
    catch (trackError) { args.logError?.(`Track settlement failed: ${trackError instanceof Error ? trackError.message : String(trackError)}`) }
    confirmationFailureProjection ??= await readConfirmationFailureProjection(storage, args.sessionId, args.acceptedTurn?.turnId ?? args.turnId ?? requestId)
    if (!confirmationFailureProjection) {
      if (e instanceof HostedTurnFinalizedError) sessionEventReason = hostedTerminalSessionEventReason(e.outcome)
      sessionEventError = error
      args.logError?.(error)
      if (args.rethrowAsError) throw e instanceof Error ? e : new Error(error)
      throw e
    }
    const errorWithConfirmationFailure = appendConfirmationFailureProjection(error, confirmationFailureProjection)
    if (e instanceof HostedTurnFinalizedError) sessionEventReason = hostedTerminalSessionEventReason(e.outcome)
    sessionEventError = errorWithConfirmationFailure
    args.logError?.(errorWithConfirmationFailure)
    if (e instanceof HostedTurnFinalizedError) throw new HostedTurnFinalizedError(new Error(errorWithConfirmationFailure, { cause: e }), e.outcome, e.usage)
    if (args.rethrowAsError) throw new Error(errorWithConfirmationFailure, { cause: e })
    throw new Error(errorWithConfirmationFailure, { cause: e })
  } finally {
    if (sessionEventStarted) {
      if (sessionEventLocation && sessionEventSink) {
        try {
          await sessionEventSink.appendCritical({ type: 'step_end', payload: { turnId: turnIdForEvents, stepId: requestId, reason: sessionEventReason } })
          await sessionEventSink.appendCritical({ type: 'turn_end', payload: { turnId: turnIdForEvents, reason: sessionEventReason, ...(sessionEventError ? { error: sessionEventError } : {}) } })
        } catch (error) {
          try { args.logError?.(`remote session event finalization failed: ${error instanceof Error ? error.message : String(error)}`) }
          catch { /* event diagnostics must not replace the turn outcome */ }
        }
      }
    }
    stopRemoteProgressSession(args.sessionId)
    clearRemoteProgressSession(args.sessionId)
    args.onFinally?.()
  }
  }
}
