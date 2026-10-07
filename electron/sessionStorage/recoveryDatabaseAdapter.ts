import type { AppDatabase } from '../database/sqliteStore'
import { reconcileCommittedSessionTranscripts, recoverStaleSessionExecutionClaims } from '../database/sessionTranscript'

/** Privileged SQLite leaf kept separate from the public recovery orchestration port. */
export function createSessionTranscriptRecoveryAdapter(db: AppDatabase) {
  return Object.freeze({
    reconcile(now = Date.now()) {
      const staleClaims = recoverStaleSessionExecutionClaims(db, now)
      return { ...staleClaims, reconciled: reconcileCommittedSessionTranscripts(db, now) }
    }
  })
}
