/** Named SQLite host bindings for legacy runtime adapters awaiting full SessionStorage port migration. */
export {
  computeCanonicalProjectionFingerprint, hasCurrentProjectionEligibility, publishTranscriptParityProof,
  refreshValidatedProjectionFastPath, validateCanonicalProjection
} from './infrastructure/sqlite/sessionProjectionRevalidationFacts'
export { readLegacyProjectionMessages, readLegacyTurnContextSkeleton, iterateLegacyTurnRoutingSkeletons }
  from './infrastructure/sqlite/sessionLegacyQueryAdapter'
export {
  readLegacyApiContextBaseline, readLegacyChatMessagePage, readLegacyMessage, readLegacyMessageSkeletons,
  readLegacyMessages, readLegacyMessagesPageWithSequence, readLegacySearchCorpusPage, readLegacyRetryContext,
} from './infrastructure/sqlite/sessionLegacyQueryAdapter'
export type {
  ApiContextBaselineResult, ChatMessagePage, MessageSearchHit, MessagesPageWithSequence, RetryContextTarget, SearchCorpusPage,
} from './infrastructure/sqlite/sessionLegacyQueryAdapter'
export { resolveSelectedMessageBodies } from './internal/messageBodyResolver'
export { createProjectionService } from './application/projectionService'
export { createSqliteProjectionStateStore } from './infrastructure/sqlite/sessionProjectionStateStore'
export { createSqliteSessionApiRouteProjectionFence } from './infrastructure/sqlite/sessionApiRouteProjectionFence'
export { hasRejectedTranscriptParityStateInConnection } from './infrastructure/sqlite/sessionProjectionEligibility'
export { createSessionLedgerCompactionDependencyGuard, createCanonicalSessionProjectionRetentionPreparer }
  from './infrastructure/sqlite/sessionEventRetentionAdapter'
export { selectRecentTurnRoutingMessages, selectTurnContext } from './infrastructure/sqlite/sessionTranscriptSelector'
export {
  clearProjectionRejection, computeLegacyProjectionDigest, consultProjectionRejection, getProjectionRejection,
  listProjectionRejectionWork, markProjectionRejectionStale, projectionRejectionBackoffDelayMs,
  readProjectionO1Metadata, recordProjectionRejection
} from './infrastructure/sqlite/sessionProjectionRejection'
export type { ProjectionO1Metadata, ProjectionRejectionRow, ProjectionRejectionVerdict } from './infrastructure/sqlite/sessionProjectionRejection'
