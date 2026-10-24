import type { SessionProjectionConsistencyAuditReport, SessionProjectionConsistencySession } from './sessionProjectionConsistencyAudit'

export type SessionProjectionRetirementCandidate = Readonly<{
  sessionId: string
  classification: 'projection-migrated' | 'approved-legacy-exception' | 'blocked'
  owner?: string
  reader?: string
  reason?: string
  issues: readonly string[]
}>

export type SessionProjectionRetirementCandidateReport = Readonly<{
  runId: string
  readyForOwnerReview: boolean
  supportedSessionCount: number
  migratedCount: number
  approvedLegacyExceptionCount: number
  blockedCount: number
  deletedCount: number
  issues: readonly string[]
  candidates: readonly SessionProjectionRetirementCandidate[]
}>

/**
 * This registry is the maintained support contract for legacy-required sessions.
 * The named reader retains the old SQLite message path while the exception remains supported.
 */
const LEGACY_READER_OWNERS: Readonly<Record<string, string>> = {
  'session-storage-refactor-maintainers': 'readSessionTranscriptProjection → getMessages'
}

function candidateFor(session: SessionProjectionConsistencySession): SessionProjectionRetirementCandidate {
  if (session.status === 'consistent' && session.migrationStatus === 'migrated' && session.issues.length === 0) {
    return { sessionId: session.sessionId, classification: 'projection-migrated', issues: [] }
  }
  if (session.status === 'legacy_exception' && session.migrationStatus === 'legacy_required' &&
    session.legacyDecision === 'retain-legacy' && session.legacyOwner && LEGACY_READER_OWNERS[session.legacyOwner]) {
    return {
      sessionId: session.sessionId, classification: 'approved-legacy-exception', owner: session.legacyOwner,
      reader: LEGACY_READER_OWNERS[session.legacyOwner], reason: session.reason, issues: []
    }
  }
  const issues = [...session.issues]
  if (session.status === 'consistent' && session.migrationStatus !== 'migrated') issues.push('session-not-migrated')
  if (session.status === 'legacy_exception') {
    if (session.legacyDecision !== 'retain-legacy') issues.push('legacy-retain-decision-missing')
    if (!session.legacyOwner || !LEGACY_READER_OWNERS[session.legacyOwner]) issues.push('unsupported-legacy-owner')
  }
  if (issues.length === 0) issues.push('session-not-classified-for-retirement')
  return { sessionId: session.sessionId, classification: 'blocked', owner: session.legacyOwner, reason: session.reason, issues }
}

/** Build the M4-1 live-session scope from a completed M3-5 read-only audit. */
export function buildSessionProjectionRetirementCandidates(
  audit: SessionProjectionConsistencyAuditReport
): SessionProjectionRetirementCandidateReport {
  const liveSessions = audit.sessions.filter(({ status }) => status !== 'deleted')
  const supportedSessionCount = audit.migrationSessionCount
  const candidates = liveSessions.map(candidateFor).sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
  const migratedCount = candidates.filter(({ classification }) => classification === 'projection-migrated').length
  const approvedLegacyExceptionCount = candidates.filter(({ classification }) => classification === 'approved-legacy-exception').length
  const blockedCount = candidates.filter(({ classification }) => classification === 'blocked').length
  const issues: string[] = []
  if (!audit.complete) issues.push('audit-incomplete')
  if (liveSessions.length !== supportedSessionCount) issues.push('session-census-not-classifiable')
  if (migratedCount + approvedLegacyExceptionCount + blockedCount !== supportedSessionCount) issues.push('session-census-not-classifiable')
  if (blockedCount > 0) issues.push('sessions-not-retirement-classifiable')
  return {
    runId: audit.runId, readyForOwnerReview: issues.length === 0,
    supportedSessionCount, migratedCount, approvedLegacyExceptionCount, blockedCount,
    deletedCount: audit.deletedCount, issues: [...new Set(issues)], candidates
  }
}
