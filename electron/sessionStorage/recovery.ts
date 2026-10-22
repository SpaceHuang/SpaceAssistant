import type { SessionRecoveryHistoryResult, SessionRecoveryPort, SessionRecoveryReadiness, SessionRecoveryReport } from './application/ports'
import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import type { SessionQueries } from './public/ports'
import type { SessionExecutionStore } from './application/ports'
import { createSessionTranscriptRecoveryAdapter } from './recoveryDatabaseAdapter'
import type { PersistedTurn } from '../database/operations'
import { reconcileRunningAgentContinuations } from '../runtime/agentContinuation'
import { hasUnfinishedStartupProjections, restorePersistedTurnSnapshotsDetailed } from './recoveryHelpers'

export type SessionRecoveryDependencies = Readonly<{
  history(): Promise<Readonly<{ interruptedCount: number; repairFailureCount: number; sessionFailures?: readonly Readonly<{ sessionId: string; invocationId: string; capability: 'execution' | 'ledger'; failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending' }>[] }>>
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
  let historyResult: SessionRecoveryHistoryResult | undefined
  let historyInFlight: Promise<SessionRecoveryHistoryResult> | undefined

  const recoverHistory = (): Promise<SessionRecoveryHistoryResult> => {
    if (historyResult) return Promise.resolve(historyResult)
    if (historyInFlight) return historyInFlight
    historyInFlight = (async () => {
      const failures: Array<{ stage: 'history'; error: Error; sessionId?: string; invocationId?: string }> = []
      const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value))
      let history = { succeeded: false, interruptedCount: 0, repairFailureCount: 0,
        sessionFailures: [] as readonly Readonly<{ sessionId: string; invocationId: string; capability: 'execution' | 'ledger'; failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending' }>[] }
      try {
        const result = await dependencies.history()
        const sessionFailures = result.sessionFailures ?? []
        history = { ...result, sessionFailures, succeeded: result.repairFailureCount === sessionFailures.length }
        for (const failure of sessionFailures) failures.push({ stage: 'history', error: new Error(failure.failureClass === 'history-stream-corrupt' ? 'SESSION_HISTORY_STREAM_CORRUPT' : failure.failureClass === 'ledger-repair-failed' ? 'SESSION_LEDGER_REPAIR_FAILED' : 'SESSION_LEDGER_REPAIR_PENDING'),
          sessionId: failure.sessionId, invocationId: failure.invocationId })
        if (!history.succeeded) failures.push({ stage: 'history', error: new Error('SESSION_HISTORY_RECOVERY_REPORTED_FAILURES') })
      } catch (error) {
        failures.push({ stage: 'history', error: asError(error) })
      }
      if (dependencies.ledgerRepairs) {
        let ledgerRepairFailureCount = 0
        try {
          ledgerRepairFailureCount = await dependencies.ledgerRepairs()
          if (ledgerRepairFailureCount > 0) failures.push({ stage: 'history', error: new Error('SESSION_LEDGER_RECOVERY_REPORTED_FAILURES') })
        } catch (error) {
          failures.push({ stage: 'history', error: asError(error) })
          ledgerRepairFailureCount = 1
        }
        history = { ...history, repairFailureCount: history.repairFailureCount + ledgerRepairFailureCount }
        history = { ...history, succeeded: history.succeeded && ledgerRepairFailureCount === 0 }
      }
      historyResult = Object.freeze({ history: Object.freeze(history), failures: Object.freeze(failures.map((failure) => Object.freeze(failure))) })
      return historyResult
    })().finally(() => { historyInFlight = undefined })
    return historyInFlight
  }

  const recover = (): Promise<SessionRecoveryReport> => {
    if (completed) return Promise.resolve(completed)
    if (inFlight) return inFlight
    inFlight = (async () => {
      const historyPhase = await recoverHistory()
      const failures: Array<{ stage: SessionRecoveryReport['failures'][number]['stage']; error: Error; sessionId?: string; invocationId?: string }> = [...historyPhase.failures]
      const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value))
      const history = historyPhase.history
      let snapshots = emptySnapshots
      let coordinator = emptyCoordinator
      let reconciliation: SessionRecoveryReport['reconciliation'] = { status: 'skipped', reason: 'history-recovery-incomplete' }
      let continuations = emptyContinuations

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

      const blocked = !history.succeeded || !coordinator.succeeded || reconciliation.status === 'skipped' || failures.some((failure) => !failure.sessionId)
      const report: SessionRecoveryReport = Object.freeze({
        status: blocked ? 'blocked' : snapshots.skippedCanonicalUnavailableCount > 0 || history.sessionFailures.length > 0 ? 'degraded' : 'ready',
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
    recoverHistory,
    recover,
    inspectRecoveryStatus: () => Object.freeze({ state: completed?.status ?? 'pending' }),
    inspectReadiness: (sessionId: string) => {
      if (!completed) return { readable: false, executable: false, reason: 'recovery-pending' as const }
      if (completed.history.sessionFailures.some((failure) => failure.sessionId === sessionId && failure.capability === 'execution')) {
        const readiness = dependencies.inspectReadiness(sessionId)
        return { ...readiness, executable: false, reason: 'recovery-pending' as const }
      }
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
    if (transcript.status === 'commit_uncertain') return { readable: true, executable: false, reason: 'commit-uncertain' }
    if (transcript.status === 'blocked') return { readable: true, executable: false, reason: 'execution-blocked' }
    return { readable: true, executable: true }
  }
  return createSessionRecoveryPort({
    history: input.stages?.history ?? (async () => ({ interruptedCount: 0, repairFailureCount: 0 })),
    snapshots: input.stages?.snapshots ?? defaultSnapshots,
    coordinator: input.stages?.coordinator ?? defaultCoordinator,
    hasUnfinishedProjections: hasUnfinishedProjectionsForDb,
    reconcile: input.stages?.reconcile ?? defaultReconcile,
    continuations: input.stages?.continuations ?? defaultContinuations,
    ledgerRepairs: input.stages?.ledgerRepairs,
    inspectReadiness
  })
}
