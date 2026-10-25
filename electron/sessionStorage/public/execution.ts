import type { Message } from '../../../src/shared/domainTypes'
import type { AcceptedTurn } from '../../../src/shared/acceptedTurn'
import type { TurnExecutionConfig } from '../../../src/shared/assistantFactAggregator'
import type { ClaudeChatMessageWithBlocks } from '../../../src/shared/api'
import type { PersistedTurnRecord, TurnStarted, TurnStorage } from '../../../src/shared/turnCoordinator'
import type { EnqueueResult, HostedTranscriptSnapshot, MessageEntry, ContinuationIntentAcceptance,
  ContinuationIntentReceipt, ContinuationSourceRef, SelectionFence, MessageSkeleton } from './model'
import type { SessionHistoryPort } from './ports'

export type PreparedIdentity = Readonly<{
  sessionId: string; turnId: string; requestId: string; startToken: string; userMessage?: Pick<Message, 'id'>
}>
export type ExecutionLease = Readonly<{ sessionId: string; turnId: string; ownerId: string; generation: number }>
export type ExecutionClaimResult = Readonly<{ acquired: true; generation: number }> | Readonly<{ acquired: false; reason: 'owned' | 'blocked' }>
export type PrepareTurnInput = Parameters<TurnStorage['prepareAtomic']>[0] & Readonly<{
  acceptance?: Readonly<{
    payloadSha256: string; rawText: string; kind: 'exact-continue' | 'follow-up'; route: string
    sourceInvocationId?: string; sourceTurnId?: string; sourceSequence?: number
  }>
}>
export type ClaimQueuedTurnInput = Parameters<TurnStorage['claimQueuedAtomic']>[0]
export type PreparedTurnResult = ReturnType<TurnStorage['prepareAtomic']>
export type ClaimedQueuedTurnResult = ReturnType<TurnStorage['claimQueuedAtomic']>

export type ContinuationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'
export type ContinuationTerminalStatus = Extract<ContinuationStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'>
export type ContinuationRecordSnapshot = Readonly<{
  continuationId: string; sourceInvocationId: string; sourceTurnId: string; checkpointSequence: number
  checkpointSha256: string; requestIdempotencyKey: string; createdBy: string; frozenConfig: Record<string, unknown>
  targetInvocationId: string; targetTurnId: string; targetStartToken: string; status: ContinuationStatus
}>
export type ContinuationIntentAcceptanceResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'selection-required'; receipt: ContinuationIntentReceipt }>
  | Readonly<{ kind: 'queued'; receipt: ContinuationIntentReceipt; message: MessageSkeleton }>
  | Readonly<{ kind: 'turn'; receipt: ContinuationIntentReceipt; turn: PersistedTurnRecord; assistant: MessageSkeleton }>
  | Readonly<{ kind: 'continuation'; receipt: ContinuationIntentReceipt; continuation: ContinuationRecordSnapshot; message: MessageSkeleton }>
  | Readonly<{ kind: 'starting'; receipt: ContinuationIntentReceipt; continuation?: ContinuationRecordSnapshot }>
  | Readonly<{ kind: 'unresolved'; receipt?: ContinuationIntentReceipt; reason: string }>

export interface ContinuationStore {
  createOrGet(input: { sessionId: string; sourceInvocationId: string; requestIdempotencyKey: string; createdBy: string; frozenConfig: Record<string, unknown> }): ContinuationRecordSnapshot
  claim(input: { continuationId: string; revalidatedFrozenConfig: Record<string, unknown> }): boolean
  settle(input: { continuationId: string; status: ContinuationTerminalStatus }): boolean
  settleForTurn(input: { targetTurnId: string; status: ContinuationTerminalStatus }): boolean
  readByTarget(input: { sessionId: string; targetInvocationId: string }): ContinuationRecordSnapshot | undefined
  readByRequest(input: { sessionId: string; requestIdempotencyKey: string }): ContinuationRecordSnapshot | undefined
  readAwaitingBySource(input: { sessionId: string; sourceTurnId: string }): ContinuationRecordSnapshot | undefined
  readCancelledBySource(input: { sessionId: string; sourceTurnId: string }): ContinuationRecordSnapshot | undefined
  cancelPending(input: { continuationId: string }): boolean
}
export type ContinuationLaunchResult = Readonly<{ accepted: true; started: boolean; continuation: ContinuationRecordSnapshot; turn?: TurnStarted }>
export interface ContinuationLaunchStore {
  prepareAndClaim(input: {
    payload: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments'] }
    source: ContinuationSourceRef; createdBy: string; frozenConfig: Record<string, unknown>
    executionConfig: TurnExecutionConfig; recoveryMode?: 'exact' | 'unknown-effects'; deferDispatch?: boolean
    acceptance?: Pick<ContinuationIntentAcceptance, 'payloadSha256' | 'rawText' | 'attachments' | 'intentKind' | 'route'>
  }): Promise<ContinuationLaunchResult>
}

/** Public process capability used by turn execution, recovery and outbound adapters. */
export interface SessionExecutionStore {
  readonly continuations: ContinuationStore
  readonly continuationLaunch: ContinuationLaunchStore
  prepareTurn(input: PrepareTurnInput): PreparedTurnResult
  claimQueuedTurn(input: ClaimQueuedTurnInput): ClaimedQueuedTurnResult
  historyFor(input: Readonly<{ sessionId: string }>): SessionHistoryPort
  acceptPrepared(input: { prepared: PreparedIdentity; lane: NonNullable<TurnExecutionConfig['lane']>; config: TurnExecutionConfig }): AcceptedTurn
  commitExecutionConfig(input: { ref: Readonly<{ sessionId: string; turnId: string }>; config: TurnExecutionConfig; intentFingerprint: string; fence: SelectionFence }): boolean
  failConfiguring(input: { ref: Readonly<{ sessionId: string; turnId: string }>; version: number; error: { code: string; message: string } }): boolean
  readTurn(ref: Readonly<{ sessionId: string; turnId: string }>): PersistedTurnRecord | undefined
  readTurnByRequest(ref: Readonly<{ sessionId: string; requestId: string }>): PersistedTurnRecord | undefined
  hasActiveTurn(sessionId: string): boolean
  listStartupOrphanTurns(): readonly Readonly<{ turnId: string; state: string; assistantMessageId: string }>[]
  getNextQueuedMessage(sessionId: string): import('./model').QueuedSessionMessage | null
  readAccepted(input: Readonly<{ sessionId: string; requestId: string }>): AcceptedTurn | undefined
  readTranscriptState(sessionId: string): Readonly<{ sessionId: string; version: number; lastTurnId?: string; status: 'ready' | 'commit_uncertain' | 'blocked' }>
  readHostedTranscript(sessionId: string): HostedTranscriptSnapshot
  loadAcceptedContinuationTranscript(ref: Readonly<{ sessionId: string; turnId: string }>): ClaudeChatMessageWithBlocks[] | undefined
  claimExecution(input: Readonly<{ sessionId: string; turnId: string; ownerId: string }>): ExecutionClaimResult
  markExecutionStarted(input: ExecutionLease): boolean
  releaseExecution(input: ExecutionLease): boolean
  cancelQueuedExecution(input: Readonly<{ sessionId: string; turnId: string; ownerId: string }>): boolean
  markExecutionUncertain(input: ExecutionLease): boolean
  enqueueContinuation(input: { enqueue: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }; intent: ContinuationIntentAcceptance }): EnqueueResult
  readContinuationIntent(input: { requestId: string; sessionId: string }): ContinuationIntentReceipt | undefined
  resolveContinuationAcceptance(input: { requestId: string; sessionId: string; payloadSha256: string }): ContinuationIntentAcceptanceResult
  requireContinuationSourceSelection(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up' }): ContinuationIntentReceipt
  selectOrdinaryContinuation(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up' }): ContinuationIntentReceipt
  rejectContinuationIntent(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up'; reason: string; status: 'rejected_retryable' | 'commit_uncertain' }): ContinuationIntentReceipt
  ensureContinuationStatusMessage(input: { requestId: string; sessionId: string }): MessageEntry
  beginContinuationIntent(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up'; source: ContinuationSourceRef }): ContinuationIntentReceipt
  finalizeContinuationAcceptance(input: { requestId: string; sessionId: string; payloadSha256: string; continuationId: string }): { receipt: ContinuationIntentReceipt; statusMessage: MessageEntry }
  enqueueAndRecordContinuation(input: { enqueue: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }; intent: ContinuationIntentAcceptance & { route: string } }): EnqueueResult
  bindStartedContinuationTurn(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up'; route: string; turnId: string; source?: { invocationId: string; turnId: string; sequence?: number }; retrySource?: { assistantMessageId: string; invocationId?: string } }): ContinuationIntentReceipt
  bindExactContinueTurn(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; turnId: string }): ContinuationIntentReceipt
  repairPreparedContinuationAcceptance(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up'; route: string; turnId: string; source?: { invocationId: string; turnId: string; sequence?: number }; retrySource?: { assistantMessageId: string; invocationId?: string } }): ContinuationIntentReceipt
  /** Synchronous compatibility reader; production provider handoffs must use loadAcceptedMessagesAsync. */
  loadAcceptedMessages(ref: Readonly<{ sessionId: string; turnId: string }>): Message[]
  /** Prepare and resolve canonical-backed accepted context through the bounded worker cache before handoff. */
  loadAcceptedMessagesAsync(ref: Readonly<{ sessionId: string; turnId: string }>): Promise<Message[]>
}
