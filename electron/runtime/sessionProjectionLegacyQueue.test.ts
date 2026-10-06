import { describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { buildSessionProjectionMigrationInventory } from './sessionProjectionMigrationInventory'
import { listLegacyRequiredSessionProjections, runSessionProjectionMigrationBatch, startSessionProjectionMigration } from './sessionProjectionMigration'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'
import { clearNextSessionMessageContentBatch } from './sessionStorageCutover'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import * as projectionModule from './sessionTranscriptProjection'

describe('legacy-required session projection queue', () => {
  it('records an owner, retain-legacy decision, readable behavior, and reconciles against M3-1', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'legacy-required-session', model: 'test' })
    appendMessage(db, { id: 'legacy-required-message', sessionId: session.id, role: 'system', content: 'legacy body', timestamp: 1, status: 'sent' })
    const inventory = buildSessionProjectionMigrationInventory(db)
    expect(inventory.counts.legacy_required).toBe(1)
    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-legacy-required', now: 10 })
    const conn = getDbConnection(db)
    const beforeQueueRead = {
      cache: conn.prepare("SELECT COUNT(*) AS count FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id),
      eligibility: conn.prepare('SELECT * FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)
    }

    const report = listLegacyRequiredSessionProjections(db, run.runId)

    expect(report).toMatchObject({ censusCount: 1, queuedCensusCount: 1, baselineMigratedCensusCount: 0, discoveredDuringMigrationCount: 0, reconciled: true })
    expect(report.items).toEqual([expect.objectContaining({
      sessionId: session.id,
      reason: 'field-not-eligible',
      owner: 'session-storage-refactor-maintainers',
      decision: 'retain-legacy',
      userBehavior: 'legacy-reader-retain-source',
      userMessage: {
        'zh-CN': '此会话继续使用兼容读取路径；原有消息数据会保留。',
        'en-US': 'This session continues using the compatible reader; its existing message data is retained.'
      }
    })])
    conn.prepare("UPDATE session_projection_migration_items SET status='retry' WHERE run_id=? AND session_id=?").run(run.runId, session.id)
    expect(listLegacyRequiredSessionProjections(db, run.runId)).toMatchObject({ censusCount: 1, queuedCensusCount: 0, reconciled: false, items: [] })
    conn.prepare("UPDATE session_projection_migration_items SET status='legacy_required' WHERE run_id=? AND session_id=?").run(run.runId, session.id)
    expect({
      cache: conn.prepare("SELECT COUNT(*) AS count FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id),
      eligibility: conn.prepare('SELECT * FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)
    }).toEqual(beforeQueueRead)
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', messages: [expect.objectContaining({ content: 'legacy body' })] })
    expect(clearNextSessionMessageContentBatch(db, session.id)).toMatchObject({ status: 'ineligible', cleanedMessageCount: 0 })
    expect(conn.prepare('SELECT content FROM messages WHERE id=?').get('legacy-required-message')).toEqual({ content: 'legacy body' })
    expect(conn.prepare('SELECT status,reason FROM session_projection_migration_items WHERE run_id=? AND session_id=?').get(run.runId, session.id))
      .toEqual({ status: 'legacy_required', reason: 'field-not-eligible' })
    db.close()
  })

  it('keeps internal hidden History out of the user legacy queue and rejects a corrupted internal queue row', async () => {
    const db = createMemoryAppDb()
    const product = createSession(db, { name: 'legacy product session', model: 'test' })
    appendMessage(db, { id: 'scope-legacy-product-message', sessionId: product.id, role: 'system', content: 'legacy body', timestamp: 1, status: 'sent' })
    const internalWithHistory = createSession(db, { name: 'private audit', model: 'test', ownership: 'internal', visibility: 'hidden' })
    const internalEmpty = createSession(db, { name: 'private empty', model: 'test', ownership: 'internal', visibility: 'hidden' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, internalWithHistory.id).appendBatch([{
      invocationId: 'private-legacy-audit', turnId: 'private-audit-turn', sequence: 1, schemaVersion: 1,
      eventId: 'private-audit-context', idempotencyKey: 'private-audit-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'private-audit-message', role: 'user', content: 'audit only', timestamp: 2 }] }
    }], 0)
    const inventory = buildSessionProjectionMigrationInventory(db)
    expect(inventory.counts.legacy_required).toBe(1)
    expect(inventory.excludedInternalHiddenSessionCount).toBe(2)
    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-scope-legacy-queue', now: 10 })

    expect(listLegacyRequiredSessionProjections(db, run.runId)).toMatchObject({
      censusCount: 1, queuedCensusCount: 1, baselineMigratedCensusCount: 0, discoveredDuringMigrationCount: 0, reconciled: true,
      items: [expect.objectContaining({ sessionId: product.id, decision: 'retain-legacy' })]
    })
    const conn = getDbConnection(db)
    for (const internal of [internalWithHistory, internalEmpty]) {
      conn.prepare(`INSERT INTO session_projection_migration_items(run_id,session_id,session_generation,source_disposition,status,reason,
        updated_at,legacy_owner,legacy_decision,legacy_user_behavior,legacy_user_message_zh,legacy_user_message_en,legacy_decided_at)
        VALUES(?,?,NULL,'deleted','legacy_required','tampered-scope',11,'session-storage-refactor-maintainers','retain-legacy',
        'legacy-reader-retain-source','继续使用兼容读取','Use legacy reader',11)`).run(run.runId, internal.id)
    }

    expect(() => listLegacyRequiredSessionProjections(db, run.runId)).toThrow('legacy-required queue contains a session outside migration scope')
    db.close()
  })

  it('records eligible sessions that become legacy-required during migration as additional explained queue entries', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'new-legacy-required-session', model: 'test' })
    const message = { id: 'newly-legacy-user', role: 'user' as const, content: 'body', timestamp: 1 }
    appendMessage(db, { ...message, sessionId: session.id, status: 'sent' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'newly-legacy-invocation', turnId: 'newly-legacy-turn', sequence: 1, schemaVersion: 1,
      eventId: 'newly-legacy-context', idempotencyKey: 'newly-legacy-context', kind: 'invocation-context-committed', payload: { messages: [message] }
    }], 0)
    getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    const inventory = buildSessionProjectionMigrationInventory(db)
    expect(inventory.counts.projection_eligible).toBe(1)
    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-new-legacy', now: 10 })
    vi.spyOn(projectionModule, 'readSessionTranscriptProjection').mockReturnValue({ source: 'legacy', messages: [], reason: 'message-identity-mismatch' })
    await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 1, rateLimitMs: 0, now: 11 })
    vi.restoreAllMocks()

    const report = listLegacyRequiredSessionProjections(db, run.runId)
    expect(report).toMatchObject({ censusCount: 0, queuedCensusCount: 0, discoveredDuringMigrationCount: 1, reconciled: true })
    expect(report.items).toEqual([expect.objectContaining({
      sessionId: session.id,
      sourceDisposition: 'projection_eligible',
      reason: 'message-identity-mismatch',
      decision: 'retain-legacy',
      userBehavior: 'legacy-reader-retain-source'
    })])
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get(message.id)).toEqual({ content: 'body' })
    db.close()
  })
})
