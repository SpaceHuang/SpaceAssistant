import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { runEligibleSessionProjectionMigration } from './sessionProjectionMigration'
import { auditSessionProjectionMigration } from './sessionProjectionConsistencyAudit'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { buildSessionProjectionMigrationInventory } from './sessionProjectionMigrationInventory'
import { buildSessionProjectionRetirementCandidates } from './sessionProjectionRetirementCandidates'

async function addEligibleSession(db: ReturnType<typeof createMemoryAppDb>, id: string,
  scope: Partial<Parameters<typeof createSession>[1]> = {}) {
  const session = createSession(db, { name: id, model: 'test', ...scope })
  const messages = [
    { id: `${id}-user`, role: 'user' as const, content: `question-${id}`, timestamp: 1 },
    { id: `${id}-assistant`, role: 'assistant' as const, content: `answer-${id}`, timestamp: 2 }
  ]
  for (const [index, message] of messages.entries()) appendMessage(db, { ...message, sessionId: session.id, sequence: index + 1, status: index ? 'completed' : 'sent' })
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
    invocationId: `audit-invocation-${id}`, turnId: `audit-turn-${id}`, sequence: 1, schemaVersion: 1,
    eventId: `audit-context-${id}`, idempotencyKey: `audit-context-${id}`, kind: 'invocation-context-committed', payload: { messages }
  }], 0)
  getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
  return session
}

async function completeMigration(db: ReturnType<typeof createMemoryAppDb>, runId: string) {
  return runEligibleSessionProjectionMigration(db, { runId, batchSize: 10, rateLimitMs: 0 })
}

describe('session projection consistency audit', () => {
  it('compares every cache to canonical and legacy data in a read-only snapshot, including boundaries', async () => {
    const db = createMemoryAppDb()
    const first = await addEligibleSession(db, 'audit-a')
    const second = await addEligibleSession(db, 'audit-b')
    const inventory = buildSessionProjectionMigrationInventory(db)
    await runEligibleSessionProjectionMigration(db, { runId: 'audit-run', batchSize: 1, rateLimitMs: 0 })
    const conn = getDbConnection(db)
    const changesBefore = Number((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
    const cacheRowsBefore = conn.prepare('SELECT session_id,value_sha256 FROM canonical_session_projection_cache ORDER BY session_id').all()

    const report = auditSessionProjectionMigration(db, 'audit-run', { sampleSize: 1 })

    expect(report).toMatchObject({ complete: true, stableSnapshot: true, globalHistoryOrderValid: true,
      sessionCount: inventory.databaseSessionCount, consistentCount: 2, legacyExceptionCount: 0, differenceCount: 0,
      exactLegacyComparisonCount: 2, sampleCount: 1, sampleMismatchCount: 0 })
    expect(report.boundarySessionIds).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(report.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: first.id, status: 'consistent', legacyComparison: 'exact', canonicalWatermark: expect.objectContaining({ eventId: expect.any(String), invocationId: expect.any(String) }) }),
      expect.objectContaining({ sessionId: second.id, status: 'consistent', legacyComparison: 'exact' })
    ]))
    const auditedFirst = report.sessions.find(({ sessionId }) => sessionId === first.id)!
    expect(auditedFirst.cacheWatermark).toEqual(auditedFirst.canonicalWatermark)
    expect(Number((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n)).toBe(changesBefore)
    expect(conn.prepare('SELECT session_id,value_sha256 FROM canonical_session_projection_cache ORDER BY session_id').all()).toEqual(cacheRowsBefore)
    db.close()
  })

  it('does not complete the audit while the durable migration run is still active', async () => {
    const db = createMemoryAppDb()
    await addEligibleSession(db, 'audit-active-run')
    await completeMigration(db, 'audit-active-run-id')
    getDbConnection(db).prepare("UPDATE session_projection_migration_runs SET status='running' WHERE run_id=?").run('audit-active-run-id')

    const report = auditSessionProjectionMigration(db, 'audit-active-run-id')

    expect(report).toMatchObject({ migrationRunStatus: 'running', complete: false,
      issues: expect.arrayContaining(['migration-run-not-completed']) })
    db.close()
  })

  it('compares cache event identity against its live History anchor', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'audit-event-anchor')
    await completeMigration(db, 'audit-event-anchor-run')
    getDbConnection(db).prepare(`UPDATE canonical_session_projection_cache SET watermark_event_id='forged-event'
      WHERE session_id=? AND cache_key='transcript'`).run(session.id)

    const report = auditSessionProjectionMigration(db, 'audit-event-anchor-run')

    expect(report).toMatchObject({ complete: false, differenceCount: 1 })
    expect(report.sessions).toEqual([expect.objectContaining({
      sessionId: session.id,
      status: 'difference',
      issues: expect.arrayContaining(['cache-watermark-invalid', 'cache-watermark-mismatch'])
    })])
    db.close()
  })

  it('uses the canonical message skeleton for cleaned rows and reports absent legacy sampling honestly', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'audit-canonical-only')
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    await completeMigration(db, 'audit-canonical-only-run')

    const report = auditSessionProjectionMigration(db, 'audit-canonical-only-run')

    expect(report).toMatchObject({ complete: false, consistentCount: 1, differenceCount: 0, exactLegacyComparisonCount: 0,
      issues: ['legacy-comparison-sample-unavailable'] })
    expect(report.sessions).toEqual([expect.objectContaining({ sessionId: session.id, status: 'consistent', legacyComparison: 'skeleton' })])
    db.close()
  })

  it('reports cache content drift even when the stored checksum is internally valid', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'audit-damaged-cache')
    await completeMigration(db, 'audit-damaged-run')
    const wrongValue = JSON.stringify([])
    const wrongHash = createHash('sha256').update(wrongValue, 'utf8').digest('hex')
    getDbConnection(db).prepare(`UPDATE canonical_session_projection_cache SET value=?,value_sha256=? WHERE session_id=? AND cache_key='transcript'`)
      .run(wrongValue, wrongHash, session.id)

    const report = auditSessionProjectionMigration(db, 'audit-damaged-run')

    expect(report).toMatchObject({ complete: false, differenceCount: 1 })
    expect(report.sessions).toEqual([expect.objectContaining({ sessionId: session.id, status: 'difference', issues: ['cache-content-mismatch'] })])
    db.close()
  })

  it('accepts an explicitly retained legacy session while still auditing migrated peers', async () => {
    const db = createMemoryAppDb()
    const migrated = await addEligibleSession(db, 'audit-migrated-peer')
    const legacy = createSession(db, { name: 'audit-legacy-exception', model: 'test' })
    appendMessage(db, { id: 'audit-legacy-body', sessionId: legacy.id, role: 'system', content: 'kept old body', timestamp: 1, status: 'sent' })
    await completeMigration(db, 'audit-exception-run')

    const report = auditSessionProjectionMigration(db, 'audit-exception-run')

    expect(report).toMatchObject({ complete: true, consistentCount: 1, legacyExceptionCount: 1, differenceCount: 0,
      legacyCensusCount: 1, legacyQueuedCount: 1, legacyQueueReconciled: true })
    expect(report.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: migrated.id, status: 'consistent' }),
      expect.objectContaining({ sessionId: legacy.id, status: 'legacy_exception', reason: 'field-not-eligible', dormantProjectionCache: true })
    ]))
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get('audit-legacy-body')).toEqual({ content: 'kept old body' })
    db.close()
  })

  it('reports new sessions absent from the migration census and generation drift', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'audit-generation-drift')
    await completeMigration(db, 'audit-drift-run')
    getDbConnection(db).prepare('UPDATE sessions SET generation=? WHERE id=?').run('replacement-generation', session.id)
    const added = createSession(db, { name: 'after-census-session', model: 'test' })

    const report = auditSessionProjectionMigration(db, 'audit-drift-run')

    expect(report).toMatchObject({ complete: false, differenceCount: 2, unclassifiedSessionIds: [added.id] })
    expect(report.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: session.id, issues: ['generation-mismatch'] }),
      expect.objectContaining({ sessionId: added.id, issues: ['unclassified-session'] })
    ]))
    db.close()
  })

  it('finds projection cache records orphaned after a session disappears', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'audit-orphan-cache')
    await completeMigration(db, 'audit-orphan-run')
    getDbConnection(db).prepare('DELETE FROM sessions WHERE id=?').run(session.id)

    const report = auditSessionProjectionMigration(db, 'audit-orphan-run')

    expect(report).toMatchObject({ complete: false, differenceCount: 1 })
    expect(report.sessions).toEqual([expect.objectContaining({
      sessionId: session.id,
      status: 'difference',
      issues: expect.arrayContaining(['session-missing-without-deleted-disposition', 'orphan-projection-cache'])
    })])
    db.close()
  })

  it('reports internal History health and scope anomalies separately from the product migration cohort', async () => {
    const db = createMemoryAppDb()
    const product = await addEligibleSession(db, 'audit-scope-product')
    const internalWithHistory = createSession(db, { name: 'audit internal history', model: 'test', ownership: 'internal', visibility: 'hidden' })
    const internalEmpty = createSession(db, { name: 'audit internal empty', model: 'test', ownership: 'internal', visibility: 'hidden' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, internalWithHistory.id).appendBatch([{
      invocationId: `audit-private-${internalWithHistory.id}`, turnId: 'private-audit-turn', sequence: 1, schemaVersion: 1,
      eventId: 'private-audit-context', idempotencyKey: 'private-audit-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'private-audit-message', role: 'user', content: 'private', timestamp: 1 }] }
    }], 0)
    const inventory = buildSessionProjectionMigrationInventory(db)
    expect(inventory).toMatchObject({ databaseSessionCount: 3, migrationSessionCount: 1, excludedInternalHiddenSessionCount: 2 })
    await completeMigration(db, 'audit-scope-run')
    const conn = getDbConnection(db)
    for (const trigger of [
      'invalidate_canonical_transcript_cache_after_history_event_update',
      'invalidate_session_api_eligibility_after_history_event_update',
      'track_pending_history_cursor_allocation', 'settle_pending_history_cursor_allocation',
      'invalidate_session_projections_after_history_cursor_update', 'invalidate_session_projections_after_history_cursor_delete'
    ]) conn.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run()
    conn.prepare("UPDATE agent_history_events SET payload_json='{' WHERE event_id=?").run('private-audit-context')
    const unknown = createSession(db, { name: 'audit unknown scope', model: 'test' })
    conn.prepare("UPDATE sessions SET ownership='mystery' WHERE id=?").run(unknown.id)

    const report = auditSessionProjectionMigration(db, 'audit-scope-run')

    expect(report).toMatchObject({
      complete: false, stableSnapshot: true, sessionCount: 4, migrationSessionCount: 1,
      excludedInternalHiddenSessionCount: 2,
      internalHistory: { sessionCount: 2, withHistoryCount: 1, healthyCount: 0, unhealthyCount: 1 },
      scopeAnomalies: [{ sessionId: unknown.id, ownership: 'mystery', visibility: 'primary', reason: 'unknown-scope' }],
      scopeAnomalyCount: 1, differenceCount: 0, unclassifiedSessionIds: []
    })
    expect(report.sessions.map(({ sessionId }) => sessionId)).toEqual([product.id])
    expect(report.issues).toEqual(expect.arrayContaining(['internal-history-unhealthy', 'session-scope-anomaly']))
    db.close()
  })

  it('audits and builds the M4-1 candidate range over products while keeping healthy internal History separate', async () => {
    const db = createMemoryAppDb()
    const user = await addEligibleSession(db, 'audit-range-user')
    const remote = await addEligibleSession(db, 'audit-range-remote', {
      ownership: 'remote', visibility: 'primary', metadata: { source: 'feishu', feishuChatId: 'range-chat' }
    })
    const automation = await addEligibleSession(db, 'audit-range-automation', { ownership: 'automation', visibility: 'section' })
    const internal = createSession(db, { name: 'audit-range-private', model: 'test', ownership: 'internal', visibility: 'hidden' })
    const internalEmpty = createSession(db, { name: 'audit-range-private-empty', model: 'test', ownership: 'internal', visibility: 'hidden' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, internal.id).appendBatch([{
      invocationId: 'audit-range-private-stream', turnId: 'private-turn', sequence: 1, schemaVersion: 1,
      eventId: 'audit-range-private-context', idempotencyKey: 'audit-range-private-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'audit-range-private-message', role: 'user', content: 'private', timestamp: 1 }] }
    }], 0)
    await completeMigration(db, 'audit-range-run')

    const audit = auditSessionProjectionMigration(db, 'audit-range-run')
    const candidates = buildSessionProjectionRetirementCandidates(audit)

    expect(audit).toMatchObject({ complete: true, sessionCount: 5, databaseSessionCount: 5, migrationSessionCount: 3,
      excludedInternalHiddenSessionCount: 2, internalHistory: { sessionCount: 2, withHistoryCount: 1, healthyCount: 1, unhealthyCount: 0 },
      scopeAnomalyCount: 0, differenceCount: 0, consistentCount: 3 })
    expect(audit.sessions.map(({ sessionId }) => sessionId)).toEqual(expect.arrayContaining([user.id, remote.id, automation.id]))
    expect(audit.sessions.map(({ sessionId }) => sessionId)).not.toEqual(expect.arrayContaining([internal.id, internalEmpty.id]))
    expect(candidates).toMatchObject({ readyForOwnerReview: true, supportedSessionCount: 3, migratedCount: 3, blockedCount: 0 })
    expect(candidates.candidates.map(({ sessionId }) => sessionId)).toEqual(expect.arrayContaining([user.id, remote.id, automation.id]))
    expect(candidates.candidates.map(({ sessionId }) => sessionId)).not.toEqual(expect.arrayContaining([internal.id, internalEmpty.id]))
    db.close()
  })
})
