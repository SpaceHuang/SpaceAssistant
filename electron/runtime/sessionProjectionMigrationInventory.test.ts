import { describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection, openSqliteDatabaseReadOnly } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { buildSessionProjectionMigrationInventory, classifySessionProjectionMigrationScope, SessionProjectionMigrationInventoryError } from './sessionProjectionMigrationInventory'

async function appendCanonicalContext(db: ReturnType<typeof createMemoryAppDb>, sessionId: string,
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>): Promise<void> {
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).appendBatch([{
    invocationId: `inventory-${sessionId}`, turnId: `turn-${sessionId}`, sequence: 1, schemaVersion: 1,
    eventId: `context-${sessionId}`, idempotencyKey: `context-${sessionId}`, kind: 'invocation-context-committed',
    payload: { messages }
  }], 0)
}

describe('session projection migration inventory', () => {
  it('allows only the explicitly approved ownership and visibility pairs', () => {
    expect(classifySessionProjectionMigrationScope('user', 'primary')).toBe('product')
    expect(classifySessionProjectionMigrationScope('remote', 'primary')).toBe('product')
    expect(classifySessionProjectionMigrationScope('automation', 'section')).toBe('product')
    expect(classifySessionProjectionMigrationScope('internal', 'hidden')).toBe('internal-hidden')

    for (const ownership of ['user', 'remote', 'automation']) {
      for (const visibility of ['primary', 'section']) {
        const approved = (ownership === 'user' && visibility === 'primary') ||
          (ownership === 'remote' && visibility === 'primary') ||
          (ownership === 'automation' && visibility === 'section')
        if (!approved) expect(classifySessionProjectionMigrationScope(ownership, visibility)).toBe('unknown')
      }
    }
    expect(classifySessionProjectionMigrationScope('internal', 'primary')).toBe('unknown')
    expect(classifySessionProjectionMigrationScope('internal', 'section')).toBe('unknown')
    expect(classifySessionProjectionMigrationScope('user', 'hidden')).toBe('unknown')
  })

  it('classifies all current sessions from one read snapshot and reconciles removed IDs', async () => {
    const db = createMemoryAppDb()
    const migrated = createSession(db, { name: 'already projected empty session', model: 'test' })
    const eligible = createSession(db, { name: 'legacy session with canonical coverage', model: 'test' })
    appendMessage(db, { id: 'inventory-user', sessionId: eligible.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    appendMessage(db, { id: 'inventory-assistant', sessionId: eligible.id, role: 'assistant', content: 'answer', timestamp: 2, status: 'completed' })
    await appendCanonicalContext(db, eligible.id, [
      { id: 'inventory-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'inventory-assistant', role: 'assistant', content: 'answer', timestamp: 2 }
    ])
    const legacy = createSession(db, { name: 'legacy-only session', model: 'test' })
    appendMessage(db, { id: 'inventory-legacy-user', sessionId: legacy.id, role: 'user', content: 'old body', timestamp: 1, status: 'sent' })

    const inventory = buildSessionProjectionMigrationInventory(db, { knownSessionIds: [migrated.id, eligible.id, legacy.id, 'deleted-before-scan'] })

    expect(inventory.databaseSessionCount).toBe(3)
    expect(inventory.dataVersion).toEqual(expect.any(Number))
    expect(inventory.classifiedSessionCount).toBe(4)
    expect(inventory.counts).toEqual({ projection_migrated: 1, projection_eligible: 1, legacy_required: 1, deleted: 1 })
    expect(inventory.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: migrated.id, disposition: 'projection_migrated' }),
      expect.objectContaining({ sessionId: eligible.id, sessionGeneration: expect.any(String), disposition: 'projection_eligible' }),
      expect.objectContaining({ sessionId: legacy.id, sessionGeneration: expect.any(String), disposition: 'legacy_required', reason: 'history-absent' }),
      expect.objectContaining({ sessionId: 'deleted-before-scan', disposition: 'deleted' })
    ]))
    db.close()
  })

  it('distinguishes legacy-only history absence from a conflicting canonical transcript', async () => {
    const db = createMemoryAppDb()
    const legacyOnly = createSession(db, { name: 'legacy-only without canonical rows', model: 'test' })
    appendMessage(db, { id: 'legacy-only-message', sessionId: legacyOnly.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    const absentInventory = buildSessionProjectionMigrationInventory(db)
    expect(absentInventory.sessions).toContainEqual(expect.objectContaining({
      sessionId: legacyOnly.id, disposition: 'legacy_required', reason: 'history-absent'
    }))

    const conflicting = createSession(db, { name: 'canonical conflicts with legacy', model: 'test' })
    appendMessage(db, { id: 'conflicting-message', sessionId: conflicting.id, role: 'user', content: 'legacy body', timestamp: 1, status: 'sent' })
    await appendCanonicalContext(db, conflicting.id, [{
      id: 'conflicting-message', role: 'user', content: 'different canonical body', timestamp: 1
    }])
    getDbConnection(db).prepare('UPDATE messages SET content=? WHERE id=?').run('legacy body', 'conflicting-message')
    const conflictInventory = buildSessionProjectionMigrationInventory(db)
    expect(conflictInventory.sessions).toContainEqual(expect.objectContaining({
      sessionId: conflicting.id, disposition: 'legacy_required', reason: 'legacy-mismatch'
    }))
    db.close()
  })

  it('does not seed caches, grant eligibility, or change cutover state while classifying', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'read only inventory', model: 'test' })
    appendMessage(db, { id: 'inventory-read-only-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await appendCanonicalContext(db, session.id, [{ id: 'inventory-read-only-user', role: 'user', content: 'question', timestamp: 1 }])
    const conn = getDbConnection(db)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)
    conn.prepare('DELETE FROM canonical_session_projection_eligibility WHERE session_id=?').run(session.id)
    const before = {
      caches: conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache WHERE session_id=?').get(session.id),
      eligibility: conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id),
      cutover: conn.prepare('SELECT * FROM session_message_content_cutover WHERE session_id=?').get(session.id)
    }

    expect(buildSessionProjectionMigrationInventory(db).counts.projection_eligible).toBe(1)
    expect({
      caches: conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache WHERE session_id=?').get(session.id),
      eligibility: conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_eligibility WHERE session_id=?').get(session.id),
      cutover: conn.prepare('SELECT * FROM session_message_content_cutover WHERE session_id=?').get(session.id)
    }).toEqual(before)
    db.close()
  })

  it('classifies canonical-backed-only sessions from History without requiring legacy bodies', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'canonical-only migration candidate', model: 'test' })
    appendMessage(db, { id: 'inventory-canonical-only-user', sessionId: session.id, role: 'user', content: 'canonical body', timestamp: 1, status: 'sent' })
    await appendCanonicalContext(db, session.id, [{ id: 'inventory-canonical-only-user', role: 'user', content: 'canonical body', timestamp: 1 }])
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'").run(session.id)

    expect(buildSessionProjectionMigrationInventory(db)).toMatchObject({
      databaseSessionCount: 1,
      counts: { projection_eligible: 1 }
    })
    db.close()
  })

  it('refuses to call damaged canonical-backed data a safe legacy fallback', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'damaged canonical inventory', model: 'test' })
    appendMessage(db, { id: 'inventory-canonical-user', sessionId: session.id, role: 'user', content: 'question', timestamp: 1, status: 'sent' })
    await appendCanonicalContext(db, session.id, [{ id: 'inventory-canonical-user', role: 'user', content: 'question', timestamp: 1 }])
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
    conn.prepare("UPDATE agent_history_events SET payload_json=? WHERE event_id=?").run(
      JSON.stringify({ messages: [{ id: 'wrong-owner-message', role: 'user', content: 'question', timestamp: 1 }] }),
      `context-${session.id}`
    )

    expect(() => buildSessionProjectionMigrationInventory(db)).toThrowError(
      expect.objectContaining<Partial<SessionProjectionMigrationInventoryError>>({
        name: 'SessionProjectionMigrationInventoryError',
        sessionId: session.id,
        reason: 'canonical History does not match message skeletons'
      })
    )
    db.close()
  })

  it('excludes only internal hidden sessions while reporting their History health and retaining product cohorts', async () => {
    const db = createMemoryAppDb()
    const internalWithHistory = createSession(db, { name: 'approval audit', ownership: 'internal', visibility: 'hidden' })
    const internalEmpty = createSession(db, { name: 'empty internal', ownership: 'internal', visibility: 'hidden' })
    await appendCanonicalContext(db, internalWithHistory.id, [{
      id: 'approval-audit-user', role: 'user', content: 'private audit clue', timestamp: 1
    }])
    const user = createSession(db, { name: 'parent user' })
    const remote = createSession(db, { name: 'IM session', ownership: 'remote', visibility: 'primary', metadata: {
      source: 'feishu', feishuChatId: 'chat-1'
    } })
    const automation = createSession(db, { name: 'automation session', ownership: 'automation', visibility: 'section' })
    for (const session of [user, remote, automation]) {
    appendMessage(db, { id: `message-${session.id}`, sessionId: session.id, role: 'user', content: 'prompt', timestamp: 2, status: 'sent' })
    }
    await appendCanonicalContext(db, user.id, [{ id: `message-${user.id}`, role: 'user', content: 'prompt', timestamp: 2 }])
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, user.id).appendBatch([
      { invocationId: `inventory-${user.id}`, turnId: `turn-${user.id}`, sequence: 2, schemaVersion: 1,
        eventId: `approval-wait-${user.id}`, idempotencyKey: `approval-wait-${user.id}`, kind: 'approval-waiting',
        payload: { approvalId: `approval-${user.id}`, answerer: 'user', reasonCode: 'confirm', requestedAt: 3 } },
      { invocationId: `inventory-${user.id}`, turnId: `turn-${user.id}`, sequence: 3, schemaVersion: 1,
        eventId: `approval-result-${user.id}`, idempotencyKey: `approval-result-${user.id}`, kind: 'approval-resolved',
        payload: { approvalId: `approval-${user.id}`, approved: true, outcome: 'approved', settledAt: 4 } },
      { invocationId: `inventory-${user.id}`, turnId: `turn-${user.id}`, sequence: 4, schemaVersion: 1,
        eventId: `terminal-${user.id}`, idempotencyKey: `terminal-${user.id}`, kind: 'invocation-completed', payload: { status: 'completed' } }
    ], 1)
    await appendCanonicalContext(db, remote.id, [{ id: `message-${remote.id}`, role: 'user', content: 'prompt', timestamp: 2 }])
    await appendCanonicalContext(db, automation.id, [{ id: `message-${automation.id}`, role: 'user', content: 'prompt', timestamp: 2 }])
    const conn = getDbConnection(db)
    const beforeChanges = (conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n

    const inventory = buildSessionProjectionMigrationInventory(db, {
      knownSessionIds: [internalWithHistory.id, internalEmpty.id, user.id, remote.id, automation.id, 'deleted-product-session']
    })

    expect(inventory.databaseSessionCount).toBe(5)
    expect(inventory.migrationSessionCount).toBe(3)
    expect(inventory.excludedInternalHiddenSessionCount).toBe(2)
    expect(inventory.internalHistory).toMatchObject({ sessionCount: 2, withHistoryCount: 1, healthyCount: 1, unhealthyCount: 0 })
    expect(inventory.classifiedSessionCount).toBe(4)
    expect(inventory.counts).toEqual({ projection_migrated: 0, projection_eligible: 3, legacy_required: 0, deleted: 1 })
    expect(inventory.sessions.map(({ sessionId }) => sessionId)).not.toContain(internalWithHistory.id)
    expect(inventory.sessions.map(({ sessionId }) => sessionId)).not.toContain(internalEmpty.id)
    expect(inventory.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: user.id, disposition: 'projection_eligible' }),
      expect.objectContaining({ sessionId: remote.id, disposition: 'projection_eligible' }),
      expect.objectContaining({ sessionId: automation.id, disposition: 'projection_eligible' }),
      expect.objectContaining({ sessionId: 'deleted-product-session', disposition: 'deleted' })
    ]))
    expect(conn.prepare('SELECT ownership,visibility,metadata FROM sessions WHERE id=?').get(remote.id)).toMatchObject({
      ownership: 'remote', visibility: 'primary', metadata: JSON.stringify({ source: 'feishu', feishuChatId: 'chat-1' })
    })
    expect((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(beforeChanges)
    db.close()
  })

  it('fails closed when an internal hidden History transcript is damaged', async () => {
    const db = createMemoryAppDb()
    const internal = createSession(db, { name: 'damaged approval audit', ownership: 'internal', visibility: 'hidden' })
    await appendCanonicalContext(db, internal.id, [{ id: 'private-id', role: 'user', content: 'audit', timestamp: 1 }])
    const conn = getDbConnection(db)
    conn.prepare('DROP TRIGGER invalidate_canonical_transcript_cache_after_history_event_update').run()
    conn.prepare('DROP TRIGGER invalidate_session_api_eligibility_after_history_event_update').run()
    conn.prepare('DROP TRIGGER track_pending_history_cursor_allocation').run()
    conn.prepare('DROP TRIGGER settle_pending_history_cursor_allocation').run()
    conn.prepare('DROP TRIGGER invalidate_session_projections_after_history_cursor_update').run()
    conn.prepare('DROP TRIGGER invalidate_session_projections_after_history_cursor_delete').run()
    conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?').run(
      JSON.stringify({ messages: [{ id: 'different-private-id', role: 'user', content: 'audit', timestamp: 1 }] }),
      `context-${internal.id}`
    )
    conn.prepare('UPDATE agent_history_commit_cursor SET allocated_at=allocated_at+1 WHERE id=1').run()
    conn.prepare('UPDATE agent_history_streams SET version=version+1 WHERE invocation_id=?').run(`inventory-${internal.id}`)

    expect(() => buildSessionProjectionMigrationInventory(db)).toThrowError(
      expect.objectContaining<Partial<SessionProjectionMigrationInventoryError>>({
        name: 'SessionProjectionMigrationInventoryError', sessionId: internal.id,
        reason: 'internal History integrity check failed'
      })
    )
    db.close()
  })

  it('binds the internal History digest to every canonical event, including audit-only lifecycle facts', async () => {
    const db = createMemoryAppDb()
    const internal = createSession(db, { name: 'audit lifecycle', ownership: 'internal', visibility: 'hidden' })
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, internal.id).appendBatch([
      { invocationId: `audit-${internal.id}`, turnId: 'audit-turn', sequence: 1, schemaVersion: 1,
        eventId: 'audit-start', idempotencyKey: 'audit-start', kind: 'invocation-context-committed',
        payload: { messages: [{ id: 'audit-visible', role: 'user', content: 'same folded transcript', timestamp: 1 }] } },
      { invocationId: `audit-${internal.id}`, turnId: 'audit-turn', sequence: 2, schemaVersion: 1,
        eventId: 'audit-tool', idempotencyKey: 'audit-tool', kind: 'approval-waiting',
        payload: { approvalId: 'approval', answerer: 'agent', reasonCode: 'original', requestedAt: 2 } }
    ], 0)
    const before = buildSessionProjectionMigrationInventory(db)
    const conn = getDbConnection(db)
    for (const trigger of [
      'invalidate_canonical_transcript_cache_after_history_event_update',
      'invalidate_session_api_eligibility_after_history_event_update',
      'track_pending_history_cursor_allocation', 'settle_pending_history_cursor_allocation',
      'invalidate_session_projections_after_history_cursor_update', 'invalidate_session_projections_after_history_cursor_delete'
    ]) conn.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run()
    conn.prepare('UPDATE agent_history_events SET payload_json=? WHERE event_id=?').run(
      JSON.stringify({ approvalId: 'approval', answerer: 'agent', reasonCode: 'changed-audit-reason', requestedAt: 2 }), 'audit-tool'
    )

    const after = buildSessionProjectionMigrationInventory(db)
    expect(after.internalHistorySha256).not.toBe(before.internalHistorySha256)
    db.close()
  })

  it('rejects events whose owning stream and event session disagree instead of reporting empty internal history', async () => {
    const db = createMemoryAppDb()
    const internal = createSession(db, { name: 'mismatched audit ownership', ownership: 'internal', visibility: 'hidden' })
    await appendCanonicalContext(db, internal.id, [{ id: 'private', role: 'user', content: 'audit', timestamp: 1 }])
    const conn = getDbConnection(db)
    conn.prepare('DROP TRIGGER IF EXISTS invalidate_canonical_transcript_cache_after_history_event_update').run()
    conn.prepare('DROP TRIGGER IF EXISTS invalidate_session_api_eligibility_after_history_event_update').run()
    conn.prepare('DROP TRIGGER IF EXISTS track_pending_history_cursor_allocation').run()
    conn.prepare('DROP TRIGGER IF EXISTS settle_pending_history_cursor_allocation').run()
    conn.prepare('DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_update').run()
    conn.prepare('DROP TRIGGER IF EXISTS invalidate_session_projections_after_history_cursor_delete').run()
    conn.prepare('UPDATE agent_history_events SET session_id=? WHERE event_id=?').run('foreign-session', `context-${internal.id}`)

    expect(() => buildSessionProjectionMigrationInventory(db)).toThrowError(
      expect.objectContaining<Partial<SessionProjectionMigrationInventoryError>>({
        name: 'SessionProjectionMigrationInventoryError', sessionId: internal.id,
        reason: 'internal History ownership does not match its session event ledger'
      })
    )
    db.close()
  })

  it('fails closed for unknown ownership or visibility instead of guessing migration scope', () => {
    const db = createMemoryAppDb()
    const unknownOwner = createSession(db, { name: 'unknown owner' })
    getDbConnection(db).prepare("UPDATE sessions SET ownership='mystery' WHERE id=?").run(unknownOwner.id)

    expect(() => buildSessionProjectionMigrationInventory(db)).toThrowError(
      expect.objectContaining<Partial<SessionProjectionMigrationInventoryError>>({
        name: 'SessionProjectionMigrationInventoryError', sessionId: unknownOwner.id,
        reason: 'session migration scope is unknown (mystery/primary)'
      })
    )
    db.close()
  })

  it('runs the scope census through a read-only SQLite connection without changing the database', async () => {
    const temp = createTempDatabase('projection-inventory-read-only-')
    const product = createSession(temp.db, { name: 'read-only product' })
    const internal = createSession(temp.db, { name: 'read-only internal', ownership: 'internal', visibility: 'hidden' })
    await appendCanonicalContext(temp.db, internal.id, [{ id: 'read-only-audit', role: 'user', content: 'private', timestamp: 1 }])
    temp.db.close()
    const readOnly = openSqliteDatabaseReadOnly(temp.dbPath)
    const conn = getDbConnection(readOnly)
    const before = Number((conn.prepare('SELECT total_changes() AS total_changes').get() as { total_changes: number }).total_changes)

    const inventory = buildSessionProjectionMigrationInventory(readOnly)

    expect(inventory).toMatchObject({ databaseSessionCount: 2, migrationSessionCount: 1,
      excludedInternalHiddenSessionCount: 1, internalHistory: { sessionCount: 1, withHistoryCount: 1, healthyCount: 1, unhealthyCount: 0 } })
    expect(inventory.sessions.map(({ sessionId }) => sessionId)).toEqual([product.id])
    expect(Number((conn.prepare('SELECT total_changes() AS total_changes').get() as { total_changes: number }).total_changes)).toBe(before)
    expect(() => conn.prepare('UPDATE sessions SET name=name WHERE id=?').run(product.id)).toThrow(/readonly/i)
    readOnly.close()
    temp.cleanup()
  })
})
