import { describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { computeLegacyProjectionDigest, getProjectionRejection } from './sessionProjectionRejection'
import { runDueSessionProjectionRevalidations } from './sessionProjectionRevalidation'
import { enqueueSessionProjectionRevalidation } from './sessionProjectionRevalidationQueue'
import { readSessionTranscriptProjection, refreshSessionTranscriptProjectionCache } from './sessionTranscriptProjection'

/** Build a mismatched session: legacy holds [A, B] while canonical History folds to [A]. */
async function createMismatchedSession(label: string) {
  const db = createMemoryAppDb()
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
    const second = await createMismatchedSession('budget-b')
    readSessionTranscriptProjection(db, sessionA.id)
    readSessionTranscriptProjection(second.db, second.session.id)
    enqueueSessionProjectionRevalidation(db, sessionA.id)
    enqueueSessionProjectionRevalidation(db, second.session.id)

    const later = Date.now() + 60_000
    const result = await runDueSessionProjectionRevalidations(db, { maxSessions: 1, now: later })

    expect(result.revalidated).toBe(1)
    expect(result.deferred).toBe(1)
    expect(await runDueSessionProjectionRevalidations(db, { now: later })).toMatchObject({ revalidated: 1 })
    db.close()
    second.db.close()
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
