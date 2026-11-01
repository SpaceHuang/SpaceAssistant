import type { ProjectionStateCommand, ProjectionStateRecord } from '../domain/projectionState'

export type {
  PreparedIdentity, ExecutionLease, ExecutionClaimResult, PrepareTurnInput, ClaimQueuedTurnInput, PreparedTurnResult,
  ClaimedQueuedTurnResult, SessionExecutionStore, ContinuationStore, ContinuationLaunchStore, ContinuationLaunchResult,
  ContinuationRecordSnapshot, ContinuationIntentAcceptanceResult, ContinuationTerminalStatus
} from '../public/execution'

type ProjectionCacheCandidateBase = Readonly<{
  sourceIdentityJson: string
  payloadGeneration: string
  payloadDigest: string
  validatedRangeJson: string
  blobReferences?: readonly ProjectionCacheBlobReference[]
}>
export type ProjectionCacheBlobReference = Readonly<{
  locator: string
  byteLength: number
  payloadDigest: string
  kind: 'body-block' | 'sequence-directory' | 'id-directory' | 'body-manifest'
}>
export type ProjectionCacheCandidate = ProjectionCacheCandidateBase &
  (Readonly<{ inlinePayload: string; blobLocator?: never; blobByteLength?: never }> |
   Readonly<{ inlinePayload?: never; blobLocator: string; blobByteLength: number }>)

export interface ProjectionStateStore {
  get(sessionId: string, scopeKey: string): ProjectionStateRecord | null
  readCheckpoint(sessionId: string, scopeKey: string): string | null
  saveCheckpoint(input: Readonly<{
    sessionId: string; scopeKey: string; sessionGeneration: string; sourceIdentityJson: string
    processGeneration: number; rebuildToken: string; checkpointJson: string; now: number
  }>): boolean
  releaseLease(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string; processGeneration: number; rebuildToken: string; now: number }>): boolean
  ensureInvalid(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string; now: number }>): ProjectionStateRecord | null
  readSourceIdentity(sessionId: string, sessionGeneration: string): string | null
  transition(input: Readonly<{
    sessionId: string; scopeKey: string; sessionGeneration: string; command: ProjectionStateCommand; cache?: ProjectionCacheCandidate
  }>): ProjectionStateRecord | null
  invalidateInTransaction(input: Readonly<{ sessionId: string; scopeKey: string; sessionGeneration: string; now: number }>): ProjectionStateRecord | null
}

export type SessionAvailabilityTask = Readonly<{ taskId: string; category: string; status: 'idle' | 'scheduled' | 'running' | 'paused' | 'failed' | 'completed' }>
export type SessionAvailability = Readonly<{
  content: Readonly<{ state: 'readable' | 'unavailable'; reason?: 'content-unavailable' | 'session-missing'; source: Readonly<{ sessionGeneration: string; messageRevision: number; authority: string }> }>
  execution: Readonly<{ state: 'ready' | 'busy' | 'commit-uncertain' | 'blocked'; source: Readonly<{ sessionId: string; transcriptVersion: number; lastTurnId?: string }> }>
  ledger: Readonly<{
    state: 'ready' | 'degraded'
    readinessState: 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'
    reasonCode?: 'location-unavailable' | 'readiness-missing' | 'ledger-uninitialized' | 'ledger-initializing' | 'ledger-unknown' | 'ledger-checking' | 'ledger-dirty' | 'ledger-blocked'
    reason?: 'location-unavailable' | 'readiness-missing'
    source: Readonly<{ sessionId: string; locationKey?: string; ledgerGeneration?: number; canonicalWatermark?: string | null; failureClass?: string | null }>
  }>
  maintenance: Readonly<{ state: 'available' | 'paused' | 'blocked'; tasks: readonly SessionAvailabilityTask[]; source: readonly Readonly<{ taskId: string; status: SessionAvailabilityTask['status'] }>[] }>
}>
export interface SessionAvailabilityPort { inspect(sessionId: string): SessionAvailability }
