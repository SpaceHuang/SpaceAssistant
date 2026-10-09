import { collectModelAttempt, InvalidModelStreamError, ModelRouteChangedError, snapshotPreparedModelCall, type CanonicalContentBlock, type CanonicalModelMessage, type CanonicalToolCall, type CollectedModelStream, type ModelProvider, type ModelProviderRegistry, type PreparedModelCall, type StreamChunk } from './model'
import type { PermitBinding } from './safetyPermit'
import { type SafetyDenyReason, type SafetyGatePort } from './safetyGate'
import { ToolExecutionAfterDispatchError, ToolExecutionRejectedError, type PermitBoundToolExecutionPort } from './toolExecutionPort'
import { createHash } from 'node:crypto'
import { surfaceItemIdentities, surfaceItemIdentity } from './contextIdentity'
import { InvocationHistoryWriter, type HistoryEvent, type HistoryPort, type HistorySnapshot } from './history'
import { createContextRegistrar, createInvocationContextPort, type ContextFrame, type ContextItem, type ContextProjectionCommitter, type ContextScope } from './context'
import { ResourceLockRegistry } from './resourceLock'
import { CapacityLedger, type CapacityReservation } from './capacity'
import { Semaphore } from './runtime/semaphore'

export type AgentTurnPorts = Readonly<{
  registry: ModelProviderRegistry
  safetyGate: SafetyGatePort
  prepareTool(call: CanonicalToolExecutionCall, stage: ToolPreparationStage): Promise<PermitBinding>
  /** Release host planning state when a proposal is deterministically stopped before dispatch. */
  discardPreparedTool?(call: CanonicalToolExecutionCall, reason: string): void | Promise<void>
  /** Pure dispatch admission. Rejections are committed as not-dispatched and returned to the model. */
  beforeToolDispatch?(call: CanonicalToolExecutionCall, context: Readonly<{ modelTurn: number; toolCallIndex: number; responseToolCallCount: number }>): Promise<Readonly<{ kind: 'dispatch' }> | Readonly<{ kind: 'reject'; reasonCode: string; message: string }>> | Readonly<{ kind: 'dispatch' }> | Readonly<{ kind: 'reject'; reasonCode: string; message: string }>
  /** Persist actual provider usage once, including complete responses discarded during recovery. */
  recordProviderAttemptUsage?(input: Record<string, unknown>): void | Promise<void>
  /** Recover one provider attempt that failed before an assistant response was accepted. */
  recoverProviderAttempt?(input: Readonly<{ error?: unknown; response?: Readonly<{ finishReason: Extract<StreamChunk, { type: 'finish' }>['reason']; usage: Extract<StreamChunk, { type: 'usage' }>; hasOutputContent: boolean }>; attempt: number; modelTurn: number; routeId: string; request: PreparedModelCall['request']; messages: readonly CanonicalTurnMessage[]; currentUserMessageId?: string; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }> }>): Promise<Readonly<{ kind?: 'retry'; reasonCode: string; messages: readonly CanonicalTurnMessage[]; retryEvent?: Readonly<{ attempt: number; code: string }>; requestPatch?: Partial<Pick<PreparedModelCall['request'], 'thinking' | 'maxTokens'>>; recordTranscriptCompaction?: boolean } | { kind: 'reject'; reasonCode: string }> | undefined>
  /** Convert an accepted max-output-limit response into a bounded runtime continuation message. */
  recoverOutputLimit?(input: Readonly<{ invocationId: string; modelTurn: number; attempt: number; hadVisibleText: boolean; toolCalls: readonly CanonicalToolExecutionCall[] }>): Promise<Readonly<{ continuation?: CanonicalModelMessage; toolCallErrorContent?: string; retryLocation?: unknown; retryTurnId?: string; retryStepId?: string }> | undefined>
  confirmation?: ConfirmationPort
  toolExecution: PermitBoundToolExecutionPort<CanonicalToolExecutionCall, CanonicalToolExecutionResult>
  request: Omit<PreparedModelCall['request'], 'messages'>
  observer?: AgentTurnObserver
  routeId: string
  invocationId: string
  sessionId?: string
  turnId?: string
  windowId?: string
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  history?: HistoryPort
  contextProjectionCommitter?: ContextProjectionCommitter
  maxModelTurns: number
  /** Legacy product bound counts dispatched tool rounds; model requests do not consume this bound. */
  maxToolRounds?: number
  /** Product hosts may preserve the legacy conversational denial result instead of terminating the invocation. */
  returnDeniedToolsToModel?: boolean
  maxConcurrentTools?: number
  /** Resource identity resolver supplied by the host; unknown side effects are serialized conservatively. */
  resourceLocks?: { acquire(keys: readonly string[], options?: { signal?: AbortSignal }): Promise<{ release(): void }> }
  /** Returns the normalized host resource keys affected by this call; undefined is treated as an unknown side effect. */
  toolResourceKeys?(call: CanonicalToolExecutionCall): readonly string[] | undefined
  /** Uses the host's existing tool metadata to preserve bounded approval-candidate scheduling. */
  isApprovalCandidate?(call: CanonicalToolExecutionCall): boolean
  sessionLedgerForToolResult?(call: CanonicalToolExecutionCall, result: CanonicalToolExecutionResult): Promise<Record<string, unknown>> | Record<string, unknown>
  /** Host product policy after a tool result is durably committed and before the next model request. */
  afterToolResult?(call: CanonicalToolExecutionCall, result: CanonicalToolExecutionResult, source?: Readonly<{ kind: 'execution' | 'safety-rejection'; reasonCode?: string; modelTurn?: number }>): void | Promise<void>
  /** Single planner for initial-request and accepted-response context replacement. */
  planContextReplacement?(input: ContextReplacementPlanInput): Promise<ContextReplacementPlanResult | void>
  sessionLedgerForNotDispatched?(call: CanonicalToolExecutionCall, reason: string, result: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionLedgerForModelResponse?(message: CanonicalTurnMessage, modelTurn: number, attempt: number, committedSessionLedger?: unknown): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionLedgerForAttemptUsage?(attempt: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionLedgerForInvocationTerminal?(terminal: { status: 'completed' | 'failed' | 'interrupted'; turnId: string; sessionEventReason?: 'completed' | 'failed' | 'interrupted' | 'cancelled' }): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionTranscriptBaseVersion?: number
  sessionTranscriptFailureMessages?: readonly CanonicalTurnMessage[]
}>

export type ContextReplacementPlanInput = Readonly<{
  phase: 'preflight'
  invocationId: string
  modelTurn: number
  windowId?: string
  request: PreparedModelCall['request']
  messages: readonly CanonicalTurnMessage[]
  requestProjection?: unknown
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}> | Readonly<{
  phase: 'turn-boundary'
  invocationId: string
  modelTurn: number
  windowId?: string
  response: CanonicalTurnMessage
  messages: readonly CanonicalTurnMessage[]
  toolCalls: readonly CanonicalToolExecutionCall[]
  usage: AgentTurnResult['usage']
  requestProjection?: unknown
  currentUserMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
}>

export type ContextReplacementPlanResult = Readonly<{
  messages: readonly CanonicalTurnMessage[]
  windowId?: string
  historyPayload?: Record<string, unknown>
}> | Readonly<{ rejected: 'OVER_BUDGET' }>

export type AgentTurnHost = Readonly<{
  createPorts(invocation: { invocationId: string; sessionId?: string; turnId?: string; windowId?: string; currentUserMessageId?: string; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>; sessionTranscriptBaseVersion?: number; sessionTranscriptFailureMessages?: readonly CanonicalTurnMessage[]; routeId: string; request: PreparedModelCall['request'] }): Promise<AgentTurnPorts>
}>

export type AgentTurnObserver = Readonly<{
  /** Treat host response projection as a required commit step; failures stop before tool dispatch. */
  criticalModelResponseProjection?: boolean
  criticalModelRequestProjection?: boolean
  /** Require durable accounting for each completed or discarded provider attempt. */
  criticalModelAttemptUsageProjection?: boolean
  /** Treat host tool lifecycle projections as required steps around dispatch and before the next model request. */
  criticalToolProjection?: boolean
  onModelRequest?(request: Readonly<{ modelTurn: number; attempt: number; routeId: string; windowId?: string; request: PreparedModelCall['request']; currentUserMessageId?: string; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }> }>): void | Promise<void>
  prepareUsageAttribution?(input: Readonly<{ modelTurn: number; request: PreparedModelCall['request'] }>): Record<string, unknown> | void
  prepareModelRequest?(request: Readonly<{ modelTurn: number; attempt: number; routeId: string; windowId?: string; request: PreparedModelCall['request']; currentUserMessageId?: string; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }> }>): Readonly<{ sessionLedger?: unknown; requestProjection?: unknown }> | void | Promise<Readonly<{ sessionLedger?: unknown; requestProjection?: unknown }> | void>
  onProviderRetry?(retry: Readonly<{ attempt: number; modelTurn: number; routeId: string; requestId: string; code: string }>): void | Promise<void>
  onModelAttemptDiscarded?(attempt: Readonly<{ attempt: number; modelTurn: number; reasonCode: string }>): void | Promise<void>
  prepareProviderRetry?(retry: Readonly<{ attempt: number; modelTurn: number; routeId: string; requestId: string; code: string }>): Readonly<{ location: unknown; requestRetry: Record<string, unknown> }> | void | Promise<Readonly<{ location: unknown; requestRetry: Record<string, unknown> }> | void>
  prepareContextBoundaryEvidence?(response: Readonly<{ message: CanonicalTurnMessage; finishReason: Extract<import('./model').StreamChunk, { type: 'finish' }>['reason']; usage: Extract<StreamChunk, { type: 'usage' }>; modelTurn: number }>): Readonly<{ sessionLedger?: unknown; contextBoundaryEvidence?: unknown }> | void | Promise<Readonly<{ sessionLedger?: unknown; contextBoundaryEvidence?: unknown }> | void>
  onOutputRecovery?(recovery: Readonly<{ attempt: number; modelTurn: number; requestId: string; toolCalls: readonly CanonicalToolExecutionCall[]; willRetry: boolean; toolCallErrorContent: string; sessionLedgerEvents: readonly HistoryEvent[] }>): void | Promise<void>
  onModelChunk?(chunk: Exclude<import('./model').StreamChunk, { type: 'finish' }>): void | Promise<void>
  onModelResponseCommitted?(response: Readonly<{ message: CanonicalTurnMessage; finishReason: Extract<import('./model').StreamChunk, { type: 'finish' }>['reason']; usage: Extract<StreamChunk, { type: 'usage' }>; modelTurn: number; alreadyProjected?: boolean; committedStepId?: string }>): void | Promise<void>
  onToolStarted?(call: CanonicalToolExecutionCall): void | Promise<void>
  onToolFinished?(call: CanonicalToolExecutionCall, result: CanonicalToolExecutionResult): void | Promise<void>
  onDispatchStoppedWithPending?(event: Readonly<{ modelTurn: number; reason: string; attemptedCount: number; undispatchedToolCallIds: readonly string[] }>): void | Promise<void>
  onUndispatchedToolsMaterialized?(event: Readonly<{ modelTurn: number; count: number }>): void | Promise<void>
  onToolDispatchFailureContext?(event: Readonly<{ modelTurn: number; stepId: string; toolCallId: string; toolName: string; reasonCode: string }>): void | Promise<void>
  onTurnOutputReady?(result: AgentTurnResult): void | Promise<void>
  onTurnFinished?(result: AgentTurnResult): void | Promise<void>
  onTurnFailed?(failure: Readonly<{ error: unknown; status: 'cancelled' | 'interrupted' | 'denied' | 'failed' }>): void | Promise<void>
  onObservationError?(error: unknown, stage: 'model-request' | 'model-chunk' | 'model-attempt-discarded' | 'model-response-committed' | 'model-attempt-usage' | 'tool-started' | 'tool-finished' | 'turn-output-ready' | 'turn-finished' | 'turn-failed' | 'history-terminal' | 'prepared-tool-discard' | 'dispatch-diagnostic'): void | Promise<void>
}>

export type HostCommittedModelResponse = Readonly<{
  message: CanonicalTurnMessage
  finishReason: Extract<StreamChunk, { type: 'finish' }>['reason']
  usage: Extract<StreamChunk, { type: 'usage' }>
  historyCommitted: true
  /** The existing host already committed this response to user facts and session-event projections. */
  hostProjectionCommitted?: true
}>

export type AgentTurnResult = Readonly<{
  text: string
  messages: readonly CanonicalTurnMessage[]
  modelTurns: number
  finishReason: Extract<StreamChunk, { type: 'finish' }>['reason']
  /** Aggregate provider usage across every model request in this turn. */
  usage: Readonly<{ inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
  parked?: true
  parkedTodoId?: string
}>

class DeferredTurnParkedError extends Error {
  constructor() { super('INVOCATION_PARKED_FOR_DEFERRED_APPROVAL'); this.name = 'DeferredTurnParkedError' }
}

function freezeRequestSnapshot<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return value
  if (Array.isArray(value)) {
    for (const item of value) freezeRequestSnapshot(item)
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeRequestSnapshot(item)
  }
  return Object.freeze(value)
}

function snapshotHostedRequest(request: PreparedModelCall['request']): PreparedModelCall['request'] {
  return freezeRequestSnapshot({
    ...request,
    messages: structuredClone([...request.messages]),
    ...(request.tools ? { tools: structuredClone([...request.tools]) } : {}),
    ...(request.thinking ? { thinking: structuredClone(request.thinking) } : {}),
    ...(request.credentials ? { credentials: structuredClone(request.credentials) } : {})
  })
}

/** Host entrypoint: the SDK owns the turn loop; hosts only resolve model/safety/execution ports. */
export async function runHostedAgentTurn(input: {
  host: AgentTurnHost
  invocationId: string
  sessionId?: string
  turnId?: string
  windowId?: string
  currentUserMessageId?: string
  assistantMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  routeId: string
  request: PreparedModelCall['request']
  /** Optional already-collected first response; requires an exact matching committed History event. */
  initialResponse?: HostCommittedModelResponse
  sessionTranscriptBaseVersion?: number
  contextProjectionCommitter?: ContextProjectionCommitter
  sessionTranscriptFailureMessages?: readonly CanonicalTurnMessage[]
  observer?: AgentTurnObserver
}): Promise<AgentTurnResult> {
  if (!input.routeId.trim()) throw new Error('hosted turn routeId is required')
  if (input.currentUserMessageId && !input.requiredUserMessage) {
    throw new Error('current user message id requires an explicit canonical required user message')
  }
  if (input.currentUserMessageId && input.requiredUserMessage?.id !== input.currentUserMessageId) {
    throw new Error('current user message id does not match its required user message')
  }
  if (input.requiredUserMessage && (input.requiredUserMessage.message.role !== 'user' ||
    !input.request.messages.some((message) => JSON.stringify(message) === JSON.stringify(input.requiredUserMessage!.message)))) {
    throw new Error('required user message must exactly match a request message')
  }
  const request = snapshotHostedRequest(input.request)
  const requiredUserMessage = input.requiredUserMessage ? freezeRequestSnapshot(structuredClone(input.requiredUserMessage)) : undefined
  const ports = await input.host.createPorts({ invocationId: input.invocationId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.windowId ? { windowId: input.windowId } : {}), ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}), ...(requiredUserMessage ? { requiredUserMessage } : {}), ...(input.sessionTranscriptBaseVersion !== undefined ? { sessionTranscriptBaseVersion: input.sessionTranscriptBaseVersion } : {}), ...(input.sessionTranscriptFailureMessages ? { sessionTranscriptFailureMessages: input.sessionTranscriptFailureMessages } : {}), routeId: input.routeId, request })
  if (ports.invocationId !== input.invocationId) throw new Error('host returned ports for a different invocation')
  if (input.turnId && ports.turnId !== input.turnId) throw new Error('host returned ports for a different turn')
  if (ports.routeId !== input.routeId) throw new Error('host returned ports for a different route')
  return runAgentTurn({ ...ports, request, sessionId: input.sessionId, windowId: input.windowId ?? ports.windowId, currentUserMessageId: input.currentUserMessageId, assistantMessageId: input.assistantMessageId, ...(requiredUserMessage ? { requiredUserMessage } : {}), ...(input.initialResponse ? { initialResponse: input.initialResponse } : {}), ...(input.contextProjectionCommitter ?? ports.contextProjectionCommitter ? { contextProjectionCommitter: input.contextProjectionCommitter ?? ports.contextProjectionCommitter } : {}), maxToolRounds: ports.maxToolRounds, observer: input.observer ?? ports.observer })
}

export type { CanonicalContentBlock, CanonicalToolCall } from './model'
export type CanonicalTurnMessage = CanonicalModelMessage

type CanonicalToolExecutionCall = { invocationId: string; toolCallId: string; toolName: string; input: Record<string, unknown>; signal?: AbortSignal }
type CanonicalToolExecutionResult = { output: unknown; replayContent?: unknown; isError?: boolean; auditRef?: string }
export type ToolPreparationStage =
  | Readonly<{ kind: 'initial' }>
  | Readonly<{ kind: 'recheck'; confirmation?: Readonly<{ receipt: string }> }>
export type ToolConfirmationResult = Readonly<{
  answerer?: 'user' | 'agent'
  cause?: string
  userMessage?: string
  /** Opaque host-selected confirmation memory; consumed by the host callback and never written to History. */
  selectedMemory?: unknown
}> & (
  | Readonly<{ kind: 'approved'; receipt: string }>
  | Readonly<{ kind: 'deferred'; todoId: string; invocationId: string; checkpointRef: Readonly<{ checkpointId: string; workflowRevision: number }> }>
  | Readonly<{ kind: 'denied' | 'timeout' | 'unavailable' | 'cancelled' }>
)
export type ConfirmationPort = (input: {
  call: CanonicalToolExecutionCall
  /** Model response batch within the current turn; used for batch-scoped confirmation decisions. */
  modelTurn: number
  confirmationId: string
  answerer: 'user' | 'agent'
  reasonCode: string
  context?: unknown
  signal?: AbortSignal
}) => Promise<ToolConfirmationResult>

export class ToolDeniedError extends Error {
  readonly code = 'TOOL_DENIED'
  constructor(readonly reasonCode: SafetyDenyReason | string, readonly userMessage?: string) { super(`tool call denied: ${reasonCode}`); this.name = 'ToolDeniedError' }
}

export class ModelTurnLimitError extends Error {
  readonly code = 'MODEL_TURN_LIMIT'
  constructor(readonly maxModelTurns: number) { super(`model turn limit reached: ${maxModelTurns}`); this.name = 'ModelTurnLimitError' }
}

export class ModelPreflightRejectedError extends Error {
  readonly code = 'MODEL_PREFLIGHT_REJECTED'
  constructor(readonly reason: 'OVER_BUDGET') { super(`model request preflight rejected: ${reason}`); this.name = 'ModelPreflightRejectedError' }
}

export class ToolLoopRoundLimitError extends Error {
  readonly code = 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED'
  constructor(readonly maxToolRounds: number, message = `TOOL_LOOP_MAX_ROUNDS_EXCEEDED(${maxToolRounds})`) { super(message); this.name = 'ToolLoopRoundLimitError' }
}

export class ModelOutputTokenLimitError extends Error {
  readonly code = 'MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED'
  constructor(readonly attempts: number) { super(`model output token limit recovery exhausted after ${attempts} attempts`); this.name = 'ModelOutputTokenLimitError' }
}

export class AgentTurnCancelledError extends Error {
  readonly code = 'TURN_CANCELLED'
  constructor() { super('agent turn cancelled'); this.name = 'AgentTurnCancelledError' }
}

export const AGENT_TURN_TIMEOUT_ABORT_REASON = 'agent-turn-timeout' as const

export class AgentTurnTimedOutError extends Error {
  readonly code = 'TURN_TIMED_OUT'
  constructor() { super('agent turn timed out'); this.name = 'AgentTurnTimedOutError' }
}

function isTurnTimeoutSignal(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason === AGENT_TURN_TIMEOUT_ABORT_REASON
}

async function sessionTranscriptMessagesForFailure(input: RunAgentTurnInput): Promise<readonly CanonicalTurnMessage[] | undefined> {
  const baseline = input.sessionTranscriptFailureMessages
  if (!baseline || !input.history) return baseline
  let snapshot: HistorySnapshot
  try { snapshot = await input.history.read(input.invocationId) }
  catch { return undefined }
  const compacted = [...snapshot.events].reverse().find((event) => event.kind === 'transcript-compacted')
  if (!compacted) return baseline
  const payload = compacted.payload && typeof compacted.payload === 'object' ? compacted.payload as { messages?: unknown } : undefined
  if (!Array.isArray(payload?.messages) || !payload.messages.every((message) => message && typeof message === 'object' && !Array.isArray(message))) return undefined
  const messages = payload.messages as CanonicalTurnMessage[]
  if (!input.requiredUserMessage) return undefined
  const required = JSON.stringify(input.requiredUserMessage.message)
  let acceptedIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (JSON.stringify(messages[index]) === required) { acceptedIndex = index; break }
  }
  return acceptedIndex >= 0 ? messages.slice(0, acceptedIndex + 1) : undefined
}

function abortErrorForSignal(signal?: AbortSignal): AgentTurnCancelledError | AgentTurnTimedOutError {
  return isTurnTimeoutSignal(signal) ? new AgentTurnTimedOutError() : new AgentTurnCancelledError()
}

export class InvalidTurnBoundaryError extends Error {
  readonly code = 'INVALID_TURN_BOUNDARY'
  constructor(message: string) { super(message); this.name = 'InvalidTurnBoundaryError' }
}

class AgentTurnBoundaryProjectionError extends Error {
  constructor(readonly originalError: unknown) {
    super(`turn boundary ledger projection failed: ${originalError instanceof Error ? originalError.message : String(originalError)}`)
    this.name = 'AgentTurnBoundaryProjectionError'
  }
}

export class ModelAttemptRecoveryRejectedError extends Error {
  readonly code = 'MODEL_ATTEMPT_RECOVERY_REJECTED'
  constructor(readonly reasonCode: string) { super(`model attempt recovery rejected: ${reasonCode}`); this.name = 'ModelAttemptRecoveryRejectedError' }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortErrorForSignal(signal)
}

export type RunAgentTurnInput = {
  registry: ModelProviderRegistry
  routeId: string
  request: Omit<PreparedModelCall['request'], 'messages'> & { messages: readonly CanonicalTurnMessage[] }
  initialResponse?: HostCommittedModelResponse
  safetyGate: SafetyGatePort
  prepareTool(call: CanonicalToolExecutionCall, stage: ToolPreparationStage): Promise<PermitBinding>
  discardPreparedTool?(call: CanonicalToolExecutionCall, reason: string): void | Promise<void>
  beforeToolDispatch?(call: CanonicalToolExecutionCall, context: Readonly<{ modelTurn: number; toolCallIndex: number; responseToolCallCount: number }>): ReturnType<NonNullable<AgentTurnPorts['beforeToolDispatch']>>
  recordProviderAttemptUsage?(input: Record<string, unknown>): void | Promise<void>
  confirmation?: ConfirmationPort
  /** Only the SDK's permit-bound factory can produce this port; host resolver must use its private prepared record. */
  toolExecution: PermitBoundToolExecutionPort<CanonicalToolExecutionCall, CanonicalToolExecutionResult>
  invocationId: string
  sessionId?: string
  windowId?: string
  maxModelTurns: number
  /** Product bound counts tool execution rounds independently from provider request retries. */
  maxToolRounds?: number
  returnDeniedToolsToModel?: boolean
  observer?: AgentTurnObserver
  turnId?: string
  currentUserMessageId?: string
  assistantMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  history?: HistoryPort
  contextProjectionCommitter?: ContextProjectionCommitter
  maxConcurrentTools?: number
  resourceLocks?: { acquire(keys: readonly string[], options?: { signal?: AbortSignal }): Promise<{ release(): void }> }
  toolResourceKeys?(call: CanonicalToolExecutionCall): readonly string[] | undefined
  isApprovalCandidate?(call: CanonicalToolExecutionCall): boolean
  sessionLedgerForToolResult?(call: CanonicalToolExecutionCall, result: CanonicalToolExecutionResult): Promise<Record<string, unknown>> | Record<string, unknown>
  afterToolResult?(call: CanonicalToolExecutionCall, result: CanonicalToolExecutionResult, source?: Readonly<{ kind: 'execution' | 'safety-rejection'; reasonCode?: string; modelTurn?: number }>): void | Promise<void>
  sessionLedgerForNotDispatched?(call: CanonicalToolExecutionCall, reason: string, result: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionLedgerForModelResponse?(message: CanonicalTurnMessage, modelTurn: number, attempt: number, committedSessionLedger?: unknown): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionLedgerForAttemptUsage?(attempt: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionLedgerForInvocationTerminal?(terminal: { status: 'completed' | 'failed' | 'interrupted'; turnId: string; sessionEventReason?: 'completed' | 'failed' | 'interrupted' | 'cancelled' }): Promise<Record<string, unknown>> | Record<string, unknown>
  sessionTranscriptBaseVersion?: number
  sessionTranscriptFailureMessages?: readonly CanonicalTurnMessage[]
  planContextReplacement?(input: Parameters<NonNullable<AgentTurnPorts['planContextReplacement']>>[0]): ReturnType<NonNullable<AgentTurnPorts['planContextReplacement']>>
  recoverProviderAttempt?(input: Parameters<NonNullable<AgentTurnPorts['recoverProviderAttempt']>>[0]): ReturnType<NonNullable<AgentTurnPorts['recoverProviderAttempt']>>
  recoverOutputLimit?(input: Parameters<NonNullable<AgentTurnPorts['recoverOutputLimit']>>[0]): ReturnType<NonNullable<AgentTurnPorts['recoverOutputLimit']>>
  /** Provider 流空闲超时（无进展护栏）：相邻 chunk（含首字节）间隔超过该毫秒数即抛
   *  ModelStreamIdleTimeoutError 并走 recoverProviderAttempt 重试；缺省 120s，0/负值关闭。 */
  providerStreamIdleTimeoutMs?: number
}

type AppendTurnHistory = (events: readonly Readonly<{ kind: HistoryEvent['kind']; payload: unknown }>[], transcriptCommit?: import('./history').SessionTranscriptCommitIntent) => Promise<readonly HistoryEvent[]>

class AgentTurnHistoryAppendError extends Error {
  constructor(readonly kinds: readonly HistoryEvent['kind'][], readonly originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError)
    super(`history append failed (${kinds.join(',')}): ${detail}`)
    this.name = 'AgentTurnHistoryAppendError'
  }
}

class AgentTurnHostProjectionError extends Error {
  constructor(readonly originalError: unknown) {
    super(`host response projection failed: ${originalError instanceof Error ? originalError.message : String(originalError)}`)
    this.name = 'AgentTurnHostProjectionError'
  }
}

class AgentTurnToolProjectionError extends Error {
  constructor(readonly originalError: unknown) {
    super(`host tool projection failed: ${originalError instanceof Error ? originalError.message : String(originalError)}`)
    this.name = 'AgentTurnToolProjectionError'
  }
}

class AgentTurnHistoryAlreadyTerminalError extends Error {
  constructor(invocationId: string) {
    super(`History invocation is already terminal: ${invocationId}`)
    this.name = 'AgentTurnHistoryAlreadyTerminalError'
  }
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult> {
  if (input.observer?.criticalModelResponseProjection && !input.observer.onModelResponseCommitted) {
    throw new Error('critical model response projection requires onModelResponseCommitted')
  }
  if (input.observer?.criticalModelRequestProjection && !input.observer.onModelRequest) {
    throw new Error('critical model request projection requires onModelRequest')
  }
  if (input.observer?.criticalModelAttemptUsageProjection && !input.recordProviderAttemptUsage) {
    throw new Error('critical model attempt usage projection requires recordProviderAttemptUsage')
  }
  if (input.observer?.criticalToolProjection && (!input.observer.onToolStarted || !input.observer.onToolFinished)) {
    throw new Error('critical tool projection requires onToolStarted and onToolFinished')
  }
  const writer = input.history
    ? new InvocationHistoryWriter(input.history, { invocationId: input.invocationId, turnId: input.turnId ?? input.invocationId })
    : undefined
  const appendHistory: AppendTurnHistory = async (events, transcriptCommit) => {
    if (!writer) return []
    try {
      const result = await writer.append(events, transcriptCommit)
      return result.events
    } catch (error) {
      throw new AgentTurnHistoryAppendError(events.map(({ kind }) => kind), error)
    }
  }
  const appendTerminalHistory = async (kind: HistoryEvent['kind'], payload: unknown, sessionLedger?: Record<string, unknown>, transcriptCommit?: import('./history').SessionTranscriptCommitIntent): Promise<void> => {
    const persistedPayload = sessionLedger ? { ...(payload as Record<string, unknown>), sessionLedger } : payload
    try {
      await appendHistory([{ kind, payload: persistedPayload }], transcriptCommit)
    } catch (error) {
      // Preserve the terminal fact when the transcript participant itself fails. The host then
      // observes the original commit error and can fence/reconcile the session instead of
      // misclassifying a rolled-back terminal as a missing History event.
      if (transcriptCommit) {
        try { await appendHistory([{ kind, payload: persistedPayload }]) }
        catch { /* The original atomic append error remains authoritative. */ }
      }
      await observe(input.observer, 'history-terminal', () => input.observer?.onObservationError?.(error, 'history-terminal'))
      if (input.history) {
        try {
          const snapshot = await input.history.read(input.invocationId)
          const terminal = [...snapshot.events].reverse().find((event) =>
            event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted'
          )
          if (!transcriptCommit && terminal?.kind === kind && terminal.invocationId === input.invocationId &&
            terminal.turnId === (input.turnId ?? input.invocationId) &&
            JSON.stringify(terminal.payload) === JSON.stringify(persistedPayload)) return
        } catch { /* The append error remains authoritative when its outcome cannot be read. */ }
      }
      throw error
    }
  }
  let lastValidUsage: Extract<StreamChunk, { type: 'usage' }> | undefined
  try {
    const result = await runAgentTurnLoop(input, appendHistory, writer, (usage) => { lastValidUsage = usage })
    if (result.parked) {
      const terminalPayload = { status: 'parked' as const, reason: 'deferred-approval', todoId: result.parkedTodoId, outputText: result.text, usage: result.usage }
      await appendTerminalHistory('invocation-parked', terminalPayload)
      return result
    }
    await projectTurnOutput(input.observer, result)
    const terminalPayload = { status: 'completed' as const, outputText: result.text, usage: result.usage }
    const sessionLedger = input.sessionLedgerForInvocationTerminal
      ? await input.sessionLedgerForInvocationTerminal({ ...terminalPayload, turnId: input.turnId ?? input.invocationId })
      : undefined
    const transcriptCommit = input.sessionId && input.sessionTranscriptBaseVersion !== undefined
      ? { sessionId: input.sessionId, baseVersion: input.sessionTranscriptBaseVersion, outcome: 'completed' as const,
          messages: result.messages.filter((message) => message.role !== 'system') as readonly Readonly<Record<string, unknown>>[],
          ...(input.assistantMessageId ? { messageMirror: { messageId: input.assistantMessageId, status: 'completed' as const, content: result.text } } : {}) }
      : undefined
    await appendTerminalHistory('invocation-completed', terminalPayload, sessionLedger, transcriptCommit)
    await observe(input.observer, 'turn-finished', () => input.observer?.onTurnFinished?.(result))
    return result
  } catch (error) {
    let failureSettlementUncertain = false
    if (input.history && !(error instanceof AgentTurnHistoryAlreadyTerminalError)) {
      try {
        const snapshot = await input.history.read(input.invocationId)
        const terminalExists = snapshot.events.some((event) => event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted')
        if (!terminalExists) {
          const pending = new Map<string, { id: string; name: string; input: Record<string, unknown> }>()
          const started = new Set<string>()
          for (const event of snapshot.events) {
            const payload = event.payload && typeof event.payload === 'object' ? event.payload as {
              message?: { toolCalls?: readonly { id?: unknown; name?: unknown; input?: unknown }[] }
              toolCallId?: unknown
            } : undefined
            if (event.kind === 'model-response-committed') {
              for (const tool of payload?.message?.toolCalls ?? []) {
                if (typeof tool.id === 'string' && typeof tool.name === 'string' && tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)) {
                  pending.set(tool.id, { id: tool.id, name: tool.name, input: tool.input as Record<string, unknown> })
                  started.delete(tool.id)
                }
              }
            }
            if (event.kind === 'tool-call-started' && typeof payload?.toolCallId === 'string' && pending.has(payload.toolCallId)) started.add(payload.toolCallId)
            if ((event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched' || event.kind === 'tool-call-deferred') && typeof payload?.toolCallId === 'string') {
              pending.delete(payload.toolCallId)
              started.delete(payload.toolCallId)
            }
          }
          for (const tool of pending.values()) {
            if (started.has(tool.id)) {
              failureSettlementUncertain = true
              continue
            }
            const reason = 'TURN_FAILED_BEFORE_TOOL_DISPATCH'
            const sessionResult = { success: false, data: `Tool call was not dispatched (${reason}).` }
            try {
              const sessionLedger = input.sessionLedgerForNotDispatched
                ? await input.sessionLedgerForNotDispatched({ invocationId: input.invocationId, toolCallId: tool.id, toolName: tool.name, input: structuredClone(tool.input) }, reason, sessionResult)
                : undefined
              await appendHistory([{ kind: 'tool-call-not-dispatched', payload: {
                toolCallId: tool.id, reason, replayContent: sessionResult.data, isError: true,
                ...(sessionLedger ? { sessionLedger } : {})
              } }])
            } catch {
              failureSettlementUncertain = true
              break
            }
          }
        }
      } catch {
        failureSettlementUncertain = true
      }
    }
    const resultPersistenceUncertain = failureSettlementUncertain || error instanceof AgentTurnHistoryAppendError && error.kinds.includes('tool-call-finished')
    const executionUncertain = error instanceof ToolExecutionAfterDispatchError
    const boundaryProjectionUncertain = error instanceof AgentTurnBoundaryProjectionError
    const hostProjectionFailed = error instanceof AgentTurnHostProjectionError
    const toolProjectionFailed = error instanceof AgentTurnToolProjectionError
    const status = error instanceof AgentTurnCancelledError
      ? 'cancelled' as const
      : resultPersistenceUncertain || executionUncertain || hostProjectionFailed || toolProjectionFailed || boundaryProjectionUncertain
        ? 'interrupted' as const
        : error instanceof ToolDeniedError ? 'denied' as const : 'failed' as const
    if (!(error instanceof AgentTurnHistoryAlreadyTerminalError)) {
      try {
        const terminalKind = error instanceof AgentTurnCancelledError || resultPersistenceUncertain || executionUncertain || hostProjectionFailed || toolProjectionFailed || boundaryProjectionUncertain ? 'invocation-interrupted' : 'invocation-failed'
        const terminalPayload = error instanceof AgentTurnCancelledError
            ? { status: 'cancelled', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
            : error instanceof AgentTurnTimedOutError
              ? { status: 'failed', reason: 'timeout', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
            : hostProjectionFailed
              ? { status: 'interrupted', reason: 'host-projection-failed', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
            : toolProjectionFailed
              ? { status: 'interrupted', reason: 'tool-projection-failed', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
            : boundaryProjectionUncertain
              ? { status: 'interrupted', reason: 'turn-boundary-ledger-projection-failed', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
            : resultPersistenceUncertain || executionUncertain
              ? { status: 'interrupted', reason: 'unknown-after-dispatch', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
            : error instanceof ToolDeniedError
              ? { status: 'denied', reason: error.reasonCode, ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
              : error && typeof error === 'object' && 'code' in error &&
                (error.code === 'TOOL_LOOP_MAX_ROUNDS_EXCEEDED' || error.code === 'SHELL_DIALECT_MISMATCH')
                ? { status: 'failed', reason: error instanceof Error ? error.message : String(error), errorCode: error.code, ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
                : { status: 'failed', ...(lastValidUsage ? { usage: lastValidUsage } : {}) }
        const status = terminalKind === 'invocation-interrupted' ? 'interrupted' as const : 'failed' as const
        const sessionLedger = input.sessionLedgerForInvocationTerminal
          ? await input.sessionLedgerForInvocationTerminal({ status, turnId: input.turnId ?? input.invocationId, ...(error instanceof AgentTurnCancelledError ? { sessionEventReason: 'cancelled' } : {}) })
          : undefined
        const transcriptOutcome: import('./history').SessionTranscriptCommitIntent['outcome'] = error instanceof AgentTurnCancelledError ? 'cancelled'
          : error instanceof AgentTurnTimedOutError ? 'timed_out'
          : status === 'interrupted' ? 'interrupted' : 'failed'
        const failureMessages = await sessionTranscriptMessagesForFailure(input)
        const mirroredFailureMessage = input.assistantMessageId
          ? failureMessages?.find((message) => message.role === 'assistant' && message.id === input.assistantMessageId)
          : undefined
        const mirroredFailureContent = mirroredFailureMessage ? assistantTextForLegacyProjection(mirroredFailureMessage.content) : undefined
        const transcriptCommit = input.sessionId && input.sessionTranscriptBaseVersion !== undefined && failureMessages
          ? { sessionId: input.sessionId, baseVersion: input.sessionTranscriptBaseVersion, outcome: transcriptOutcome,
              messages: failureMessages.filter((message) => message.role !== 'system') as readonly Readonly<Record<string, unknown>>[],
              ...(input.assistantMessageId ? { messageMirror: {
                messageId: input.assistantMessageId,
                status: error instanceof AgentTurnCancelledError ? 'cancelled' as const : 'failed' as const,
                ...(mirroredFailureContent !== undefined ? { content: mirroredFailureContent } : {})
              } } : {}) }
          : undefined
        await appendTerminalHistory(terminalKind, terminalPayload, sessionLedger, transcriptCommit)
      } catch { /* Preserve the original turn failure when terminal persistence also fails. */ }
    }
    await observe(input.observer, 'turn-failed', () => input.observer?.onTurnFailed?.({ error, status }))
    throw error
  }
}

async function ensureInitialHistoryContext(input: RunAgentTurnInput, call: PreparedModelCall, appendHistory: AppendTurnHistory): Promise<void> {
  if (!input.history) return
  const snapshot = await input.history.read(input.invocationId)
  if (snapshot.events.some(({ kind }) => kind === 'invocation-completed' || kind === 'invocation-failed' || kind === 'invocation-interrupted' || kind === 'invocation-parked')) {
    throw new AgentTurnHistoryAlreadyTerminalError(input.invocationId)
  }
  if (snapshot.events.some(({ kind }) => kind === 'invocation-context-committed' || kind === 'transcript-compacted')) {
    assertHistoryRequestCompatibility(snapshot.events, call)
    return
  }
  const requiredUserMessage = input.requiredUserMessage
  if (input.currentUserMessageId && (!requiredUserMessage || requiredUserMessage.id !== input.currentUserMessageId)) {
    throw new Error('current user message id requires an explicit canonical required user message')
  }
  if (snapshot.events.length > 0) {
    const [sessionInput] = snapshot.events
    const payload = sessionInput?.kind === 'session-input-committed' && sessionInput.payload && typeof sessionInput.payload === 'object'
      ? sessionInput.payload as { sessionId?: unknown; messageId?: unknown; role?: unknown; inputFingerprint?: unknown }
      : undefined
    if (snapshot.events.length !== 1 || !input.sessionId || !requiredUserMessage || payload?.sessionId !== input.sessionId ||
      payload.messageId !== requiredUserMessage.id || payload.role !== 'user' || typeof payload.inputFingerprint !== 'string' || !payload.inputFingerprint.trim() ||
      requiredUserMessage.id !== input.currentUserMessageId) {
      throw new Error('history base context is missing for a non-empty invocation')
    }
  }
  if (requiredUserMessage && (requiredUserMessage.message.role !== 'user' ||
    !input.request.messages.some((message) => JSON.stringify(message) === JSON.stringify(requiredUserMessage.message)))) {
      throw new Error('required user message must exactly match a message in the history base')
  }
  await appendHistory([{
    kind: 'invocation-context-committed',
    payload: {
      messages: structuredClone(call.request.messages),
      requestSnapshot: canonicalRequestSnapshot(call),
      ...(requiredUserMessage
        ? { requiredUserMessage: structuredClone(requiredUserMessage) }
        : {})
    }
  }])
}

function assertHistoryRequestCompatibility(events: readonly HistoryEvent[], call: PreparedModelCall): void {
  const withoutMessages = (request: Record<string, unknown>) => Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'messages'))
  const allowedOptions: string[] = []
  let latestOptions: Record<string, unknown> | undefined
  for (const event of events) {
    if (event.kind === 'invocation-context-committed' || event.kind === 'model-request-started' || event.kind === 'model-response-committed') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { requestSnapshot?: unknown } : undefined
      if (payload?.requestSnapshot === undefined) continue // Pre-snapshot history remains readable during the migration window.
      if (!payload.requestSnapshot || typeof payload.requestSnapshot !== 'object') throw new Error('History request snapshot is invalid')
      const persisted = payload.requestSnapshot as { route?: unknown; request?: unknown }
      if (!persisted.route || typeof persisted.route !== 'object' || !persisted.request || typeof persisted.request !== 'object') {
        throw new Error('History request snapshot is incomplete')
      }
      if (!sameRouteIdentity(persisted.route as PreparedModelCall['route'], call.route)) {
        throw new Error(`History request snapshot route mismatch: ${event.eventId}`)
      }
      const options = stableRequestValue(withoutMessages(persisted.request as Record<string, unknown>))
      if (allowedOptions.length && !allowedOptions.includes(options)) throw new Error(`History request snapshot options mismatch: ${event.eventId}`)
      if (!allowedOptions.length) allowedOptions.push(options)
      if (!latestOptions) latestOptions = withoutMessages(persisted.request as Record<string, unknown>)
      else if (options === stableRequestValue(latestOptions)) latestOptions = withoutMessages(persisted.request as Record<string, unknown>)
      continue
    }
    if (event.kind === 'model-attempt-discarded') {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { reasonCode?: unknown; requestPatch?: unknown } : undefined
      if (payload?.reasonCode !== 'EFFORT_UNSUPPORTED' || payload.requestPatch === undefined) continue
      if (!latestOptions || !payload.requestPatch || typeof payload.requestPatch !== 'object') throw new Error(`History request patch is invalid: ${event.eventId}`)
      const patch = payload.requestPatch as { thinking?: unknown }
      if (!patch.thinking || typeof patch.thinking !== 'object' || typeof (patch.thinking as { enabled?: unknown }).enabled !== 'boolean' || 'effort' in (patch.thinking as Record<string, unknown>)) {
        throw new Error(`History effort fallback patch is invalid: ${event.eventId}`)
      }
      latestOptions = { ...latestOptions, thinking: patch.thinking }
      allowedOptions.push(stableRequestValue(latestOptions))
    }
  }
  if (latestOptions) {
    const currentOptions = withoutMessages(snapshotPreparedModelCall(call).request as Record<string, unknown>)
    if (stableRequestValue(currentOptions) !== stableRequestValue(latestOptions)) throw new Error('History request snapshot options mismatch: current request')
  }
}

function stableRequestValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRequestValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableRequestValue(nested)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** @internal Frame projection is exported for contract regression tests, not from the package barrel. */
export function contextFrameFromMessages(
  messages: readonly CanonicalTurnMessage[],
  windowId: string,
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>,
  pendingTools: readonly CanonicalToolCall[] = [],
  base?: ContextFrame,
  checkpoint?: Readonly<{ messageId: string; replayIdentity: string }>
): ContextFrame {
  const sourceIdentities = base ? surfaceItemIdentities(base.items.map(({ message }) => message)) : []
  const sourceBySurfaceIdentity = new Map(base?.items.map((item, index) => [sourceIdentities[index]!, item]) ?? [])
  const baseById = new Map<string, ContextItem[]>()
  for (const item of base?.items ?? []) for (const id of item.sourceMessageIds) baseById.set(id, [...(baseById.get(id) ?? []), item])
  const baseByContent = new Map<string, ContextItem[]>()
  for (const item of base?.items ?? []) {
    const key = JSON.stringify(item.message)
    baseByContent.set(key, [...(baseByContent.get(key) ?? []), item])
  }
  const occurrences = new Map<string, number>()
  const usedIdentities = new Set<string>()
  const items: ContextItem[] = []
  for (const message of messages) {
    const identityHash = createHash('sha256').update(JSON.stringify(message)).digest('hex')
    const occurrence = occurrences.get(identityHash) ?? 0
    occurrences.set(identityHash, occurrence + 1)
    const messageId = typeof (message as { id?: unknown }).id === 'string' ? (message as { id: string }).id : undefined
    const requiredId = requiredUserMessage && JSON.stringify(message) === JSON.stringify(requiredUserMessage.message) ? requiredUserMessage.id : undefined
    const sourceMessageId = messageId ?? requiredId
    const isCheckpoint = Boolean(checkpoint && messageId === checkpoint.messageId)
    const source = (sourceMessageId && !isCheckpoint ? baseById.get(sourceMessageId)?.find((item) => !usedIdentities.has(item.replayIdentity)) : undefined)
      ?? baseByContent.get(JSON.stringify(message))?.find((item) => item.sourceMessageIds.length === 0)
      ?? sourceBySurfaceIdentity.get(surfaceItemIdentity(message, occurrence))
    const replayIdentity = isCheckpoint ? checkpoint!.replayIdentity : source?.replayIdentity ?? messageId ?? `message-${identityHash}-${occurrence}`
    const effectiveSourceMessageIds = isCheckpoint ? [] : source?.sourceMessageIds ?? (sourceMessageId ? [sourceMessageId] : [])
    items.push({
      replayIdentity: usedIdentities.has(replayIdentity) ? `message-${identityHash}-${occurrence}` : replayIdentity,
      sourceMessageIds: effectiveSourceMessageIds,
      message: structuredClone(message),
      sourceData: source?.sourceData ?? {}
    })
    usedIdentities.add(items.at(-1)!.replayIdentity)
  }
  return {
    items,
    system: base?.system ?? '',
    windowId,
    ...(requiredUserMessage ? { requiredUser: structuredClone(requiredUserMessage) } : {}),
    pendingTools: structuredClone([...pendingTools])
  }
}

function contextSourceBindings(base: readonly ContextItem[], output: readonly ContextItem[]): Array<{ outputIdentity: string; inputIdentities: string[] }> {
  const bySourceId = new Map(base.flatMap((item) => item.sourceMessageIds.map((id) => [id, item] as const)))
  return output.flatMap((item) => {
    if (!item.sourceMessageIds.length) {
      const retained = base.find((candidate) => candidate.replayIdentity === item.replayIdentity && !candidate.sourceMessageIds.length && JSON.stringify(candidate.message) === JSON.stringify(item.message))
      return retained ? [{ outputIdentity: item.replayIdentity, inputIdentities: [retained.replayIdentity] }] : []
    }
    const sources = item.sourceMessageIds.map((id) => bySourceId.get(id))
    if (sources.some((source) => !source)) {
      if (item.sourceMessageIds.length === 1 && item.sourceMessageIds[0] === item.replayIdentity) return []
      throw new InvalidTurnBoundaryError('context replacement invented a source message identity')
    }
    const unique = [...new Map(sources.map((source) => [source!.replayIdentity, source!])).values()]
    if (JSON.stringify(unique.flatMap((source) => source.sourceMessageIds)) !== JSON.stringify(item.sourceMessageIds)) {
      throw new InvalidTurnBoundaryError('context replacement changed source identity order')
    }
    return [{ outputIdentity: item.replayIdentity, inputIdentities: unique.map(({ replayIdentity }) => replayIdentity) }]
  })
}

function contextShadowedRanges(historyPayload: Record<string, import('./context').JsonValue>): Array<{ start: string; end: string }> {
  const root = historyPayload.sessionLedger
  if (!root || typeof root !== 'object' || Array.isArray(root)) return []
  const summary = (root as Record<string, import('./context').JsonValue>).summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return []
  const ranges = (summary as Record<string, import('./context').JsonValue>).shadowedRanges
  if (!Array.isArray(ranges)) return []
  return ranges.flatMap((range) => range && typeof range === 'object' && !Array.isArray(range) && typeof (range as Record<string, import('./context').JsonValue>).start === 'string' && typeof (range as Record<string, import('./context').JsonValue>).end === 'string'
    ? [{ start: (range as Record<string, string>).start!, end: (range as Record<string, string>).end! }]
    : [])
}

function extractCheckpointEvidence(historyPayload: Record<string, import('./context').JsonValue>): Record<string, import('./context').JsonValue> {
  const checkpoint = historyPayload.checkpoint
  if (checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) && Object.keys(checkpoint).length > 0) return checkpoint as Record<string, import('./context').JsonValue>
  const ledger = historyPayload.sessionLedger
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return {}
  const summary = (ledger as Record<string, import('./context').JsonValue>).summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return {}
  const record = summary as Record<string, import('./context').JsonValue>
  return typeof record.compactionId === 'string' && record.compactionId.length > 0 ? { compactionId: record.compactionId } : {}
}

function isCheckpointEvidence(historyPayload: Record<string, import('./context').JsonValue>): boolean {
  return Object.keys(extractCheckpointEvidence(historyPayload)).length > 0
}

function checkpointIdentityFromPayload(payload: Record<string, unknown> | undefined): { messageId: string; replayIdentity: string } | undefined {
  const ledger = payload?.sessionLedger
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return undefined
  const summary = (ledger as Record<string, unknown>).summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined
  const candidate = (summary as Record<string, unknown>).candidate
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const record = candidate as Record<string, unknown>
  const checkpointMessage = record.checkpointMessage
  if (!checkpointMessage || typeof checkpointMessage !== 'object' || Array.isArray(checkpointMessage)) return undefined
  const messageId = (checkpointMessage as Record<string, unknown>).id
  const replayIdentity = record.checkpointReplayIdentity
  return typeof messageId === 'string' && typeof replayIdentity === 'string' ? { messageId, replayIdentity } : undefined
}

async function runAgentTurnLoop(input: RunAgentTurnInput, appendHistory: AppendTurnHistory, writer: InvocationHistoryWriter | undefined, onAcceptedUsage: (usage: Extract<StreamChunk, { type: 'usage' }>) => void): Promise<AgentTurnResult> {
  if (!Number.isInteger(input.maxModelTurns) || input.maxModelTurns <= 0) throw new Error('maxModelTurns must be a positive integer')
  if (!input.invocationId.trim()) throw new Error('invocationId is required')
  const invocationId = input.invocationId
  const messages: CanonicalTurnMessage[] = structuredClone([...input.request.messages])
  const resourceLocks = input.resourceLocks ?? new ResourceLockRegistry()
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadInputTokens = 0
  let cacheCreationInputTokens = 0
  let outputRecoveryAttempts = 0
  let dispatchedToolRounds = 0
  let requestTemplate: Omit<PreparedModelCall['request'], 'messages'> = { ...input.request }
  let activeWindowId = input.windowId ?? ''
  let contextEpoch = 0
  let contextPhase: 'preflight' | 'boundary' = 'preflight'
  let contextPendingTools: CanonicalToolCall[] = []
  let contextCaptureOverride: readonly CanonicalTurnMessage[] | undefined
  const contextScope: Extract<ContextScope, { kind: 'invocation' }> = { kind: 'invocation', sessionId: input.sessionId ?? input.invocationId, invocationId }
  const contextRegistrar = createContextRegistrar()
  const invocationContextPort = createInvocationContextPort({ registrar: contextRegistrar, binding: {
    scope: contextScope,
    capture: async () => ({
      frame: contextFrameFromMessages(contextCaptureOverride ?? messages, activeWindowId, input.requiredUserMessage, contextPendingTools),
      phase: contextPhase, epoch: contextEpoch,
      expectedHistoryVersion: writer ? await writer.currentOrPersistedVersion() : 0
    }),
    appendReplacement: async ({ epoch, expectedHistoryVersion, payload }) => {
      if (!writer) throw new InvalidTurnBoundaryError('context replacement requires canonical History')
      try {
        return await writer.appendAtVersion([{ kind: 'transcript-compacted', payload }], expectedHistoryVersion, undefined, () => {
          if (epoch !== contextEpoch) throw new Error('CONTEXT_EPOCH_STALE')
        })
      } catch (error) {
        if (error instanceof Error && (error as Error & { code?: string }).code === 'uncompressible') return { status: 'uncompressible' as const }
        throw error
      }
    },
    applyCommitted: ({ frame, epoch }) => {
      messages.splice(0, messages.length, ...frame.items.map(({ message }) => structuredClone(message)))
      activeWindowId = frame.windowId
      contextEpoch = epoch
    }
  } })
  let pinnedRoute: PreparedModelCall['route'] | undefined
  let pinnedProvider: ModelProvider | undefined

  for (let modelTurns = 1; modelTurns <= input.maxModelTurns; modelTurns += 1) {
    throwIfAborted(input.request.signal)
    let call = input.registry.prepare(input.routeId, { ...requestTemplate, messages })
    await ensureInitialHistoryContext(input, call, appendHistory)
    const initialResponse = modelTurns === 1 ? input.initialResponse : undefined
    let requestObservation = { modelTurn: modelTurns, attempt: 1, routeId: input.routeId, ...(activeWindowId ? { windowId: activeWindowId } : {}), request: call.request, ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}), ...(input.requiredUserMessage ? { requiredUserMessage: input.requiredUserMessage } : {}) }
    let preparedRequestProjection = !initialResponse ? await input.observer?.prepareModelRequest?.(requestObservation) : undefined
    if (!initialResponse && input.planContextReplacement) {
      const requestExceedsBudget = (projection: unknown): boolean => {
        if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false
        const record = projection as { budget?: { totalInputBudget?: unknown }; surfaceSnapshot?: { surfaceTokens?: unknown }; contextUsage?: { projectedTokens?: unknown } }
        if (typeof record.budget?.totalInputBudget !== 'number') return false
        const projectedTokens = typeof record.contextUsage?.projectedTokens === 'number'
          ? record.contextUsage.projectedTokens
          : record.surfaceSnapshot?.surfaceTokens
        return typeof projectedTokens === 'number' && projectedTokens > record.budget.totalInputBudget
      }
      const overBudgetBeforeRecovery = requestExceedsBudget(preparedRequestProjection?.requestProjection)
      const preflight = await input.planContextReplacement({
        phase: 'preflight',
        invocationId,
        modelTurn: modelTurns,
        ...(activeWindowId ? { windowId: activeWindowId } : {}),
        request: call.request,
        messages: structuredClone(messages),
        ...(preparedRequestProjection?.requestProjection !== undefined ? { requestProjection: preparedRequestProjection.requestProjection } : {}),
        ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}),
        ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {})
      })
      if (preflight && 'rejected' in preflight) {
        throw new ModelPreflightRejectedError('OVER_BUDGET')
      }
      const preflightRecovery = preflight && 'messages' in preflight ? preflight : undefined
      const didRecover = Boolean(preflightRecovery?.messages && JSON.stringify(preflightRecovery.messages) !== JSON.stringify(messages))
      if (didRecover && preflightRecovery?.messages) {
        const compacted = structuredClone([...preflightRecovery.messages])
        if (input.currentUserMessageId && input.requiredUserMessage) {
          const required = JSON.stringify(input.requiredUserMessage.message)
          if (!compacted.some((message) => message.role === 'user' && JSON.stringify(message) === required)) {
            throw new InvalidTurnBoundaryError(`preflight omitted required user message: ${input.currentUserMessageId}`)
          }
        }
        if (!input.history) throw new InvalidTurnBoundaryError('preflight transcript replacement requires canonical History')
        const base = await invocationContextPort.readCurrent(contextScope)
        const historyPayload = (preflightRecovery.historyPayload ?? {}) as Record<string, import('./context').JsonValue>
        const output = contextFrameFromMessages(compacted, preflightRecovery.windowId ?? base.frame.windowId, input.requiredUserMessage, base.frame.pendingTools, base.frame, checkpointIdentityFromPayload(preflightRecovery.historyPayload))
        const sourceBindings = contextSourceBindings(base.frame.items, output.items)
        const checkpointItems = output.items.some((item) => item.sourceMessageIds.length === 0)
        const candidate = contextRegistrar.registerTransformation({
          base, output,
          proof: {
            historyPayload,
            sourceBindings,
            ...(checkpointItems && isCheckpointEvidence(historyPayload) ? { checkpoint: extractCheckpointEvidence(historyPayload) } : {}),
            shadowedRanges: contextShadowedRanges(historyPayload),
            ...(input.contextProjectionCommitter ? {
              commitProjection: async () => {
                const projected = {
                  scope: { invocationId, turnId: input.turnId ?? invocationId }, reason: 'preflight' as const,
                  messages: compacted, historyPayload, inputFingerprint: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
                  ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {}),
                }
                await input.contextProjectionCommitter!(projected)
              }
            } : {})
          }
        })
        const result = await invocationContextPort.commitReplacement({
          operationId: `${invocationId}:preflight:${modelTurns}`,
          reason: output.windowId !== base.frame.windowId ? 'window-transition' : 'auto-compact', candidate
        })
        if (result.status === 'commit-uncertain') throw new AgentTurnBoundaryProjectionError(result.error)
        if (result.status === 'committed') {
          requestTemplate = { ...requestTemplate }
          call = input.registry.prepare(input.routeId, { ...requestTemplate, messages })
          requestObservation = { modelTurn: modelTurns, attempt: 1, routeId: input.routeId, ...(activeWindowId ? { windowId: activeWindowId } : {}), request: call.request, ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}), ...(input.requiredUserMessage ? { requiredUserMessage: input.requiredUserMessage } : {}) }
          preparedRequestProjection = await input.observer?.prepareModelRequest?.(requestObservation)
        }
        call = input.registry.prepare(input.routeId, { ...requestTemplate, messages })
        requestObservation = { modelTurn: modelTurns, attempt: 1, routeId: input.routeId, ...(activeWindowId ? { windowId: activeWindowId } : {}), request: call.request, ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}), ...(input.requiredUserMessage ? { requiredUserMessage: input.requiredUserMessage } : {}) }
        preparedRequestProjection = await input.observer?.prepareModelRequest?.(requestObservation)
      }
      if (overBudgetBeforeRecovery && (!didRecover || requestExceedsBudget(preparedRequestProjection?.requestProjection))) {
        throw new ModelPreflightRejectedError('OVER_BUDGET')
      }
    }
    const provider = input.registry.getProvider(call)
    if (pinnedRoute && (!sameRouteIdentity(pinnedRoute, call.route) || pinnedProvider !== provider)) {
      throw new ModelRouteChangedError(input.routeId)
    }
    pinnedRoute ??= call.route
    pinnedProvider ??= provider
    if (!initialResponse) {
      await appendHistory([{
        kind: 'model-request-started',
        payload: {
          requestId: `${invocationId}:round:${modelTurns}`,
          modelTurn: modelTurns,
          attempt: 1,
          routeId: input.routeId,
          requestSnapshot: canonicalRequestSnapshot(call),
          ...(preparedRequestProjection?.sessionLedger !== undefined ? { sessionLedger: preparedRequestProjection.sessionLedger } : {})
        }
      }])
      const onModelRequest = () => input.observer?.onModelRequest?.(requestObservation)
      if (input.observer?.criticalModelRequestProjection) await onModelRequest()
      else await observe(input.observer, 'model-request', onModelRequest)
    }
    // The host has already streamed and committed this response; reduce its canonical message without re-emitting provisional chunks.
    let collected: CollectedModelStream
    let recoveredAttempt = false
    const recover = async (details: {
      error?: unknown
      response?: Readonly<{ finishReason: Extract<StreamChunk, { type: 'finish' }>['reason']; usage: Extract<StreamChunk, { type: 'usage' }>; hasOutputContent: boolean }>
    }): Promise<CollectedModelStream | undefined> => {
      if (!input.recoverProviderAttempt) return undefined
      const recovery = await input.recoverProviderAttempt({
        ...details,
        attempt: recoveredAttempt ? 2 : 1,
        modelTurn: modelTurns,
        routeId: input.routeId,
        request: { ...requestTemplate, messages: structuredClone(messages) },
        messages: structuredClone(messages),
        ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}),
        ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {})
      })
      if (!recovery) return undefined
      if (recoveredAttempt) throw new ModelAttemptRecoveryRejectedError('RETRY_LIMIT_EXCEEDED')
      if (!/^[A-Z0-9_]{1,64}$/.test(recovery.reasonCode)) throw new Error('provider recovery reasonCode must be a stable uppercase code')
      const recordDiscardedUsage = async (response: NonNullable<typeof details.response>, attempt: number): Promise<Record<string, unknown> | undefined> => {
        inputTokens += response.usage.inputTokens
        outputTokens += response.usage.outputTokens
        cacheReadInputTokens += response.usage.cacheReadInputTokens ?? 0
        cacheCreationInputTokens += response.usage.cacheCreationInputTokens ?? 0
        const requestForAttempt = { ...requestTemplate, messages: structuredClone(messages) }
        const attributionInput = input.observer?.prepareUsageAttribution?.({ modelTurn: modelTurns, request: requestForAttempt })
        const attemptUsage = {
          invocationId,
          modelTurn: modelTurns,
          attempt,
          routeId: input.routeId,
          usage: response.usage,
          ...(attributionInput ? { attributionInput } : {}),
          finishReason: response.finishReason,
          disposition: 'discarded',
          reasonCode: recovery.reasonCode
        }
        await projectModelAttemptUsage(input, attemptUsage)
        return input.sessionLedgerForAttemptUsage ? await input.sessionLedgerForAttemptUsage(attemptUsage) : undefined
      }
      if (recovery.kind === 'reject') {
        const sessionLedger = details.response ? await recordDiscardedUsage(details.response, recoveredAttempt ? 2 : 1) : undefined
        if (details.response && input.history) await appendHistory([{
          kind: 'model-attempt-discarded',
          payload: { modelTurn: modelTurns, attempt: recoveredAttempt ? 2 : 1, reasonCode: recovery.reasonCode, finishReason: details.response.finishReason, usage: details.response.usage, ...(sessionLedger ? { sessionLedger } : {}) }
        }])
        throwIfAborted(input.request.signal)
        throw new ModelAttemptRecoveryRejectedError(recovery.reasonCode)
      }
      throwIfAborted(input.request.signal)
      if (recoveredAttempt) throw new ModelAttemptRecoveryRejectedError('RETRY_LIMIT_EXCEEDED')
      const recoveredMessages = structuredClone([...recovery.messages])
      if (input.currentUserMessageId && input.requiredUserMessage &&
        !recoveredMessages.some((message) => message.role === 'user' && JSON.stringify(message) === JSON.stringify(input.requiredUserMessage!.message))) {
        throw new InvalidTurnBoundaryError(`provider recovery omitted required user message: ${input.currentUserMessageId}`)
      }
      const sessionLedger = details.response ? await recordDiscardedUsage(details.response, recoveredAttempt ? 2 : 1) : undefined
      if (input.history && recovery.recordTranscriptCompaction === false && recovery.requestPatch) await appendHistory([{
        kind: 'model-attempt-discarded',
        payload: { modelTurn: modelTurns, attempt: recoveredAttempt ? 2 : 1, reasonCode: recovery.reasonCode, requestPatch: recovery.requestPatch, ...(sessionLedger ? { sessionLedger } : {}) }
      }])
      if (input.history && recovery.recordTranscriptCompaction !== false) {
        const discarded = details.response ? [{
          kind: 'model-attempt-discarded' as const,
          payload: {
            modelTurn: modelTurns,
            attempt: recoveredAttempt ? 2 : 1,
            reasonCode: recovery.reasonCode,
            finishReason: details.response.finishReason,
            usage: details.response.usage,
            ...(sessionLedger ? { sessionLedger } : {})
          }
        }] : []
        const compactedPayload = {
          messages: recoveredMessages,
          inputFingerprint: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
          outputFingerprint: createHash('sha256').update(JSON.stringify(recoveredMessages)).digest('hex'),
          recoveryReason: recovery.reasonCode,
          ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {})
        }
        if (input.contextProjectionCommitter) {
          if (discarded.length) await appendHistory(discarded)
          const base = await invocationContextPort.readCurrent(contextScope)
          const output = contextFrameFromMessages(recoveredMessages, base.frame.windowId, input.requiredUserMessage, base.frame.pendingTools, base.frame)
          const candidate = contextRegistrar.registerTransformation({
            base, output,
            proof: {
              historyPayload: compactedPayload as Record<string, import('./context').JsonValue>,
              sourceBindings: contextSourceBindings(base.frame.items, output.items), shadowedRanges: [],
              commitProjection: async () => input.contextProjectionCommitter!({
                scope: { invocationId, turnId: input.turnId ?? invocationId }, reason: 'provider-recovery', messages: recoveredMessages,
                historyPayload: compactedPayload, inputFingerprint: compactedPayload.inputFingerprint,
                ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {})
              })
            }
          })
          const committed = await invocationContextPort.commitReplacement({
            operationId: `${invocationId}:provider-recovery:${modelTurns}`,
            reason: 'auto-compact', candidate
          })
          if (committed.status === 'commit-uncertain') throw new AgentTurnBoundaryProjectionError(committed.error)
          if (committed.status !== 'committed' && committed.status !== 'no-op') throw new InvalidTurnBoundaryError(`provider recovery context replacement ${committed.status}`)
        } else await appendHistory([...discarded, { kind: 'transcript-compacted', payload: compactedPayload }])
      }
      if (recovery.retryEvent) {
        if (input.observer?.criticalModelRequestProjection && !input.observer.onProviderRetry) {
          throw new Error('critical model request projection requires onProviderRetry')
        }
        const retry = {
          attempt: recovery.retryEvent.attempt,
          modelTurn: modelTurns,
          routeId: input.routeId,
          requestId: `${invocationId}:round:${modelTurns}`,
          code: recovery.retryEvent.code
        }
        const retryLedger = await input.observer?.prepareProviderRetry?.(retry)
        await appendHistory([{
          kind: 'provider-retry-scheduled',
          payload: {
            requestId: retry.requestId,
            modelTurn: retry.modelTurn,
            routeId: retry.routeId,
            retryAttempt: retry.attempt,
            code: recovery.retryEvent.code,
            backoffMs: 0,
            ...(retryLedger ? { sessionLedger: { location: retryLedger.location, requestRetry: retryLedger.requestRetry } } : {})
          }
        }])
        await observe(input.observer, 'model-attempt-discarded', () => input.observer?.onModelAttemptDiscarded?.({
          attempt: retry.attempt,
          modelTurn: retry.modelTurn,
          reasonCode: recovery.reasonCode
        }))
        const onProviderRetry = () => input.observer?.onProviderRetry?.(retry)
        if (input.observer?.criticalModelRequestProjection) await onProviderRetry()
        else await observe(input.observer, 'model-request', onProviderRetry)
      }
      throwIfAborted(input.request.signal)
      messages.splice(0, messages.length, ...recoveredMessages)
      requestTemplate = { ...requestTemplate, ...(recovery.requestPatch ?? {}) }
        const retryCall = input.registry.prepare(input.routeId, { ...requestTemplate, messages })
        const retryProvider = input.registry.getProvider(retryCall)
        if (!sameRouteIdentity(retryCall.route, call.route) || retryProvider !== provider) throw new ModelRouteChangedError(input.routeId)
        recoveredAttempt = true
        const retryRequestObservation = { modelTurn: modelTurns, attempt: 2, routeId: input.routeId, ...(activeWindowId ? { windowId: activeWindowId } : {}), request: retryCall.request, ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}), ...(input.requiredUserMessage ? { requiredUserMessage: input.requiredUserMessage } : {}) }
        const retryProjection = await input.observer?.prepareModelRequest?.(retryRequestObservation)
        await appendHistory([{
          kind: 'model-request-started',
          payload: {
            requestId: `${invocationId}:round:${modelTurns}`,
            modelTurn: modelTurns,
            attempt: 2,
            routeId: input.routeId,
            requestSnapshot: canonicalRequestSnapshot(retryCall),
            ...(retryProjection?.sessionLedger !== undefined ? { sessionLedger: retryProjection.sessionLedger } : {})
          }
        }])
        const onRetryModelRequest = () => input.observer?.onModelRequest?.(retryRequestObservation)
        if (input.observer?.criticalModelRequestProjection) await onRetryModelRequest()
        else await observe(input.observer, 'model-request', onRetryModelRequest)
      return collectProviderAttempt(retryProvider.stream(retryCall), modelTurns, 2)
    }
    const settleCancelledAttempt = async (cancelled: CollectedModelStream): Promise<never> => {
      if (cancelled.finish.reason !== 'cancelled') throw new Error('cancel settlement requires a cancelled provider attempt')
      if (cancelled.usage) {
        const cancelledAttemptUsage = {
          invocationId,
          modelTurn: modelTurns,
          attempt: recoveredAttempt ? 2 : 1,
          routeId: input.routeId,
          usage: cancelled.usage,
          finishReason: 'cancelled',
          disposition: 'cancelled'
        }
        await projectModelAttemptUsage(input, cancelledAttemptUsage)
        const sessionLedger = input.sessionLedgerForAttemptUsage
          ? await input.sessionLedgerForAttemptUsage(cancelledAttemptUsage)
          : undefined
        if (input.history) await appendHistory([{
          kind: 'model-attempt-discarded',
          payload: {
            modelTurn: modelTurns,
            attempt: recoveredAttempt ? 2 : 1,
            reasonCode: 'TURN_CANCELLED',
            finishReason: 'cancelled',
            usage: cancelled.usage,
            ...(sessionLedger ? { sessionLedger } : {})
          }
        }])
        onAcceptedUsage(cancelled.usage)
      }
      throwIfAborted(input.request.signal)
      throw new AgentTurnCancelledError()
    }
    if (initialResponse) {
      collected = collectCanonicalHostResponse(initialResponse)
    } else {
      try {
        collected = await collectProviderAttempt(provider.stream(call), modelTurns, recoveredAttempt ? 2 : 1)
      } catch (error) {
        throwIfAborted(input.request.signal)
        const retry = await recover({ error })
        if (!retry) throw error
        collected = retry
      }
      if (input.request.signal?.aborted && collected.finish.reason !== 'cancelled') {
        collected = { ...collected, finish: { type: 'finish', reason: 'cancelled' } }
      }
      if (collected.finish.reason === 'cancelled') {
        await settleCancelledAttempt(collected)
        throw new AgentTurnCancelledError()
      }
      const collectedUsage = collected.usage
      if (!collectedUsage) throw new InvalidModelStreamError('non-cancelled provider attempt completed without usage')
      if (input.recoverProviderAttempt && !recoveredAttempt) {
        const hasOutputContent = collected.chunks.some((chunk) => chunk.type === 'text-delta' || chunk.type === 'thinking-delta' || chunk.type === 'thinking-signature' || chunk.type === 'tool-call')
        const retry = await recover({ response: { finishReason: collected.finish.reason, usage: collectedUsage, hasOutputContent } })
        if (retry) {
          collected = retry
          if (collected.finish.reason === 'cancelled') {
            await settleCancelledAttempt(collected)
            throw new AgentTurnCancelledError()
          }
          if (!collected.usage) throw new InvalidModelStreamError('non-cancelled provider retry completed without usage')
          const retryHasOutputContent = collected.chunks.some((chunk) => chunk.type === 'text-delta' || chunk.type === 'thinking-delta' || chunk.type === 'thinking-signature' || chunk.type === 'tool-call')
          const retryAgain = await recover({ response: { finishReason: collected.finish.reason, usage: collected.usage, hasOutputContent: retryHasOutputContent } })
          if (retryAgain) collected = retryAgain
        }
      }
      if (collected.finish.reason === 'cancelled') await settleCancelledAttempt(collected)
      if (!collected.usage) throw new InvalidModelStreamError('non-cancelled provider attempt completed without usage')
    }
    if (collected.finish.reason === 'cancelled') {
      if (initialResponse) {
        throwIfAborted(input.request.signal)
        throw new AgentTurnCancelledError()
      }
      await settleCancelledAttempt(collected)
    }
    if (!collected.usage) throw new InvalidModelStreamError('non-cancelled model attempt completed without usage')
    throwIfAborted(input.request.signal)
    const toolCalls = collected.chunks.filter((chunk): chunk is Extract<typeof chunk, { type: 'tool-call' }> => chunk.type === 'tool-call')
    inputTokens += collected.usage.inputTokens
    outputTokens += collected.usage.outputTokens
    cacheReadInputTokens += collected.usage.cacheReadInputTokens ?? 0
    cacheCreationInputTokens += collected.usage.cacheCreationInputTokens ?? 0
    const textDelta = collected.chunks.filter((chunk): chunk is Extract<typeof chunk, { type: 'text-delta' }> => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    const assistantContent: CanonicalContentBlock[] = []
    for (const chunk of collected.chunks) {
      if (chunk.type === 'text-delta') {
        const previous = assistantContent.at(-1)
        if (previous?.type === 'text') assistantContent[assistantContent.length - 1] = { type: 'text', text: previous.text + chunk.text }
        else assistantContent.push({ type: 'text', text: chunk.text })
      } else if (chunk.type === 'thinking-delta') {
        const previous = assistantContent.at(-1)
        if (previous?.type === 'thinking' && !previous.thinkingSignature && !previous.redacted) assistantContent[assistantContent.length - 1] = { ...previous, thinking: previous.thinking + chunk.text }
        else assistantContent.push({ type: 'thinking', thinking: chunk.text })
      }
      else if (chunk.type === 'thinking-signature') {
        let index = assistantContent.length - 1
        while (index >= 0 && assistantContent[index]?.type !== 'thinking') index -= 1
        if (index < 0) assistantContent.push({ type: 'thinking', thinking: '', thinkingSignature: chunk.signature, ...(chunk.redacted ? { redacted: true } : {}) })
        else {
          const current = assistantContent[index] as Extract<CanonicalContentBlock, { type: 'thinking' }>
          assistantContent[index] = {
            type: 'thinking',
            thinking: chunk.redacted ? '' : current.thinking,
            thinkingSignature: chunk.signature,
            ...(chunk.redacted ? { redacted: true } : {})
          }
        }
      }
    }
    text += textDelta

    if (collected.finish.reason !== 'length' && ((collected.finish.reason === 'tool-calls') !== (toolCalls.length > 0))) {
      throw new Error('model finish reason does not match tool calls')
    }
    const ids = new Set<string>()
    for (const tool of toolCalls) {
      if (!tool.toolCallId.trim() || ids.has(tool.toolCallId)) throw new Error('duplicate or empty tool call id')
      ids.add(tool.toolCallId)
    }

    // Mixed assistant text + tool proposals keep canonical block structure, matching persisted host History.
    const canonicalAssistantBlocks = toolCalls.length > 0
      ? assistantContent.filter((block) => block.type !== 'text' || block.text.trim().length > 0)
      : assistantContent
    const assistantContentValue = toolCalls.length > 0
      ? (canonicalAssistantBlocks.length > 0 ? canonicalAssistantBlocks : undefined)
      : assistantHistoryContent(assistantContent, textDelta)
    const reducedAssistantMessage: CanonicalTurnMessage = toolCalls.length
      ? {
          role: 'assistant',
          ...(assistantContentValue !== undefined ? { content: assistantContentValue } : {}),
          toolCalls: toolCalls.map((tool) => ({ id: tool.toolCallId, name: tool.toolName, input: structuredClone(tool.input), ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}) }))
      }
      : { role: 'assistant', content: assistantContentValue ?? '' }
    const unboundAssistantMessage: CanonicalTurnMessage = initialResponse?.message ?? reducedAssistantMessage
    if (unboundAssistantMessage.role !== 'assistant') throw new Error('canonical model response must be an assistant message')
    if (input.assistantMessageId && unboundAssistantMessage.id && unboundAssistantMessage.id !== input.assistantMessageId) {
      throw new Error('canonical assistant response message id does not match the assigned turn message')
    }
    const assistantMessage: CanonicalTurnMessage = input.assistantMessageId
      ? { ...unboundAssistantMessage, id: input.assistantMessageId }
      : unboundAssistantMessage
    const toolDispatchStates = new Map(toolCalls.map((tool) => [tool.toolCallId, 'pending' as 'pending' | 'not-dispatched' | 'started' | 'finished']))
    const markNotDispatched = async (tool: (typeof toolCalls)[number], reason: string, userMessage?: string): Promise<void> => {
      if (toolDispatchStates.get(tool.toolCallId) !== 'pending') return
      const replayContent = userMessage ?? `Tool call was not dispatched (${reason}).`
      const sessionResult = { success: false, data: replayContent }
      const sessionLedger = input.sessionLedgerForNotDispatched
        ? await input.sessionLedgerForNotDispatched({ ...tool, invocationId }, reason, sessionResult)
        : undefined
      let appendFailed = false
      let appendError: unknown
      try {
        await appendHistory([{
          kind: 'tool-call-not-dispatched',
          payload: {
            toolCallId: tool.toolCallId,
            reason,
            replayContent,
            isError: true,
            ...(sessionLedger ? { sessionLedger } : {})
          }
        }])
      } catch (error) {
        appendFailed = true
        appendError = error
      }
      toolDispatchStates.set(tool.toolCallId, 'not-dispatched')
      try {
        await input.discardPreparedTool?.({ invocationId, toolCallId: tool.toolCallId, toolName: tool.toolName, input: structuredClone(tool.input), ...(input.request.signal ? { signal: input.request.signal } : {}) }, reason)
      } catch (error) {
        await observe(input.observer, 'prepared-tool-discard', () => input.observer?.onObservationError?.(error, 'prepared-tool-discard'))
      }
      if (appendFailed) throw appendError
    }
    let committedInitialResponseStepId: string | undefined
    if (initialResponse) {
      const committedResponse = await assertHostCommittedResponse(input.history, input.invocationId, initialResponse)
      committedInitialResponseStepId = committedResponse.sessionLedgerStepId
      // Seed read-only host projections from the canonical committed response. Do not append
      // another model-response event or replay any already committed side effects.
      if (input.sessionLedgerForModelResponse) {
        await input.sessionLedgerForModelResponse(committedResponse.message, modelTurns, 1, committedResponse.sessionLedger)
      }
    }
    const acceptedAttemptNumber = recoveredAttempt ? 2 : 1
    let attemptUsageLedger: Record<string, unknown> | undefined
    if (!initialResponse) {
      const attributionInput = input.observer?.prepareUsageAttribution?.({ modelTurn: modelTurns, request: call.request })
      const acceptedAttemptUsage = {
        invocationId,
        modelTurn: modelTurns,
        ...(activeWindowId ? { windowId: activeWindowId } : {}),
        attempt: acceptedAttemptNumber,
        routeId: input.routeId,
        usage: collected.usage,
        ...(attributionInput ? { attributionInput } : {}),
        finishReason: collected.finish.reason,
        disposition: 'completed'
      }
      await projectModelAttemptUsage(input, acceptedAttemptUsage)
      attemptUsageLedger = input.sessionLedgerForAttemptUsage ? await input.sessionLedgerForAttemptUsage(acceptedAttemptUsage) : undefined
    }
    const responseProjection = !initialResponse ? await input.observer?.prepareContextBoundaryEvidence?.({
      message: assistantMessage,
      finishReason: collected.finish.reason,
      usage: collected.usage,
      modelTurn: modelTurns
    }) : undefined
    const committedResponse = modelTurns === 1 && input.initialResponse ? [] : await appendHistory([{
      kind: 'model-response-committed',
      payload: {
        requestId: `${invocationId}:turn:${modelTurns}`,
        modelTurn: modelTurns,
        attempt: acceptedAttemptNumber,
        requestSnapshot: canonicalRequestSnapshot(call),
        message: assistantMessage,
        finishReason: collected.finish.reason,
        usage: collected.usage,
        ...((input.sessionLedgerForModelResponse || attemptUsageLedger || responseProjection?.sessionLedger !== undefined) ? { sessionLedger: {
          ...(input.sessionLedgerForModelResponse ? await input.sessionLedgerForModelResponse(assistantMessage, modelTurns, acceptedAttemptNumber) : {}),
          ...(responseProjection?.sessionLedger && typeof responseProjection.sessionLedger === 'object' ? structuredClone(responseProjection.sessionLedger) as Record<string, unknown> : {}),
          ...(attemptUsageLedger ?? {})
        } } : {})
      }
    }])
    onAcceptedUsage(collected.usage)
    const committedMessage = committedResponse.length
      ? (committedResponse[0]?.payload as { message: CanonicalTurnMessage }).message
      : assistantMessage
    const responseObservation = {
      message: committedMessage,
      finishReason: collected.finish.reason,
      usage: collected.usage,
      modelTurn: modelTurns,
      ...(initialResponse?.hostProjectionCommitted ? { alreadyProjected: true } : {}),
      ...(committedInitialResponseStepId ? { committedStepId: committedInitialResponseStepId } : {})
    } as const
    if (input.observer?.criticalModelResponseProjection && input.observer.onModelResponseCommitted) {
      try {
        await input.observer.onModelResponseCommitted(responseObservation)
      } catch (error) {
        await observe(input.observer, 'model-response-committed', () => input.observer?.onObservationError?.(error, 'model-response-committed'))
        for (const tool of toolCalls) {
          if (toolDispatchStates.get(tool.toolCallId) === 'pending') await markNotDispatched(tool, 'HOST_PROJECTION_FAILED')
        }
        throw new AgentTurnHostProjectionError(error)
      }
    } else {
      await observe(input.observer, 'model-response-committed', () => input.observer?.onModelResponseCommitted?.(responseObservation))
    }
    if (collected.finish.reason === 'length') {
      const recoveryAttempt = outputRecoveryAttempts + 1
      const recovery = await input.recoverOutputLimit?.({
        invocationId,
        modelTurn: modelTurns,
        attempt: recoveryAttempt,
        hadVisibleText: textDelta.trim().length > 0,
        toolCalls: toolCalls.map((tool) => ({ invocationId, toolCallId: tool.toolCallId, toolName: tool.toolName, input: structuredClone(tool.input) }))
      })
      const recoveryMessage = recovery?.continuation
      if (recoveryMessage && (recoveryMessage.role !== 'user' || typeof recoveryMessage.content !== 'string' || !recoveryMessage.content.trim())) throw new Error('invalid output recovery continuation message')
      const toolCallErrorContent = recovery?.toolCallErrorContent ?? 'Tool call was not dispatched because the model output reached its limit.'
      const recoveryEvents = [
        ...await Promise.all(toolCalls.map(async (tool) => {
          const result = { success: false, error: 'model_output_token_limit', userMessage: toolCallErrorContent, notExecuted: true, notExecutedReason: 'model_output_truncated' }
          const sessionLedger = input.sessionLedgerForNotDispatched
            ? await input.sessionLedgerForNotDispatched({ ...tool, invocationId }, 'MODEL_OUTPUT_TRUNCATED', result)
            : undefined
          return { kind: 'tool-call-not-dispatched' as const, payload: {
            toolCallId: tool.toolCallId,
            reason: 'MODEL_OUTPUT_TRUNCATED',
            replayContent: toolCallErrorContent,
            isError: true,
            ...(sessionLedger ? { sessionLedger } : {})
          } }
        })),
        ...(recoveryMessage && recovery?.retryLocation ? [{ kind: 'provider-retry-scheduled' as const, payload: {
          requestId: `${invocationId}:round:${modelTurns}`, modelTurn: modelTurns, routeId: input.routeId,
          retryAttempt: recoveryAttempt, code: 'model_output_token_limit', backoffMs: 0,
          sessionLedger: { location: recovery.retryLocation, requestRetry: {
            turnId: recovery.retryTurnId ?? input.turnId ?? invocationId,
            stepId: recovery.retryStepId ?? invocationId,
            requestId: `${invocationId}:round:${modelTurns}`, attempt: recoveryAttempt,
            backoffMs: 0, code: 'model_output_token_limit'
          } }
        } }] : []),
        ...(recoveryMessage ? [{ kind: 'replay-message-committed' as const, payload: { message: recoveryMessage } }] : [])
      ]
      const committedRecoveryEvents = recoveryEvents.length ? await appendHistory(recoveryEvents) : []
      const failedToolMessages: CanonicalTurnMessage[] = toolCalls.map((tool) => ({
        role: 'tool', toolCallId: tool.toolCallId,
        content: toolCallErrorContent,
        isError: true
      }))
      const committedContent = committedMessage.role === 'assistant' ? committedMessage.content : undefined
      const hasCommittedAssistantContent = typeof committedContent === 'string'
        ? committedContent.length > 0
        : Array.isArray(committedContent) && committedContent.length > 0
      const hasCommittedToolCalls = committedMessage.role === 'assistant' && Boolean(committedMessage.toolCalls?.length)
      if (hasCommittedAssistantContent || hasCommittedToolCalls) messages.push(committedMessage)
      messages.push(...failedToolMessages, ...(recoveryMessage ? [structuredClone(recoveryMessage)] : []))
      outputRecoveryAttempts = recoveryAttempt
      const recoveryNotice = { attempt: recoveryAttempt, modelTurn: modelTurns, requestId: `${invocationId}:round:${modelTurns}`, toolCalls: toolCalls.map((tool) => ({ invocationId, toolCallId: tool.toolCallId, toolName: tool.toolName, input: structuredClone(tool.input) })), willRetry: Boolean(recoveryMessage), toolCallErrorContent }
      const sessionLedgerEvents = committedRecoveryEvents.filter((event) => event.kind === 'tool-call-not-dispatched' && toolCalls.some((tool) => tool.toolCallId === (event.payload as { toolCallId?: unknown }).toolCallId) || event.kind === 'provider-retry-scheduled' && (event.payload as { requestId?: unknown }).requestId === recoveryNotice.requestId)
      await observe(input.observer, 'model-request', () => input.observer?.onOutputRecovery?.({ ...recoveryNotice, sessionLedgerEvents }))
      if (!recoveryMessage) throw new ModelOutputTokenLimitError(recoveryAttempt)
      continue
    }
    let boundaryReplacedTranscript = false
    if (input.planContextReplacement) {
      const boundaryInputMessages = structuredClone([...messages, committedMessage])
      const boundaryTools = toolCalls.map((tool) => ({ id: tool.toolCallId, name: tool.toolName, input: structuredClone(tool.input), ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}) }))
      const priorCapture: { phase: 'preflight' | 'boundary'; pendingTools: CanonicalToolCall[] } = { phase: contextPhase, pendingTools: contextPendingTools }
      contextPhase = 'boundary'
      contextEpoch += 1
      contextPendingTools = boundaryTools
      contextCaptureOverride = boundaryInputMessages
      const boundary = await input.planContextReplacement({
        phase: 'turn-boundary',
        invocationId,
        modelTurn: modelTurns,
        response: committedMessage,
        messages: boundaryInputMessages,
        toolCalls: toolCalls.map((tool) => ({ invocationId, toolCallId: tool.toolCallId, toolName: tool.toolName, input: structuredClone(tool.input) })),
        usage: { inputTokens, outputTokens, ...(cacheReadInputTokens ? { cacheReadInputTokens } : {}), ...(cacheCreationInputTokens ? { cacheCreationInputTokens } : {}) },
        ...(responseProjection?.contextBoundaryEvidence !== undefined ? { requestProjection: responseProjection.contextBoundaryEvidence } : {}),
        ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}),
        ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {})
      })
      if (boundary && 'rejected' in boundary) throw new InvalidTurnBoundaryError('turn-boundary planner returned a preflight rejection')
      if (boundary && 'messages' in boundary && boundary.messages) {
        const compacted = structuredClone(boundary.messages)
        const compactedToolCalls = new Map(compacted.flatMap((message) => message.role === 'assistant' ? (message.toolCalls ?? []).map((tool) => [tool.id, tool] as const) : []))
        for (const tool of toolCalls) {
          const preserved = compactedToolCalls.get(tool.toolCallId)
          if (!preserved || preserved.name !== tool.toolName || JSON.stringify(preserved.input) !== JSON.stringify(tool.input)) {
            throw new InvalidTurnBoundaryError(`turn boundary omitted or changed pending tool proposal: ${tool.toolCallId}`)
          }
          if (tool.thoughtSignature !== undefined && preserved.thoughtSignature !== tool.thoughtSignature) throw new InvalidTurnBoundaryError(`turn boundary changed pending tool signature: ${tool.toolCallId}`)
        }
        if (input.currentUserMessageId && input.requiredUserMessage) {
          const required = JSON.stringify(input.requiredUserMessage.message)
          if (!compacted.some((message) => message.role === 'user' && JSON.stringify(message) === required)) {
            throw new InvalidTurnBoundaryError(`turn boundary omitted required user message: ${input.currentUserMessageId}`)
          }
        }
        if (input.history && (input.contextProjectionCommitter || JSON.stringify(compacted) !== JSON.stringify(boundaryInputMessages) || boundary.windowId !== undefined && boundary.windowId !== activeWindowId)) {
          const base = await invocationContextPort.readCurrent(contextScope)
          const historyPayload = (boundary.historyPayload ?? {}) as Record<string, import('./context').JsonValue>
          const output = contextFrameFromMessages(compacted, boundary.windowId ?? activeWindowId, input.requiredUserMessage, base.frame.pendingTools, base.frame, checkpointIdentityFromPayload(boundary.historyPayload))
          const checkpointItems = output.items.some((item) => item.sourceMessageIds.length === 0)
          const candidate = contextRegistrar.registerTransformation({
            base, output,
            proof: {
              historyPayload,
              sourceBindings: contextSourceBindings(base.frame.items, output.items),
              ...(checkpointItems && isCheckpointEvidence(historyPayload) ? { checkpoint: extractCheckpointEvidence(historyPayload) } : {}),
              shadowedRanges: contextShadowedRanges(historyPayload),
              ...(input.contextProjectionCommitter ? {
                commitProjection: async () => {
                  const replacement = {
                    scope: { invocationId, turnId: input.turnId ?? invocationId }, reason: 'turn-boundary' as const,
                    messages: compacted, historyPayload, inputFingerprint: createHash('sha256').update(JSON.stringify(boundaryInputMessages)).digest('hex'),
                    ...(input.requiredUserMessage ? { requiredUserMessage: structuredClone(input.requiredUserMessage) } : {}),
                  }
                  await input.contextProjectionCommitter!(replacement)
                }
              } : {})
            }
          })
          const result = await invocationContextPort.commitReplacement({
            operationId: `${invocationId}:boundary:${modelTurns}`,
            reason: output.windowId !== base.frame.windowId ? 'window-transition' : 'auto-compact', candidate
          })
          if (result.status === 'commit-uncertain') throw new AgentTurnBoundaryProjectionError(result.error)
          if (result.status === 'committed') boundaryReplacedTranscript = true
        } else if (!input.history) {
          messages.splice(0, messages.length, ...compacted)
          if (boundary.windowId) activeWindowId = boundary.windowId
        } else if (input.history && boundary.messages) {
          messages.splice(0, messages.length, ...compacted)
          if (boundary.windowId) activeWindowId = boundary.windowId
          boundaryReplacedTranscript = true
        }
      }
      contextCaptureOverride = undefined
      contextPhase = priorCapture.phase
      contextPendingTools = priorCapture.pendingTools
    }

    if (!boundaryReplacedTranscript) messages.push(committedMessage)

    if (toolCalls.length === 0) {
      const result = { text, messages, modelTurns, finishReason: collected.finish.reason, usage: { inputTokens, outputTokens, ...(cacheReadInputTokens ? { cacheReadInputTokens } : {}), ...(cacheCreationInputTokens ? { cacheCreationInputTokens } : {}) } }
      return result
    }
    if (input.maxToolRounds !== undefined && dispatchedToolRounds >= input.maxToolRounds) {
      for (const tool of toolCalls) await markNotDispatched(tool, 'tool_loop_max_rounds_exceeded')
      throw new ToolLoopRoundLimitError(input.maxToolRounds)
    }
    if (modelTurns === input.maxModelTurns) throw new ModelTurnLimitError(input.maxModelTurns)

    const candidateSlots = new ApprovalCandidateSlots(2, Math.max(toolCalls.length, 1))
    const approvalSlots = new Semaphore(2)
    let parkRequested = false
    let parkedTodoId: string | undefined
    const settledTools = await mapWithConcurrency(toolCalls, input.maxConcurrentTools ?? 2, async (tool) => {
      if (parkRequested) throw new DeferredTurnParkedError()
      const executionCall = {
        invocationId, toolCallId: tool.toolCallId, toolName: tool.toolName,
        input: structuredClone(tool.input),
        ...(input.request.signal ? { signal: input.request.signal } : {})
      }
      const approvalCandidate = input.isApprovalCandidate?.(executionCall)
        ?? ['write_file', 'edit_file', 'run_shell', 'run_script', 'browser', 'browser_action'].includes(tool.toolName)
      let releaseCandidate: (() => void) | undefined
      let approvalPermitHeld = false
      try {
      const dispatchAdmission = await input.beforeToolDispatch?.(executionCall, { modelTurn: modelTurns, toolCallIndex: toolCalls.findIndex(({ toolCallId }) => toolCallId === tool.toolCallId), responseToolCallCount: toolCalls.length })
      if (dispatchAdmission?.kind === 'reject') {
        await markNotDispatched(tool, dispatchAdmission.reasonCode, dispatchAdmission.message)
        return { role: 'tool', toolCallId: tool.toolCallId, content: dispatchAdmission.message, isError: true } satisfies CanonicalTurnMessage
      }
      releaseCandidate = approvalCandidate ? await candidateSlots.acquire(invocationId, input.request.signal) : undefined
      const initialBinding = await (async () => {
        try {
          return await input.prepareTool(executionCall, { kind: 'initial' })
        } catch (error) {
          // FR12②：host 侧 prepareTool 可抛 ToolDeniedError（如 REGISTERED_TOOL_NOT_FOUND → 结构化拒绝）；
          // 与 safetyGate deny 路径一致，先解除 pending 再抛，避免 invocation 终态校验挂起。
          if (error instanceof ToolDeniedError) {
            await markNotDispatched(tool, error.reasonCode, error.userMessage)
          }
          throw error
        }
      })()
      await projectTool(input.observer, 'tool-started', () => input.observer?.onToolStarted?.(executionCall))
      throwIfAborted(input.request.signal)
      if (initialBinding.invocationId !== invocationId || initialBinding.toolCallId !== tool.toolCallId || initialBinding.capabilityId !== tool.toolName || initialBinding.phase !== 'initial-compat') {
        await markNotDispatched(tool, 'PREPARED_CALL_MISMATCH')
        throw new ToolDeniedError('PREPARED_CALL_MISMATCH')
      }
        const initialDecision = await input.safetyGate.evaluate(initialBinding, input.request.signal)
      throwIfAborted(input.request.signal)

      let confirmation: Readonly<{ receipt: string }> | undefined
      if (initialDecision.kind === 'deny') {
        await markNotDispatched(tool, initialDecision.reasonCode)
        // FR12②：deny 决策可携带模型可见的区分文案（预算未注入 vs 服务不可用）
        throw new ToolDeniedError(initialDecision.reasonCode, initialDecision.userMessage)
      }
      if (initialDecision.kind === 'ask') {
        if (!input.confirmation) {
          await markNotDispatched(tool, 'CONFIRMATION_REQUIRED')
          throw new ToolDeniedError('CONFIRMATION_REQUIRED')
        }
        try {
          await approvalSlots.acquire(input.request.signal ? { signal: input.request.signal } : {})
          approvalPermitHeld = true
        }
        catch (error) {
          await markNotDispatched(tool, input.request.signal?.aborted ? 'REQUEST_CANCELLED' : 'CONFIRMATION_CAPACITY_UNAVAILABLE')
          throw error
        }
        await appendHistory([{
          kind: 'approval-waiting',
          payload: {
            toolCallId: tool.toolCallId,
            approvalId: initialDecision.confirmationId,
            answerer: initialDecision.answerer,
            reasonCode: initialDecision.reasonCode,
            requestedAt: Date.now()
          }
        }])
        if (input.request.signal?.aborted) {
          const timedOut = isTurnTimeoutSignal(input.request.signal)
          await appendHistory([{
            kind: 'approval-resolved',
            payload: {
              toolCallId: tool.toolCallId,
              approvalId: initialDecision.confirmationId,
              approved: false,
              outcome: timedOut ? 'timeout' : 'cancelled',
              cause: timedOut ? 'timeout' : 'cancelled',
              settledAt: Date.now()
            }
          }])
          await markNotDispatched(tool, timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED')
          throwIfAborted(input.request.signal)
        }
        let result: ToolConfirmationResult
        try {
          result = await input.confirmation({
            call: executionCall,
            modelTurn: modelTurns,
            confirmationId: initialDecision.confirmationId,
            answerer: initialDecision.answerer,
            reasonCode: initialDecision.reasonCode,
            ...(initialDecision.context !== undefined ? { context: structuredClone(initialDecision.context) } : {}),
            ...(input.request.signal ? { signal: input.request.signal } : {})
          })
        } catch (error) {
          await appendHistory([{ kind: 'approval-resolved', payload: { toolCallId: tool.toolCallId, approvalId: initialDecision.confirmationId, approved: false, outcome: 'unavailable', settledAt: Date.now() } }])
          throw error
        } finally {
          if (approvalPermitHeld) { approvalSlots.release(); approvalPermitHeld = false }
        }
        if (result.kind === 'deferred') {
          if (!result.todoId.trim() || result.invocationId !== input.invocationId || !result.checkpointRef.checkpointId.trim() ||
            !Number.isInteger(result.checkpointRef.workflowRevision) || result.checkpointRef.workflowRevision <= 0) {
            await markNotDispatched(tool, 'DEFERRED_CHECKPOINT_INVALID')
            throw new ToolDeniedError('DEFERRED_CHECKPOINT_INVALID')
          }
          await appendHistory([{ kind: 'approval-deferred', payload: {
            toolCallId: tool.toolCallId, approvalId: initialDecision.confirmationId, todoId: result.todoId, invocationId: result.invocationId,
            checkpointId: result.checkpointRef.checkpointId, workflowRevision: result.checkpointRef.workflowRevision
          } }])
          toolDispatchStates.set(tool.toolCallId, 'finished')
          parkRequested = true
          parkedTodoId = result.todoId
          throw new DeferredTurnParkedError()
        }
        const approved = result.kind === 'approved' && Boolean(result.receipt.trim())
        const approvalOutcome = approved ? 'approved' : result.kind === 'approved' ? 'denied' : result.kind
        const resolvedApproval = {
          toolCallId: tool.toolCallId,
          approvalId: initialDecision.confirmationId,
          approved,
          outcome: approvalOutcome,
          ...(result.answerer ? { answerer: result.answerer } : {}),
          ...(result.cause ? { cause: result.cause } : {}),
          settledAt: Date.now()
        }
        await appendHistory([{ kind: 'approval-resolved', payload: resolvedApproval }])
        if (input.request.signal?.aborted) {
          await markNotDispatched(tool, isTurnTimeoutSignal(input.request.signal) ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED')
          throwIfAborted(input.request.signal)
        }
        if (result.kind !== 'approved' || !result.receipt.trim()) {
          const reason = `CONFIRMATION_${result.kind.toUpperCase()}`
          await markNotDispatched(tool, reason, result.userMessage)
          throw new ToolDeniedError(reason, result.userMessage)
        }
        if (input.request.signal?.aborted) {
          await markNotDispatched(tool, isTurnTimeoutSignal(input.request.signal) ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED')
          throwIfAborted(input.request.signal)
        }
        confirmation = { receipt: result.receipt }
      }

      let resourceLease: { release(): void } | undefined
      let executionResult: CanonicalToolExecutionResult
      try {
        const resourceKeys = input.toolResourceKeys?.(executionCall) ?? [`unknown:${invocationId}`]
        resourceLease = await resourceLocks.acquire(resourceKeys, input.request.signal ? { signal: input.request.signal } : undefined)
        // Match the host lifecycle: resource ownership is acquired before the final policy/facts recheck.
        let recheckBinding: PermitBinding
        try {
          recheckBinding = await input.prepareTool(executionCall, { kind: 'recheck', ...(confirmation ? { confirmation } : {}) })
        } catch (error) {
          throwIfAborted(input.request.signal)
          const message = error instanceof Error ? error.message : ''
          const reasonCode = /^[A-Z0-9_]{1,64}$/.test(message) ? message : 'PREPARED_RECHECK_FAILED'
          await markNotDispatched(tool, reasonCode)
          throw new ToolDeniedError(reasonCode)
        }
        throwIfAborted(input.request.signal)
        if (!matchesRecheckBinding(initialBinding, recheckBinding)) {
          await markNotDispatched(tool, 'STALE_AUTHORIZATION')
          throw new ToolDeniedError('STALE_AUTHORIZATION')
        }
        const authorization = await input.safetyGate.authorize(recheckBinding, input.request.signal)
        if (input.request.signal?.aborted && authorization.kind === 'allow') {
          input.safetyGate.discardPermit(authorization.permitId)
        }
        throwIfAborted(input.request.signal)
        if (authorization.kind !== 'allow') {
          const reason = authorization.kind === 'deny' ? authorization.reasonCode : 'RECHECK_REQUIRES_CONFIRMATION'
          await markNotDispatched(tool, reason)
          throw new ToolDeniedError(reason)
        }
        try {
          executionResult = await input.toolExecution.execute(executionCall, authorization.permitId, async () => {
            await appendHistory([{
              kind: 'tool-call-started',
              payload: {
                toolCallId: tool.toolCallId,
                toolName: tool.toolName,
                inputHash: createHash('sha256').update(JSON.stringify(tool.input)).digest('hex'),
                decisionRuleId: recheckBinding.authorizationVersion
              }
            }])
            toolDispatchStates.set(tool.toolCallId, 'started')
          })
        } catch (error) {
          if (error instanceof ToolExecutionRejectedError) {
            // tool-call-started is committed before the dispatch lease's final abort check.
            // A rejection here proves the executor was never entered, so settle the
            // proposal as not-dispatched even if that start projection already exists.
            toolDispatchStates.set(tool.toolCallId, 'pending')
            if (error.reason === 'CANCELLED' || input.request.signal?.aborted) {
              await markNotDispatched(tool, isTurnTimeoutSignal(input.request.signal) ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED')
              throw abortErrorForSignal(input.request.signal)
            }
            await markNotDispatched(tool, error.reason)
            throw new ToolDeniedError(error.reason)
          }
          throw error
        }
      } catch (error) {
        if (error instanceof ToolExecutionAfterDispatchError) throw error
        throwIfAborted(input.request.signal)
        throw error
      } finally {
        resourceLease?.release()
      }
      const replayContent = executionResult.replayContent ?? executionResult.output
      const committedToolResult = await appendHistory([{
        kind: 'tool-call-finished',
        payload: {
          toolCallId: tool.toolCallId,
          success: !(executionResult.isError ?? false),
          result: executionResult.output,
          replayContent,
          isError: executionResult.isError ?? false,
          ...(executionResult.auditRef ? { auditRef: executionResult.auditRef } : {}),
          ...(input.sessionLedgerForToolResult ? { sessionLedger: await input.sessionLedgerForToolResult({ ...tool, invocationId: input.invocationId }, executionResult) } : {})
        }
      }])
      toolDispatchStates.set(tool.toolCallId, 'finished')
      const committedPayload = committedToolResult[0]?.payload as { toolCallId?: string; result?: unknown; replayContent?: unknown; success?: boolean; isError?: boolean } | undefined
      const canonicalResult: CanonicalTurnMessage = {
        role: 'tool',
        toolCallId: committedPayload?.toolCallId ?? tool.toolCallId,
        content: committedPayload && 'replayContent' in committedPayload
          ? committedPayload.replayContent
          : committedPayload && 'result' in committedPayload ? committedPayload.result : replayContent,
        isError: committedPayload ? committedPayload.isError ?? committedPayload.success === false : executionResult.isError ?? false
      }
      await projectTool(input.observer, 'tool-finished', () => input.observer?.onToolFinished?.(executionCall, executionResult))
      try { await input.afterToolResult?.(executionCall, executionResult, { kind: 'execution', modelTurn: modelTurns }) }
      catch (error) { await observe(input.observer, 'tool-finished', () => input.observer?.onObservationError?.(error, 'tool-finished')) }
      return canonicalResult
      } finally {
        if (approvalPermitHeld) approvalSlots.release()
        releaseCandidate?.()
      }
    }, { shouldDrain: (reason) => reason instanceof ToolDeniedError })
    const fatalRejection = settledTools.find((settled) => settled?.status === 'rejected' && !(settled.reason instanceof ToolDeniedError))
    const pendingToolCallIds = toolCalls.flatMap((tool, index) => settledTools[index] === undefined ? [tool.toolCallId] : [])
    if (fatalRejection?.status === 'rejected') {
      const attemptedCount = settledTools.filter((settled) => settled !== undefined).length
      if (pendingToolCallIds.length > 0) {
        await observe(input.observer, 'dispatch-diagnostic', () => input.observer?.onDispatchStoppedWithPending?.({
          modelTurn: modelTurns,
          reason: fatalRejection.reason instanceof AgentTurnHistoryAppendError ? fatalRejection.reason.kinds.join(',') : fatalRejection.reason instanceof Error ? fatalRejection.reason.name : 'UNKNOWN',
          attemptedCount,
          undispatchedToolCallIds: pendingToolCallIds
        }))
      }
      const failedIndex = settledTools.findIndex((settled) => settled?.status === 'rejected' && settled.reason === fatalRejection.reason)
      const failedTool = toolCalls[failedIndex]
      if (failedTool) {
        await observe(input.observer, 'dispatch-diagnostic', () => input.observer?.onToolDispatchFailureContext?.({
          modelTurn: modelTurns, stepId: `${invocationId}:turn:${modelTurns}`, toolCallId: failedTool.toolCallId,
          toolName: failedTool.toolName,
          reasonCode: fatalRejection.reason instanceof AgentTurnHistoryAppendError ? fatalRejection.reason.kinds.join(',') : fatalRejection.reason instanceof Error ? fatalRejection.reason.name : 'UNKNOWN'
        }))
      }
    }
    // A fatal stop can leave unclaimed slots in the scheduler. Materialize each
    // one before any array iterator can turn a sparse hole into `undefined`.
    let materializedCount = 0
    for (const [index, settled] of settledTools.entries()) {
      if (settled !== undefined) continue
      const tool = toolCalls[index]
      if (!tool) continue
      if (toolDispatchStates.get(tool.toolCallId) !== 'pending') {
        throw new Error(`tool dispatch slot ${tool.toolCallId} has no settled result after dispatch`)
      }
      const reason = parkRequested ? 'DEFERRED_APPROVAL_PARKED' : input.request.signal?.aborted ? 'REQUEST_CANCELLED' : 'TURN_STOPPED_BEFORE_DISPATCH'
      await markNotDispatched(tool, reason)
      settledTools[index] = { status: 'fulfilled', value: {
        role: 'tool', toolCallId: tool.toolCallId,
        content: `Tool call was not dispatched (${reason}).`,
        isError: true
      } }
      materializedCount += 1
    }
    if (materializedCount > 0) await observe(input.observer, 'dispatch-diagnostic', () => input.observer?.onUndispatchedToolsMaterialized?.({ modelTurn: modelTurns, count: materializedCount }))
    const deniedToolResults = new Map<string, CanonicalTurnMessage>()
    if (input.returnDeniedToolsToModel) {
      for (const [index, settled] of settledTools.entries()) {
        if (!settled) continue
        if (settled.status !== 'rejected' || !(settled.reason instanceof ToolDeniedError)) continue
        const matchingTool = toolCalls[index]
        if (!matchingTool) continue
        const content = settled.reason.userMessage ?? `Tool call was not dispatched (${settled.reason.reasonCode}).`
        const executionCall = { invocationId, toolCallId: matchingTool.toolCallId, toolName: matchingTool.toolName, input: structuredClone(matchingTool.input), ...(input.request.signal ? { signal: input.request.signal } : {}) }
        const result = { output: content, replayContent: content, isError: true }
        deniedToolResults.set(matchingTool.toolCallId, { role: 'tool', toolCallId: matchingTool.toolCallId, content, isError: true })
        await projectTool(input.observer, 'tool-finished', () => input.observer?.onToolFinished?.(executionCall, result))
        try { await input.afterToolResult?.(executionCall, result, { kind: 'safety-rejection', reasonCode: settled.reason.reasonCode }) }
        catch (error) { await observe(input.observer, 'tool-finished', () => input.observer?.onObservationError?.(error, 'tool-finished')) }
      }
    }
    const rejectedTools = settledTools.filter((settled, index): settled is PromiseRejectedResult => settled?.status === 'rejected' &&
      !(input.returnDeniedToolsToModel && deniedToolResults.has(toolCalls[index]?.toolCallId ?? '')))
    const rejectedTool = rejectedTools.find(({ reason }) => reason instanceof ToolExecutionAfterDispatchError)
      ?? rejectedTools.find(({ reason }) => reason instanceof AgentTurnHistoryAppendError && reason.kinds.includes('tool-call-finished'))
      ?? rejectedTools.find(({ reason }) => reason instanceof AgentTurnCancelledError || reason instanceof AgentTurnTimedOutError)
      ?? rejectedTools[0]
    if (rejectedTool) {
      if (rejectedTool.reason instanceof DeferredTurnParkedError) {
        for (const tool of toolCalls) {
          if (toolDispatchStates.get(tool.toolCallId) === 'pending') await markNotDispatched(tool, 'DEFERRED_APPROVAL_PARKED')
        }
        return { text, messages, modelTurns, finishReason: collected.finish.reason,
          usage: { inputTokens, outputTokens, ...(cacheReadInputTokens ? { cacheReadInputTokens } : {}), ...(cacheCreationInputTokens ? { cacheCreationInputTokens } : {}) }, parked: true,
          ...(parkedTodoId ? { parkedTodoId } : {}) }
      }
      for (const tool of toolCalls) {
        if (toolDispatchStates.get(tool.toolCallId) === 'pending') {
          await markNotDispatched(tool, input.request.signal?.aborted ? 'REQUEST_CANCELLED' : 'TURN_STOPPED_BEFORE_DISPATCH')
        }
      }
      throw rejectedTool.reason
    }
    // Keep transcript order tied to the provider's tool-call order, independent of dispatch completion order.
    messages.push(...settledTools.map((settled) => settled!.status === 'fulfilled'
      ? settled!.value
      : deniedToolResults.get(toolCalls[settledTools.indexOf(settled!)]?.toolCallId ?? '')!))
    dispatchedToolRounds += 1
  }

  async function collectProviderAttempt(stream: AsyncIterable<StreamChunk>, modelTurn: number, attempt: number): Promise<CollectedModelStream> {
    return collectModelAttempt(stream, {
      onChunk: (chunk) => observe(input.observer, 'model-chunk', () => input.observer?.onModelChunk?.(chunk)),
      onStreamError: async ({ usage }) => {
        if (!usage) return
        await projectModelAttemptUsage(input, {
          invocationId, modelTurn, attempt, routeId: input.routeId,
          usage, disposition: 'failed', reasonCode: 'PROVIDER_STREAM_FAILED'
        })
      }
    }, { idleTimeoutMs: input.providerStreamIdleTimeoutMs ?? 120_000 })
  }
  throw new ModelTurnLimitError(input.maxModelTurns)
}

function collectCanonicalHostResponse(response: HostCommittedModelResponse): CollectedModelStream {
  if (response.message.role !== 'assistant') throw new Error('host-committed model response must be an assistant message')
  if (!['stop', 'tool-calls', 'length', 'cancelled'].includes(response.finishReason)) throw new Error('host-committed model response has an invalid finish reason')
  if (!Number.isInteger(response.usage.inputTokens) || response.usage.inputTokens < 0 || !Number.isInteger(response.usage.outputTokens) || response.usage.outputTokens < 0) {
    throw new Error('host-committed model response has invalid usage')
  }
  const chunks: Array<Exclude<StreamChunk, { type: 'finish' | 'usage' }>> = []
  if (typeof response.message.content === 'string') {
    if (response.message.content) chunks.push({ type: 'text-delta', text: response.message.content })
  } else if (response.message.content) {
    for (const block of response.message.content) {
      if (block.type === 'text') chunks.push({ type: 'text-delta', text: block.text })
      else if (block.type === 'thinking') {
        if (block.thinking) chunks.push({ type: 'thinking-delta', text: block.thinking })
        if (block.thinkingSignature) chunks.push({ type: 'thinking-signature', signature: block.thinkingSignature, ...(block.redacted ? { redacted: true } : {}) })
      }
    }
  }
  for (const tool of response.message.toolCalls ?? []) chunks.push({ type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: structuredClone(tool.input), ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}) })
  if (response.finishReason === 'cancelled') return { chunks, usage: response.usage, finish: { type: 'finish', reason: 'cancelled' } }
  return { chunks, usage: response.usage, finish: { type: 'finish', reason: response.finishReason } }
}

async function assertHostCommittedResponse(history: HistoryPort | undefined, invocationId: string, response: HostCommittedModelResponse): Promise<Readonly<{ message: CanonicalTurnMessage; sessionLedger?: unknown; sessionLedgerStepId?: string }>> {
  if (!history) throw new Error('host-committed model response requires HistoryPort')
  const snapshot = await history.read(invocationId)
  const latest = snapshot.events.at(-1)
  if (!latest || latest.kind !== 'model-response-committed') {
    throw new Error('host-committed model response is not the latest History event')
  }
  const payload = latest?.payload as { message?: unknown; finishReason?: unknown; usage?: unknown } | undefined
  if (!latest || JSON.stringify(payload?.message) !== JSON.stringify(response.message)) {
    throw new Error('host-committed model response does not match the latest canonical History event')
  }
  const hostFinishReason = response.finishReason === 'tool-calls' ? 'tool_use'
    : response.finishReason === 'length' ? 'max_tokens'
      : response.finishReason === 'cancelled' ? 'cancelled' : 'end_turn'
  if (payload?.finishReason !== hostFinishReason) throw new Error('host-committed model response finish reason does not match History')
  const expectedUsage = {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    ...(response.usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: response.usage.cacheReadInputTokens } : {}),
    ...(response.usage.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: response.usage.cacheCreationInputTokens } : {})
  }
  if (JSON.stringify(payload?.usage) !== JSON.stringify(expectedUsage)) {
    throw new Error('host-committed model response usage does not match History')
  }
  const sessionLedger = (payload as { sessionLedger?: unknown } | undefined)?.sessionLedger
  const sessionLedgerStepId = sessionLedger && typeof sessionLedger === 'object' && !Array.isArray(sessionLedger) && typeof (sessionLedger as { stepId?: unknown }).stepId === 'string'
    ? (sessionLedger as { stepId: string }).stepId
    : undefined
  return {
    message: response.message,
    ...(sessionLedger !== undefined ? { sessionLedger } : {}),
    ...(sessionLedgerStepId ? { sessionLedgerStepId } : {})
  }
}

function canonicalRequestSnapshot(call: PreparedModelCall): Readonly<{
  route: PreparedModelCall['route']
  request: Omit<PreparedModelCall['request'], 'credentials' | 'signal'>
}> {
  return snapshotPreparedModelCall(call)
}

function sameRouteIdentity(left: PreparedModelCall['route'], right: PreparedModelCall['route']): boolean {
  const normalize = (route: PreparedModelCall['route']) => Object.entries(route).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>, options: { shouldDrain?: (reason: unknown) => boolean } = {}): Promise<Array<PromiseSettledResult<R> | undefined>> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('maxConcurrentTools must be a positive integer')
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let nextIndex = 0
  let state: 'running' | 'draining-after-denial' | 'stopped' = 'running'
  let activeWorkers = 0
  const claimed = new Set<number>()
  let wakeWorkers: (() => void) | undefined
  const notifyWorkers = () => { const wake = wakeWorkers; wakeWorkers = undefined; wake?.() }
  const waitForWorkers = () => new Promise<void>((resolve) => {
    const previous = wakeWorkers
    wakeWorkers = () => { previous?.(); resolve() }
  })
  const worker = async () => {
    while (true) {
      if (state === 'stopped') return
      if (state === 'draining-after-denial') {
        if (activeWorkers === 0) {
          state = 'running'
          notifyWorkers()
        } else {
          await waitForWorkers()
          continue
        }
      }
      const index = nextIndex++
      if (index >= items.length) return
      claimed.add(index)
      activeWorkers += 1
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]!, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
        if (options.shouldDrain?.(reason)) {
          if (state === 'running') state = 'draining-after-denial'
        } else {
          state = 'stopped'
        }
      } finally {
        activeWorkers -= 1
        if (activeWorkers === 0 || state === 'stopped') notifyWorkers()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  // Keep the slot array dense for every claimed worker. Only indices beyond the
  // scheduler cursor were never claimed and may be materialized by the caller.
  for (const index of claimed) {
    if (results[index] !== undefined) continue
    results[index] = { status: 'rejected', reason: new Error('claimed tool worker ended without a settled result') }
  }
  return results
}

class ApprovalCandidateSlots {
  private readonly ledger: CapacityLedger
  private readonly waiters: Array<() => void> = []
  constructor(limit: number, queueLimit: number) {
    this.ledger = new CapacityLedger({ applicationSlots: 1, approvalCandidateSlots: limit, queueLimit, maxApprovalsPerParent: limit })
  }
  async acquire(parentTaskId: string, signal?: AbortSignal, onWait?: () => void | Promise<void>): Promise<() => void> {
    let waitingNotified = false
    while (true) {
          if (signal?.aborted) throw abortErrorForSignal(signal)
      const reservation: CapacityReservation | undefined = this.ledger.reserveApprovalCandidate(parentTaskId)
      if (reservation) return () => { reservation.release(); this.waiters.shift()?.() }
      if (!waitingNotified) {
        waitingNotified = true
        await onWait?.()
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { const index = this.waiters.indexOf(wake); if (index >= 0) this.waiters.splice(index, 1); reject(abortErrorForSignal(signal)) }
        const wake = () => { signal?.removeEventListener('abort', onAbort); resolve() }
        this.waiters.push(wake)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}

function assistantHistoryContent(content: readonly CanonicalContentBlock[], text: string): string | readonly CanonicalContentBlock[] | undefined {
  if (content.some((block) => block.type === 'thinking')) return content
  return text || (content.length ? content.map((block) => block.type === 'text' ? block.text : '').join('') : undefined)
}

function assistantTextForLegacyProjection(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.every((block) => block && typeof block === 'object' && !Array.isArray(block) &&
    (((block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string') ||
      ((block as Record<string, unknown>).type === 'thinking' && typeof (block as Record<string, unknown>).thinking === 'string') ||
      ((block as Record<string, unknown>).type === 'image' && typeof (block as Record<string, unknown>).data === 'string')))) return undefined
  return content.filter((block) => (block as Record<string, unknown>).type === 'text')
    .map((block) => (block as Record<string, unknown>).text as string).join('')
}

async function observe(observer: AgentTurnObserver | undefined, stage: Parameters<NonNullable<AgentTurnObserver['onObservationError']>>[1], callback: () => void | Promise<void> | undefined): Promise<void> {
  try { await callback() } catch (error) {
    try { await observer?.onObservationError?.(error, stage) } catch { /* observation diagnostics cannot change execution */ }
  }
}

async function projectTool(observer: AgentTurnObserver | undefined, stage: 'tool-started' | 'tool-finished', callback: () => void | Promise<void> | undefined): Promise<void> {
  if (!observer?.criticalToolProjection) {
    await observe(observer, stage, callback)
    return
  }
  try { await callback() }
  catch (error) {
    try { await observer.onObservationError?.(error, stage) } catch { /* diagnostic delivery cannot replace the projection failure */ }
    throw new AgentTurnToolProjectionError(error)
  }
}

async function projectTurnOutput(observer: AgentTurnObserver | undefined, result: AgentTurnResult): Promise<void> {
  if (!observer?.onTurnOutputReady) return
  try { await observer.onTurnOutputReady(result) }
  catch (error) {
    try { await observer.onObservationError?.(error, 'turn-output-ready') } catch { /* diagnostic delivery cannot replace the projection failure */ }
    throw new AgentTurnHostProjectionError(error)
  }
}

async function projectModelAttemptUsage(input: RunAgentTurnInput, usage: Record<string, unknown>): Promise<void> {
  const project = () => input.recordProviderAttemptUsage?.(usage)
  if (!input.observer?.criticalModelAttemptUsageProjection) {
    await observe(input.observer, 'model-attempt-usage', project)
    return
  }
  try { await project() }
  catch (error) {
    try { await input.observer.onObservationError?.(error, 'model-attempt-usage') } catch { /* diagnostic delivery cannot replace the usage failure */ }
    throw error
  }
}

function matchesRecheckBinding(initial: PermitBinding, recheck: PermitBinding): boolean {
  return recheck.phase === 'recheck' &&
    initial.requestId === recheck.requestId &&
    initial.turnId === recheck.turnId &&
    initial.invocationId === recheck.invocationId &&
    initial.toolCallId === recheck.toolCallId &&
    initial.capabilityId === recheck.capabilityId &&
    initial.inputSnapshotHash === recheck.inputSnapshotHash &&
    initial.planDigest === recheck.planDigest &&
    initial.factsDigest === recheck.factsDigest &&
    initial.authorizationVersion === recheck.authorizationVersion
}
