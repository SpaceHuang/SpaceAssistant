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
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '80' })
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_todo_capacity_reservations'").get())
      .toEqual({ name: 'deferred_todo_capacity_reservations' })
    db.close()
  })
})
