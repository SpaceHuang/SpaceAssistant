import type { CanonicalModelMessage, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import type { HostCommittedModelResponse } from '../../packages/agent-sdk/src/turn'
import { runHostedAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ToolLoopRoundLimitError } from '../../packages/agent-sdk/src/turn'
import type { HistoryPort } from '../../packages/agent-sdk/src/history'
import { InvocationHistoryWriter } from '../../packages/agent-sdk/src/history'
import type { RunToolChatSessionArgs, RunToolChatSessionResult } from '../toolChatLoop'
import type { AgentInvocationMaterials } from './invocationAssembler'
import type { createAgentSdkConfirmationPort } from '../confirmation/agentSdkConfirmationPort'
import { HostedTurnFinalizedError, type HostedTurnFinalization } from './hostedTurnFinalization'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { resolveCanonicalRequestCutover } from './sessionHistoryCutover'
import { decodeTerminalOutcome } from './terminalOutcome'
import type { AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { AppDatabase } from '../database/sqliteStore'
import { cancelQueuedSessionExecution, claimSessionExecution, commitSessionTranscript, markSessionExecutionStarted, markSessionExecutionUncertain, readSessionTranscript, releaseSessionExecution } from '../database/sessionTranscript'
import { getMessage } from '../database/operations'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { ensureApiTextContent } from '../../src/shared/claudeToolHistory'
import { randomUUID } from 'node:crypto'

function hostedFailureOutcome(terminal: Parameters<typeof decodeTerminalOutcome>[0]): 'failed' | 'interrupted' | 'cancelled' | 'timed-out' | 'commit-uncertain' {
  const outcome = decodeTerminalOutcome(terminal)
  if (outcome === 'cancelled' || outcome === 'interrupted') return outcome
  if (outcome === 'timed_out') return 'timed-out'
  return 'failed'
}

type HostedRuntimeFactory = Readonly<{
  createHostedTurnRuntime(input: Readonly<{ confirmationAdapter?: unknown; authorizedToolNames: ReadonlySet<string>; /** FR3：延迟名集合（并入 capabilities known + authorized）。 */ deferredToolNames?: ReadonlySet<string>; /** FR8：延迟维度（turn 计量）。 */ deferredDimension?: import('../../src/shared/usageAttribution').DeferredToolDimension; /** FR8：延迟工具未浮现直调判定（sessionLedger 持久化投影用）。 */ deferredUnsurfacedCheck?: (toolName: string) => boolean; /** FR12②：广告面层被裁工具名。 */ eagerBudgetDroppedNames?: ReadonlySet<string>; resolveRegisteredToolName?: (providerToolName: string) => string; hostHistory?: HistoryPort; afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']; recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']; refreshExecutionContext?(call: { invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, stage: Extract<import('../../packages/agent-sdk/src/turn').ToolPreparationStage, { kind: 'recheck' }>, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> }>): Promise<Readonly<{ host: Parameters<typeof runHostedAgentTurn>[0]['host']; dispose(): Promise<void> }>> | Readonly<{ host: Parameters<typeof runHostedAgentTurn>[0]['host']; dispose(): Promise<void> }>
}>

type HandoffInput = Readonly<{
  request: PreparedModelCall['request']
  authorizedToolNames: ReadonlySet<string>
  /** FR3：延迟名集合（不在 request.tools、在授权面）。 */
  deferredToolNames?: ReadonlySet<string>
  /** FR8：延迟维度（turn 计量）。 */
  deferredDimension?: import('../../src/shared/usageAttribution').DeferredToolDimension
  /** FR8：延迟工具未浮现直调判定。 */
  deferredUnsurfacedCheck?: (toolName: string) => boolean
  /** FR12②：广告面层被裁工具名（被拒文案区分用）。 */
  eagerBudgetDroppedNames?: ReadonlySet<string>
  resolveRegisteredToolName: (providerToolName: string) => string
  windowId?: string
  hostHistory?: HistoryPort
  afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
  initialResponse?: HostCommittedModelResponse
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

function logSessionHistoryShadowDiagnostic(input: {
  requestId: string; turnId: string; sessionId: string; stage: 'read-history' | 'select-snapshot' | 'match-current-message'
  reasonCode: string; historyStreamId?: string; previousTurnId?: string; snapshotVersion?: number
}): void {
  try {
    logAgentEvent('warn', 'history.cutover', { ...input, outcome: 'rejected' })
  } catch {
    // Diagnostic persistence must not affect turn ownership or execution.
  }
}

function terminalUsage(terminal: { payload?: unknown }): import('./hostedTurnFinalization').HostedFailureUsage | undefined {
  const payload = terminal.payload && typeof terminal.payload === 'object' ? terminal.payload as Record<string, unknown> : {}
  const raw = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : undefined
  if (!raw || !Number.isFinite(raw.inputTokens) || !Number.isFinite(raw.outputTokens) ||
    (raw.cacheReadInputTokens !== undefined && !Number.isFinite(raw.cacheReadInputTokens)) ||
    (raw.cacheCreationInputTokens !== undefined && !Number.isFinite(raw.cacheCreationInputTokens))) return undefined
  return {
    inputTokens: raw.inputTokens as number,
    outputTokens: raw.outputTokens as number,
    ...(raw.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: raw.cacheReadInputTokens as number } : {}),
    ...(raw.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: raw.cacheCreationInputTokens as number } : {})
  }
}

function committedTranscriptMessages(messages: readonly CanonicalModelMessage[]): CanonicalModelMessage[] {
  return messages.filter((message) => message.role !== 'system')
}

function recoverAcceptedRestartInput(input: {
  snapshot: Awaited<ReturnType<HistoryPort['read']>>
  db: AppDatabase
  sessionId: string
  requestMessages: readonly CanonicalModelMessage[]
  requiredUserMessage: CanonicalModelMessage
}): { id: string; message: CanonicalModelMessage } | undefined {
  const [accepted, terminal] = input.snapshot.events
  const terminalPayload = terminal?.payload && typeof terminal.payload === 'object' && !Array.isArray(terminal.payload)
    ? terminal.payload as Record<string, unknown>
    : undefined
  if (input.snapshot.events.length !== 2 || accepted?.kind !== 'session-input-committed' || terminal?.kind !== 'invocation-interrupted' ||
    accepted.turnId !== terminal.turnId || terminalPayload?.status !== 'interrupted' || terminalPayload?.reason !== 'process-restart') return undefined
  const marker = accepted.payload && typeof accepted.payload === 'object' ? accepted.payload as Record<string, unknown> : undefined
  if (marker?.sessionId !== input.sessionId || marker.role !== 'user' || typeof marker.messageId !== 'string' ||
    typeof marker.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(marker.inputFingerprint)) return undefined
  const stored = getMessage(input.db, marker.messageId)
  if (!stored || stored.sessionId !== input.sessionId || stored.role !== 'user' || stored.attachments?.length ||
    queueInputFingerprint({ text: stored.content, attachments: stored.attachments }) !== marker.inputFingerprint) return undefined
  const content = ensureApiTextContent(stored.content)
  let currentUserIndex = -1
  const requiredUserJson = JSON.stringify(input.requiredUserMessage)
  for (let index = input.requestMessages.length - 1; index >= 0; index -= 1) {
    if (input.requestMessages[index]?.role === 'user' && JSON.stringify(input.requestMessages[index]) === requiredUserJson) {
      currentUserIndex = index
      break
    }
  }
  if (currentUserIndex < 0) return undefined
  let requestMessage: CanonicalModelMessage | undefined
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    const candidate = input.requestMessages[index]
    if (candidate?.role === 'user' && typeof candidate.content === 'string' && candidate.content === content) {
      requestMessage = candidate
      break
    }
  }
  if (!requestMessage || requestMessage.role !== 'user') return undefined
  // Persisted message timestamps are not part of the Hosted model transcript. Return the
  // request's canonical shape so cutover matching does not depend on storage metadata.
  return { id: stored.id, message: requestMessage }
}

function latestCompactedTranscript(snapshot: Awaited<ReturnType<HistoryPort['read']>>): CanonicalModelMessage[] | undefined {
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const event = snapshot.events[index]
    if (event.kind !== 'transcript-compacted') continue
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : undefined
    if (!payload || !Array.isArray(payload.messages) || !payload.messages.every((message) =>
      Boolean(message) && typeof message === 'object' && !Array.isArray(message) &&
      typeof (message as { role?: unknown }).role === 'string'
    )) throw new Error('Canonical compacted transcript is invalid')
    return payload.messages as CanonicalModelMessage[]
  }
  return undefined
}

export function createHostedTurnHandoff(input: {
  agentSdk: HostedRuntimeFactory
  history: HistoryPort
  invocationId: string
  turnId: string
  routeId: string
  sessionId?: string
  acceptedTurn?: AcceptedTurn
  sessionDb?: AppDatabase
  maxToolRounds?: number
  hostHistory?: HistoryPort
  recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']
  refreshExecutionContext?: NonNullable<Parameters<HostedRuntimeFactory['createHostedTurnRuntime']>[0]['refreshExecutionContext']>
  confirmationAdapter?: Partial<Parameters<typeof createAgentSdkConfirmationPort>[0]>
}): NonNullable<RunToolChatSessionArgs['onHostedTurnHandoff']> {
  if (input.acceptedTurn && (input.acceptedTurn.turnId !== input.turnId || input.acceptedTurn.sessionId !== input.sessionId ||
    input.acceptedTurn.requestId.length === 0)) throw new Error('ACCEPTED_TURN_HANDOFF_IDENTITY_MISMATCH')
  return async (handoff: HandoffInput): Promise<Readonly<{ result: RunToolChatSessionResult; finalization: HostedTurnFinalization }>> => {
    if (input.acceptedTurn && (handoff.currentUserMessageId !== input.acceptedTurn.currentUserMessageId ||
      handoff.requiredUserMessage?.id !== input.acceptedTurn.currentUserMessageId)) {
      throw new Error('ACCEPTED_TURN_USER_MESSAGE_ID_MISMATCH')
    }
    let ownership: { sessionId: string; turnId: string; ownerId: string; generation: number } | undefined
    let queuedOwnership: { sessionId: string; turnId: string; ownerId: string } | undefined
    let keepClaimedForReconciliation = false
    let executionStarted = false
    try {
    let checkpoint: ReturnType<typeof readSessionTranscript> | undefined
    if (input.sessionDb && input.sessionId) {
      const ownerId = `runtime:${process.pid}:${randomUUID()}`
      queuedOwnership = { sessionId: input.sessionId, turnId: input.turnId, ownerId }
      // Session ownership has its own queue budget, independent of the parent turn deadline.
      const waitUntil = Date.now() + 30_000
      for (;;) {
        const claim = claimSessionExecution(input.sessionDb, { sessionId: input.sessionId, turnId: input.turnId, ownerId })
        if (claim.acquired) {
          ownership = { sessionId: input.sessionId, turnId: input.turnId, ownerId, generation: claim.generation }
          break
        }
        if (claim.reason === 'blocked' || Date.now() >= waitUntil) throw new Error(claim.reason === 'blocked' ? 'SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED' : 'SESSION_EXECUTION_QUEUE_TIMEOUT')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      checkpoint = readSessionTranscript(input.sessionDb, input.sessionId)
      if (checkpoint.status !== 'ready') throw new Error('SESSION_TRANSCRIPT_RECONCILIATION_REQUIRED')
      if (checkpoint.version > 0) {
        logAgentEvent('info', 'history.cutover', {
          requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId,
          stage: 'session-checkpoint', reasonCode: 'committed-transcript', outcome: 'matched', snapshotVersion: checkpoint.version
        })
      }
    }
    let request = handoff.request
    if (checkpoint && checkpoint.version > 0 && handoff.requiredUserMessage) {
      const systemMessages = handoff.request.messages.filter((message) => message.role === 'system')
      request = { ...handoff.request, messages: [...systemMessages, ...committedTranscriptMessages(checkpoint.messages as CanonicalModelMessage[]), handoff.requiredUserMessage.message] }
    } else if (input.sessionId && handoff.requiredUserMessage && input.history instanceof SqliteAgentHistory) {
      // Existing streams must never silently fall back to legacy session messages.
      let latest: Awaited<ReturnType<SqliteAgentHistory['readLatestInvocationForSession']>>
      try {
        latest = await input.history.readLatestInvocationForSession(input.sessionId, { excludeInvocationId: input.invocationId })
      } catch {
        logSessionHistoryShadowDiagnostic({ requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId, stage: 'read-history', reasonCode: 'history-read-failed' })
        throw new Error('Canonical session History could not safely provide the Hosted transcript')
      }
      if (latest.kind === 'none') {
        logAgentEvent('info', 'history.cutover', { requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId, stage: 'select-snapshot', reasonCode: 'no-previous-history', outcome: 'no-cutover' })
      }
      if (latest.kind === 'unavailable') {
        let previousTurnId: string | undefined
        let snapshotVersion: number | undefined
        let recoveredRestartInput = false
        try {
          const snapshot = await input.history.read(latest.invocationId)
          snapshotVersion = snapshot.version
          previousTurnId = snapshot.events.at(-1)?.turnId
          const acceptedInput = input.sessionDb && handoff.requiredUserMessage
            ? recoverAcceptedRestartInput({ snapshot, db: input.sessionDb, sessionId: input.sessionId, requestMessages: handoff.request.messages,
                requiredUserMessage: handoff.requiredUserMessage.message })
            : undefined
          if (acceptedInput && handoff.requiredUserMessage) {
            const prior = await input.history.readLatestInvocationForSession(input.sessionId, {
              excludeInvocationIds: [input.invocationId, latest.invocationId]
            })
            if (prior.kind !== 'unavailable') {
              const priorSnapshot = prior.kind === 'completed' || prior.kind === 'cancelled' ? prior.snapshot : undefined
              const recovered = resolveCanonicalRequestCutover({
                ...(priorSnapshot ? { snapshot: priorSnapshot } : {}),
                requestMessages: handoff.request.messages,
                requiredUserMessage: handoff.requiredUserMessage.message,
                ...(acceptedInput.id !== handoff.requiredUserMessage.id ? { additionalAcceptedMessages: [acceptedInput.message] } : {})
              })
              if (recovered.kind === 'matched') {
                request = { ...handoff.request, messages: [...recovered.messages] }
                recoveredRestartInput = true
                logAgentEvent('info', 'history.cutover', {
                  requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId,
                  stage: 'match-current-message', reasonCode: 'recovered-process-restart-input', outcome: 'matched',
                  historyStreamId: latest.invocationId, previousTurnId, snapshotVersion
                })
              }
            }
          }
        } catch { /* 保持原始 unavailable 原因，诊断不改变执行分支 */ }
        if (!recoveredRestartInput) {
          logSessionHistoryShadowDiagnostic({ requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId, stage: 'select-snapshot', reasonCode: 'history-unavailable', historyStreamId: latest.invocationId, ...(previousTurnId ? { previousTurnId } : {}), ...(snapshotVersion !== undefined ? { snapshotVersion } : {}) })
          throw new Error('Canonical session History could not safely provide the Hosted transcript')
        }
      }
      if (latest.kind === 'completed' || latest.kind === 'cancelled') {
        try {
          const result = resolveCanonicalRequestCutover({
            snapshot: latest.snapshot,
            requestMessages: handoff.request.messages,
            requiredUserMessage: handoff.requiredUserMessage.message
          })
          if (result.kind !== 'matched') throw new Error(result.kind)
          request = { ...handoff.request, messages: [...result.messages] }
          logAgentEvent('info', 'history.cutover', {
            requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId,
            stage: 'match-current-message', reasonCode: 'matched', outcome: 'matched',
            historyStreamId: latest.snapshot.invocationId, previousTurnId: latest.snapshot.events.at(-1)?.turnId,
            snapshotVersion: latest.snapshot.version
          })
        } catch (error) {
          const reason = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'history-read-failed'
          logSessionHistoryShadowDiagnostic({ requestId: input.invocationId, turnId: input.turnId, sessionId: input.sessionId, stage: 'match-current-message', reasonCode: reason, historyStreamId: latest.snapshot.invocationId, previousTurnId: latest.snapshot.events.at(-1)?.turnId, snapshotVersion: latest.snapshot.version })
          throw new Error('Canonical session History could not safely provide the Hosted transcript')
        }
      }
    }
    const historyFacade: HistoryPort = {
      appendBatch: (events, expectedVersion) => input.history.appendBatch(events, expectedVersion),
      read: (invocationId) => input.history.read(invocationId)
    }
    const runtime = await input.agentSdk.createHostedTurnRuntime({
      ...(input.confirmationAdapter ? { confirmationAdapter: input.confirmationAdapter } : {}),
      authorizedToolNames: handoff.authorizedToolNames,
      ...(handoff.deferredToolNames ? { deferredToolNames: handoff.deferredToolNames } : {}),
      ...(handoff.deferredDimension ? { deferredDimension: handoff.deferredDimension } : {}),
      ...(handoff.deferredUnsurfacedCheck ? { deferredUnsurfacedCheck: handoff.deferredUnsurfacedCheck } : {}),
      ...(handoff.eagerBudgetDroppedNames ? { eagerBudgetDroppedNames: handoff.eagerBudgetDroppedNames } : {}),
      resolveRegisteredToolName: handoff.resolveRegisteredToolName,
      hostHistory: handoff.hostHistory ?? input.hostHistory ?? historyFacade,
      ...(handoff.afterToolResult ? { afterToolResult: handoff.afterToolResult } : {}),
      ...(input.maxToolRounds !== undefined ? { maxToolRounds: input.maxToolRounds } : {}),
      ...(input.refreshExecutionContext ? { refreshExecutionContext: input.refreshExecutionContext } : {}),
      ...(input.recoverProviderAttempt ? { recoverProviderAttempt: input.recoverProviderAttempt } : {})
    })
    try {
      if (ownership && !markSessionExecutionStarted(input.sessionDb!, ownership)) throw new Error('SESSION_EXECUTION_CLAIM_FENCED')
      executionStarted = true
      const hosted = await runHostedAgentTurn({
        host: runtime.host,
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        ...(handoff.windowId ? { windowId: handoff.windowId } : {}),
        currentUserMessageId: handoff.currentUserMessageId,
        requiredUserMessage: handoff.requiredUserMessage,
        routeId: input.routeId,
        request,
        ...(input.maxToolRounds !== undefined ? { maxToolRounds: input.maxToolRounds } : {}),
        ...(handoff.initialResponse ? { initialResponse: handoff.initialResponse } : {})
      })
      const snapshot = await input.history.read(input.invocationId)
      const terminal = [...(snapshot?.events ?? [])].reverse().find((event) => event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted')
      if (!terminal) throw new HostedTurnFinalizedError(new Error('Hosted invocation terminal is missing from canonical History'), 'failed')
      if (terminal.kind !== 'invocation-completed') {
        const payload = terminal.payload && typeof terminal.payload === 'object' && !Array.isArray(terminal.payload)
          ? terminal.payload as Record<string, unknown>
          : undefined
        if (payload?.errorCode === 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED' && typeof payload.reason === 'string') {
          throw new HostedTurnFinalizedError(new ToolLoopRoundLimitError(input.maxToolRounds ?? 0, payload.reason), hostedFailureOutcome(terminal), terminalUsage(terminal))
        }
        if (payload?.errorCode === 'SHELL_DIALECT_MISMATCH' && typeof payload.reason === 'string') {
          throw new HostedTurnFinalizedError(new Error(payload.reason), hostedFailureOutcome(terminal), terminalUsage(terminal))
        }
        throw new HostedTurnFinalizedError(new Error(`Hosted invocation ended as ${terminal.kind}`), hostedFailureOutcome(terminal))
      }
      if (ownership && checkpoint) {
        let committed: ReturnType<typeof commitSessionTranscript>
        try {
          committed = commitSessionTranscript(input.sessionDb!, {
            sessionId: ownership.sessionId, turnId: ownership.turnId, baseVersion: checkpoint.version,
            outcome: 'completed', messages: committedTranscriptMessages(hosted.messages as CanonicalModelMessage[]) as unknown as readonly Record<string, unknown>[]
          })
        } catch (error) {
          keepClaimedForReconciliation = true
          try { markSessionExecutionUncertain(input.sessionDb!, ownership) }
          catch (reconciliationError) {
            logAgentEvent('error', 'session.transcript.reconciliation', {
              requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
              outcome: 'commit_uncertain', reasonCode: 'checkpoint-write-and-uncertain-mark-failed', transcriptVersion: checkpoint.version
            })
            throw new HostedTurnFinalizedError(new AggregateError([error, reconciliationError], 'Transcript checkpoint and uncertainty marker both failed'), 'commit-uncertain')
          }
          logAgentEvent('error', 'session.transcript.reconciliation', {
            requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
            outcome: 'commit_uncertain', reasonCode: 'checkpoint-write-failed', transcriptVersion: checkpoint.version
          })
          throw new HostedTurnFinalizedError(error, 'commit-uncertain')
        }
        if (!committed.committed) {
          markSessionExecutionUncertain(input.sessionDb!, ownership)
          keepClaimedForReconciliation = true
          logAgentEvent('error', 'session.transcript.reconciliation', {
            requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
            outcome: 'commit_uncertain', reasonCode: committed.reason, transcriptVersion: checkpoint.version
          })
          throw new HostedTurnFinalizedError(new Error(`SESSION_TRANSCRIPT_COMMIT_UNCERTAIN:${committed.reason}`), 'commit-uncertain')
        }
      }
      return {
        result: {
          ok: true,
          content: [{ type: 'text', text: hosted.text }],
          stopReason: hosted.finishReason === 'cancelled' ? 'cancelled' : 'end_turn',
          usage: {
            input_tokens: hosted.usage.inputTokens,
            output_tokens: hosted.usage.outputTokens,
            ...(hosted.usage.cacheReadInputTokens !== undefined ? { cache_read_input_tokens: hosted.usage.cacheReadInputTokens } : {}),
            ...(hosted.usage.cacheCreationInputTokens !== undefined ? { cache_creation_input_tokens: hosted.usage.cacheCreationInputTokens } : {}),
            cacheSemantics: 'additive'
          }
        },
        finalization: {
          outcome: 'completed',
          usage: {
            modelTurns: Math.max(0, hosted.modelTurns - (handoff.initialResponse ? 1 : 0)),
            initialMessageCount: request.messages.length,
            messages: hosted.messages,
            notDispatchedToolCallIds: snapshot.events.flatMap((event) => {
              if (event.kind !== 'tool-call-not-dispatched') return []
              const toolCallId = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
                ? (event.payload as { toolCallId?: unknown }).toolCallId
                : undefined
              return typeof toolCallId === 'string' ? [toolCallId] : []
            })
          }
        }
      }
    } catch (error) {
      let snapshot: Awaited<ReturnType<HistoryPort['read']>>
      try { snapshot = await input.history.read(input.invocationId) }
      catch (historyError) {
        if (ownership && executionStarted) {
          keepClaimedForReconciliation = true
          markSessionExecutionUncertain(input.sessionDb!, ownership)
          logAgentEvent('error', 'session.transcript.reconciliation', {
            requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
            outcome: 'commit_uncertain', reasonCode: 'history-terminal-read-failed', transcriptVersion: checkpoint?.version ?? 0
          })
          throw new HostedTurnFinalizedError(new AggregateError([error, historyError], 'Hosted History terminal state could not be read'), 'commit-uncertain')
        }
        throw new HostedTurnFinalizedError(new AggregateError([error, historyError], 'Hosted History terminal state could not be read'), 'failed')
      }
      const terminal = [...snapshot.events].reverse().find((event) => event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted')
      if (!terminal && ownership && checkpoint && executionStarted) {
        keepClaimedForReconciliation = true
        markSessionExecutionUncertain(input.sessionDb!, ownership)
        logAgentEvent('error', 'session.transcript.reconciliation', {
          requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
          outcome: 'commit_uncertain', reasonCode: 'history-terminal-missing', transcriptVersion: checkpoint.version
        })
        throw new HostedTurnFinalizedError(new Error('SESSION_TRANSCRIPT_COMMIT_UNCERTAIN:history-terminal-missing', { cause: error }), 'commit-uncertain')
      }
      if (terminal && terminal.kind !== 'invocation-completed' && ownership && checkpoint && handoff.requiredUserMessage) {
        const decoded = decodeTerminalOutcome(terminal)
        const outcome = decoded === 'cancelled' ? 'cancelled' : decoded === 'timed_out' ? 'timed_out' : decoded === 'interrupted' ? 'interrupted' : 'failed'
        // The request was assembled from the committed checkpoint or from a validated legacy History cutover.
        // On a first cutover the checkpoint is still empty, so using it here would discard the prior transcript.
        let canonicalCompaction: CanonicalModelMessage[] | undefined
        try { canonicalCompaction = latestCompactedTranscript(snapshot) }
        catch (projectionError) {
          keepClaimedForReconciliation = true
          markSessionExecutionUncertain(input.sessionDb!, ownership)
          throw new HostedTurnFinalizedError(new AggregateError([error, projectionError], 'Canonical compacted transcript could not be read safely'), 'commit-uncertain', terminalUsage(terminal))
        }
        const acceptedRequestMessages = canonicalCompaction ?? request.messages
        let acceptedUserIndex = -1
        const requiredMessage = JSON.stringify(handoff.requiredUserMessage.message)
        for (let index = acceptedRequestMessages.length - 1; index >= 0; index -= 1) {
          if (JSON.stringify(acceptedRequestMessages[index]) === requiredMessage) { acceptedUserIndex = index; break }
        }
        if (acceptedUserIndex < 0) {
          if (canonicalCompaction) {
            keepClaimedForReconciliation = true
            markSessionExecutionUncertain(input.sessionDb!, ownership)
            throw new HostedTurnFinalizedError(new Error('Canonical compacted transcript omitted its accepted user message'), 'commit-uncertain', terminalUsage(terminal))
          }
          throw new HostedTurnFinalizedError(new Error('Hosted request omitted its accepted user message'), 'failed')
        }
        const acceptedTranscript = committedTranscriptMessages(acceptedRequestMessages.slice(0, acceptedUserIndex + 1))
        let committed: ReturnType<typeof commitSessionTranscript>
        try {
          committed = commitSessionTranscript(input.sessionDb!, {
            sessionId: ownership.sessionId, turnId: ownership.turnId, baseVersion: checkpoint.version, outcome,
            messages: acceptedTranscript as unknown as readonly Record<string, unknown>[]
          })
        } catch (commitError) {
          keepClaimedForReconciliation = true
          try { markSessionExecutionUncertain(input.sessionDb!, ownership) }
          catch (reconciliationError) {
            logAgentEvent('error', 'session.transcript.reconciliation', {
              requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
              outcome: 'commit_uncertain', reasonCode: 'checkpoint-write-and-uncertain-mark-failed', transcriptVersion: checkpoint.version
            })
            throw new HostedTurnFinalizedError(new AggregateError([commitError, reconciliationError], 'Transcript checkpoint and uncertainty marker both failed'), 'commit-uncertain', terminalUsage(terminal))
          }
          logAgentEvent('error', 'session.transcript.reconciliation', {
            requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
            outcome: 'commit_uncertain', reasonCode: 'checkpoint-write-failed', transcriptVersion: checkpoint.version
          })
          throw new HostedTurnFinalizedError(commitError, 'commit-uncertain', terminalUsage(terminal))
        }
        if (!committed.committed) {
          markSessionExecutionUncertain(input.sessionDb!, ownership)
          keepClaimedForReconciliation = true
          logAgentEvent('error', 'session.transcript.reconciliation', {
            requestId: input.invocationId, turnId: ownership.turnId, sessionId: ownership.sessionId,
            outcome: 'commit_uncertain', reasonCode: committed.reason, transcriptVersion: checkpoint.version
          })
          throw new HostedTurnFinalizedError(new Error(`SESSION_TRANSCRIPT_COMMIT_UNCERTAIN:${committed.reason}`, { cause: error }), 'commit-uncertain', terminalUsage(terminal))
        }
      }
      if (error instanceof HostedTurnFinalizedError && error.outcome === 'commit-uncertain') throw error
      // A tool-loop limit is a deliberate, user-facing stop condition (for example,
      // the shell dialect retry breaker). Preserve its diagnostic instead of
      // replacing it with the terminal History event's bare error code.
      if (terminal && !(error instanceof ToolLoopRoundLimitError)) throw new HostedTurnFinalizedError(error, hostedFailureOutcome(terminal), terminalUsage(terminal))
      if (error instanceof ToolLoopRoundLimitError) throw error
      throw error
    } finally {
      try { await runtime.dispose() }
      catch (error) {
        logAgentEvent('warn', 'tool.error', { requestId: input.invocationId, toolName: 'hosted-turn-runtime-dispose', message: error instanceof Error ? error.message : String(error) })
      }
    }
    } finally {
      if (ownership && !keepClaimedForReconciliation) {
        releaseSessionExecution(input.sessionDb!, ownership)
      } else if (!ownership && queuedOwnership) cancelQueuedSessionExecution(input.sessionDb!, queuedOwnership)
    }
  }
}
