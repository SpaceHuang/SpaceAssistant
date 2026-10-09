import { createWakeEvent, type WakeEvent, type WakeEventInput } from '../../src/shared/wakeEvent'
import { getDbConnection, type AppDatabase } from './sqliteStore'
import { runInTransaction } from './transaction'
import type { WakeEventRetryState } from '../remote/wakeEventRetryPolicy'

export type AppendWakeEventResult = { eventId: string; duplicate: boolean }
export type ClaimedWakeEventSet = { runId: string; eventIds: string[] }
export const DEFAULT_WAKE_EVENT_LEASE_MS = 30_000

export function appendWakeEvent(db: AppDatabase, input: WakeEventInput): AppendWakeEventResult {
  const event = createWakeEvent(input)
  const conn = getDbConnection(db)
  const payloadJson = JSON.stringify(event.payloadRef)
  try {
    conn.prepare(`INSERT INTO wake_events(event_id,reason_key,session_id,event_type,payload_ref_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).run(
      event.eventId, event.reasonKey, event.sessionId, event.type, payloadJson, event.createdAt, event.updatedAt
    )
    return { eventId: event.eventId, duplicate: false }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed: wake_events.session_id, wake_events.reason_key')) throw error
    const existing = conn.prepare(`SELECT event_id,event_type,payload_ref_json FROM wake_events WHERE session_id=? AND reason_key=?`)
      .get(event.sessionId, event.reasonKey) as { event_id: string; event_type: string; payload_ref_json: string } | undefined
    if (!existing) throw error
    if (existing.event_type !== event.type || existing.payload_ref_json !== payloadJson) {
      throw new Error('WAKE_EVENT_REASON_KEY_CONFLICT')
    }
    return { eventId: existing.event_id, duplicate: true }
  }
}

export function continueWorkflow(
  db: AppDatabase,
  input: { sessionId: string; reasonKey: string }
): AppendWakeEventResult {
  return runInTransaction(getDbConnection(db), () => {
    const continuation = appendWakeEvent(db, {
      sessionId: input.sessionId,
      reasonKey: input.reasonKey,
      type: 'continuation',
      payloadRef: { kind: 'continuation', continuationId: input.reasonKey }
    })
    const now = Date.now()
    getDbConnection(db).prepare(`INSERT OR IGNORE INTO wake_event_outbox(event_id,session_id,state,created_at,updated_at)
      VALUES(?,?,'pending',?,?)`).run(continuation.eventId, input.sessionId, now, now)
    return continuation
  })
}

export function readWakeEvent(db: AppDatabase, eventId: string): WakeEvent | null {
  const row = getDbConnection(db).prepare(`SELECT event_id,reason_key,session_id,event_type,payload_ref_json,status,created_at,updated_at
    FROM wake_events WHERE event_id=?`).get(eventId) as {
      event_id: string; reason_key: string; session_id: string; event_type: WakeEvent['type']; payload_ref_json: string
      status: WakeEvent['status']; created_at: number; updated_at: number
    } | undefined
  if (!row) return null
  return {
    eventId: row.event_id as WakeEvent['eventId'],
    reasonKey: row.reason_key as WakeEvent['reasonKey'],
    sessionId: row.session_id as WakeEvent['sessionId'],
    type: row.event_type,
    payloadRef: JSON.parse(row.payload_ref_json) as WakeEvent['payloadRef'],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listWakeEvents(db: AppDatabase, sessionId: string): WakeEvent[] {
  const rows = getDbConnection(db).prepare(`SELECT event_id,reason_key,session_id,event_type,payload_ref_json,status,created_at,updated_at
    FROM wake_events WHERE session_id=? ORDER BY created_at,event_id`).all(sessionId) as Array<{
      event_id: string; reason_key: string; session_id: string; event_type: WakeEvent['type']; payload_ref_json: string
      status: WakeEvent['status']; created_at: number; updated_at: number
    }>
  return rows.map((row) => ({
    eventId: row.event_id as WakeEvent['eventId'],
    reasonKey: row.reason_key as WakeEvent['reasonKey'],
    sessionId: row.session_id as WakeEvent['sessionId'],
    type: row.event_type,
    payloadRef: JSON.parse(row.payload_ref_json) as WakeEvent['payloadRef'],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

export function claimWakeEvent(
  db: AppDatabase,
  input: { sessionId: string; eventId: string; ownerId: string; leaseDurationMs?: number }
): WakeEvent | null {
  if (!input.ownerId.trim()) throw new TypeError('Wake event claim ownerId must not be empty')
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_WAKE_EVENT_LEASE_MS
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('Wake event lease duration must be positive')
  return runInTransaction(getDbConnection(db), () => {
    const now = Date.now()
    const changed = getDbConnection(db).prepare(`UPDATE wake_events SET status='claimed',claimed_by=?,updated_at=?,lease_expires_at=?
      WHERE event_id=? AND session_id=? AND (status='pending' OR (status='claimed' AND lease_expires_at<=?))`)
      .run(input.ownerId, now, now + leaseDurationMs, input.eventId, input.sessionId, now)
    if (Number(changed.changes) !== 1) return null
    return readWakeEvent(db, input.eventId)
  })
}

export function claimWakeEvents(
  db: AppDatabase,
  input: { sessionId: string; runId: string; ownerId: string; leaseDurationMs?: number; eventIds?: readonly string[]; now?: number }
): ClaimedWakeEventSet {
  if (!input.runId.trim()) throw new TypeError('Wake event claim runId must not be empty')
  if (!input.ownerId.trim()) throw new TypeError('Wake event claim ownerId must not be empty')
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_WAKE_EVENT_LEASE_MS
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('Wake event lease duration must be positive')
  if (input.eventIds?.length === 0) return { runId: input.runId, eventIds: [] }
  return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const now = input.now ?? Date.now()
    const idsFilter = input.eventIds ? ` AND event_id IN (${input.eventIds.map(() => '?').join(',')})` : ''
    const rows = conn.prepare(`SELECT event_id FROM wake_events WHERE session_id=? AND
      (status='pending' OR (status='claimed' AND lease_expires_at<=?))${idsFilter} ORDER BY created_at,event_id`)
      .all(input.sessionId, now, ...(input.eventIds ?? [])) as Array<{ event_id: string }>
    const eventIds: string[] = []
    const update = conn.prepare(`UPDATE wake_events SET status='claimed',claimed_by=?,run_id=?,updated_at=?,lease_expires_at=?
      WHERE event_id=? AND session_id=? AND (status='pending' OR (status='claimed' AND lease_expires_at<=?))`)
    for (const { event_id: eventId } of rows) {
      const changed = update.run(input.ownerId, input.runId, now, now + leaseDurationMs, eventId, input.sessionId, now)
      if (Number(changed.changes) === 1) eventIds.push(eventId)
    }
    return { runId: input.runId, eventIds }
  })
}

export function listClaimableWakeEventIds(db: AppDatabase, sessionId: string, now = Date.now()): string[] {
  const rows = getDbConnection(db).prepare(`SELECT event_id FROM wake_events WHERE session_id=? AND
    (status='pending' OR (status='claimed' AND lease_expires_at<=?)) ORDER BY created_at,event_id`)
    .all(sessionId, now) as Array<{ event_id: string }>
  return rows.map(({ event_id }) => event_id)
}

export function releaseWakeEventClaimsForRetry(
  db: AppDatabase,
  input: { sessionId: string; runId: string; ownerId: string; eventIds: readonly string[]; now?: number }
): string[] {
  const ids = [...new Set(input.eventIds)]
  if (ids.length === 0) return []
  return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const update = conn.prepare(`UPDATE wake_events SET status='pending',claimed_by=NULL,run_id=NULL,lease_expires_at=NULL,updated_at=?
      WHERE event_id=? AND session_id=? AND status='claimed' AND run_id=? AND claimed_by=?`)
    const released: string[] = []
    const now = input.now ?? Date.now()
    for (const eventId of ids) {
      const changed = update.run(now, eventId, input.sessionId, input.runId, input.ownerId)
      if (Number(changed.changes) === 1) released.push(eventId)
    }
    return released
  })
}

export function readWakeEventRetryState(db: AppDatabase, eventId: string): WakeEventRetryState | null {
  const row = getDbConnection(db).prepare(`SELECT event_id,attempt_count,started_at,next_attempt_at,should_retry,last_failure_json
    FROM wake_event_retry_state WHERE event_id=?`).get(eventId) as {
      event_id: string; attempt_count: number; started_at: number; next_attempt_at: number | null
      should_retry: number; last_failure_json: string
    } | undefined
  if (!row) return null
  return {
    eventId: row.event_id,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    nextAttemptAt: row.next_attempt_at,
    shouldRetry: row.should_retry === 1,
    lastFailure: JSON.parse(row.last_failure_json) as WakeEventRetryState['lastFailure']
  }
}

export function saveWakeEventRetryState(db: AppDatabase, state: WakeEventRetryState, updatedAt = Date.now()): void {
  if (!state.lastFailure) throw new TypeError('Wake event retry state requires a failure fact')
  getDbConnection(db).prepare(`INSERT INTO wake_event_retry_state(event_id,attempt_count,started_at,next_attempt_at,should_retry,last_failure_json,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET attempt_count=excluded.attempt_count,
      started_at=excluded.started_at,next_attempt_at=excluded.next_attempt_at,should_retry=excluded.should_retry,
      last_failure_json=excluded.last_failure_json,updated_at=excluded.updated_at`)
    .run(state.eventId, state.attemptCount, state.startedAt, state.nextAttemptAt, state.shouldRetry ? 1 : 0,
      JSON.stringify(state.lastFailure), updatedAt)
}

export function clearWakeEventRetryState(db: AppDatabase, eventId: string): void {
  getDbConnection(db).prepare('DELETE FROM wake_event_retry_state WHERE event_id=?').run(eventId)
}

export function ackWakeEvent(
  db: AppDatabase,
  input: { sessionId: string; eventId: string; ownerId: string }
): boolean {
  if (!input.ownerId.trim()) throw new TypeError('Wake event ack ownerId must not be empty')
  return runInTransaction(getDbConnection(db), () => {
    const changed = getDbConnection(db).prepare(`UPDATE wake_events SET status='acked',updated_at=?
      WHERE event_id=? AND session_id=? AND status='claimed' AND claimed_by=?`).run(Date.now(), input.eventId, input.sessionId, input.ownerId)
    return Number(changed.changes) === 1
  })
}

export function ackWakeEventInRun(
  db: AppDatabase,
  input: { sessionId: string; eventId: string; runId: string; ownerId: string }
): boolean {
  if (!input.runId.trim()) throw new TypeError('Wake event ack runId must not be empty')
  if (!input.ownerId.trim()) throw new TypeError('Wake event ack ownerId must not be empty')
  return runInTransaction(getDbConnection(db), () => {
    const now = Date.now()
    const changed = getDbConnection(db).prepare(`UPDATE wake_events SET status='acked',updated_at=?
      WHERE event_id=? AND session_id=? AND status='claimed' AND run_id=? AND claimed_by=? AND lease_expires_at>?`)
      .run(now, input.eventId, input.sessionId, input.runId, input.ownerId, now)
    return Number(changed.changes) === 1
  })
}

export function finalizeWakeEvents(
  db: AppDatabase,
  input: { sessionId: string; runId: string; ownerId: string; eventIds: readonly string[]; now?: number }
): string[] {
  if (!input.runId.trim()) throw new TypeError('Wake event finalize runId must not be empty')
  if (!input.ownerId.trim()) throw new TypeError('Wake event finalize ownerId must not be empty')
  const eventIds = [...new Set(input.eventIds)]
  if (eventIds.length === 0) return []
  return runInTransaction(getDbConnection(db), () => {
    const conn = getDbConnection(db)
    const now = input.now ?? Date.now()
    const update = conn.prepare(`UPDATE wake_events SET status='acked',updated_at=?
      WHERE event_id=? AND session_id=? AND status='claimed' AND run_id=? AND claimed_by=? AND lease_expires_at>?`)
    const dispatchOutbox = conn.prepare(`UPDATE wake_event_outbox SET state='dispatched',updated_at=? WHERE event_id=?`)
    const finalized: string[] = []
    for (const eventId of eventIds) {
      const changed = update.run(now, eventId, input.sessionId, input.runId, input.ownerId, now)
      if (Number(changed.changes) === 1) {
        dispatchOutbox.run(now, eventId)
        finalized.push(eventId)
      }
    }
    return finalized
  })
}

export type WaitForEventInput = {
  sessionId: string
  runId: string
  ownerId: string
  eventIds: readonly string[]
}

export function waitForEvent(db: AppDatabase, input: WaitForEventInput): string[] {
  return finalizeWakeEvents(db, input)
}
