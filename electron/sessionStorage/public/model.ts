import type { Message, Session } from '../../../src/shared/domainTypes'
import type { HistorySnapshot } from '../../../packages/agent-sdk/src/history'

export type MessageEntry = Readonly<{ message: Message; sequence: number }>
export type PreparedChatBodyView = Readonly<{
  messages: readonly Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>[]
  sourceIdentityJson: string
  sessionGeneration: string
}>
export type QueuedSessionMessage = Readonly<{ message: Message; sequence: number; requestId?: string }>
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
export type MessageRef = Readonly<{ sessionId: string; messageId: string }>
export type RemoteSessionIdentityUpdate =
  | Readonly<{ channel: 'feishu'; messageId: string }>
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
