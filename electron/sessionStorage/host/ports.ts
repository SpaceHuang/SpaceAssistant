import type { ContextPort, ContextScope, SessionContextAdapter } from '../../../packages/agent-sdk/src/context'
import type { SessionCommands, SessionQueries } from '../public/ports'
import type { SessionExecutionStore } from '../public/execution'
import type { SessionAvailabilityPort, SessionRecoveryPort } from '../application/ports'
import type { CompactionReplay } from '../../../src/shared/compactionEvents'
import type { CanonicalContextMeterEvent, PreparedChatBodyView } from '../public/model'
import type { ProjectionPreparationRequest } from '../public/ports'
export type { ProjectionPreparationRequest } from '../public/ports'


export type SessionContextSurfaceMessage = { id?: string; role: 'user' | 'assistant'; content: unknown; [key: string]: unknown }
export type BoundSessionContext = Readonly<{ adapter: SessionContextAdapter; messages: SessionContextSurfaceMessage[]; windowId: string }>
export type SessionContextStoragePort = ContextPort & Readonly<{
  bind(scope: ContextScope, scopedPort: ContextPort): () => void
  createBoundAdapter(input: { sessionId: string; isBusy(): boolean }): Promise<BoundSessionContext>
}>

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
  prepareProjection(input: ProjectionPreparationRequest): Promise<void>
  allowBackgroundWork(): void
  pauseMaintenance(input?: { category?: MaintenanceClass }): Promise<void>
  resumeMaintenance(input?: { category?: MaintenanceClass }): void
  inspectMaintenance(): readonly MaintenanceState[]
  stop(input: { deadlineMs: number }): Promise<{ status: 'quiescent' | 'deadline-exceeded' }>
}

export type HistoryStartupRecoverySummary = Readonly<{
  interruptedCount: number
  repairFailureCount: number
  sessionFailures?: readonly Readonly<{ sessionId: string; invocationId: string; capability: 'execution' | 'ledger'; failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending' }>[]
}>
export type SessionLedgerStartupRecoverySummary = Readonly<{ repairFailureCount: number }>
export interface SessionLedgerRecoveryLocationInput {
  sessionId: string
  createdAt: number
  workDirProfileId?: string | null
  activeProfileId?: string
  configuredWorkDir: string
  profilesJson?: string
}
export type SessionLedgerRecoveryLocation = { workDir: string; sessionId: string; createdAt: number }
export interface SessionLedgerRecoveryBindings {
  getAllowedRoots(input: { configuredWorkDir?: string; profilesJson?: string }): readonly string[]
  isLocationAllowed(input: { location: { workDir: string }; allowedRoots: readonly string[] }): boolean
  resolveLocation(input: SessionLedgerRecoveryLocationInput): SessionLedgerRecoveryLocation | undefined
  toToolCallProjection(input: SessionLedgerToolCallProjectionInput): SessionLedgerToolCallProjection
  toToolResultProjection(input: SessionLedgerToolResultProjectionInput): SessionLedgerToolResultProjection
}
export interface SessionLedgerToolCallProjectionInput {
  toolUseId: string; turnId?: string; stepId: string; requestId?: string; invocationRequestId?: string; lane?: string
  name: string; args: Record<string, unknown>
}
export type SessionLedgerToolCallProjection = SessionLedgerToolCallProjectionInput
export interface SessionLedgerToolResultProjectionInput {
  toolUseId: string; turnId?: string; stepId: string; requestId?: string; invocationRequestId?: string; lane?: string
  result: Record<string, unknown>
}
export type SessionLedgerToolResultProjection = SessionLedgerToolResultProjectionInput
export interface SessionStorageStartupCoordination {
  recoverHistory(): Promise<HistoryStartupRecoverySummary>
  recoverSessionLedgers(): Promise<SessionLedgerStartupRecoverySummary>
}

export type SessionMessageContentCleanupBatch = Readonly<{
  status: 'advanced' | 'complete' | 'ineligible'
  cleanedMessageCount: number
  nextSequence?: number
  afterMessageId?: string | null
  reason?: 'session-or-progress-missing' | 'fence-changed' | 'active-control' | 'history-unavailable' | 'message-mismatch'
}>
export interface SessionCleanupPort {
  certifyCanonicalRead(sessionId: string): boolean
  authorizationSnapshotSha256(sessionId: string): string | undefined
  markWriteStopped(sessionId: string): boolean
  begin(sessionId: string): boolean
  clearNextBatch(sessionId: string, batchSize?: number): SessionMessageContentCleanupBatch
  verifyAndComplete(sessionId: string): boolean
}

export interface SessionStorage {
  readonly queries: SessionQueries
  readonly commands: SessionCommands
  readonly execution: SessionExecutionStore
  readonly contexts: SessionContextStoragePort
  readonly recovery: SessionRecoveryPort
  readonly availability: SessionAvailabilityPort
  readonly cleanup: SessionCleanupPort
  readCompactionReplay(input: Readonly<{ sessionId: string; workDir: string }>): Promise<CompactionReplay>
  readContextMeterEvents(input: Readonly<{ sessionId: string; workDir: string }>): Promise<readonly CanonicalContextMeterEvent[]>
  ensureLedgerReady?(sessionId: string): Promise<boolean>
  checkpointProjection?(sessionId: string): boolean
  clearProjectionCaches?(): Promise<Readonly<{ cacheRows: number; eligibilityRows: number }>>
  shouldRetainSessionEventDirectory?(sessionName: string, workDir: string): Promise<boolean>
  prepareSessionEventRetentionProjection?(sessionName: string, workDir: string): Promise<void>
  prepareProjection?(input: ProjectionPreparationRequest): Promise<void>
  ensureChatBodyV1?(input: Readonly<{ sessionId: string; signal?: AbortSignal }>): Promise<PreparedChatBodyView>
}

export type LifecycleTaskHandle = Readonly<{
  stop(): void
  quiesce(): Promise<void>
  request?(reason: MaintenanceReason): void
}>
export type LifecycleTaskRegistration = Readonly<{
  taskId: string
  category: MaintenanceClass
  start(): LifecycleTaskHandle | undefined
  prepare?(input: ProjectionPreparationRequest): Promise<void>
}>
export interface SessionStorageHost {
  readonly storage: SessionStorage
  readonly startup: SessionStorageStartupCoordination
  readonly ledgerRecovery: SessionLedgerRecoveryBindings
  readonly lifecycle: StorageLifecycleControl
}
