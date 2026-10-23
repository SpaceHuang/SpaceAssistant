/** Named SQLite host bindings for legacy runtime adapters awaiting full SessionStorage port migration. */
export {
  computeCanonicalProjectionFingerprint, hasCurrentProjectionEligibility, publishTranscriptParityProof,
  readLegacyProjectionMessages, refreshValidatedProjectionFastPath, validateAndCacheCanonicalProjection
} from './infrastructure/sqlite/sessionProjectionRevalidationFacts'
export { resolveSelectedMessageBodies } from './internal/messageBodyResolver'
export { createProjectionService } from './application/projectionService'
export { createSqliteProjectionStateStore } from './infrastructure/sqlite/sessionProjectionStateStore'
export { createSqliteSessionApiRouteProjectionFence } from './infrastructure/sqlite/sessionApiRouteProjectionFence'
export { hasRejectedTranscriptParityStateInConnection } from './infrastructure/sqlite/sessionProjectionEligibility'
export { createSessionLedgerCompactionDependencyGuard, createCanonicalSessionProjectionRetentionPreparer }
  from './infrastructure/sqlite/sessionEventRetentionAdapter'
export { createSqliteStartupHistoryRecoveryBindings } from './infrastructure/sqlite/sessionHistoryRecoveryHost'
