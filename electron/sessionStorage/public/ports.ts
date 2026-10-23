import type { Message, Session } from '../../../src/shared/domainTypes'
import type { AcceptedTurn } from '../../../src/shared/acceptedTurn'
import type { SessionOwnership, SessionVisibility } from '../../../src/shared/sessionOwnership'
import type { SessionDirectoryGrantRecord } from '../../../src/shared/sessionDirectoryGrant'
import type { SessionUsage } from '../../../src/shared/sessionUsage'
import type { EnqueueResult, MessageEntry, RemoteSessionIdentityUpdate, ContinuationSourceInspection,
  ContinuationRecoveryFacts, MessageRef, ChatMessagePage, ApiContextBaseline, ContextHistorySummaryBaseline, CanonicalContextMeterEvent,
  RoutingRead, RouteInput, SelectionFence, ExportPage, SearchCorpusPage, MessageSearchHit, RetryContextTarget,
  PreparedChatBodyView,
} from './model'
import type { HistoryPort, HistorySnapshot } from '../../../packages/agent-sdk/src/history'
import type { CanonicalModelMessage } from '../../../packages/agent-sdk/src/model'
import type { CompactionReplay } from '../../../src/shared/compactionEvents'
import type { TurnExecutionConfig } from '../../../src/shared/assistantFactAggregator'

export type ProjectionPreparationRequest = Readonly<{ sessionId: string; scopeKey: string; specVersion: number }>
export type SessionTurnSnapshot = Readonly<{
  turnId: string; requestId: string; sessionId: string; state: string; outcome?: string
  userMessageId?: string; executionConfig?: TurnExecutionConfig; error?: Readonly<{ code: string; message: string }>
}>

/** Session-scoped extension of the SDK History capability. */
export type SessionHistoryPort = HistoryPort & Readonly<{
  listInvocationIds(): string[]
  readLatestInvocationForSession(
    sessionId: string,
    options?: { excludeInvocationId?: string; excludeInvocationIds?: readonly string[] }
  ): Promise<
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'completed'; snapshot: HistorySnapshot }>
    | Readonly<{ kind: 'cancelled'; snapshot: HistorySnapshot }>
    | Readonly<{ kind: 'unavailable'; invocationId: string; snapshot?: HistorySnapshot }>
  >
}>

/** SDK-derived commit protocol aliases keep the History contract owned by agent-sdk. */
export type SessionCommitPort = Pick<SessionHistoryPort, 'appendBatch' | 'read'>
export type SessionCommitEvent = Parameters<SessionHistoryPort['appendBatch']>[0][number]
export type SessionCommitResult = Awaited<ReturnType<SessionHistoryPort['appendBatch']>>
export type SessionCommitIntent = NonNullable<Parameters<SessionHistoryPort['appendBatch']>[2]>
export type SessionCanonicalMessage = CanonicalModelMessage
export type SessionAcceptedTurn = AcceptedTurn

/** Host-owned facts and repair callbacks used when recovering canonical History into a session ledger. */
export type SessionHistoryLedgerLocation = Readonly<{ workDir: string; sessionId: string; createdAt: number }>
export type SessionHistoryRecoveryOptions = Readonly<{
  onSessionRecoveryFailure?: (error: unknown, invocationId: string, sessionId: string | null) => void
  resolveSessionLedgerLocation?: (sessionId: string) => Promise<SessionHistoryLedgerLocation | undefined> | SessionHistoryLedgerLocation | undefined
  onSessionLocationResolveError?: (error: unknown, invocationId: string, sessionId: string) => void
  repairCompaction?: (location: SessionHistoryLedgerLocation, start: Record<string, unknown>, summary: Record<string, unknown>) => Promise<unknown>
  repairToolLedger?: (location: SessionHistoryLedgerLocation, result: Record<string, unknown>) => Promise<unknown>
  repairToolCallLedger?: (location: SessionHistoryLedgerLocation, toolCall: Record<string, unknown>) => Promise<unknown>
  repairModelRequestLedger?: (location: SessionHistoryLedgerLocation, projection: { requestHeader: Record<string, unknown>; requestContext: Record<string, unknown> }) => Promise<unknown>
  repairProviderRetryLedger?: (location: SessionHistoryLedgerLocation, retry: Record<string, unknown>) => Promise<unknown>
  repairUsageLedger?: (location: SessionHistoryLedgerLocation, requestUsage: Record<string, unknown>) => Promise<unknown>
  repairFinalRequestContextLedger?: (location: SessionHistoryLedgerLocation, requestContext: Record<string, unknown>) => Promise<unknown>
  repairInvocationTerminal?: (location: SessionHistoryLedgerLocation, terminal: Record<string, unknown>) => Promise<unknown>
  onCompactionRepairError?: (error: unknown, invocationId: string, compactionId: string) => void
  onToolLedgerRepairError?: (error: unknown, invocationId: string, toolCallId: string) => void
  onModelRequestLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
  onProviderRetryLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
  onUsageLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
  onFinalRequestContextLedgerRepairError?: (error: unknown, invocationId: string, requestId: string) => void
  onInvocationTerminalRepairError?: (error: unknown, invocationId: string, turnId: string) => void
}>

/** Business commands for one session storage instance; implementation details stay behind the adapter. */
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
  stripLegacyPlanMetadata(sessionId: string): Session | undefined
  setSessionUsage(sessionId: string, usage: SessionUsage): void
  deleteSessionUsage(sessionId: string): void
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
  enqueue(input: { sessionId: string; requestId: string; content: string; attachments?: Message['attachments'] }): EnqueueResult
  editMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean>
}

export interface ContinuationSourceQueries {
  read(input: { sessionId: string; activeTurnIds: readonly string[]; selectedAssistantMessageId?: string }): ContinuationSourceInspection
  readRecoveryFacts(sessionId: string): ContinuationRecoveryFacts
}

/** Bound, database-free read capabilities for one session storage instance. */
export interface SessionQueries {
  readonly continuationSources: ContinuationSourceQueries
  readSession(sessionId: string): Session | undefined
  readSessionUsage(sessionId: string): SessionUsage | undefined
  listSessions(options?: { view?: 'all' | 'user-visible' }): Session[]
  readMessage(ref: MessageRef): Message | undefined
  readMessages(input: { sessionId: string; limit?: number; offset?: number }): Message[]
  /** Async chat-body cache lookup; undefined means selection must use the existing authority reader. */
  readPreparedMessages?(input: { sessionId: string; limit?: number; offset?: number; prepared?: PreparedChatBodyView }): Promise<Message[] | undefined>
  /** Async single message body lookup; undefined means selection must use the existing authority reader. */
  readPreparedMessage?(input: { sessionId: string; messageId: string; prepared?: PreparedChatBodyView }): Promise<Message | undefined>
  /** Async sequence-page lookup; undefined means selection must use the existing authority reader. */
  readPreparedChatPage?(input: { sessionId: string; beforeSequence?: number | null; limit?: number; prepared?: PreparedChatBodyView }): Promise<ChatMessagePage | undefined>
  /** Async latest-window API baseline lookup; undefined means selection must use the existing authority reader. */
  readPreparedApiBaseline?(input: { sessionId: string; limit?: number; prepared?: PreparedChatBodyView }): Promise<ApiContextBaseline | undefined>
  /** Async ASC search corpus page lookup; undefined means selection must use the existing authority reader. */
  readPreparedSearchCorpusPage?(input: { sessionId: string; fromSequence: number; pageSize?: number; prepared?: PreparedChatBodyView }): Promise<SearchCorpusPage | undefined>
  /** Async export page lookup; undefined means selection must use the existing authority reader. */
  readPreparedExportPage?(input: { sessionId: string; fromSequence: number; pageSize: number; prepared?: PreparedChatBodyView }): Promise<ExportPage | undefined>
  /** Async retry-context lookup; undefined means selection must use the existing authority reader. */
  readPreparedRetryTarget?(input: { sessionId: string; failedAssistantMessageId?: string; prepared?: PreparedChatBodyView }): Promise<RetryContextTarget | null | undefined>
  readChatPage(input: { sessionId: string; beforeSequence?: number | null; limit?: number }): ChatMessagePage
  readTurnContext(input: { sessionId: string; boundarySequence?: number; requiredUserMessageId?: string; excludeMessageIds?: string[] }): Message[]
  readApiBaseline(input: { sessionId: string; limit?: number }): ApiContextBaseline
  readContextHistorySummaryBaseline(sessionId: string): ContextHistorySummaryBaseline
  /** Returns canonical replay when this session has History, or undefined for legacy-only sessions. */
  readCanonicalCompactionReplay(sessionId: string): CompactionReplay | undefined
  readCanonicalContextMeterEvents(sessionId: string): readonly CanonicalContextMeterEvent[] | undefined
  readRoutingInput(input: { sessionId: string; boundarySequence?: number; requiredUserMessageId?: string; excludeMessageIds?: string[]; limit?: number; reuseUserMessageId?: string; userInput?: string }): RoutingRead
  resolveRoutingInput<T extends RouteInput>(input: { sessionId: string; selection: SelectionFence; routeInput: T }): Readonly<{ routeInput: T; fence: SelectionFence }>
  isSelectionCurrent(sessionId: string, fence: SelectionFence): boolean
  readSelectionSnapshot(sessionId: string, fence: SelectionFence): Readonly<{ sessionId: string; generation: string; messageRevision: number }> | undefined
  readExportPage(input: { sessionId: string; fromSequence: number; pageSize: number }): ExportPage
  readSearchCorpusPage(input: { sessionId: string; fromSequence: number; pageSize?: number }): SearchCorpusPage
  searchMessages(input: { query: string; activeProfileId: string; limit?: number }): MessageSearchHit[]
  readRetryTarget(input: { sessionId: string; failedAssistantMessageId: string }): RetryContextTarget | null
  readLatestRetryTarget(sessionId: string): RetryContextTarget | null
  readMessageSequence(ref: MessageRef): number | null
  readTurnByRequest(input: { sessionId: string; requestId: string }): SessionTurnSnapshot | undefined
  listTurnErrorsByAssistantMessageIds(assistantMessageIds: readonly string[]): Array<{ assistantMessageId: string; message: string }>
}

