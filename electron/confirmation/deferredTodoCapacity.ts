import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

export const DEFAULT_DEFERRED_TODO_SESSION_LIMIT = 5
export const DEFAULT_DEFERRED_TODO_IDENTITY_LIMIT = 10
export const DEFAULT_DEFERRED_RESERVATION_TTL_MS = 24 * 60 * 60_000

type CapacityReservation = {
  reservationId: string
  invocationId: string
  sessionId: string
  identityKey: string
  state: 'prepared' | 'pending'
  now?: number
  expiresAt?: number
}

export interface DeferredTodoCapacityLifecycle {
  releaseByInvocation(invocationId: string, now?: number): boolean
}

function assertLimit(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) throw new TypeError(`INVALID_DEFERRED_TODO_${name}_LIMIT`)
}

export function createDeferredTodoCapacityController(
  db: AppDatabase,
  limits: { sessionLimit?: number; identityLimit?: number } = {}
) {
  const sessionLimit = limits.sessionLimit ?? DEFAULT_DEFERRED_TODO_SESSION_LIMIT
  const identityLimit = limits.identityLimit ?? DEFAULT_DEFERRED_TODO_IDENTITY_LIMIT
  assertLimit(sessionLimit, 'SESSION')
  assertLimit(identityLimit, 'IDENTITY')
  const conn = getDbConnection(db)

  function expire(now: number): number {
    const result = conn.prepare(`UPDATE deferred_todo_capacity_reservations SET state='expired',updated_at=?
      WHERE state IN ('prepared','pending') AND expires_at<=?`).run(now, now)
    const count = Number(result.changes)
    if (count > 0) db.save()
    return count
  }

  return {
    reserve(input: CapacityReservation): { ok: true; duplicate: boolean } | { ok: false; reason: 'session_limit' | 'identity_limit' | 'reservation_conflict' } {
      if (![input.reservationId, input.invocationId, input.sessionId, input.identityKey].every((value) => value.trim())) {
        throw new TypeError('DEFERRED_TODO_RESERVATION_IDENTITY_REQUIRED')
      }
      const now = input.now ?? Date.now()
      const expiresAt = input.expiresAt ?? now + DEFAULT_DEFERRED_RESERVATION_TTL_MS
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) throw new TypeError('DEFERRED_TODO_RESERVATION_TTL_INVALID')
      return runInTransaction(conn, () => {
        expire(now)
        const prior = conn.prepare(`SELECT reservation_id,session_id,identity_key,state FROM deferred_todo_capacity_reservations
          WHERE invocation_id=?`).get(input.invocationId) as { reservation_id: string; session_id: string; identity_key: string; state: string } | undefined
        if (prior) {
          if (prior.reservation_id !== input.reservationId || prior.session_id !== input.sessionId || prior.identity_key !== input.identityKey) {
            return { ok: false, reason: 'reservation_conflict' }
          }
          return prior.state === 'prepared' || prior.state === 'pending'
            ? { ok: true, duplicate: true }
            : { ok: false, reason: 'reservation_conflict' }
        }
        const sessionCount = conn.prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations
          WHERE session_id=? AND identity_key=? AND state IN ('prepared','pending')`).get(input.sessionId, input.identityKey) as { count: number }
        if (sessionCount.count >= sessionLimit) return { ok: false, reason: 'session_limit' }
        const identityCount = conn.prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations
          WHERE identity_key=? AND state IN ('prepared','pending')`).get(input.identityKey) as { count: number }
        if (identityCount.count >= identityLimit) return { ok: false, reason: 'identity_limit' }
        conn.prepare(`INSERT INTO deferred_todo_capacity_reservations(
          reservation_id,invocation_id,session_id,identity_key,state,created_at,expires_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          input.reservationId, input.invocationId, input.sessionId, input.identityKey, input.state, now, expiresAt, now
        )
        db.save()
        return { ok: true, duplicate: false }
      })
    },

    activate(reservationId: string, invocationId: string, now = Date.now()): boolean {
      const result = conn.prepare(`UPDATE deferred_todo_capacity_reservations SET state='pending',updated_at=?
        WHERE reservation_id=? AND invocation_id=? AND state='prepared' AND expires_at>?`).run(now, reservationId, invocationId, now)
      if (Number(result.changes) === 1) db.save()
      return Number(result.changes) === 1
    },

    release(reservationId: string, invocationId: string, now = Date.now()): boolean {
      const result = conn.prepare(`UPDATE deferred_todo_capacity_reservations SET state='released',updated_at=?
        WHERE reservation_id=? AND invocation_id=? AND state IN ('prepared','pending')`).run(now, reservationId, invocationId)
      if (Number(result.changes) === 1) db.save()
      return Number(result.changes) === 1
    },

    releaseByInvocation(invocationId: string, now = Date.now()): boolean {
      const row = conn.prepare(`SELECT reservation_id FROM deferred_todo_capacity_reservations
        WHERE invocation_id=? AND state IN ('prepared','pending')`).get(invocationId) as { reservation_id: string } | undefined
      return row ? this.release(row.reservation_id, invocationId, now) : false
    },

    counts(input: { identityKey: string; now?: number }): { identity: number; sessions: Record<string, number> } {
      const now = input.now ?? Date.now()
      expire(now)
      const identity = conn.prepare(`SELECT COUNT(*) AS count FROM deferred_todo_capacity_reservations
        WHERE identity_key=? AND state IN ('prepared','pending')`).get(input.identityKey) as { count: number }
      const rows = conn.prepare(`SELECT session_id,SUM(CASE WHEN state IN ('prepared','pending') THEN 1 ELSE 0 END) AS count
        FROM deferred_todo_capacity_reservations WHERE identity_key=? GROUP BY session_id`).all(input.identityKey) as Array<{ session_id: string; count: number }>
      const sessions = Object.fromEntries(rows.map(({ session_id, count }) => [session_id, count]))
      return { identity: identity.count, sessions }
    },

    reconcile(validInvocationIds: string[], now = Date.now()): { expired: number; released: number } {
      return runInTransaction(conn, () => {
        const expired = expire(now)
        const valid = new Set(validInvocationIds)
        const active = conn.prepare(`SELECT reservation_id,invocation_id FROM deferred_todo_capacity_reservations
          WHERE state IN ('prepared','pending')`).all() as Array<{ reservation_id: string; invocation_id: string }>
        let released = 0
        for (const reservation of active) {
          if (valid.has(reservation.invocation_id)) continue
          const result = conn.prepare(`UPDATE deferred_todo_capacity_reservations SET state='released',updated_at=?
            WHERE reservation_id=? AND state IN ('prepared','pending')`).run(now, reservation.reservation_id)
          released += Number(result.changes)
        }
        if (released > 0) db.save()
        return { expired, released }
      })
    }
  }
}
