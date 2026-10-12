/** Cross-process contract for remote intent ownership; it carries association, never tool authority. */
export type RemoteTrackChannel = 'wechat' | 'feishu'

export type RemoteTrackState =
  | 'open'
  | 'processing'
  | 'waiting-user'
  | 'waiting-async-approval'
  | 'resuming'
  | 'cancelling'
  | 'reconciliation-blocked'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed'

export type RemoteTrackContext = Readonly<{
  trackId: string
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rootMessageId: string
  parentTrackId?: string
  originSessionId?: string
  attributionEventId: string
}>

export type RemoteTrackEventRef = Readonly<{
  trackId: string
  eventId: string
  parentEventId?: string
  messageId?: string
  sessionId?: string
  requestId?: string
  turnId?: string
  toolUseId?: string
  confirmationId?: string
  todoId?: string
  attemptId?: string
}>

/** Metadata identifying the only message/event view permitted at a remote Track model boundary. */
export type TrackModelInputViewRef = Readonly<{
  trackId: string
  sessionId: string
  viewVersion: string
  completeness: 'complete' | 'partial' | 'unavailable'
  includedEventIds: readonly string[]
  includedMessageIds: readonly string[]
  includedInvocationIds: readonly string[]
  includedSessionIds: readonly string[]
  messageSessionMap: Readonly<Record<string, string>>
  invocationSessionMap: Readonly<Record<string, string>>
  permittedParentTrackIds: readonly string[]
  contentHash: string
}>

/** Persisted attribution facts. Semantic confidence never represents authorization. */
export type RemoteTrackAttribution =
  | { kind: 'new-track'; trackId: string; reasonCode: string }
  | { kind: 'continuation'; trackId: string; confidence: number; evidenceCodes: readonly string[] }
  | { kind: 'successor'; trackId: string; parentTrackId: string; confidence: number; evidenceCodes: readonly string[] }
  | { kind: 'ambiguous'; clarificationId: string; candidateTrackIds: readonly string[]; reasonCode: string }
  | { kind: 'rejected'; reasonCode: string }
