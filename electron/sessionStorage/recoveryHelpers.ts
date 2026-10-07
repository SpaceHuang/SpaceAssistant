import type { AppDatabase } from '../database/sqliteStore'
import { listPersistedTurns, listStreamingAssistantMessages } from '../database/operations'
import type { PersistedTurn } from '../database/operations'
import type { Message } from '../../src/shared/domainTypes'
import { createSessionQueries } from './queries'

export type PersistedTurnSnapshotRecovery = Readonly<{
  restoredCount: number
  skippedCanonicalUnavailableCount: number
  missingAssistantCount: number
}>

/** Restore in-memory turn snapshots when their bodies are readable; durable recovery can proceed without them. */
export function restorePersistedTurnSnapshotsForStartup(
  db: AppDatabase,
  restoreTurn: (turn: PersistedTurn, assistant: Message) => unknown
): number {
  return restorePersistedTurnSnapshotsDetailed(db, restoreTurn).skippedCanonicalUnavailableCount
}

export function restorePersistedTurnSnapshotsDetailed(
  db: AppDatabase,
  restoreTurn: (turn: PersistedTurn, assistant: Message) => unknown
): PersistedTurnSnapshotRecovery {
  let restoredCount = 0
  let skippedCanonicalUnavailableCount = 0
  let missingAssistantCount = 0
  for (const state of ['configuring', 'prepared', 'executing', 'waiting-confirm']) {
    for (const persisted of listPersistedTurns(db, state)) {
      let assistant: Message | undefined
      try {
        assistant = createSessionQueries(db).readMessage({ sessionId: persisted.sessionId, messageId: persisted.assistantMessageId })
      } catch (error) {
        if (error instanceof Error && error.message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE') {
          // This snapshot is only for in-memory display. recoverTurn below validates durable History
          // independently and must still converge the persisted turn when the body projection is corrupt.
          skippedCanonicalUnavailableCount += 1
          continue
        }
        throw error
      }
      if (assistant) {
        restoreTurn(persisted, assistant)
        restoredCount += 1
      } else missingAssistantCount += 1
    }
  }
  return { restoredCount, skippedCanonicalUnavailableCount, missingAssistantCount }
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
