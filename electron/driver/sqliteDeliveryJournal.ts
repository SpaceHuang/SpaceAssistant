import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import type { DeliveryOutcome, DeliveryPayload, DeliveryPreference } from './deliveryHub'
import { runInTransaction } from '../database/transaction'
import { isDeepStrictEqual } from 'node:util'

export type PersistedDeliveryIntent = Readonly<{
  deliveryId: string
  target: string
  preference: DeliveryPreference
  payload: DeliveryPayload
  status: DeliveryOutcome | 'pending' | 'delivering'
  createdAt: number
  lastError?: string
}>

export type PersistedSupersedeState = Readonly<{
  deliveryId: string
  target: string
  supersedeKey: string
  status: PersistedDeliveryIntent['status']
}>

/** Durable local delivery ledger. External IM delivery remains at-least-unknown after dispatch. */
export class SqliteDeliveryJournal {
  constructor(private readonly db: AppDatabase, private readonly now: () => number = Date.now) {}

  listResumable(): PersistedDeliveryIntent[] {
    const conn = getDbConnection(this.db)
    const rows = conn.prepare(`SELECT delivery_id, target, preference_json, payload_json, status, created_at, last_error
      FROM driver_deliveries WHERE status IN ('pending','deferred') ORDER BY created_at, delivery_id, target`).all() as Array<{
        delivery_id: string; target: string; preference_json: string; payload_json: string; status: 'pending' | 'deferred'; created_at: number; last_error: string | null
      }>
    return rows.map((row) => ({ deliveryId: row.delivery_id, target: row.target, preference: JSON.parse(row.preference_json) as DeliveryPreference, payload: JSON.parse(row.payload_json) as DeliveryPayload, status: row.status, createdAt: row.created_at, ...(row.last_error ? { lastError: row.last_error } : {}) }))
  }

  /** Returns the most recently accepted intent per target/key to restore supersede ordering after restart. */
  listLatestSupersedeStates(): PersistedSupersedeState[] {
    const rows = getDbConnection(this.db).prepare(`SELECT delivery_id, target, preference_json, status
      FROM driver_deliveries ORDER BY rowid ASC`).all() as Array<{
        delivery_id: string; target: string; preference_json: string; status: PersistedDeliveryIntent['status']
      }>
    const latest = new Map<string, PersistedSupersedeState>()
    for (const row of rows) {
      const supersedeKey = (JSON.parse(row.preference_json) as DeliveryPreference).supersedeKey
      if (!supersedeKey) continue
      latest.set(`${row.target}\u0000${supersedeKey}`, {
        deliveryId: row.delivery_id,
        target: row.target,
        supersedeKey,
        status: row.status
      })
    }
    return [...latest.values()]
  }

  status(deliveryId: string, target: string): string | undefined {
    const row = getDbConnection(this.db).prepare('SELECT status FROM driver_deliveries WHERE delivery_id = ? AND target = ?').get(deliveryId, target) as { status: string } | undefined
    return row?.status
  }

  intent(deliveryId: string, target: string): PersistedDeliveryIntent | undefined {
    const row = getDbConnection(this.db).prepare(`SELECT delivery_id, target, preference_json, payload_json, status, created_at, last_error
      FROM driver_deliveries WHERE delivery_id = ? AND target = ?`).get(deliveryId, target) as {
        delivery_id: string; target: string; preference_json: string; payload_json: string; status: PersistedDeliveryIntent['status']; created_at: number; last_error: string | null
      } | undefined
    if (!row) return undefined
    return {
      deliveryId: row.delivery_id,
      target: row.target,
      preference: JSON.parse(row.preference_json) as DeliveryPreference,
      payload: JSON.parse(row.payload_json) as DeliveryPayload,
      status: row.status,
      createdAt: row.created_at,
      ...(row.last_error ? { lastError: row.last_error } : {})
    }
  }

  transition(input: PersistedDeliveryIntent, status: PersistedDeliveryIntent['status'], error?: string): void {
    const conn = getDbConnection(this.db)
    const ts = this.now()
    runInTransaction(conn, () => {
      conn.prepare(`INSERT INTO driver_deliveries(delivery_id,target,preference_json,payload_json,status,created_at,updated_at,last_error)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id,target) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,last_error=excluded.last_error`)
        .run(input.deliveryId, input.target, JSON.stringify(input.preference), JSON.stringify(input.payload), status, input.createdAt, ts, error ?? null)
      conn.prepare('INSERT INTO driver_delivery_events(delivery_id,target,status,created_at,details_json) VALUES(?,?,?,?,?)')
        .run(input.deliveryId, input.target, status, ts, error ? JSON.stringify({ error }) : null)
    })
    this.db.save()
  }

  /** Atomically claims one durable pending item so independent hubs/processes cannot flush it twice. */
  claimForDispatch(input: PersistedDeliveryIntent): boolean {
    const conn = getDbConnection(this.db)
    const ts = this.now()
    const claimed = runInTransaction(conn, () => {
      const updated = conn.prepare(`UPDATE driver_deliveries SET status='delivering',updated_at=?,last_error=NULL
        WHERE delivery_id=? AND target=? AND status IN ('pending','deferred')`)
        .run(ts, input.deliveryId, input.target)
      if (Number(updated.changes) !== 1) return false
      conn.prepare('INSERT INTO driver_delivery_events(delivery_id,target,status,created_at,details_json) VALUES(?,?,?,?,NULL)')
        .run(input.deliveryId, input.target, 'delivering', ts)
      return true
    })
    if (claimed) this.db.save()
    return claimed
  }

  /** Persists a new direct intent and atomically claims it before external dispatch. */
  claimNewForDispatch(input: PersistedDeliveryIntent): boolean | 'conflict' {
    const conn = getDbConnection(this.db)
    const ts = this.now()
    const claimed = runInTransaction(conn, () => {
      const existing = conn.prepare('SELECT preference_json,payload_json FROM driver_deliveries WHERE delivery_id=? AND target=?').get(input.deliveryId, input.target) as { preference_json: string; payload_json: string } | undefined
      if (existing && (!isDeepStrictEqual(JSON.parse(existing.payload_json), input.payload)
        || (JSON.parse(existing.preference_json) as DeliveryPreference).supersedeKey !== input.preference.supersedeKey)) return 'conflict' as const
      if (!existing) {
        conn.prepare(`INSERT INTO driver_deliveries(delivery_id,target,preference_json,payload_json,status,created_at,updated_at,last_error)
          VALUES(?,?,?,?, 'pending',?,?,NULL)`).run(input.deliveryId, input.target, JSON.stringify(input.preference), JSON.stringify(input.payload), input.createdAt, ts)
        conn.prepare('INSERT INTO driver_delivery_events(delivery_id,target,status,created_at,details_json) VALUES(?,?,?,?,NULL)')
          .run(input.deliveryId, input.target, 'pending', ts)
      }
      const updated = conn.prepare(`UPDATE driver_deliveries SET status='delivering',updated_at=?,last_error=NULL
        WHERE delivery_id=? AND target=? AND status IN ('pending','deferred','failed')`)
        .run(ts, input.deliveryId, input.target)
      if (Number(updated.changes) !== 1) return false
      conn.prepare('INSERT INTO driver_delivery_events(delivery_id,target,status,created_at,details_json) VALUES(?,?,?,?,NULL)')
        .run(input.deliveryId, input.target, 'delivering', ts)
      return true
    })
    if (claimed === true) this.db.save()
    return claimed
  }

  markInterruptedDispatchesUncertain(): number {
    const conn = getDbConnection(this.db)
    const rows = conn.prepare("SELECT delivery_id,target,preference_json,payload_json,created_at FROM driver_deliveries WHERE status='delivering'").all() as Array<{
      delivery_id: string; target: string; preference_json: string; payload_json: string; created_at: number
    }>
    for (const row of rows) this.transition({ deliveryId: row.delivery_id, target: row.target, preference: JSON.parse(row.preference_json), payload: JSON.parse(row.payload_json), status: 'delivering', createdAt: row.created_at }, 'delivery-uncertain', 'PROCESS_RESTART_AFTER_DISPATCH')
    return rows.length
  }
}
