import type { SessionRecoveryPort, SessionRecoveryReadiness, SessionRecoveryReport } from './contracts'
import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database'
import type { SessionQueries, SessionExecutionStore } from './contracts'
import { createSessionTranscriptRecoveryAdapter } from './recoveryDatabaseAdapter'
import type { PersistedTurn } from '../database/operations'
import { reconcileRunningAgentContinuations } from '../runtime/agentContinuation'
import { hasUnfinishedStartupProjections, restorePersistedTurnSnapshotsDetailed } from './recoveryHelpers'

export type SessionRecoveryDependencies = Readonly<{
  history(): Promise<Readonly<{ interruptedCount: number; repairFailureCount: number }>>
  snapshots(): Promise<Readonly<{ restoredCount: number; skippedCanonicalUnavailableCount: number; missingAssistantCount: number }>> | Readonly<{ restoredCount: number; skippedCanonicalUnavailableCount: number; missingAssistantCount: number }>
  coordinator(): Promise<Readonly<{ recoveredCount: number; succeeded: boolean }>> | Readonly<{ recoveredCount: number; succeeded: boolean }>
  hasUnfinishedProjections(): boolean
  reconcile(): Readonly<{ releasedUnstarted: number; markedUncertain: number; repairedCheckpoints: number; reconciled: number }>
  continuations(recoveryReady: boolean): Readonly<{ interrupted: number; unknownSideEffect: number; settled: number }>
  inspectReadiness(sessionId: string): SessionRecoveryReadiness
  ledgerRepairs?(): Promise<number>
}>

/** Storage-owned reconciliation helper retained for focused durable transcript recovery callers. */
export function reconcileStartupSessionTranscripts(db: AppDatabase, readiness: {
  historyRecoverySucceeded: boolean
  turnCoordinatorRecoverySucceeded: boolean
}, now = Date.now()) {
  if (!readiness.historyRecoverySucceeded) return { reconciled: 0, skippedReason: 'history-recovery-incomplete' as const }
  if (!readiness.turnCoordinatorRecoverySucceeded || hasUnfinishedStartupProjections(db)) {
    return { reconciled: 0, skippedReason: 'turn-projection-recovery-incomplete' as const }
  }
  return createSessionTranscriptRecoveryAdapter(db).reconcile(now)
}

const emptySnapshots = { restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }
const emptyCoordinator = { recoveredCount: 0, succeeded: false }
const emptyContinuations = { interrupted: 0, unknownSideEffect: 0, settled: 0 }

/** Orchestrates existing recovery owners and reports facts gathered at each original stage. */
export function createSessionRecoveryPort(dependencies: SessionRecoveryDependencies): SessionRecoveryPort {
  let completed: SessionRecoveryReport | undefined
  let inFlight: Promise<SessionRecoveryReport> | undefined

  const recover = (): Promise<SessionRecoveryReport> => {
    if (completed) return Promise.resolve(completed)
    if (inFlight) return inFlight
    inFlight = (async () => {
      const failures: Array<{ stage: SessionRecoveryReport['failures'][number]['stage']; error: Error }> = []
      const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value))
      let history = { succeeded: false, interruptedCount: 0, repairFailureCount: 0 }
      let snapshots = emptySnapshots
      let coordinator = emptyCoordinator
      let reconciliation: SessionRecoveryReport['reconciliation'] = { status: 'skipped', reason: 'history-recovery-incomplete' }
      let continuations = emptyContinuations

      try {
        const result = await dependencies.history()
        history = { ...result, succeeded: result.repairFailureCount === 0 }
        if (!history.succeeded) failures.push({ stage: 'history', error: new Error('SESSION_HISTORY_RECOVERY_REPORTED_FAILURES') })
      } catch (error) {
        failures.push({ stage: 'history', error: asError(error) })
      }

      let ledgerRepairFailureCount = 0
      if (dependencies.ledgerRepairs) {
        try {
          ledgerRepairFailureCount = await dependencies.ledgerRepairs()
          if (ledgerRepairFailureCount > 0) failures.push({ stage: 'history', error: new Error('SESSION_LEDGER_RECOVERY_REPORTED_FAILURES') })
        } catch (error) {
          failures.push({ stage: 'history', error: asError(error) })
          ledgerRepairFailureCount = 1
        }
        history = { ...history, repairFailureCount: history.repairFailureCount + ledgerRepairFailureCount }
        history = { ...history, succeeded: history.repairFailureCount === 0 }
      }

      let snapshotsSucceeded = true
      try { snapshots = await dependencies.snapshots() }
      catch (error) { snapshotsSucceeded = false; failures.push({ stage: 'snapshots', error: asError(error) }) }

      if (snapshotsSucceeded) {
        try {
          const result = await dependencies.coordinator()
          const unfinished = dependencies.hasUnfinishedProjections()
          coordinator = { recoveredCount: result.recoveredCount, succeeded: result.succeeded && !unfinished }
          if (!coordinator.succeeded) failures.push({ stage: 'coordinator', error: new Error('TURN_PROJECTION_RECOVERY_INCOMPLETE') })
        } catch (error) {
          failures.push({ stage: 'coordinator', error: asError(error) })
        }
      } else {
        coordinator = { recoveredCount: 0, succeeded: false }
      }

      if (!history.succeeded) reconciliation = { status: 'skipped', reason: 'history-recovery-incomplete' }
      else if (!coordinator.succeeded) reconciliation = { status: 'skipped', reason: 'turn-projection-recovery-incomplete' }
      else {
        try {
          if (dependencies.hasUnfinishedProjections()) throw new Error('TURN_PROJECTION_RECOVERY_INCOMPLETE')
          reconciliation = { status: 'completed', ...dependencies.reconcile() }
        } catch (error) {
          failures.push({ stage: 'reconciliation', error: asError(error) })
          reconciliation = { status: 'skipped', reason: 'turn-projection-recovery-incomplete' }
        }
      }

      try { continuations = dependencies.continuations(history.succeeded && coordinator.succeeded) }
      catch (error) { failures.push({ stage: 'continuations', error: asError(error) }) }

      const blocked = !history.succeeded || !coordinator.succeeded || reconciliation.status === 'skipped' || failures.length > 0
      const report: SessionRecoveryReport = Object.freeze({
        status: blocked ? 'blocked' : snapshots.skippedCanonicalUnavailableCount > 0 ? 'degraded' : 'ready',
        history: Object.freeze(history), snapshots: Object.freeze(snapshots), coordinator: Object.freeze(coordinator),
        reconciliation: Object.freeze(reconciliation), continuations: Object.freeze(continuations),
        failures: Object.freeze(failures.map((failure) => Object.freeze(failure)))
      })
      completed = report
      return report
    })().finally(() => { inFlight = undefined })
    return inFlight
  }

  return Object.freeze({
    recover,
    inspectReadiness: (sessionId: string) => {
      if (!completed) return { readable: false, executable: false, reason: 'recovery-pending' as const }
      if (completed.status === 'blocked') {
        const readiness = dependencies.inspectReadiness(sessionId)
        return { ...readiness, executable: false, reason: readiness.reason ?? 'recovery-pending' as const }
      }
      return dependencies.inspectReadiness(sessionId)
    }
  })
}

export function createSqliteSessionRecoveryPort(input: Readonly<{
  db: AppDatabase
  queries: SessionQueries
  execution: SessionExecutionStore
  getTurnRuntime?: () => Readonly<{ coordinator: Readonly<{ restoreTurn(turn: PersistedTurn, assistant: import('../../src/shared/domainTypes').Message): unknown; recover(): number }> }> | undefined
  stages?: Partial<Pick<SessionRecoveryDependencies, 'history' | 'snapshots' | 'coordinator' | 'reconcile' | 'continuations' | 'ledgerRepairs'>>
}>): SessionRecoveryPort {
  const hasUnfinishedProjectionsForDb = () => hasUnfinishedStartupProjections(input.db)
  const defaultSnapshots = () => {
    const runtime = input.getTurnRuntime?.()
    if (!runtime) return emptySnapshots
    return restorePersistedTurnSnapshotsDetailed(input.db, (turn, assistant) => runtime.coordinator.restoreTurn(turn, assistant))
  }
  const defaultCoordinator = () => {
    const runtime = input.getTurnRuntime?.()
    return runtime ? { recoveredCount: runtime.coordinator.recover(), succeeded: true } : { recoveredCount: 0, succeeded: false }
  }
  const defaultReconcile = () => createSessionTranscriptRecoveryAdapter(input.db).reconcile()
  const defaultContinuations = (recoveryReady: boolean) => reconcileRunningAgentContinuations(getDbConnection(input.db), recoveryReady)
  const inspectReadiness = (sessionId: string): SessionRecoveryReadiness => {
    if (!input.queries.readSession(sessionId)) return { readable: false, executable: false, reason: 'execution-blocked' }
    try { input.queries.readApiBaseline({ sessionId, limit: 1 }) }
    catch (error) {
      if (error instanceof Error && error.message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE') {
        return { readable: false, executable: false, reason: 'content-unavailable' }
      }
      throw error
    }
    const transcript = input.execution.readTranscriptState(sessionId)
    if (transcript.status !== 'ready') return { readable: true, executable: false, reason: 'execution-blocked' }
    return { readable: true, executable: true }
  }
  return createSessionRecoveryPort({
    history: input.stages?.history ?? (async () => ({ interruptedCount: 0, repairFailureCount: 0 })),
    snapshots: input.stages?.snapshots ?? defaultSnapshots,
    coordinator: input.stages?.coordinator ?? defaultCoordinator,
    hasUnfinishedProjections: hasUnfinishedProjectionsForDb,
    reconcile: input.stages?.reconcile ?? defaultReconcile,
    continuations: input.stages?.continuations ?? defaultContinuations,
    inspectReadiness
  })
}
