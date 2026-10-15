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
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '95' })
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
 * - I3 release/releaseByInvocation 成功后该 invocation 无 active 行
 * - I4 reserve duplicate:true 不新增行
 * - I5 reconcile 后不在 valid 集的 invocation 无 active 行
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

  it('200 步随机 reserve/activate/release/releaseByInvocation/reconcile/expire 序列后配额不变量成立', () => {
    const random = mulberry32(20261015)
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const db = createMemoryAppDb()
    try {
      const sessionLimit = 3
      const identityLimit = 4
      const capacity = createDeferredTodoCapacityController(db, { sessionLimit, identityLimit })
      const activeInvocations = new Set<string>()
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
          const rowsBefore = getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations WHERE invocation_id=?`)
            .get(invocationId) as { count: number }
          const outcome = capacity.reserve({
            reservationId: `res-${step}`,
            invocationId,
            sessionId: `session-${Math.floor(random() * 3)}`,
            identityKey: `identity-${Math.floor(random() * 2)}`,
            state: random() < 0.5 ? 'prepared' : 'pending',
            now,
            expiresAt: now + 60_000
          })
          const rowsAfter = getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations WHERE invocation_id=?`)
            .get(invocationId) as { count: number }
          if (outcome.ok && !outcome.duplicate) {
            activeInvocations.add(invocationId)
            expect(rowsAfter.count).toBe(rowsBefore.count + 1)
          } else {
            // I4：duplicate/冲突/满员拒绝不新增行
            expect(rowsAfter.count).toBe(rowsBefore.count)
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
        for (const invocationId of activeInvocations) {
          expect(getDbConnection(db).prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations
            WHERE invocation_id=? AND state IN ('prepared','pending')`).get(invocationId)).toEqual({ count: 1 })
        }
        assertInvariants()
      }
    } finally {
      db.close()
    }
  })
})
