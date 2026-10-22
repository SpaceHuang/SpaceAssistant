import type { ContextPort } from '../../../packages/agent-sdk/src/context'
import type { SessionCommands, SessionQueries } from '../public/ports'
import type { SessionAvailabilityPort, SessionExecutionStore, SessionRecoveryPort } from '../application/ports'
import type { CompactionReplay } from '../../../src/shared/compactionEvents'
import type { CanonicalContextMeterEvent } from '../public/model'
import type { ProjectionPreparationRequest } from '../public/ports'
import type { Message } from '../../../src/shared/domainTypes'
export type { ProjectionPreparationRequest } from '../public/ports'

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

export interface SessionStorage {
  readonly queries: SessionQueries
  readonly commands: SessionCommands
  readonly execution: SessionExecutionStore
  readonly contexts: ContextPort
  readonly recovery: SessionRecoveryPort
  readonly availability: SessionAvailabilityPort
  readCompactionReplay(input: Readonly<{ sessionId: string; workDir: string }>): Promise<CompactionReplay>
  readContextMeterEvents(input: Readonly<{ sessionId: string; workDir: string }>): Promise<readonly CanonicalContextMeterEvent[]>
  ensureLedgerReady?(sessionId: string): Promise<boolean>
  prepareProjection?(input: ProjectionPreparationRequest): Promise<void>
  ensureChatBodyV1?(input: Readonly<{ sessionId: string; signal?: AbortSignal }>): Promise<readonly Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>[]>
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
