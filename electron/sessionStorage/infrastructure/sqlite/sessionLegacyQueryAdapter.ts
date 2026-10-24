import {
  getApiContextBaseline, getChatMessagePage, getMessage, getMessageSkeletons, getMessages,
  getMessagesPageWithSequence, getSearchCorpusPage, getTurnContextSkeleton,
  iterateRecentTurnRoutingSkeletons, resolveRetryContext,
} from '../../../database/operations'
export type {
  ApiContextBaselineResult, ChatMessagePage, MessageSearchHit, MessagesPageWithSequence, RetryContextTarget, SearchCorpusPage,
} from '../../../database/operations'
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

/** Legacy query operations retained behind the SessionStorage SQLite adapter during owner migration. */
export const readLegacyApiContextBaseline = getApiContextBaseline
export const readLegacyChatMessagePage = getChatMessagePage
export const readLegacyMessage = getMessage
export const readLegacyMessageSkeletons = getMessageSkeletons
export function readLegacyMessages(db: AppDatabase, sessionId: string, limit?: number, offset?: number) {
  return getMessages(db, sessionId, limit, offset)
}
export const readLegacyMessagesPageWithSequence = getMessagesPageWithSequence
export const readLegacySearchCorpusPage = getSearchCorpusPage
export const readLegacyRetryContext = resolveRetryContext
