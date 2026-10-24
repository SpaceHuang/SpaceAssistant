import { getMessages, getTurnContextSkeleton, iterateRecentTurnRoutingSkeletons } from '../../../database/operations'
import type { AppDatabase } from '../../../database/sqliteStore'

/** Read the complete legacy projection input owned by the SQLite adapter. */
export function readLegacyProjectionMessages(db: AppDatabase, sessionId: string) {
  return getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
}

/** Read the selected legacy API-context skeleton through the SQLite adapter. */
export function readLegacyTurnContextSkeleton(db: AppDatabase, sessionId: string, boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined, excludeMessageIds: string[]) {
  return getTurnContextSkeleton(db, sessionId, boundarySequence, requiredUserMessageId, excludeMessageIds)
}

/** Iterate legacy turn-routing skeleton facts without exposing the raw message table to runtime callers. */
export function* iterateLegacyTurnRoutingSkeletons(db: AppDatabase, sessionId: string, boundarySequence?: number,
  excludeMessageIds: string[] = []) {
  yield* iterateRecentTurnRoutingSkeletons(db, sessionId, boundarySequence, excludeMessageIds)
}
