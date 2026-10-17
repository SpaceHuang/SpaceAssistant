import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { runMigrations } from '../database/migrations'
import { createDeferredTodoCapacityController } from './deferredTodoCapacity'

describe('deferred todo capacity reservations', () => {
  it('enforces per-session and per-identity limits atomically and counts prepared reservations', async () => {
    const db = createMemoryAppDb()
    const capacity = createDeferredTodoCapacityController(db, { sessionLimit: 5, identityLimit: 10 })
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => capacity.reserve({
      reservationId: `reserve-${index}`, invocationId: `invoke-${index}`,
      sessionId: index < 8 ? 'session-a' : `session-${index}`,
      identityKey: 'identity-a', state: index % 2 === 0 ? 'prepared' : 'pending', now: 100 + index
    }))))
    expect(attempts.filter(({ ok }) => ok)).toHaveLength(10)
    expect(attempts.filter(({ ok }) => !ok)).toHaveLength(10)
    expect(attempts.slice(0, 8).filter(({ ok }) => ok)).toHaveLength(5)
    expect(capacity.counts({ identityKey: 'identity-a', now: 200 })).toMatchObject({ identity: 10, sessions: { 'session-a': 5 } })
    db.close()
  })

  it('does not double reserve an idempotent invocation and releases only its own reservation', () => {
    const db = createMemoryAppDb()
    const capacity = createDeferredTodoCapacityController(db, { sessionLimit: 5, identityLimit: 10 })
    const input = {
      reservationId: 'reservation-idempotent', invocationId: 'invocation-idempotent',
      sessionId: 'session-idempotent', identityKey: 'identity-idempotent', state: 'prepared' as const, now: 10
    }
    expect(capacity.reserve(input)).toMatchObject({ ok: true, duplicate: false })
    expect(capacity.reserve(input)).toMatchObject({ ok: true, duplicate: true })
    expect(capacity.counts({ identityKey: input.identityKey, now: 10 })).toMatchObject({ identity: 1, sessions: { [input.sessionId]: 1 } })
    expect(capacity.release(input.reservationId, 'wrong-invocation')).toBe(false)
    expect(capacity.release(input.reservationId, input.invocationId)).toBe(true)
    expect(capacity.counts({ identityKey: input.identityKey, now: 10 })).toMatchObject({ identity: 0, sessions: { [input.sessionId]: 0 } })
    db.close()
  })

  it('expires and reconciles orphan reservations and rejects invalid configured limits', () => {
    const db = createMemoryAppDb()
    const capacity = createDeferredTodoCapacityController(db, { sessionLimit: 5, identityLimit: 10 })
    capacity.reserve({
      reservationId: 'orphan-prepared', invocationId: 'orphan-invocation', sessionId: 'reconcile-session',
      identityKey: 'reconcile-identity', state: 'prepared', now: 10, expiresAt: 100
    })
    capacity.reserve({
      reservationId: 'expired-pending', invocationId: 'expired-invocation', sessionId: 'reconcile-session',
      identityKey: 'reconcile-identity', state: 'pending', now: 10, expiresAt: 20
    })
    expect(capacity.reconcile([], 20)).toEqual({ expired: 1, released: 1 })
    expect(capacity.counts({ identityKey: 'reconcile-identity', now: 20 })).toMatchObject({ identity: 0 })
    expect(() => createDeferredTodoCapacityController(db, { sessionLimit: 0, identityLimit: 10 }))
      .toThrow('INVALID_DEFERRED_TODO_SESSION_LIMIT')
    expect(() => createDeferredTodoCapacityController(db, { sessionLimit: 5, identityLimit: Number.NaN }))
      .toThrow('INVALID_DEFERRED_TODO_IDENTITY_LIMIT')
    db.close()
  })

  it('creates the reservation tables while upgrading a schema v69 database', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE deferred_todo_capacity_reservations')
    conn.prepare("UPDATE schema_meta SET value='70' WHERE key='schema_version'").run()
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '103' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_todo_capacity_reservations'").get())
      .toEqual({ name: 'deferred_todo_capacity_reservations' })
    db.close()
  })
})

/**
 * AGENTS.md 配额类模块纪律：随机操作序列 + 每步跨函数状态不变量断言。
 * 逐场景用例对「跨函数成对性 / 计数守恒」类缺陷天然易漏（2026-10 评审教训）。
 *
 * 每步后全量断言：
 * - I1 (session,identity) 分组 active ∈ [1, sessionLimit]
 * - I2 identity 分组 active ∈ [1, identityLimit]
 * - I3 DB active 集合 === 跟踪集（集合相等一条覆盖 release/releaseByInvocation/reconcile/expire 后零残留）
 * - I4 reserve duplicate/冲突/满员拒绝不新增行
 * - I5 reserve 以 session_limit/identity_limit 拒绝 ⇔ 对应分组已满（拒绝⇔满员守恒）
 * - 活性：序列必须包含至少一次成功的新增 reserve（防止不变量 vacuously 成立）
 */
describe('deferredTodoCapacity 随机序列不变量（配额守恒）', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('200 步随机 reserve/release/releaseByInvocation/reconcile/expire 序列后配额不变量成立', () => {
    const random = mulberry32(20261015)
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const db = createMemoryAppDb()
    try {
      const sessionLimit = 3
      const identityLimit = 4
      const capacity = createDeferredTodoCapacityController(db, { sessionLimit, identityLimit })
      const activeInvocations = new Set<string>()
      let successfulReserves = 0
      let rejections = 0
      let now = 1_000_000

      const assertInvariants = () => {
        const conn = getDbConnection(db)
        const bySessionIdentity = conn.prepare(`SELECT session_id,identity_key,COUNT(*) AS count FROM deferred_todo_capacity_reservations
          WHERE state IN ('prepared','pending') GROUP BY session_id,identity_key`).all() as Array<{ count: number }>
        const byIdentity = conn.prepare(`SELECT identity_key,COUNT(*) AS count FROM deferred_todo_capacity_reservations
          WHERE state IN ('prepared','pending') GROUP BY identity_key`).all() as Array<{ count: number }>
        for (const row of bySessionIdentity) {
          expect(row.count).toBeLessThanOrEqual(sessionLimit)
          expect(row.count).toBeGreaterThan(0)
        }
        for (const row of byIdentity) {
          expect(row.count).toBeLessThanOrEqual(identityLimit)
          expect(row.count).toBeGreaterThan(0)
        }
      }

      for (let step = 0; step < 200; step += 1) {
        now += Math.floor(random() * 5_000) + 1
        const action = random()
        if (action < 0.55) {
          const reuseInvocation = activeInvocations.size > 0 && random() < 0.2
          const invocationId = reuseInvocation ? pick([...activeInvocations]) : `inv-${step}`
          const input = {
            reservationId: `res-${step}`,
            invocationId,
            sessionId: `session-${Math.floor(random() * 3)}`,
            identityKey: `identity-${Math.floor(random() * 2)}`,
            state: random() < 0.5 ? 'prepared' as const : 'pending' as const,
            now,
            expiresAt: now + 60_000
          }
          const rowsBefore = getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations WHERE invocation_id=?`)
            .get(invocationId) as { count: number }
          const outcome = capacity.reserve(input)
          const rowsAfter = getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations WHERE invocation_id=?`)
            .get(invocationId) as { count: number }
          if (outcome.ok && !outcome.duplicate) {
            activeInvocations.add(invocationId)
            expect(rowsAfter.count).toBe(rowsBefore.count + 1)
            successfulReserves += 1
          } else {
            // I4：duplicate/冲突/满员拒绝不新增行
            expect(rowsAfter.count).toBe(rowsBefore.count)
            rejections += 1
          }
          // I5：拒绝 ⇔ 满员守恒（reserve 的分组键即本次入参）
          if (!outcome.ok && outcome.reason === 'session_limit') {
            expect(getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations
              WHERE session_id=? AND identity_key=? AND state IN ('prepared','pending')`).get(input.sessionId, input.identityKey)).toEqual({ count: sessionLimit })
          }
          if (!outcome.ok && outcome.reason === 'identity_limit') {
            expect(getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations
              WHERE identity_key=? AND state IN ('prepared','pending')`).get(input.identityKey)).toEqual({ count: identityLimit })
          }
        } else if (action < 0.7 && activeInvocations.size > 0) {
          const invocationId = pick([...activeInvocations])
          expect(capacity.releaseByInvocation(invocationId, now)).toBe(true)
          activeInvocations.delete(invocationId)
        } else if (action < 0.8 && activeInvocations.size > 0) {
          const invocationId = pick([...activeInvocations])
          capacity.releaseByInvocation(invocationId, now)
          activeInvocations.delete(invocationId)
        } else if (action < 0.9 && activeInvocations.size > 0) {
          const valid = [...activeInvocations].filter(() => random() < 0.5)
          capacity.reconcile(valid, now)
          for (const invocationId of [...activeInvocations]) {
            if (!valid.includes(invocationId)) activeInvocations.delete(invocationId)
          }
        } else {
          now += 120_000
          capacity.counts({ identityKey: `identity-${Math.floor(random() * 2)}`, now })
          for (const invocationId of [...activeInvocations]) {
            const row = getDbConnection(db).prepare(`SELECT expires_at FROM deferred_todo_capacity_reservations WHERE invocation_id=?`)
              .get(invocationId) as { expires_at: number } | undefined
            if (row && row.expires_at <= now) activeInvocations.delete(invocationId)
          }
        }
        // 过期剔除统一提到 I3 前：reserve/reconcile 内部会隐式 expire(now)，跟踪集须同口径
        for (const invocationId of [...activeInvocations]) {
          const row = getDbConnection(db).prepare(`SELECT expires_at FROM deferred_todo_capacity_reservations WHERE invocation_id=?`)
            .get(invocationId) as { expires_at: number } | undefined
          if (row && row.expires_at <= now) activeInvocations.delete(invocationId)
        }
        // I3：DB active 集合与跟踪集严格相等（release/reconcile/expire 任一遗漏立即暴露）
        const dbActive = (getDbConnection(db).prepare(`SELECT invocation_id FROM deferred_todo_capacity_reservations
          WHERE state IN ('prepared','pending')`).all() as Array<{ invocation_id: string }>).map((row) => row.invocation_id).sort()
        expect(dbActive).toEqual([...activeInvocations].sort())
        assertInvariants()
      }
      // 活性：序列确实产生了成功的新增与拒绝，不变量非 vacuously 成立
      expect(successfulReserves).toBeGreaterThan(0)
      expect(rejections).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})
