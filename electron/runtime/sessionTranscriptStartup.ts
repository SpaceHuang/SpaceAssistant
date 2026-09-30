import type { AppDatabase } from '../database/sqliteStore'
import { listPersistedTurns, listStreamingAssistantMessages } from '../database/operations'
import { reconcileCommittedSessionTranscripts, recoverStaleSessionExecutionClaims } from '../database/sessionTranscript'

/** Startup transcript reconciliation may release execution fences only after every persisted turn projection converges. */
export function hasUnfinishedStartupProjections(db: AppDatabase): boolean {
  return listStreamingAssistantMessages(db).length > 0 || listPersistedTurns(db).some((turn) =>
    turn.state === 'configuring' || turn.state === 'prepared' || turn.state === 'executing' || turn.state === 'waiting-confirm'
  )
}

export function recoverTurnCoordinatorForStartup(db: AppDatabase, recover: () => void): { succeeded: true } | { succeeded: false; error: unknown } {
  try {
    recover()
    if (hasUnfinishedStartupProjections(db)) return { succeeded: false, error: new Error('TURN_PROJECTION_RECOVERY_INCOMPLETE') }
    return { succeeded: true }
  } catch (error) {
    return { succeeded: false, error }
  }
}

export type StartupTranscriptReconciliation =
  | { reconciled: number; skippedReason: 'history-recovery-incomplete' | 'turn-projection-recovery-incomplete' }
  | { releasedUnstarted: number; markedUncertain: number; repairedCheckpoints: number; reconciled: number }

export function reconcileStartupSessionTranscripts(db: AppDatabase, readiness: {
  historyRecoverySucceeded: boolean
  turnCoordinatorRecoverySucceeded: boolean
}, now = Date.now()): StartupTranscriptReconciliation {
  if (!readiness.historyRecoverySucceeded) return { reconciled: 0, skippedReason: 'history-recovery-incomplete' }
  if (!readiness.turnCoordinatorRecoverySucceeded || hasUnfinishedStartupProjections(db)) {
    return { reconciled: 0, skippedReason: 'turn-projection-recovery-incomplete' }
  }
  const staleClaims = recoverStaleSessionExecutionClaims(db, now)
  return { ...staleClaims, reconciled: reconcileCommittedSessionTranscripts(db, now) }
}
