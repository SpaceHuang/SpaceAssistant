import type { AppDatabase } from '../database/sqliteStore'
import { reconcileCommittedSessionTranscripts, recoverSessionExecutionForTarget, recoverStaleSessionExecutionClaims } from '../database/sessionTranscript'

/** Privileged SQLite leaf kept separate from the public recovery orchestration port. */
export function createSessionTranscriptRecoveryAdapter(db: AppDatabase) {
  return Object.freeze({
    recoverTarget(sessionId: string, now = Date.now()) {
      return recoverSessionExecutionForTarget(db, sessionId, now)
    },
    reconcile(now = Date.now()) {
      const staleClaims = recoverStaleSessionExecutionClaims(db, now)
      return { ...staleClaims, reconciled: reconcileCommittedSessionTranscripts(db, now) }
    }
  })
}
