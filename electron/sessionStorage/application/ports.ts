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

export type SessionRecoveryReadiness = Readonly<{
  readable: boolean
  executable: boolean
  reason?: 'recovery-pending' | 'content-unavailable' | 'execution-blocked' | 'commit-uncertain'
}>
export type SessionAvailabilityTask = Readonly<{ taskId: string; category: string; status: 'idle' | 'scheduled' | 'running' | 'paused' | 'failed' | 'completed' }>
export type SessionAvailability = Readonly<{
  globalFence: Readonly<{ state: 'pending' | 'ready' | 'degraded' | 'blocked'; source: Readonly<{ recoveryState: 'pending' | 'ready' | 'degraded' | 'blocked' }> }>
  content: Readonly<{ state: 'readable' | 'unavailable'; reason?: 'content-unavailable' | 'session-missing'; source: Readonly<{ sessionGeneration: string; messageRevision: number; authority: string }> }>
  execution: Readonly<{ state: 'ready' | 'busy' | 'pending-recovery' | 'commit-uncertain' | 'blocked'; source: Readonly<{ sessionId: string; transcriptVersion: number; lastTurnId?: string }> }>
  ledger: Readonly<{ state: 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'; reason?: 'location-unavailable' | 'readiness-missing'; source: Readonly<{ sessionId: string; locationKey?: string; ledgerGeneration?: number; canonicalWatermark?: string | null; failureClass?: string | null }> }>
  maintenance: Readonly<{ state: 'available' | 'paused' | 'blocked'; tasks: readonly SessionAvailabilityTask[]; source: readonly Readonly<{ taskId: string; status: SessionAvailabilityTask['status'] }>[] }>
}>
export interface SessionAvailabilityPort { inspect(sessionId: string): SessionAvailability }
export type SessionRecoveryReport = Readonly<{
  status: 'ready' | 'degraded' | 'blocked'
  history: Readonly<{ succeeded: boolean; interruptedCount: number; repairFailureCount: number; sessionFailures: readonly Readonly<{ sessionId: string; invocationId: string; capability: 'execution' | 'ledger'; failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending' }>[] }>
  snapshots: Readonly<{ restoredCount: number; skippedCanonicalUnavailableCount: number; missingAssistantCount: number }>
  coordinator: Readonly<{ succeeded: boolean; recoveredCount: number }>
  reconciliation:
    | Readonly<{ status: 'skipped'; reason: 'history-recovery-incomplete' | 'turn-projection-recovery-incomplete' }>
    | Readonly<{ status: 'completed'; releasedUnstarted: number; markedUncertain: number; repairedCheckpoints: number; reconciled: number }>
  continuations: Readonly<{ interrupted: number; unknownSideEffect: number; settled: number }>
  failures: readonly Readonly<{ stage: 'history' | 'snapshots' | 'coordinator' | 'reconciliation' | 'continuations'; error: Error; sessionId?: string; invocationId?: string }>[]
}>
export type SessionRecoveryHistoryResult = Readonly<{
  history: Readonly<{ succeeded: boolean; interruptedCount: number; repairFailureCount: number; sessionFailures: readonly Readonly<{ sessionId: string; invocationId: string; capability: 'execution' | 'ledger'; failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending' }>[] }>
  failures: readonly Readonly<{ stage: 'history'; error: Error; sessionId?: string; invocationId?: string }>[]
}>
export interface SessionRecoveryPort {
  recoverHistory(): Promise<SessionRecoveryHistoryResult>
  recover(): Promise<SessionRecoveryReport>
  inspectReadiness(sessionId: string): SessionRecoveryReadiness
  inspectRecoveryStatus(): Readonly<{ state: 'pending' | 'ready' | 'degraded' | 'blocked' }>
}
