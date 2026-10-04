import type { AppDatabase } from '../database/sqliteStore'
import { listPersistedTurns, listStreamingAssistantMessages } from '../database/operations'
import { reconcileCommittedSessionTranscripts, recoverStaleSessionExecutionClaims } from '../database/sessionTranscript'
import type { PersistedTurn } from '../database/operations'
import type { Message } from '../../src/shared/domainTypes'
import { getProjectedMessage } from './sessionTranscriptProjection'

/** Restore in-memory turn snapshots when their bodies are readable; durable recovery can proceed without them. */
export function restorePersistedTurnSnapshotsForStartup(
  db: AppDatabase,
  restoreTurn: (turn: PersistedTurn, assistant: Message) => unknown
): number {
  let skippedCanonicalUnavailable = 0
  for (const state of ['configuring', 'prepared', 'executing', 'waiting-confirm']) {
    for (const persisted of listPersistedTurns(db, state)) {
      let assistant: Message | undefined
      try {
        assistant = getProjectedMessage(db, persisted.assistantMessageId)
      } catch (error) {
        if (error instanceof Error && error.message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE') {
          // This snapshot is only for in-memory display. recoverTurn below validates durable History
          // independently and must still converge the persisted turn when the body projection is corrupt.
          skippedCanonicalUnavailable += 1
          continue
        }
        throw error
      }
      if (assistant) restoreTurn(persisted, assistant)
    }
  }
  return skippedCanonicalUnavailable
}

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
