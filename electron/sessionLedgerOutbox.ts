import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from './database/transaction'
import type { SessionEventInput } from './sessionEvents'
import type { HistoryEvent } from '../packages/agent-sdk/src/history'
import { ensureLegacyLedgerReadiness } from './sessionLedgerReadiness'

export type CanonicalLedgerProjectionTarget = {
  ledgerLocationKey: string
  sessionId: string
  sessionGeneration: string
  canonicalEventId: string
  projectionKind: string
  expectedEvents: readonly SessionEventInput[]
  expectedEventIds: readonly string[]
  now?: number
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalLedgerProjectionTargetId(target: Pick<CanonicalLedgerProjectionTarget,
  'ledgerLocationKey' | 'canonicalEventId' | 'projectionKind'>): string {
  return createHash('sha256').update(`${target.ledgerLocationKey}\0${target.canonicalEventId}\0${target.projectionKind}`).digest('hex')
}

/** Maps the canonical tool completion sidecar to its one-event ledger obligation. */
export function buildCanonicalToolResultProjectionTargets(conn: DatabaseSync, events: readonly HistoryEvent[], sessionId: string,
  sessionGeneration: string, now = Date.now()): CanonicalLedgerProjectionTarget[] {
  const targets: CanonicalLedgerProjectionTarget[] = []
  for (const event of events) {
    if (event.kind !== 'tool-call-finished' && event.kind !== 'tool-call-not-dispatched') continue
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) continue
    const payload = event.payload as { toolCallId?: unknown; sessionLedger?: unknown }
    const ledger = payload.sessionLedger
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || typeof payload.toolCallId !== 'string') continue
    const sidecar = ledger as Record<string, unknown>
    const location = sidecar.location as { workDir?: unknown; sessionId?: unknown; createdAt?: unknown } | undefined
    if (!location || typeof location.workDir !== 'string' || typeof location.sessionId !== 'string' || !Number.isSafeInteger(location.createdAt)) continue
    if (location.sessionId !== sessionId) throw new Error('SESSION_LEDGER_PROJECTION_LOCATION_MISMATCH')
    if (typeof sidecar.stepId !== 'string' || !sidecar.stepId || !sidecar.result || typeof sidecar.result !== 'object' || Array.isArray(sidecar.result)) continue
    const readiness = ensureLegacyLedgerReadiness(conn, {
      workDir: location.workDir, sessionId, createdAt: location.createdAt as number
    }, sessionGeneration, now)
    const projection: Record<string, unknown> = { toolUseId: payload.toolCallId, stepId: sidecar.stepId, result: sidecar.result }
    for (const key of ['turnId', 'requestId', 'invocationRequestId', 'lane'] as const) {
      if (typeof sidecar[key] === 'string') projection[key] = sidecar[key]
    }
    targets.push({
      ledgerLocationKey: readiness.ledgerLocationKey, sessionId, sessionGeneration,
      canonicalEventId: event.eventId, projectionKind: 'tool-result',
      expectedEvents: [{ type: 'tool_result', payload: projection }],
      expectedEventIds: [`tool_result:${payload.toolCallId}`], now
    })
  }
  return targets
}

/** Inserts a durable obligation in the caller's canonical History transaction. */
export function enqueueCanonicalLedgerProjectionTargetInTransaction(conn: DatabaseSync, target: CanonicalLedgerProjectionTarget): string {
  if (!target.expectedEvents.length || !target.expectedEventIds.length ||
    target.expectedEvents.length !== target.expectedEventIds.length || target.expectedEventIds.some((id) => !id)) {
    throw new Error('SESSION_LEDGER_PROJECTION_TARGET_INVALID')
  }
  const location = conn.prepare(`SELECT session_id,session_generation FROM session_ledger_projection_state WHERE ledger_location_key=?`)
    .get(target.ledgerLocationKey) as { session_id: string; session_generation: string } | undefined
  if (!location || location.session_id !== target.sessionId || location.session_generation !== target.sessionGeneration) {
    throw new Error('SESSION_LEDGER_PROJECTION_LOCATION_MISMATCH')
  }
  const eventsJson = stableJson(target.expectedEvents)
  const eventIdsJson = stableJson(target.expectedEventIds)
  const digest = createHash('sha256').update(`${eventsJson}\0${eventIdsJson}`).digest('hex')
  const id = canonicalLedgerProjectionTargetId(target)
  const existing = conn.prepare(`SELECT payload_sha256 FROM session_ledger_projection_outbox WHERE target_id=?`).get(id) as { payload_sha256: string } | undefined
  if (existing && existing.payload_sha256 !== digest) throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
  conn.prepare(`INSERT OR IGNORE INTO session_ledger_projection_outbox(
    target_id,ledger_location_key,session_id,session_generation,canonical_event_id,projection_kind,
    expected_events_json,expected_event_ids_json,payload_sha256,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`).run(id, target.ledgerLocationKey, target.sessionId, target.sessionGeneration,
      target.canonicalEventId, target.projectionKind, eventsJson, eventIdsJson, digest, target.now ?? Date.now())
  conn.prepare(`UPDATE session_ledger_projection_state SET state='dirty',checked_at=NULL,updated_at=?
    WHERE ledger_location_key=? AND state IN ('ready','dirty')`).run(target.now ?? Date.now(), target.ledgerLocationKey)
  return id
}

export function listPendingCanonicalLedgerProjectionTargets(conn: DatabaseSync, ledgerLocationKey: string) {
  return conn.prepare(`SELECT target_id,session_id,session_generation,canonical_event_id,projection_kind,expected_events_json,expected_event_ids_json,payload_sha256
    FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status='pending'
    ORDER BY created_at,target_id`).all(ledgerLocationKey) as Array<{
      target_id: string; session_id: string; session_generation: string; canonical_event_id: string; projection_kind: string; expected_events_json: string
      expected_event_ids_json: string; payload_sha256: string
    }>
}

/** Acknowledges only after the sink confirms the complete expected event identity set. */
export function acknowledgeCanonicalLedgerProjectionTarget(conn: DatabaseSync, targetId: string,
  observed: { eventIds: readonly string[]; events: readonly SessionEventInput[] }, now = Date.now()): boolean {
  const row = conn.prepare(`SELECT ledger_location_key,expected_event_ids_json,expected_events_json,status FROM session_ledger_projection_outbox WHERE target_id=?`)
    .get(targetId) as { ledger_location_key: string; expected_event_ids_json: string; expected_events_json: string; status: string } | undefined
  if (!row) return false
  const expected = JSON.parse(row.expected_event_ids_json) as string[]
  const expectedEvents = JSON.parse(row.expected_events_json) as SessionEventInput[]
  if (stableJson(expected) !== stableJson(observed.eventIds) || stableJson(expectedEvents) !== stableJson(observed.events)) return false
  if (row.status === 'acked') return true
  return runInTransaction(conn, () => {
    const result = conn.prepare(`UPDATE session_ledger_projection_outbox SET status='acked',acked_at=? WHERE target_id=? AND status='pending'`)
      .run(now, targetId) as { changes: number | bigint }
    if (Number(result.changes) !== 1) return false
    const pending = conn.prepare(`SELECT 1 FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status='pending' LIMIT 1`)
      .get(row.ledger_location_key)
    if (!pending) conn.prepare(`UPDATE session_ledger_projection_state SET state='unknown',updated_at=? WHERE ledger_location_key=? AND state='dirty'`)
      .run(now, row.ledger_location_key)
    return true
  })
}

export async function drainCanonicalLedgerProjectionOutbox(
  conn: DatabaseSync,
  ledgerLocationKey: string,
  apply: (target: CanonicalLedgerProjectionTarget & { targetId: string }) => Promise<{ eventIds: readonly string[]; events: readonly SessionEventInput[] }>,
  now = Date.now()
): Promise<{ projected: number; failedTargetId?: string }> {
  let projected = 0
  for (const row of listPendingCanonicalLedgerProjectionTargets(conn, ledgerLocationKey)) {
    const target = {
      targetId: row.target_id,
      ledgerLocationKey,
      sessionId: row.session_id,
      sessionGeneration: row.session_generation,
      canonicalEventId: row.canonical_event_id,
      projectionKind: row.projection_kind,
      expectedEvents: JSON.parse(row.expected_events_json) as SessionEventInput[],
      expectedEventIds: JSON.parse(row.expected_event_ids_json) as string[]
    }
    try {
      const observed = await apply(target)
      if (!acknowledgeCanonicalLedgerProjectionTarget(conn, row.target_id, observed, now)) return { projected, failedTargetId: row.target_id }
      projected += 1
    } catch {
      return { projected, failedTargetId: row.target_id }
    }
  }
  return { projected }
}
