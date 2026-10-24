/** Named SQLite host bindings for legacy runtime adapters awaiting full SessionStorage port migration. */
export {
  computeCanonicalProjectionFingerprint, hasCurrentProjectionEligibility, publishTranscriptParityProof,
  refreshValidatedProjectionFastPath, validateCanonicalProjection
} from './infrastructure/sqlite/sessionProjectionRevalidationFacts'
export { readLegacyProjectionMessages, readLegacyTurnContextSkeleton, iterateLegacyTurnRoutingSkeletons }
  from './infrastructure/sqlite/sessionLegacyQueryAdapter'
export { resolveSelectedMessageBodies } from './internal/messageBodyResolver'
export { createProjectionService } from './application/projectionService'
export { createSqliteProjectionStateStore } from './infrastructure/sqlite/sessionProjectionStateStore'
export { createSqliteSessionApiRouteProjectionFence } from './infrastructure/sqlite/sessionApiRouteProjectionFence'
export { hasRejectedTranscriptParityStateInConnection } from './infrastructure/sqlite/sessionProjectionEligibility'
export { createSessionLedgerCompactionDependencyGuard, createCanonicalSessionProjectionRetentionPreparer }
  from './infrastructure/sqlite/sessionEventRetentionAdapter'
export { createSqliteStartupHistoryRecoveryBindings } from './infrastructure/sqlite/sessionHistoryRecoveryHost'
export { selectRecentTurnRoutingMessages, selectTurnContext } from './infrastructure/sqlite/sessionTranscriptSelector'
