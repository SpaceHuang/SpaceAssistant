import { describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import type { SessionProjectionConsistencyAuditReport, SessionProjectionConsistencySession } from './sessionProjectionConsistencyAudit'
import { auditSessionProjectionMigration } from './sessionProjectionConsistencyAudit'
import { runEligibleSessionProjectionMigration } from './sessionProjectionMigration'
import { buildSessionProjectionRetirementCandidates } from './sessionProjectionRetirementCandidates'

function makeAudit(sessions: SessionProjectionConsistencySession[], overrides: Partial<SessionProjectionConsistencyAuditReport> = {}): SessionProjectionConsistencyAuditReport {
  return {
    runId: 'retirement-run', migrationRunStatus: 'completed', complete: true, stableSnapshot: true,
    globalHistoryOrderValid: true, sessionCount: sessions.filter(({ status }) => status !== 'deleted').length,
    databaseSessionCount: sessions.filter(({ status }) => status !== 'deleted').length,
    migrationSessionCount: sessions.filter(({ status }) => status !== 'deleted').length,
    excludedInternalHiddenSessionCount: 0,
    internalHistory: { sessionCount: 0, withHistoryCount: 0, healthyCount: 0, unhealthyCount: 0 },
    internalHistorySha256: '0'.repeat(64), scopeAnomalies: [], scopeAnomalyCount: 0,
    inventoryItemCount: sessions.length, classifiedCount: sessions.length, consistentCount: sessions.filter(({ status }) => status === 'consistent').length,
    legacyExceptionCount: sessions.filter(({ status }) => status === 'legacy_exception').length,
    deletedCount: sessions.filter(({ status }) => status === 'deleted').length,
    differenceCount: sessions.filter(({ status }) => status === 'difference').length,
    unclassifiedSessionIds: [], legacyCensusCount: 0, legacyQueuedCount: 0, legacyDiscoveredCount: 0,
    legacyQueueReconciled: true, exactLegacyComparisonCount: sessions.filter(({ legacyComparison }) => legacyComparison === 'exact').length,
    boundarySessionIds: [], sampledSessionIds: [], sampleCount: 0, sampleMismatchCount: 0, issues: [], sessions,
    ...overrides
  }
}

describe('session projection retirement candidate census', () => {
  it('includes baseline-migrated sessions and retains only genuinely ineligible sessions as legacy exceptions', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'retirement-legacy-session', model: 'test' })
    appendMessage(db, { id: 'retirement-legacy-message', sessionId: session.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    const unsupported = createSession(db, { name: 'retirement-system-session', model: 'test' })
    appendMessage(db, { id: 'retirement-system-message', sessionId: unsupported.id, role: 'system', content: 'system body', timestamp: 1, status: 'sent' })
    await runEligibleSessionProjectionMigration(db, { runId: 'retirement-real-run', batchSize: 10, rateLimitMs: 0 })

    const audit = auditSessionProjectionMigration(db, 'retirement-real-run')
    const report = buildSessionProjectionRetirementCandidates(audit)

    expect(report).toMatchObject({ readyForOwnerReview: true, supportedSessionCount: 2, migratedCount: 1,
      approvedLegacyExceptionCount: 1, blockedCount: 0 })
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: session.id, classification: 'projection-migrated' }),
      expect.objectContaining({ sessionId: unsupported.id, classification: 'approved-legacy-exception', owner: 'session-storage-refactor-maintainers' })
    ]))
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('retirement-legacy-message')).toEqual({ content: 'legacy body' })
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('retirement-system-message')).toEqual({ content: 'system body' })
    db.close()
  })

  it('includes every live session and classifies migrated sessions and approved legacy exceptions', () => {
    const audit = makeAudit([
      { sessionId: 'migrated', status: 'consistent', migrationStatus: 'migrated', legacyComparison: 'exact', issues: [] },
      { sessionId: 'legacy', status: 'legacy_exception', migrationStatus: 'legacy_required', legacyOwner: 'session-storage-refactor-maintainers',
        legacyDecision: 'retain-legacy', reason: 'legacy-mismatch', legacyComparison: 'legacy-exception', issues: [] },
      { sessionId: 'deleted', status: 'deleted', legacyComparison: 'not-compared', issues: [] }
    ])

    const report = buildSessionProjectionRetirementCandidates(audit)

    expect(report).toMatchObject({ readyForOwnerReview: true, supportedSessionCount: 2, migratedCount: 1,
      approvedLegacyExceptionCount: 1, blockedCount: 0, deletedCount: 1 })
    expect(report.candidates).toEqual([
      expect.objectContaining({ sessionId: 'legacy', classification: 'approved-legacy-exception', owner: 'session-storage-refactor-maintainers', reader: 'readSessionTranscriptProjection → getMessages' }),
      expect.objectContaining({ sessionId: 'migrated', classification: 'projection-migrated' })
    ])
    expect(report.issues).toEqual([])
  })

  it('blocks on unclassified or differing sessions and on an unknown legacy owner', () => {
    const audit = makeAudit([
      { sessionId: 'legacy-no-owner', status: 'legacy_exception', migrationStatus: 'legacy_required', legacyOwner: 'unknown-team',
        legacyDecision: 'retain-legacy', legacyComparison: 'legacy-exception', issues: [] },
      { sessionId: 'unclassified', status: 'difference', legacyComparison: 'not-compared', issues: ['unclassified-session'] }
    ], { complete: false, differenceCount: 1, issues: ['unclassified-session'] })

    const report = buildSessionProjectionRetirementCandidates(audit)

    expect(report).toMatchObject({ readyForOwnerReview: false, supportedSessionCount: 2, migratedCount: 0,
      approvedLegacyExceptionCount: 0, blockedCount: 2 })
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'legacy-no-owner', classification: 'blocked', issues: ['unsupported-legacy-owner'] }),
      expect.objectContaining({ sessionId: 'unclassified', classification: 'blocked', issues: ['unclassified-session'] })
    ]))
    expect(report.issues).toEqual(expect.arrayContaining(['audit-incomplete', 'sessions-not-retirement-classifiable']))
  })

  it('does not treat a migrated status as ready when the full M3-5 audit is incomplete', () => {
    const audit = makeAudit([
      { sessionId: 'migrated', status: 'consistent', migrationStatus: 'migrated', legacyComparison: 'skeleton', issues: [] }
    ], { complete: false, issues: ['legacy-comparison-sample-unavailable'] })

    expect(buildSessionProjectionRetirementCandidates(audit)).toMatchObject({ readyForOwnerReview: false,
      blockedCount: 0, issues: ['audit-incomplete'] })
  })
})
