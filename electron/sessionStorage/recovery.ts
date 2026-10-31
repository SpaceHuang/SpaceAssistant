import type { AppDatabase } from '../database/sqliteStore'
import { hasUnfinishedStartupProjections } from './recoveryHelpers'
import { createSessionTranscriptRecoveryAdapter } from './recoveryDatabaseAdapter'

/** Compatibility reconciliation primitive for focused durable transcript recovery callers. */
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
