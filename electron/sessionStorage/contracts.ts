import type { Message, Session } from '../../src/shared/domainTypes'
import type { HistoryPort, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import type { AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { TurnExecutionConfig } from '../../src/shared/assistantFactAggregator'
import type { SessionOwnership, SessionVisibility } from '../../src/shared/sessionOwnership'
import type { SessionDirectoryGrantRecord } from '../../src/shared/sessionDirectoryGrant'
import type { ContextPort } from '../../packages/agent-sdk/src/context'

export type MessageEntry = Readonly<{ message: Message; sequence: number }>
export type ApiContextBaseline = Readonly<{ sessionId: string; entries: readonly MessageEntry[] }>
export type ChatMessagePage = Readonly<{ entries: readonly MessageEntry[]; oldestSequence: number | null; hasMoreBefore: boolean }>
export type ExportPage = Readonly<{ rows: readonly MessageEntry[]; nextSequence: number }>
export type EnqueueResult = Readonly<{
  receipt: Readonly<{ sessionId: string; requestId: string; fingerprint: string; queuedMessageId?: string; turnId?: string; state: string }>
  persisted: MessageEntry
  duplicate: boolean
}>
export type MessagesPageWithSequence = Readonly<{ rows: readonly MessageEntry[]; nextSequence: number }>
export type SearchCorpusPage = Readonly<{ entries: readonly MessageEntry[]; nextSequence: number; hasMore: boolean }>
export type MessageSearchHit = Readonly<{ messageId: string; sessionId: string; content: string; sessionName: string }>
export type ContextHistorySummaryEntry = Readonly<{ messageId: string; role: Message['role']; imageTokens: number; thinkingTokens: number; sequence: number }>
export type ContextHistorySummaryBaseline = Readonly<{ sessionId: string; entries: readonly ContextHistorySummaryEntry[] }>
export type RetryContextTarget = Readonly<{
  failedAssistant: MessageEntry
  currentUser: MessageEntry
  excludeMessageIds: readonly string[]
  sourceInvocationId?: string
}>
export type HostedTranscriptSnapshot = Readonly<{
  sessionId: string
  version: number
  lastTurnId?: string
  status: 'ready' | 'commit_uncertain' | 'blocked'
  messages: readonly Readonly<Record<string, unknown>>[]
}>

export type MessageSkeleton = Readonly<{
  id: string
  sessionId: string
  role: Message['role']
  timestamp: number
  status: Message['status']
  sequence: number
}>

export type MessageRef = Readonly<{ sessionId: string; messageId: string }>
export type RemoteSessionIdentityUpdate =
  | Readonly<{ channel: 'feishu'; messageId: string }>
  | Readonly<{ channel: 'wechat'; userId: string; messageId: string; contextToken?: string; workDirProfileId?: string }>
declare const selectionFenceBrand: unique symbol
export type SelectionFence = Readonly<{ [selectionFenceBrand]: 'selection-fence' }>
export type RoutingRead = Readonly<{
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  userInput?: string
  hasVision: boolean
  fence: SelectionFence
}>
export type RouteInput = Readonly<{
  userInput: string
  recentMessages: readonly { role: 'user' | 'assistant'; content: string }[]
  [key: string]: unknown
}>

export type ContinuationSourceRef = Readonly<{
  sessionId: string
  invocationId: string
  turnId: string
  checkpointSequence: number
  expectedHistoryVersion: number
}>

/** Session-scoped History capability needed to safely select a prior Hosted transcript. */
export type SessionHistoryPort = HistoryPort & Readonly<{
  readLatestInvocationForSession(
    sessionId: string,
    options?: { excludeInvocationId?: string; excludeInvocationIds?: readonly string[] }
  ): Promise<
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'completed'; snapshot: HistorySnapshot }>
    | Readonly<{ kind: 'cancelled'; snapshot: HistorySnapshot }>
    | Readonly<{ kind: 'unavailable'; invocationId: string }>
  >
}>
export type ContinuationIntentAcceptance = Readonly<{
  payloadSha256: string
  rawText: string
  attachments?: Message['attachments']
  intentKind: 'exact-continue' | 'follow-up'
  route: string
  source?: Readonly<{ invocationId: string; turnId: string; sequence?: number }>
  context?: Readonly<Record<string, unknown>>
}>
export type ContinuationIntentReceipt = Readonly<{
  requestId: string
  sessionId: string
  payloadSha256: string
  route: string
  targetId?: string
  status: string
  rejectionReason?: string
}>
export type ContinuationIntentAcceptanceResult =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'selection-required'; receipt: ContinuationIntentReceipt }>
  | Readonly<{ kind: 'queued'; receipt: ContinuationIntentReceipt; message: MessageEntry }>
  | Readonly<{ kind: 'turn'; receipt: ContinuationIntentReceipt; turn: import('../../src/shared/turnCoordinator').PersistedTurnRecord; assistant: Message }>
  | Readonly<{ kind: 'continuation'; receipt: ContinuationIntentReceipt; continuation: SessionContinuationRecord; message: MessageEntry }>
  | Readonly<{ kind: 'starting'; receipt: ContinuationIntentReceipt; continuation?: SessionContinuationRecord }>
  | Readonly<{ kind: 'unresolved'; receipt?: ContinuationIntentReceipt; reason: string }>
export type SessionContinuationRecord = import('../runtime/agentContinuation').AgentContinuationRecord
export type ContinuationTerminalStatus = Extract<SessionContinuationRecord['status'], 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'>
export interface ContinuationStore {
  createOrGet(input: { sessionId: string; sourceInvocationId: string; requestIdempotencyKey: string; createdBy: string; frozenConfig: Record<string, unknown> }): SessionContinuationRecord
  claim(input: { continuationId: string; revalidatedFrozenConfig: Record<string, unknown> }): boolean
  settle(input: { continuationId: string; status: ContinuationTerminalStatus }): boolean
  settleForTurn(input: { targetTurnId: string; status: ContinuationTerminalStatus }): boolean
}
export interface ContinuationLaunchStore {
  prepareAndClaim(input: {
    payload: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments'] }
    source: ContinuationSourceRef
    createdBy: string
    frozenConfig: Record<string, unknown>
    executionConfig: TurnExecutionConfig
    acceptance: Pick<ContinuationIntentAcceptance, 'payloadSha256' | 'rawText' | 'attachments' | 'intentKind' | 'route'>
  }): ReturnType<typeof import('../runtime/agentContinuation').startAgentContinuation>
}

export type ContinuationSourceSummary = Readonly<{
  invocationId: string
  turnId: string
  sequence: number
  summary: string
  state: 'known' | 'unknown'
}>

export type FailedSourceCandidate = Readonly<{
  source: ContinuationSourceRef
  assistantMessageId?: string
  assistantSequence?: number
  snapshot: HistorySnapshot
  summary: ContinuationSourceSummary
}>

export type ContinuationSourceInspection =
  | Readonly<{ kind: 'unavailable'; reason: 'CONTINUATION_INTENT_HISTORY_UNAVAILABLE' }>
  | Readonly<{
      kind: 'available'
      boundary: 'running-turn-superseded' | 'newer-input' | 'completed-invocation' | 'history-start'
      failedCandidates: readonly FailedSourceCandidate[]
      selected: { kind: 'not-requested' } | { kind: 'found'; candidate: FailedSourceCandidate } | { kind: 'not-found' | 'not-recoverable' }
      fallback?: FailedSourceCandidate
      selectedFallback?: FailedSourceCandidate
    }>

export interface ContinuationSourceQueries {
  inspect(input: {
    sessionId: string
    activeTurnIds: readonly string[]
    selectedAssistantMessageId?: string
  }): ContinuationSourceInspection
}

/** Bound, database-free business read capabilities for a session storage instance. */
export interface SessionQueries {
  readonly continuationSources: ContinuationSourceQueries
  readSession(sessionId: string): Session | undefined
  listSessions(options?: { view?: 'all' | 'user-visible' }): Session[]
  readMessage(ref: MessageRef): Message | undefined
  readMessages(input: { sessionId: string; limit?: number; offset?: number }): Message[]
  readChatPage(input: { sessionId: string; beforeSequence?: number | null; limit?: number }): ChatMessagePage
  readTurnContext(input: {
    sessionId: string
    boundarySequence?: number
    requiredUserMessageId?: string
    excludeMessageIds?: string[]
  }): Message[]
  readApiBaseline(input: { sessionId: string; limit?: number }): ApiContextBaseline
  readContextHistorySummaryBaseline(sessionId: string): ContextHistorySummaryBaseline
  readRoutingInput(input: {
    sessionId: string
    boundarySequence?: number
    requiredUserMessageId?: string
    excludeMessageIds?: string[]
    limit?: number
    reuseUserMessageId?: string
    userInput?: string
  }): RoutingRead
  resolveRoutingInput<T extends RouteInput>(input: {
    sessionId: string
    selection: SelectionFence
    routeInput: T
  }): Readonly<{ routeInput: T; fence: SelectionFence }>
  isSelectionCurrent(sessionId: string, fence: SelectionFence): boolean
  readSelectionSnapshot(sessionId: string, fence: SelectionFence): Readonly<{ sessionId: string; generation: string; messageRevision: number }> | undefined
  readExportPage(input: { sessionId: string; fromSequence: number; pageSize: number }): ExportPage
  readSearchCorpusPage(input: { sessionId: string; fromSequence: number; pageSize?: number }): SearchCorpusPage
  searchMessages(input: { query: string; activeProfileId: string; limit?: number }): MessageSearchHit[]
  readRetryTarget(input: { sessionId: string; failedAssistantMessageId: string }): RetryContextTarget | null
  readLatestRetryTarget(sessionId: string): RetryContextTarget | null
  readMessageSequence(ref: MessageRef): number | null
}

export interface SessionCommands {
  appendNonTurnMessage(message: Message): MessageEntry
  createSession(input: {
    name: string; model?: string; llmServiceId?: string; temperature?: number; maxTokens?: number
    workDirProfileId?: string; fixedWorkDir?: string; ownership?: SessionOwnership; visibility?: SessionVisibility
    thinkingEffort?: Session['thinkingEffort']; metadata?: Readonly<Record<string, unknown>>
  }): Session
  renameSession(sessionId: string, name: string): Session | undefined
  updateSettings(input: {
    sessionId: string
    model?: Session['model']
    llmServiceId?: Session['llmServiceId']
    temperature?: Session['temperature']
    maxTokens?: Session['maxTokens']
    skillsState?: Session['skillsState']
    workDirProfileId?: Session['workDirProfileId']
    thinkingEffort?: Session['thinkingEffort'] | null
  }): Session | undefined
  updateUserMetadata(sessionId: string, metadataPatch: Readonly<Record<string, unknown>>): Session | undefined
  updateDirectoryGrants(sessionId: string, grants: readonly SessionDirectoryGrantRecord[]): Session | undefined
  updateTitleSuggestionState(sessionId: string, state: { generated?: boolean; backfillAttempted?: boolean }): Session | undefined
  applyGeneratedTitle(sessionId: string, title: string): Session | undefined
  recordRemoteSessionActivity(sessionId: string, at: number): Session | undefined
  recordRemoteSessionIdentity(sessionId: string, identity: RemoteSessionIdentityUpdate): Session | undefined
  deleteQueuedMessage(messageId: string): { ok: true; sessionId: string } | { ok: false; error: string }
  editQueuedMessage(input: { sessionId: string; messageId: string; content: string }):
    | { ok: true; message: Message; sequence: number }
    | { ok: false; error: 'message_not_queued' | 'empty_content' }
  reorderQueuedMessages(input: { sessionId: string; messageIds: string[] }):
    | { ok: true; entries: MessageEntry[] }
    | { ok: false; error: 'queue_changed' }
  deleteSession(sessionId: string): void
  updateToolCallScrollback(input: { sessionId: string; messageId: string; toolCalls: NonNullable<Message['toolCalls']> }): MessageEntry | null
  enqueue(input: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }): {
    receipt: Readonly<{ sessionId: string; requestId: string; fingerprint: string; queuedMessageId?: string; turnId?: string; state: string }>
    persisted: MessageEntry
    duplicate: boolean
  }
  editMessage(input: {
    sessionId: string
    messageId: string
    content: string
  }): Promise<boolean>
}

export type PreparedIdentity = Readonly<{
  turnId: string; requestId: string; sessionId: string; startToken: string
  userMessage?: Pick<Message, 'id'>
}>
export type ExecutionLease = Readonly<{ sessionId: string; turnId: string; ownerId: string; generation: number }>
export type ExecutionClaimResult = Readonly<{ acquired: true; generation: number }> | Readonly<{ acquired: false; reason: 'owned' | 'blocked' }>
export type PrepareTurnInput = Parameters<import('../../src/shared/turnCoordinator').TurnStorage['prepareAtomic']>[0] & Readonly<{
  acceptance?: Readonly<{ payloadSha256: string; rawText: string; kind: 'exact-continue' | 'follow-up'; route: string; sourceInvocationId?: string; sourceTurnId?: string; sourceSequence?: number }>
}>
export type ClaimQueuedTurnInput = Parameters<import('../../src/shared/turnCoordinator').TurnStorage['claimQueuedAtomic']>[0]

export interface SessionExecutionStore {
  readonly coordinator: import('../../src/shared/turnCoordinator').TurnStorage
  readonly continuations: ContinuationStore
  readonly continuationLaunch: ContinuationLaunchStore
  prepareTurn(input: PrepareTurnInput): ReturnType<import('../../src/shared/turnCoordinator').TurnStorage['prepareAtomic']>
  claimQueuedTurn(input: ClaimQueuedTurnInput): ReturnType<import('../../src/shared/turnCoordinator').TurnStorage['claimQueuedAtomic']>
  /** Create a HistoryPort whose reads and writes are confined to one session. */
  historyFor(input: Readonly<{ sessionId: string }>): SessionHistoryPort
  acceptPrepared(input: {
    prepared: PreparedIdentity
    lane: NonNullable<TurnExecutionConfig['lane']>
    config: TurnExecutionConfig
  }): AcceptedTurn
  commitExecutionConfig(input: {
    ref: Readonly<{ sessionId: string; turnId: string }>
    config: TurnExecutionConfig
    intentFingerprint: string
    fence: SelectionFence
  }): boolean
  failConfiguring(input: {
    ref: Readonly<{ sessionId: string; turnId: string }>
    version: number
    error: { code: string; message: string }
  }): boolean
  readTurn(ref: Readonly<{ sessionId: string; turnId: string }>): import('../../src/shared/turnCoordinator').PersistedTurnRecord | undefined
  readTurnByRequest(ref: Readonly<{ sessionId: string; requestId: string }>): import('../../src/shared/turnCoordinator').PersistedTurnRecord | undefined
  hasActiveTurn(sessionId: string): boolean
  readAccepted(input: Readonly<{ sessionId: string; requestId: string }>): AcceptedTurn | undefined
  readTranscriptState(sessionId: string): Readonly<{
    sessionId: string
    version: number
    lastTurnId?: string
    status: 'ready' | 'commit_uncertain' | 'blocked'
  }>
  /** Hosted execution checkpoint data is exposed through its owner, never through a database handle. */
  readHostedTranscript(sessionId: string): HostedTranscriptSnapshot
  /** Loads and validates the accepted continuation transcript from its scoped History owner. */
  loadAcceptedContinuationTranscript(ref: Readonly<{ sessionId: string; turnId: string }>): import('../../src/shared/api').ClaudeChatMessageWithBlocks[] | undefined
  claimExecution(input: Readonly<{ sessionId: string; turnId: string; ownerId: string }>): ExecutionClaimResult
  markExecutionStarted(input: ExecutionLease): boolean
  releaseExecution(input: ExecutionLease): boolean
  cancelQueuedExecution(input: Readonly<{ sessionId: string; turnId: string; ownerId: string }>): boolean
  markExecutionUncertain(input: ExecutionLease): boolean
  enqueueContinuation(input: {
    enqueue: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }
    intent: ContinuationIntentAcceptance
  }): EnqueueResult
  readContinuationIntent(input: { requestId: string; sessionId: string }): ContinuationIntentReceipt | undefined
  resolveContinuationAcceptance(input: { requestId: string; sessionId: string; payloadSha256: string }): ContinuationIntentAcceptanceResult
  requireContinuationSourceSelection(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up' }): ContinuationIntentReceipt
  selectOrdinaryContinuation(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up' }): ContinuationIntentReceipt
  rejectContinuationIntent(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; intentKind: 'exact-continue' | 'follow-up'; reason: string; status: 'rejected_retryable' | 'commit_uncertain' }): ContinuationIntentReceipt
  ensureContinuationStatusMessage(input: { requestId: string; sessionId: string }): MessageEntry
  beginContinuationIntent(input: {
    requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string
    intentKind: 'exact-continue' | 'follow-up'; source: ContinuationSourceRef
  }): ContinuationIntentReceipt
  finalizeContinuationAcceptance(input: { requestId: string; sessionId: string; payloadSha256: string; continuationId: string }): { receipt: ContinuationIntentReceipt; statusMessage: MessageEntry }
  enqueueAndRecordContinuation(input: {
    enqueue: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }
    intent: ContinuationIntentAcceptance & { route: string }
  }): EnqueueResult
  bindStartedContinuationTurn(input: {
    requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string
    intentKind: 'exact-continue' | 'follow-up'; route: string; turnId: string
    source?: { invocationId: string; turnId: string; sequence?: number }
    retrySource?: { assistantMessageId: string; invocationId?: string }
  }): ContinuationIntentReceipt
  bindExactContinueTurn(input: { requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string; turnId: string }): ContinuationIntentReceipt
  repairPreparedContinuationAcceptance(input: {
    requestId: string; sessionId: string; text: string; attachments?: Message['attachments']; payloadSha256: string
    intentKind: 'exact-continue' | 'follow-up'; route: string; turnId: string
    source?: { invocationId: string; turnId: string; sequence?: number }
    retrySource?: { assistantMessageId: string; invocationId?: string }
  }): ContinuationIntentReceipt
  loadAcceptedMessages(ref: Readonly<{ sessionId: string; turnId: string }>): Message[]
}

export type SessionRecoveryReadiness = Readonly<{
  readable: boolean
  executable: boolean
  reason?: 'recovery-pending' | 'content-unavailable' | 'execution-blocked'
}>
export type SessionRecoveryReport = Readonly<{
  status: 'ready' | 'degraded' | 'blocked'
  history: Readonly<{ succeeded: boolean; interruptedCount: number; repairFailureCount: number }>
  snapshots: Readonly<{ restoredCount: number; skippedCanonicalUnavailableCount: number; missingAssistantCount: number }>
  coordinator: Readonly<{ succeeded: boolean; recoveredCount: number }>
  reconciliation:
    | Readonly<{ status: 'skipped'; reason: 'history-recovery-incomplete' | 'turn-projection-recovery-incomplete' }>
    | Readonly<{ status: 'completed'; releasedUnstarted: number; markedUncertain: number; repairedCheckpoints: number; reconciled: number }>
  continuations: Readonly<{ interrupted: number; unknownSideEffect: number; settled: number }>
  failures: readonly Readonly<{ stage: 'history' | 'snapshots' | 'coordinator' | 'reconciliation' | 'continuations'; error: Error }>[]
}>
export interface SessionRecoveryPort {
  recover(): Promise<SessionRecoveryReport>
  inspectReadiness(sessionId: string): SessionRecoveryReadiness
}

export type HistoryStartupRecoverySummary = Readonly<{ interruptedCount: number; repairFailureCount: number }>
export type SessionLedgerStartupRecoverySummary = Readonly<{ repairFailureCount: number }>

export interface SessionStorage {
  readonly queries: SessionQueries
  readonly commands: SessionCommands
  readonly execution: SessionExecutionStore
  readonly contexts: ContextPort
  readonly recovery: SessionRecoveryPort
}

/** Host-only bootstrap inputs for existing external recovery owners. */
export interface SessionStorageStartupCoordination {
  recoverHistory(): Promise<HistoryStartupRecoverySummary>
  recoverSessionLedgers(): Promise<SessionLedgerStartupRecoverySummary>
}

export interface SessionStorageHost {
  readonly storage: SessionStorage
  readonly startup: SessionStorageStartupCoordination
  readonly lifecycle: StorageLifecycleControl
}

export type MaintenanceReason = 'startup' | 'window-ready' | 'policy-changed' | 'scope-changed' | 'capacity-pressure' | 'retry'
export type MaintenanceClass = 'pending-reclamation' | 'retention' | 'derived-index'
export type MaintenanceState = Readonly<{
  taskId: string
  category: MaintenanceClass
  status: 'idle' | 'scheduled' | 'running' | 'paused' | 'failed' | 'completed'
  scannedCount: number
  processedCount: number
  lastErrorCode?: string
  lastSuccessAt?: number
}>
export interface StorageLifecycleControl {
  initialize(input?: { signal?: AbortSignal }): Promise<void>
  requestMaintenance(input: { reason: MaintenanceReason; category?: MaintenanceClass }): { status: 'scheduled' | 'coalesced' | 'not-needed' }
  allowBackgroundWork(): void
  pauseMaintenance(input?: { category?: MaintenanceClass }): Promise<void>
  resumeMaintenance(input?: { category?: MaintenanceClass }): void
  inspectMaintenance(): readonly MaintenanceState[]
  stop(input: { deadlineMs: number }): Promise<{ status: 'quiescent' | 'deadline-exceeded' }>
}
