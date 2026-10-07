import { describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection, openSqliteDatabase } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { buildSessionProjectionMigrationInventory } from './sessionProjectionMigrationInventory'
import { auditSessionProjectionMigration } from './sessionProjectionConsistencyAudit'
import * as projectionModule from './sessionTranscriptProjection'
import { readSessionTranscriptProjection } from './sessionTranscriptProjection'
import { resolveImSession } from '../remote/imSessionResolver'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import {
  getSessionProjectionMigrationRun,
  listLegacyRequiredSessionProjections,
  pauseSessionProjectionMigration,
  resumeSessionProjectionMigration,
  runSessionProjectionMigrationBatch,
  runEligibleSessionProjectionMigration,
  startSessionProjectionMigration
} from './sessionProjectionMigration'

async function addEligibleSession(db: ReturnType<typeof createMemoryAppDb>, name: string,
  scope: Partial<Parameters<typeof createSession>[1]> = {}) {
  const session = createSession(db, { name, model: 'test', ...scope })
  const message = { id: `user-${name}`, role: 'user' as const, content: `body-${name}`, timestamp: 1 }
  appendMessage(db, { ...message, sessionId: session.id, status: 'sent' })
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
    invocationId: `inv-${name}`, turnId: `turn-${name}`, sequence: 1, schemaVersion: 1,
    eventId: `ctx-${name}`, idempotencyKey: `ctx-${name}`, kind: 'invocation-context-committed', payload: { messages: [message] }
  }], 0)
  getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
  return session
}

function connHasRow(db: ReturnType<typeof createMemoryAppDb>, table: string, sessionId: string): boolean {
  const safeTable = table === 'canonical_session_projection_cache' || table === 'canonical_session_projection_eligibility'
    ? table : (() => { throw new Error(`unexpected table ${table}`) })()
  return getDbConnection(db).prepare(`SELECT 1 FROM ${safeTable} WHERE session_id=?`).get(sessionId) !== undefined
}

async function appendSessionContext(db: ReturnType<typeof createMemoryAppDb>, sessionId: string, message: { id: string; role: 'user'; content: string; timestamp: number }) {
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).appendBatch([{
    invocationId: `runtime-scope-${sessionId}`, turnId: `turn-${sessionId}`, sequence: 1, schemaVersion: 1,
    eventId: `context-${sessionId}`, idempotencyKey: `context-${sessionId}`, kind: 'invocation-context-committed',
    payload: { messages: [message] }
  }], 0)
}

describe('session projection migration worker', () => {
  it('rejects unbounded batches', async () => {
    const db = createMemoryAppDb()
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-limit', now: 1 })
    await expect(runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 101, rateLimitMs: 0 })).rejects.toThrow('batchSize')
    db.close()
  })

  it('seeds history-absent role-compatible bodies but retains system-role sessions in the legacy queue', async () => {
    const db = createMemoryAppDb()
    const compatible = createSession(db, { name: 'baseline-compatible', model: 'test' })
    appendMessage(db, { id: 'baseline-compatible-user', sessionId: compatible.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'baseline-compatible-assistant', sessionId: compatible.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed',
      toolCalls: [{ id: 'baseline-tool', toolName: 'search', input: { q: 'x' }, status: 'completed', riskLevel: 'low' }] })
    const unsupported = createSession(db, { name: 'baseline-system', model: 'test' })
    appendMessage(db, { id: 'baseline-system-message', sessionId: unsupported.id, role: 'system', content: 'system text', timestamp: 1, status: 'sent' })

    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-legacy-baseline', now: 10 })
    const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 11 })

    expect(result).toMatchObject({ status: 'completed', processedCount: 1, successCount: 1, skippedCount: 0,
      outcomes: [expect.objectContaining({ sessionId: compatible.id, status: 'migrated', outcome: 'success' })] })
    expect(readSessionTranscriptProjection(db, compatible.id).source).toBe('canonical:L1')
    expect(getDbConnection(db).prepare('SELECT kind FROM agent_history_events WHERE session_id=?').get(compatible.id)).toMatchObject({ kind: 'invocation-context-committed' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(unsupported.id)).toMatchObject({ count: 0 })
    expect(getDbConnection(db).prepare('SELECT status,reason FROM session_projection_migration_items WHERE run_id=? AND session_id=?')
      .get(run.runId, unsupported.id)).toMatchObject({ status: 'legacy_required', reason: 'field-not-eligible' })
    expect(auditSessionProjectionMigration(db, run.runId)).toMatchObject({ complete: true,
      legacyCensusCount: 2, legacyQueuedCount: 1, legacyBaselineMigratedCount: 1, legacyQueueReconciled: true,
      sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: compatible.id, status: 'consistent', migrationStatus: 'migrated' }),
        expect.objectContaining({ sessionId: unsupported.id, status: 'legacy_exception', migrationStatus: 'legacy_required' })
      ]) })
    expect(listLegacyRequiredSessionProjections(db, run.runId)).toMatchObject({ censusCount: 2, queuedCensusCount: 1,
      baselineMigratedCensusCount: 1, reconciled: true, items: [expect.objectContaining({ sessionId: unsupported.id })] })
    db.close()
  })

  it('resumes after canonical baseline commit when the first projection certification fails', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'baseline commit then reader failure', model: 'test' })
    appendMessage(db, { id: 'baseline-retry-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-baseline-retry', now: 10 })
    const originalRead = projectionModule.readSessionTranscriptProjection
    let failOnce = true
    vi.spyOn(projectionModule, 'readSessionTranscriptProjection').mockImplementation((targetDb, targetSessionId) => {
      if (failOnce && targetSessionId === session.id) {
        failOnce = false
        throw new Error('injected post-commit projection certification failure')
      }
      return originalRead(targetDb, targetSessionId)
    })

    const first = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 1, rateLimitMs: 0, now: 11 })
    expect(first).toMatchObject({ status: 'needs_retry', failureCount: 1, outcomes: [expect.objectContaining({ status: 'retry' })] })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 1 })
    expect(getDbConnection(db).prepare('SELECT status FROM session_projection_migration_items WHERE run_id=? AND session_id=?')
      .get(run.runId, session.id)).toMatchObject({ status: 'retry' })

    const second = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 1, rateLimitMs: 0, now: 12 })
    vi.restoreAllMocks()
    expect(second).toMatchObject({ status: 'completed', successCount: 1, outcomes: [expect.objectContaining({ status: 'migrated' })] })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE session_id=?').get(session.id)).toMatchObject({ count: 1 })
    expect(auditSessionProjectionMigration(db, run.runId)).toMatchObject({ complete: true, consistentCount: 1, legacyQueueReconciled: true })
    db.close()
  })

  it('rejects inventory made stale by a local connection write', async () => {
    const db = createMemoryAppDb()
    const inventory = buildSessionProjectionMigrationInventory(db)
    createSession(db, { name: 'after-census', model: 'test' })
    expect(() => startSessionProjectionMigration(db, inventory, { runId: 'run-stale', now: 1 })).toThrow('inventory is stale')
    db.close()
  })

  it('rejects a stale file-backed census after another connection creates or deletes a session', () => {
    const temp = createTempDatabase('projection-migration-concurrent-scope-')
    const retained = createSession(temp.db, { name: 'retained for concurrent delete', model: 'test' })
    const inventory = buildSessionProjectionMigrationInventory(temp.db)
    const concurrent = openSqliteDatabase(temp.dbPath)
    const concurrentConnection = getDbConnection(concurrent)
    concurrentConnection.prepare('DELETE FROM sessions WHERE id=?').run(retained.id)
    concurrentConnection.prepare(`INSERT INTO sessions(id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,
      generation,ownership,visibility) VALUES('concurrent-new','concurrent new','test',0.7,1000,1,1,'{}','{}',1,'generation-new','user','primary')`).run()

    expect(() => startSessionProjectionMigration(temp.db, inventory, { runId: 'run-concurrent-scope', now: 1 }))
      .toThrow('inventory is stale')
    concurrent.close()
    temp.cleanup()
  })

  it('fences a run when a queued product session changes to internal hidden before worker execution', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'scope-changed-before-worker')
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-scope-changed', now: 1 })
    const conn = getDbConnection(db)
    conn.prepare("UPDATE sessions SET ownership='internal',visibility='hidden' WHERE id=?").run(session.id)
    const reader = vi.spyOn(projectionModule, 'readSessionTranscriptProjection')

    try {
      const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 2 })

      expect(result).toMatchObject({ processedCount: 0, failureCount: 0, status: 'needs_attention' })
      expect(reader).not.toHaveBeenCalled()
      expect(conn.prepare('SELECT * FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
      expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id)).toBeUndefined()
      expect(conn.prepare('SELECT status,error,attempts FROM session_projection_migration_items WHERE run_id=? AND session_id=?')
        .get(run.runId, session.id)).toMatchObject({ status: 'pending', error: 'session-scope-changed:internal/hidden', attempts: 0 })
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  })

  it('atomically fences canonical reads, cache writes, and eligibility against a scope change during certification', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'scope-changes-during-certification')
    const conn = getDbConnection(db)
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-scope-during-certify', now: 1 })
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    const originalRead = projectionModule.readSessionTranscriptProjection
    const reader = vi.spyOn(projectionModule, 'readSessionTranscriptProjection').mockImplementation((targetDb, sessionId) => {
      conn.prepare("UPDATE sessions SET ownership='internal',visibility='hidden' WHERE id=?").run(sessionId)
      return originalRead(targetDb, sessionId)
    })

    try {
      const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 1, rateLimitMs: 0, now: 2 })

      expect(result).toMatchObject({ status: 'needs_attention', processedCount: 1, failureCount: 1,
        outcomes: [expect.objectContaining({ sessionId: session.id, status: 'retry', reason: 'session-scope-changed-during-certification' })] })
      expect(conn.prepare('SELECT ownership,visibility FROM sessions WHERE id=?').get(session.id)).toEqual({ ownership: 'user', visibility: 'primary' })
      expect(conn.prepare('SELECT 1 FROM canonical_session_projection_cache WHERE session_id=? AND cache_key=?').get(session.id, 'transcript')).toBeUndefined()
      expect(conn.prepare('SELECT 1 FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id)).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  })

  it('ignores internal hidden sessions created after a run census without reporting migration failures', async () => {
    const db = createMemoryAppDb()
    const product = await addEligibleSession(db, 'scope-frozen-product')
    const inventory = buildSessionProjectionMigrationInventory(db)
    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-scope-frozen', now: 1 })
    const internalWithHistory = createSession(db, { name: 'new approval audit', ownership: 'internal', visibility: 'hidden' })
    await appendSessionContext(db, internalWithHistory.id, { id: 'new-internal-audit', role: 'user', content: 'private', timestamp: 2 })
    const internalEmpty = createSession(db, { name: 'new empty internal', ownership: 'internal', visibility: 'hidden' })
    const internalProjectionRows = new Map([internalWithHistory, internalEmpty].map(({ id }) => [id, {
      eligibility: connHasRow(db, 'canonical_session_projection_eligibility', id),
      cache: connHasRow(db, 'canonical_session_projection_cache', id)
    }]))
    const reader = vi.spyOn(projectionModule, 'readSessionTranscriptProjection')

    try {
      const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 3 })

      expect(result).toMatchObject({ processedCount: 1, successCount: 1, failureCount: 0, status: 'completed' })
      expect(result.outcomes.map(({ sessionId }) => sessionId)).toEqual([product.id])
      expect(reader).toHaveBeenCalledTimes(1)
      expect(reader).not.toHaveBeenCalledWith(db, internalWithHistory.id)
      expect(reader).not.toHaveBeenCalledWith(db, internalEmpty.id)
      for (const internal of [internalWithHistory, internalEmpty]) {
        expect({
          eligibility: connHasRow(db, 'canonical_session_projection_eligibility', internal.id),
          cache: connHasRow(db, 'canonical_session_projection_cache', internal.id)
        }).toEqual(internalProjectionRows.get(internal.id))
      }
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  })

  it('backfills history-absent remote IM and automation sessions without changing product routing metadata', async () => {
    const db = createMemoryAppDb()
    const remote = createSession(db, { name: 'scope-worker-remote', model: 'test',
      ownership: 'remote', visibility: 'primary', metadata: {
        source: 'feishu', feishuChatId: 'chat-worker', feishuMessageId: 'old-message', remoteSessionLastActivityAt: Date.now()
      }
    })
    appendMessage(db, { id: 'scope-worker-remote-user', sessionId: remote.id, role: 'user', content: 'remote body', timestamp: 1, status: 'sent' })
    const automation = createSession(db, { name: 'scope-worker-automation', model: 'test', ownership: 'automation', visibility: 'section' })
    appendMessage(db, { id: 'scope-worker-automation-user', sessionId: automation.id, role: 'user', content: 'automation body', timestamp: 1, status: 'sent' })
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-scoped-worker', now: 1 })
    const beforeMetadata = new Map([remote, automation].map(({ id }) => [id,
      getDbConnection(db).prepare('SELECT ownership,visibility,metadata FROM sessions WHERE id=?').get(id)]))

    const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 2 })

    expect(result).toMatchObject({ processedCount: 2, successCount: 2, failureCount: 0, status: 'completed' })
    expect(result.outcomes.map(({ sessionId }) => sessionId)).toEqual(expect.arrayContaining([remote.id, automation.id]))
    for (const session of [remote, automation]) {
      expect(getDbConnection(db).prepare('SELECT ownership,visibility,metadata FROM sessions WHERE id=?').get(session.id))
        .toEqual(beforeMetadata.get(session.id))
      expect(getDbConnection(db).prepare('SELECT session_generation FROM canonical_session_projection_eligibility WHERE session_id=?')
        .get(session.id)).toMatchObject({ session_generation: session.generation })
    }
    const resolver = await resolveImSession({
      sessionQueries: createSqliteSessionStorage(db).queries, config: { remoteSessionIdleMinutes: 10 }, defaultModel: 'test', channel: 'feishu', identityKey: 'chat-worker',
      getIdentityFromSession: (session) => (session.metadata as { feishuChatId?: string }).feishuChatId,
      createNew: async () => { throw new Error('expected the existing IM session to be reused') },
      onReuse: () => undefined
    })
    expect(resolver).toEqual({ sessionId: remote.id, isNew: false })
    db.close()
  })

  it('persists inventory and migrates only the requested bounded batch idempotently', async () => {
    const db = createMemoryAppDb()
    const first = await addEligibleSession(db, 'batch-first')
    const second = await addEligibleSession(db, 'batch-second')
    const inventory = buildSessionProjectionMigrationInventory(db)
    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-bounded', now: 10 })
    expect(startSessionProjectionMigration(db, inventory, { runId: 'run-bounded', now: 11 })).toEqual(run)
    const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 1, rateLimitMs: 0, now: 12 })
    expect(result).toMatchObject({ processedCount: 1, successCount: 1, failureCount: 0, skippedCount: 0, status: 'running',
      outcomes: [expect.objectContaining({ sessionId: expect.any(String), outcome: 'success', status: 'migrated' })] })
    expect(result.status).toBe('running')
    expect(getSessionProjectionMigrationRun(db, run.runId)).toMatchObject({ migratedCount: 1, cursor: expect.any(String) })
    const secondResult = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 13 })
    expect(secondResult).toMatchObject({ processedCount: 1, status: 'completed', migratedCount: 2 })
    const conn = getDbConnection(db)
    expect(conn.prepare("SELECT COUNT(*) AS count FROM canonical_session_projection_cache WHERE cache_key='transcript'").get()).toMatchObject({ count: 2 })
    expect(readSessionTranscriptProjection(db, first.id)).toMatchObject({ source: expect.stringMatching(/^canonical:/), messages: [expect.objectContaining({ id: 'user-batch-first', content: 'body-batch-first' })] })
    expect([first.id, second.id]).toContain(getSessionProjectionMigrationRun(db, run.runId).cursor)
    db.close()
  })

  it('persists internal exclusion and History health summary as part of the durable inventory identity', async () => {
    const temp = createTempDatabase('projection-migration-scope-summary-')
    const db = temp.db
    const user = createSession(db, { name: 'scope user', model: 'test' })
    const remote = createSession(db, { name: 'scope remote', model: 'test', ownership: 'remote', visibility: 'primary' })
    const automation = createSession(db, { name: 'scope automation', model: 'test', ownership: 'automation', visibility: 'section' })
    const internal = createSession(db, { name: 'private approval audit', ownership: 'internal', visibility: 'hidden' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, internal.id).appendBatch([{
      invocationId: `inv-${internal.id}`, turnId: `turn-${internal.id}`, sequence: 1, schemaVersion: 1,
      eventId: `ctx-${internal.id}`, idempotencyKey: `ctx-${internal.id}`, kind: 'invocation-context-committed',
      payload: { messages: [{ id: `audit-${internal.id}`, role: 'user', content: 'private', timestamp: 1 }] }
    }], 0)
    const inventory = buildSessionProjectionMigrationInventory(db)

    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-scope-summary', now: 20 })
    expect(run).toMatchObject({
      databaseSessionCount: 4,
      migrationSessionCount: 3,
      excludedInternalHiddenSessionCount: 1,
      internalHistory: { sessionCount: 1, withHistoryCount: 1, healthyCount: 1, unhealthyCount: 0 },
      internalHistorySha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(run.totalCount).toBe(3)
    const itemSessionIds = getDbConnection(db).prepare('SELECT session_id FROM session_projection_migration_items WHERE run_id=? ORDER BY session_id')
      .all(run.runId).map(({ session_id }) => session_id)
    expect(itemSessionIds).toEqual(expect.arrayContaining([user.id, remote.id, automation.id]))
    expect(getDbConnection(db).prepare('SELECT 1 AS found FROM session_projection_migration_items WHERE run_id=? AND session_id=?')
      .get(run.runId, internal.id)).toBeUndefined()
    const persisted = getDbConnection(db).prepare(`SELECT database_session_count,migration_session_count,
      excluded_internal_hidden_session_count,internal_history_session_count,internal_history_with_events_count,
      internal_history_healthy_count,internal_history_sha256
      FROM session_projection_migration_runs WHERE run_id=?`).get(run.runId)
    expect(persisted).toEqual({
      database_session_count: 4, migration_session_count: 3, excluded_internal_hidden_session_count: 1,
      internal_history_session_count: 1, internal_history_with_events_count: 1, internal_history_healthy_count: 1,
      internal_history_sha256: run.internalHistorySha256
    })

    db.close()
    const reopened = openSqliteDatabase(temp.dbPath)
    expect(getSessionProjectionMigrationRun(reopened, run.runId)).toEqual(run)

    const modified = { ...inventory, internalHistorySha256: 'f'.repeat(64) }
    expect(() => startSessionProjectionMigration(reopened, modified, { runId: run.runId, now: 21 }))
      .toThrow('run ID already belongs to a different migration inventory')
    reopened.close()
    temp.cleanup()
  })

  it('executes all eligible inventory entries in bounded batches and returns per-session outcomes', async () => {
    const db = createMemoryAppDb()
    const first = await addEligibleSession(db, 'orchestrated-first')
    const second = await addEligibleSession(db, 'orchestrated-second')
    const legacy = createSession(db, { name: 'orchestrated-legacy', model: 'test' })
    appendMessage(db, { id: 'legacy-only-body', sessionId: legacy.id, role: 'user', content: 'legacy', timestamp: 1, status: 'sent' })
    const report = await runEligibleSessionProjectionMigration(db, { runId: 'run-orchestrated', batchSize: 1, rateLimitMs: 0, now: 10 })
    expect(report).toMatchObject({ batchCount: 3, processedCount: 3, successCount: 3, failureCount: 0, skippedCount: 0,
      run: { status: 'completed', migratedCount: 3, legacyRequiredCount: 0 } })
    expect(report.outcomes.map(({ sessionId, outcome }) => ({ sessionId, outcome }))).toEqual(expect.arrayContaining([
      { sessionId: first.id, outcome: 'success' }, { sessionId: second.id, outcome: 'success' }
    ]))
    db.close()
  })

  it('returns while another worker holds an unexpired item lease', async () => {
    const db = createMemoryAppDb()
    const session = await addEligibleSession(db, 'leased-session')
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-leased', now: 1 })
    getDbConnection(db).prepare("UPDATE session_projection_migration_items SET status='processing',lease_owner='other',lease_until=5000 WHERE run_id=? AND session_id=?")
      .run(run.runId, session.id)
    const report = await runEligibleSessionProjectionMigration(db, { runId: run.runId, batchSize: 1, rateLimitMs: 0, now: 2 })
    expect(report).toMatchObject({ batchCount: 1, processedCount: 0, run: { status: 'running' } })
    db.close()
  })

  it('defers active sessions and continues processing later eligible sessions', async () => {
    const db = createMemoryAppDb()
    const active = await addEligibleSession(db, 'active-session')
    const healthy = await addEligibleSession(db, 'healthy-session')
    const assistant = createSession(db, { name: 'turn-message-owner', model: 'test' })
    appendMessage(db, { id: 'active-assistant', sessionId: assistant.id, role: 'assistant', content: '', timestamp: 1, status: 'streaming' })
    getDbConnection(db).prepare(`INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?, ?, ?, ?, 'running',1,1)`).run('active-turn', 'active-request', active.id, 'active-assistant')
    const run = startSessionProjectionMigration(db, buildSessionProjectionMigrationInventory(db), { runId: 'run-active', now: 1 })
    const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 2 })
    expect(result).toMatchObject({ processedCount: 3, successCount: 1, failureCount: 0, skippedCount: 2, migratedCount: 1, deferredCount: 2,
      status: 'needs_retry', outcomes: expect.arrayContaining([
        expect.objectContaining({ sessionId: active.id, outcome: 'skipped', reason: 'active-turn-or-queue' }),
        expect.objectContaining({ sessionId: assistant.id, outcome: 'skipped', reason: 'active-turn-or-queue' })
      ]) })
    expect(getDbConnection(db).prepare("SELECT 1 AS ok FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(active.id)).toBeUndefined()
    expect(getDbConnection(db).prepare("SELECT 1 AS ok FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(healthy.id)).toMatchObject({ ok: 1 })
    db.close()
  })

  it('isolates per-session projection errors and continues the batch', async () => {
    const db = createMemoryAppDb()
    const broken = await addEligibleSession(db, 'a-broken')
    const healthy = await addEligibleSession(db, 'b-healthy')
    const inventory = buildSessionProjectionMigrationInventory(db)
    const run = startSessionProjectionMigration(db, inventory, { runId: 'run-isolated', now: 1 })
    const originalRead = projectionModule.readSessionTranscriptProjection
    vi.spyOn(projectionModule, 'readSessionTranscriptProjection').mockImplementation((targetDb, sessionId) => {
      if (sessionId === broken.id) throw new Error('injected projection failure')
      return originalRead(targetDb, sessionId)
    })
    const result = await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 2 })
    expect(result).toMatchObject({ processedCount: 2, successCount: 1, failureCount: 1, skippedCount: 0, migratedCount: 1, retryCount: 1,
      status: 'needs_retry', outcomes: expect.arrayContaining([expect.objectContaining({ sessionId: broken.id, outcome: 'failure', error: 'injected projection failure' })]) })
    expect(getDbConnection(db).prepare("SELECT 1 AS ok FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(healthy.id)).toMatchObject({ ok: 1 })
    vi.restoreAllMocks()
    expect(await runSessionProjectionMigrationBatch(db, run.runId, { batchSize: 10, rateLimitMs: 0, now: 3 }))
      .toMatchObject({ processedCount: 1, migratedCount: 2, retryCount: 0, status: 'completed' })
    db.close()
  })

  it('supports durable pause and resume across database reopen', async () => {
    const temp = createTempDatabase('projection-migration-resume-')
    const session = await addEligibleSession(temp.db, 'pause-session')
    const run = startSessionProjectionMigration(temp.db, buildSessionProjectionMigrationInventory(temp.db), { runId: 'run-pause', now: 1 })
    expect(pauseSessionProjectionMigration(temp.db, run.runId, 2)).toMatchObject({ status: 'paused' })
    temp.db.close()
    const reopened = openSqliteDatabase(temp.dbPath)
    expect(await runSessionProjectionMigrationBatch(reopened, run.runId, { batchSize: 1, rateLimitMs: 0, now: 3 })).toMatchObject({ processedCount: 0, status: 'paused' })
    expect(resumeSessionProjectionMigration(reopened, run.runId, 4)).toMatchObject({
      databaseSessionCount: 1, migrationSessionCount: 1, excludedInternalHiddenSessionCount: 0,
      internalHistory: { sessionCount: 0, withHistoryCount: 0, healthyCount: 0, unhealthyCount: 0 },
      internalHistorySha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(await runSessionProjectionMigrationBatch(reopened, run.runId, { batchSize: 1, rateLimitMs: 0, now: 5 })).toMatchObject({ migratedCount: 1, status: 'completed' })
    expect(getDbConnection(reopened).prepare("SELECT 1 AS ok FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").get(session.id)).toMatchObject({ ok: 1 })
    reopened.close()
    temp.cleanup()
  })
})
