import type { CanonicalModelMessage, PreparedModelCall } from '../../packages/agent-sdk/src/model'
import type { HostCommittedModelResponse } from '../../packages/agent-sdk/src/turn'
import type { ApplicationAdmissionPort } from '../../packages/agent-sdk/src/turn'
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

type HostedRuntimeFactory = Readonly<{
  createHostedTurnRuntime(input: Readonly<{ confirmationAdapter?: unknown; authorizedToolNames: ReadonlySet<string>; resolveRegisteredToolName?: (providerToolName: string) => string; hostHistory?: HistoryPort; applicationAdmission?: ApplicationAdmissionPort; deadlineAt?: number; afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']; recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']; refreshExecutionContext?(call: { invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }, stage: Extract<import('../../packages/agent-sdk/src/turn').ToolPreparationStage, { kind: 'recheck' }>, current: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> }>): Promise<Readonly<{ host: Parameters<typeof runHostedAgentTurn>[0]['host']; dispose(): Promise<void> }>> | Readonly<{ host: Parameters<typeof runHostedAgentTurn>[0]['host']; dispose(): Promise<void> }>
}>

type HandoffInput = Readonly<{
  request: PreparedModelCall['request']
  authorizedToolNames: ReadonlySet<string>
  resolveRegisteredToolName: (providerToolName: string) => string
  windowId?: string
  hostHistory?: HistoryPort
  applicationAdmission?: ApplicationAdmissionPort
  deadlineAt?: number
  afterToolResult?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['afterToolResult']
  initialResponse?: HostCommittedModelResponse
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

function logSessionHistoryShadowDiagnostic(input: { requestId: string; sessionId: string; message: string }): void {
  try {
    logAgentEvent('warn', 'tool.error', { ...input, toolName: 'agent-history-session-shadow' })
  } catch {
    // Diagnostic persistence must not affect turn ownership or execution.
  }
}

function terminalOutcome(terminal: { kind: string; payload?: unknown }): 'failed' | 'interrupted' | 'cancelled' {
  if (terminal.kind !== 'invocation-interrupted') return 'failed'
  const payload = terminal.payload && typeof terminal.payload === 'object' ? terminal.payload as Record<string, unknown> : {}
  const sessionLedger = payload.sessionLedger && typeof payload.sessionLedger === 'object' ? payload.sessionLedger as Record<string, unknown> : {}
  return sessionLedger.reason === 'cancelled' ? 'cancelled' : 'interrupted'
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

export function createHostedTurnHandoff(input: {
  agentSdk: HostedRuntimeFactory
  history: HistoryPort
  invocationId: string
  turnId: string
  routeId: string
  sessionId?: string
  maxToolRounds?: number
  hostHistory?: HistoryPort
  recoverProviderAttempt?: import('../../packages/agent-sdk/src/turn').AgentTurnPorts['recoverProviderAttempt']
  refreshExecutionContext?: NonNullable<Parameters<HostedRuntimeFactory['createHostedTurnRuntime']>[0]['refreshExecutionContext']>
  confirmationAdapter?: Partial<Parameters<typeof createAgentSdkConfirmationPort>[0]>
}): NonNullable<RunToolChatSessionArgs['onHostedTurnHandoff']> {
  return async (handoff: HandoffInput): Promise<Readonly<{ result: RunToolChatSessionResult; finalization: HostedTurnFinalization }>> => {
    let request = handoff.request
    if (input.sessionId && handoff.requiredUserMessage && input.history instanceof SqliteAgentHistory) {
      // Existing streams must never silently fall back to legacy session messages.
      const latest = await input.history.readLatestInvocationForSession(input.sessionId, { excludeInvocationId: input.invocationId })
      if (latest.kind === 'unavailable') {
        logSessionHistoryShadowDiagnostic({ requestId: input.invocationId, sessionId: input.sessionId, message: 'history-unavailable' })
        throw new Error('Canonical session History could not safely provide the Hosted transcript')
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
        } catch (error) {
          const reason = error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : 'history-read-failed'
          logSessionHistoryShadowDiagnostic({ requestId: input.invocationId, sessionId: input.sessionId, message: reason })
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
      resolveRegisteredToolName: handoff.resolveRegisteredToolName,
      hostHistory: handoff.hostHistory ?? input.hostHistory ?? historyFacade,
      ...(handoff.applicationAdmission ? { applicationAdmission: handoff.applicationAdmission } : {}),
      ...(handoff.deadlineAt !== undefined ? { deadlineAt: handoff.deadlineAt } : {}),
      ...(handoff.afterToolResult ? { afterToolResult: handoff.afterToolResult } : {}),
      ...(input.maxToolRounds !== undefined ? { maxToolRounds: input.maxToolRounds } : {}),
      ...(input.refreshExecutionContext ? { refreshExecutionContext: input.refreshExecutionContext } : {}),
      ...(input.recoverProviderAttempt ? { recoverProviderAttempt: input.recoverProviderAttempt } : {})
    })
    try {
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
        throw new HostedTurnFinalizedError(new Error(`Hosted invocation ended as ${terminal.kind}`), terminalOutcome(terminal))
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
        throw new HostedTurnFinalizedError(new AggregateError([error, historyError], 'Hosted History terminal state could not be read'), 'failed')
      }
      const terminal = [...snapshot.events].reverse().find((event) => event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted')
      if (terminal && !(error instanceof ToolLoopRoundLimitError)) throw new HostedTurnFinalizedError(error, terminalOutcome(terminal), terminalUsage(terminal))
      if (error instanceof ToolLoopRoundLimitError) throw error
      throw error
    } finally {
      try { await runtime.dispose() }
      catch (error) {
        logAgentEvent('warn', 'tool.error', { requestId: input.invocationId, toolName: 'hosted-turn-runtime-dispose', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
