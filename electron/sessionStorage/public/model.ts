import type { AgentInputNotExecutedReason, AgentInputSettlement, AgentSessionExecutionApproval, AgentSessionInputSource, Message, Session } from '../../../src/shared/domainTypes'
import type { RuntimeTriggerDefinitionV1, RuntimeTriggerState } from '../../../src/shared/domainTypes'
import type { QueueScope } from '../../../src/shared/queueScope'
import type { HistorySnapshot } from '../../../packages/agent-sdk/src/history'

export type MessageEntry = Readonly<{ message: Message; sequence: number }>
export type PreparedChatBodyView = Readonly<{
  sourceIdentityJson: string
  sessionGeneration: string
  sessionId: string
  scopeKey: string
  specVersion: number
  payloadGeneration: string
  payloadDigest: string
  inlinePayload?: string
  blobLocator?: string
  blobByteLength?: number
  validatedRangeJson: string
  cachePresent: boolean
  stateSourceIdentityJson: string
  statePayloadGeneration: string
  statePayloadDigest: string
  stateValidatedRangeJson: string
}>
export type QueuedSessionMessage = Readonly<{ message: Message; sequence: number; requestId?: string }>
export type ImAcceptedFactScope = Readonly<{ channel: 'feishu' | 'wechat'; accountId: string; conversationId: string }>
export type ImAcceptedFactFrontier = Readonly<{ through: number; coverageRevision: number }>
export type ImAcceptedFact = Readonly<{ messageId: string; acceptedSeq: number; channel: ImAcceptedFactScope['channel']; accountId: string; conversationId: string; senderId: string; platformMessageId: string; timestamp: number; isGroup?: boolean; contextToken?: string; trackId?: string; trackEventId?: string }>
export type ImAcceptedFactPage = Readonly<{ items: readonly ImAcceptedFact[]; nextAfter?: number }>
export type RuntimeTriggerRecord = Readonly<{
  id: string; ownerSessionId: string; receiverSessionId: string; clientKey: string; definition: RuntimeTriggerDefinitionV1
  state: RuntimeTriggerState; createdAt: number; expiresAt: number; matchedAt?: number; event?: Readonly<Record<string, unknown>>
  messageId?: string; attempts: number; nextAttemptAt?: number; result?: Readonly<Record<string, unknown>>; revision: number; updatedAt: number
}>
/** Host-only admission material attached to HistoryPort for the first source-bearing commit. */
export type RuntimeTriggerHistoryAdmission = Readonly<{
  triggerId: string; requestId: string; receiverSessionId: string; turnId: string; invocationId: string
  contextEventId?: string; payloadDigest: string; authorizationGeneration: string; policyRevision: string; runtimeGeneration: string
  finalCheck: (conn: unknown) => boolean
}>
export type RuntimeTriggerPatch = Readonly<Partial<Pick<RuntimeTriggerRecord, 'state' | 'matchedAt' | 'event' | 'messageId' | 'attempts' | 'nextAttemptAt' | 'result' | 'updatedAt'>>>
export type QueueInputReceiptSnapshot = Readonly<{ sessionId: string; requestId: string; fingerprint: string; queuedMessageId?: string; turnId?: string; state: string }>
export type AgentSessionMessageAcceptance = Readonly<{
  receipt: Readonly<{ sessionId: string; requestId: string; fingerprint: string; queuedMessageId?: string; turnId?: string; state: string }>
  source: AgentSessionInputSource
  persisted?: MessageEntry
  duplicate: boolean
}>
export type AgentSessionApprovalSnapshot = Readonly<{
  source: AgentSessionInputSource
  originDigest: string
  approval?: AgentSessionExecutionApproval
  approvalDigest?: string
}>
export type { AgentInputNotExecutedReason, AgentInputSettlement }
export type ScopedQueueInput = Readonly<{ sessionId: string; requestId: string; content: string; attachments?: Message['attachments']; queueScope: QueueScope }>
export type QueueInputSource = 'platform-im' | 'runtime-trigger' | 'ordinary-desktop' | 'agent-session' | 'invalid'
export type { AgentSessionInputSource }
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
export type MessageSearchHit = Readonly<{ messageId: string; sessionId: string; content: string; sessionName: string; requiresProjectionPreparation?: boolean }>
export type ContextHistorySummaryEntry = Readonly<{ messageId: string; role: Message['role']; imageTokens: number; thinkingTokens: number; sequence: number }>
export type CanonicalContextMeterEvent = Readonly<{
  seq: number
  type: 'request_header' | 'request_context' | 'request_usage' | 'request_retry'
  payload: Record<string, unknown>
}>
export type ContextHistorySummaryBaseline = Readonly<{ sessionId: string; entries: readonly ContextHistorySummaryEntry[] }>
export type RetryContextTarget = Readonly<{
  failedAssistant: MessageEntry
  currentUser: MessageEntry
  excludeMessageIds: readonly string[]
  sourceInvocationId?: string
  sourceTurnId?: string
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
export type LatestMessagePreviewCandidate = Readonly<MessageSkeleton & { sessionGeneration: string; messageRevision: number }>
export type MessageRef = Readonly<{ sessionId: string; messageId: string }>
export type RemoteSessionIdentityUpdate =
  | Readonly<{ channel: 'feishu'; messageId: string; chatType?: string }>
  | Readonly<{ channel: 'wechat'; userId: string; messageId: string; contextToken?: string; workDirProfileId?: string }>
export type ContinuationSourceRef = Readonly<{
  sessionId: string
  invocationId: string
  turnId: string
  checkpointSequence: number
  expectedHistoryVersion: number
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
export type UnresolvedEffectSnapshot = Readonly<{ id: string; originInvocationId: string; toolCallId: string; toolName?: string; inputHash?: string }>
export type ContinuationRecoveryFacts = Readonly<{
  unresolvedEffects: readonly UnresolvedEffectSnapshot[]
  toolOutcomes: readonly Readonly<{
    id: string
    toolName?: string
    outcome: 'succeeded' | 'known-failure' | 'unknown-after-dispatch' | 'not-dispatched'
  }>[]
}>
