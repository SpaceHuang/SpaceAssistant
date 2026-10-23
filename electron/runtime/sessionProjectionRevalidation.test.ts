import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase as openPersistentDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { computeLegacyProjectionDigest, getProjectionRejection, listProjectionRejectionWork, markProjectionRejectionStale } from './sessionProjectionRejection'
import { runDueSessionProjectionRevalidations } from './sessionProjectionRevalidation'
import { enqueueSessionProjectionRevalidation } from './sessionProjectionRevalidationQueue'
import { publishTranscriptParityProof, readLegacyProjectionMessages, refreshValidatedProjectionFastPath, validateAndCacheCanonicalProjection } from '../sessionStorage/infrastructure/sqlite/sessionProjectionRevalidationFacts'
import { hasSessionProjectionEligibility } from './sessionTranscriptProjection'
import { readSessionTranscriptProjection, refreshSessionTranscriptProjectionCache } from './sessionTranscriptProjection'
import { encodeProjectionScopeKey } from '../sessionStorage/domain/scopeKey'

/** Build a mismatched session: legacy holds [A, B] while canonical History folds to [A]. */
async function createMismatchedSession(label: string, db = createMemoryAppDb()) {
  const session = createSession(db, { name: `${label} revalidation`, model: 'test' })
  const conn = getDbConnection(db)
  appendMessage(db, { id: `${label}-user-a`, sessionId: session.id, role: 'user', content: 'legacy-a', timestamp: 1, status: 'sent' })
  appendMessage(db, { id: `${label}-user-b`, sessionId: session.id, role: 'user', content: 'legacy-b', timestamp: 2, status: 'sent' })
  const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
  await history.appendBatch([{
    invocationId: `${label}-invocation`, turnId: `${label}-turn`, sequence: 1, schemaVersion: 1,
    eventId: `${label}-context`, idempotencyKey: `${label}-context`, kind: 'invocation-context-committed',
    payload: { messages: [{ id: `${label}-user-a`, role: 'user', content: 'legacy-a', timestamp: 1 }] }
  }], 0)
  return { db, conn, session, history }
}

describe('background projection revalidation queue (P0-③/④)', () => {
  it('reads legacy projection messages through the SQLite facts adapter', async () => {
    const { db, session } = await createMismatchedSession('facts-adapter')
    expect(readLegacyProjectionMessages(db, session.id)).toEqual([
      expect.objectContaining({ id: 'facts-adapter-user-a', role: 'user', content: 'legacy-a' }),
      expect.objectContaining({ id: 'facts-adapter-user-b', role: 'user', content: 'legacy-b' })
    ])
    db.close()
  })

  it('does not publish projection eligibility from generation alone', async () => {
    const { db, session } = await createMismatchedSession('eligibility-adapter')
    const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    getDbConnection(db).prepare(`INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,updated_at)
      VALUES(?,?,?,'invalid',1)`).run(session.id, scopeKey, session.generation)
    expect(hasSessionProjectionEligibility(db, session.id)).toBe(false)
    expect(hasSessionProjectionEligibility(db, session.id)).toBe(false)
    db.close()
  })

  it('uses a matched parity proof in the fast path without requiring the legacy transcript cache', async () => {
    const { db, session, history } = await createMismatchedSession('fast-path-adapter')
    expect(refreshValidatedProjectionFastPath(db, session.id)).toBe(false)
    getDbConnection(db).prepare("DELETE FROM messages WHERE id='fast-path-adapter-user-b'").run()
    const verified = history.readCanonicalSessionTranscript(session.id, [
      { id: 'fast-path-adapter-user-a', role: 'user', content: 'legacy-a', timestamp: 1 }
    ])
    expect(verified.kind).toBe('matched')
    if (verified.kind === 'matched') {
      expect(history.writeCanonicalSessionCache({ ...verified, cacheKey: 'transcript', value: JSON.stringify(verified.messages) })).toBe(true)
      expect(publishTranscriptParityProof(db, session.id, verified, computeLegacyProjectionDigest([
        { id: 'fast-path-adapter-user-a', role: 'user', content: 'legacy-a', timestamp: 1 }
      ]))).toBe(true)
    }
    getDbConnection(db).prepare("DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'")
      .run(session.id)
    expect(refreshValidatedProjectionFastPath(db, session.id)).toBe(true)
    db.close()
  })

  it('validates and caches canonical transcript through the SQLite facts adapter', async () => {
    const { db, session } = await createMismatchedSession('validate-cache-adapter')
    const legacyMessages = readLegacyProjectionMessages(db, session.id)
    const mismatch = validateAndCacheCanonicalProjection(db, session.id, legacyMessages.map(({ id, role, content, timestamp }) => ({
      id, role: role as 'user' | 'assistant', content, timestamp
    })))
    expect(mismatch.verified).toMatchObject({ kind: 'unavailable', reason: 'legacy-mismatch' })
    expect(mismatch.cacheWritten).toBe(false)

    getDbConnection(db).prepare("DELETE FROM messages WHERE id='validate-cache-adapter-user-b'").run()
    const matched = validateAndCacheCanonicalProjection(db, session.id, readLegacyProjectionMessages(db, session.id))
    expect(matched.verified.kind).toBe('matched')
    expect(matched.cacheWritten).toBe(true)
    db.close()
  })

  it('clears the persisted verdict and restores eligibility when a revalidation matches', async () => {
    const { db, session } = await createMismatchedSession('recover')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')

    // 移除多余 legacy 行使 canonical 与 legacy 一致：下次读发现 O(1) 元数据/摘要变化 → verdict
    // 失效（stale 登记），读路径立即 legacy；恢复由后台重验驱动，不经读路径同步等待。
    getDbConnection(db).prepare("DELETE FROM messages WHERE id='recover-user-b'").run()
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })
    expect(await runDueSessionProjectionRevalidations(db)).toMatchObject({ revalidated: 1 })

    expect(getProjectionRejection(db, session.id)).toBeUndefined()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')
    db.close()
  })

  it('records the canonical fingerprint and backs off when a revalidation still mismatches', async () => {
    const { db, session } = await createMismatchedSession('backoff')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const first = getProjectionRejection(db, session.id)
    expect(first?.attempts).toBe(1)

    enqueueSessionProjectionRevalidation(db, session.id)
    await runDueSessionProjectionRevalidations(db, { now: Date.now() + 60_000 })

    const after = getProjectionRejection(db, session.id)
    expect(after?.attempts).toBe(2)
    expect(after?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(after?.retryAfter).toBeGreaterThan(first?.retryAfter ?? 0)
    expect(after?.staleMetadata).toBe(false)
    db.close()
  })

  it('marks a session permanent after repeated revalidations of an unchanged fingerprint', async () => {
    const { db, session } = await createMismatchedSession('permanent')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const before = Date.now()

    const t0 = Date.now()
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      enqueueSessionProjectionRevalidation(db, session.id)
      await runDueSessionProjectionRevalidations(db, { now: t0 + attempt * 300_000 })
    }

    const rejection = getProjectionRejection(db, session.id)
    expect(rejection?.permanent).toBe(true)
    expect((rejection?.retryAfter ?? 0) - before).toBeGreaterThanOrEqual(6.5 * 24 * 60 * 60 * 1000)
    db.close()
  })

  it('does not re-run a queued session twice before its revalidation completes', async () => {
    const { db, session } = await createMismatchedSession('dedupe')
    readSessionTranscriptProjection(db, session.id)

    // 内容变化使两次读都登记 stale 重验；队列按会话折叠成一次执行。
    getDbConnection(db).prepare("UPDATE messages SET content='dedupe-updated' WHERE id='dedupe-user-a'").run()
    readSessionTranscriptProjection(db, session.id)
    readSessionTranscriptProjection(db, session.id)
    expect(await runDueSessionProjectionRevalidations(db)).toMatchObject({ revalidated: 1 })

    // 一次运行后队列已消费；未再次登记时下轮无事可做。
    expect(await runDueSessionProjectionRevalidations(db)).toMatchObject({ revalidated: 0 })
    db.close()
  })

  it('respects the per-run session budget and defers the rest', async () => {
    const { db, session: sessionA } = await createMismatchedSession('budget-a')
    const conn = getDbConnection(db)
    // 同库第二个 mismatch 会话（enqueue 与重验都必须落在同一数据库上下文内）。
    const sessionB = createSession(db, { name: 'budget-b', model: 'test' })
    conn.prepare(`INSERT INTO messages(id, session_id, role, content, status, schema_version, timestamp, sequence) VALUES('budget-b-user', ?, 'user', 'legacy-a', 'sent', 1, 1, 1)`).run(sessionB.id)
    conn.prepare(`INSERT INTO messages(id, session_id, role, content, status, schema_version, timestamp, sequence) VALUES('budget-b-user-2', ?, 'user', 'legacy-b', 'sent', 1, 2, 2)`).run(sessionB.id)
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES('budget-b-invocation', 1, 1, ?)`).run(sessionB.id)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id, commit_order, session_seq)
      VALUES('budget-b-invocation', 1, 'budget-b-ctx', 'budget-b-ctx', 'budget-b-turn', 1, 'invocation-context-committed', ?, 1, ?, 500, 1)`)
      .run(JSON.stringify({ messages: [{ id: 'budget-b-user', role: 'user', content: 'legacy-a', timestamp: 1 }] }), sessionB.id)
    enqueueSessionProjectionRevalidation(db, sessionA.id)
    enqueueSessionProjectionRevalidation(db, sessionB.id)

    const later = Date.now() + 60_000
    const result = await runDueSessionProjectionRevalidations(db, { maxSessions: 1, now: later })

    expect(result.revalidated).toBe(1)
    expect(result.deferred).toBe(1)
    expect(await runDueSessionProjectionRevalidations(db, { now: later })).toMatchObject({ revalidated: 1 })
    db.close()
  })

  it('enqueues a stale verdict from the read path instead of revalidating synchronously', async () => {
    const { db, session } = await createMismatchedSession('stale-enqueue')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')

    // 新输入使 O(1) 元数据变化：读路径立即 legacy，重验延迟到后台队列。
    appendMessage(db, { id: 'stale-enqueue-user-c', sessionId: session.id, role: 'user', content: 'legacy-c', timestamp: 3, status: 'sent' })
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })

    const result = await runDueSessionProjectionRevalidations(db)
    expect(result.revalidated).toBe(1)
    expect(getProjectionRejection(db, session.id)?.attempts).toBe(2)
    db.close()
  })

  it('revalidates through the terminal checkpoint path when a turn ends on a mismatched session', async () => {
    const { db, session } = await createMismatchedSession('checkpoint')
    expect(refreshSessionTranscriptProjectionCache(db, session.id)).toBe(false)
    expect(getProjectionRejection(db, session.id)?.attempts).toBe(1)

    // 终态检查点失败必须登记后台重验（每轮至多一次），退避到期后执行，下一轮读不再重付全款。
    expect(await runDueSessionProjectionRevalidations(db, { now: Date.now() + 60_000 })).toMatchObject({ revalidated: 1 })
    expect(getProjectionRejection(db, session.id)?.attempts).toBe(2)
    db.close()
  })

  it('computes a stable canonical fingerprint that changes when events change', async () => {
    const { db, session } = await createMismatchedSession('fingerprint')
    const { computeCanonicalProjectionFingerprint } = await import('./sessionProjectionRevalidation')
    const before = computeCanonicalProjectionFingerprint(db, session.id)
    expect(before).toMatch(/^[a-f0-9]{64}$/)
    expect(before).toBe(computeCanonicalProjectionFingerprint(db, session.id))

    appendMessage(db, { id: 'fingerprint-user-x', sessionId: session.id, role: 'user', content: 'more', timestamp: 9, status: 'sent' })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'fingerprint-invocation-2', turnId: 'fingerprint-turn-2', sequence: 1, schemaVersion: 1,
      eventId: 'fingerprint-context-2', idempotencyKey: 'fingerprint-context-2', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'fingerprint-user-x', role: 'user', content: 'more', timestamp: 9 }] }
    }], 0)
    expect(computeCanonicalProjectionFingerprint(db, session.id)).not.toBe(before)
    db.close()
  })

  it('clears a verdict whose session no longer holds projection-eligible roles', async () => {
    const { db, session } = await createMismatchedSession('roles')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    expect(getProjectionRejection(db, session.id)).toBeDefined()

    getDbConnection(db).prepare("UPDATE messages SET role='system' WHERE id='roles-user-a'").run()
    enqueueSessionProjectionRevalidation(db, session.id, { stale: true })
    await runDueSessionProjectionRevalidations(db)

    expect(getProjectionRejection(db, session.id)).toBeUndefined()
    db.close()
  })

  it('exposes the legacy digest contract used by read-path keying', async () => {
    const { db, session } = await createMismatchedSession('digest')
    readSessionTranscriptProjection(db, session.id)
    const rejection = getProjectionRejection(db, session.id)
    const { getMessages } = await import('../database/operations')
    expect(rejection?.legacyDigest).toBe(computeLegacyProjectionDigest(getMessages(db, session.id)))
    db.close()
  })
})

describe('production revalidation drain (review S1/S2)', () => {
  it('queries only due or stale rejection work and respects the per-tick batch limit', async () => {
    const { db, session: first } = await createMismatchedSession('bounded-first')
    const { session: second } = await createMismatchedSession('bounded-second', db)
    const { session: third } = await createMismatchedSession('bounded-third', db)
    readSessionTranscriptProjection(db, first.id)
    readSessionTranscriptProjection(db, second.id)
    readSessionTranscriptProjection(db, third.id)
    const firstRejection = getProjectionRejection(db, first.id)!
    markProjectionRejectionStale(db, second.id)

    expect(listProjectionRejectionWork(db, firstRejection.retryAfter - 1, 1)).toEqual([{ sessionId: second.id, stale: true }])
    const due = listProjectionRejectionWork(db, firstRejection.retryAfter + 1, 1)
    expect(due).toHaveLength(1)
    expect([first.id, second.id, third.id]).toContain(due[0]?.sessionId)
    db.close()
  })

  it('restores persisted rejection work after reopen and consumes it only when its backoff expires', async () => {
    const temp = createTempDatabase('projection-revalidation-reopen-')
    let db = temp.db
    const { session } = await createMismatchedSession('reopen-drain', db)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const persisted = getProjectionRejection(db, session.id)!
    db.close()
    db = openPersistentDatabase(temp.dbPath)

    const { startSessionProjectionRevalidationDrain } = await import('./sessionProjectionRevalidation')
    let now = persisted.retryAfter - 1
    const handle = startSessionProjectionRevalidationDrain(db, 5, () => now)
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(getProjectionRejection(db, session.id)?.attempts).toBe(1)
      now = persisted.retryAfter + 1
      await vi.waitFor(() => expect(getProjectionRejection(db, session.id)?.attempts).toBe(2), { timeout: 100 })
    } finally {
      handle.stop()
      db.close()
      await fs.rm(path.dirname(temp.dbPath), { recursive: true, force: true })
    }
  })

  it('consumes already-due persisted rejection work immediately after startup', async () => {
    const temp = createTempDatabase('projection-revalidation-startup-due-')
    let db = temp.db
    const { session } = await createMismatchedSession('startup-due', db)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const rejection = getProjectionRejection(db, session.id)!
    db.close()
    db = openPersistentDatabase(temp.dbPath)

    const { startSessionProjectionRevalidationDrain } = await import('./sessionProjectionRevalidation')
    const handle = startSessionProjectionRevalidationDrain(db, 60_000, () => rejection.retryAfter + 1)
    try {
      await vi.waitFor(() => expect(getProjectionRejection(db, session.id)?.attempts).toBe(2), { timeout: 200 })
    } finally {
      handle.stop()
      db.close()
      await fs.rm(path.dirname(temp.dbPath), { recursive: true, force: true })
    }
  })

  it('restores stale rejection metadata as immediate work after reopen', async () => {
    const temp = createTempDatabase('projection-revalidation-stale-reopen-')
    let db = temp.db
    const { session } = await createMismatchedSession('stale-reopen-drain', db)
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    const rejection = getProjectionRejection(db, session.id)!
    markProjectionRejectionStale(db, session.id)
    db.close()
    db = openPersistentDatabase(temp.dbPath)

    const { startSessionProjectionRevalidationDrain } = await import('./sessionProjectionRevalidation')
    const handle = startSessionProjectionRevalidationDrain(db, 5, () => rejection.retryAfter - 1)
    try {
      await vi.waitFor(() => expect(getProjectionRejection(db, session.id)?.attempts).toBe(2), { timeout: 100 })
      expect(getProjectionRejection(db, session.id)?.staleMetadata).toBe(false)
    } finally {
      handle.stop()
      db.close()
      await fs.rm(path.dirname(temp.dbPath), { recursive: true, force: true })
    }
  })

  it('recovers a healed session through the resident drain without anyone calling runDue directly', async () => {
    const { startSessionProjectionRevalidationDrain } = await import('./sessionProjectionRevalidation')
    const { db, session } = await createMismatchedSession('resident')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')

    // 修复 legacy 正文使下次全量对比 matched；恢复只依赖常驻 drain（评审 S1）。
    getDbConnection(db).prepare("DELETE FROM messages WHERE id='resident-user-b'").run()
    expect(readSessionTranscriptProjection(db, session.id)).toMatchObject({ source: 'legacy', reason: 'projection-rejected' })

    const handle = startSessionProjectionRevalidationDrain(db, 10)
    await new Promise((resolve) => setTimeout(resolve, 80))
    handle.stop()

    expect(getProjectionRejection(db, session.id)).toBeUndefined()
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('canonical:L1')
    db.close()
  })

  it('keeps backoff-skipped entries queued for a later drain (review S2)', async () => {
    const { db, session } = await createMismatchedSession('skipped')
    expect(readSessionTranscriptProjection(db, session.id).source).toBe('legacy')
    // 例行登记（退避未到期）后 drain：条目不得被丢弃。
    enqueueSessionProjectionRevalidation(db, session.id)
    const first = await runDueSessionProjectionRevalidations(db)
    expect(first.skipped).toBe(1)
    // 退避到期后的下一次 drain 必须仍能消费到它（自愈/永久化路径可达）。
    const second = await runDueSessionProjectionRevalidations(db, { now: Date.now() + 60_000 })
    expect(second.revalidated).toBe(1)
    expect(getProjectionRejection(db, session.id)?.attempts).toBe(2)
    db.close()
  })
})
