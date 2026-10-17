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
  projectionOrder?: number
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

/** Maps supported canonical sidecars to ordered, exact ledger obligations. */
export function buildCanonicalToolResultProjectionTargets(conn: DatabaseSync, events: readonly HistoryEvent[], sessionId: string,
  sessionGeneration: string, now = Date.now()): CanonicalLedgerProjectionTarget[] {
  const targets: CanonicalLedgerProjectionTarget[] = []
  for (const event of events) {
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) continue
    const payload = event.payload as { toolCallId?: unknown; sessionLedger?: unknown }
    const ledger = payload.sessionLedger
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) continue
    const sidecar = ledger as Record<string, unknown>
    const location = sidecar.location as { workDir?: unknown; sessionId?: unknown; createdAt?: unknown } | undefined
    if (!location || typeof location.workDir !== 'string' || typeof location.sessionId !== 'string' || !Number.isSafeInteger(location.createdAt)) continue
    if (location.sessionId !== sessionId) throw new Error('SESSION_LEDGER_PROJECTION_LOCATION_MISMATCH')
    const readiness = ensureLegacyLedgerReadiness(conn, {
      workDir: location.workDir, sessionId, createdAt: location.createdAt as number
    }, sessionGeneration, now)
    let projectionOrder = 0
    const add = (projectionKind: string, expectedEvents: SessionEventInput[], expectedEventIds: string[]) => targets.push({
      ledgerLocationKey: readiness.ledgerLocationKey, sessionId, sessionGeneration, canonicalEventId: event.eventId,
      projectionOrder: projectionOrder++, projectionKind, expectedEvents, expectedEventIds, now
    })
    if (event.kind === 'model-response-committed' && typeof sidecar.stepId === 'string' && sidecar.stepId && Array.isArray(sidecar.toolCalls)) {
      for (const rawCall of sidecar.toolCalls) {
        if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) continue
        const call = rawCall as Record<string, unknown>
        if (typeof call.toolUseId !== 'string' || typeof call.name !== 'string' || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) continue
        const projection = { toolUseId: call.toolUseId, stepId: sidecar.stepId, name: call.name, args: call.args, turnId: event.turnId }
        add(`tool-call:${call.toolUseId}`, [{ type: 'tool_call', payload: projection }], [`tool_call:${call.toolUseId}`])
      }
    }
    if (event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') {
      if (typeof payload.toolCallId === 'string' && typeof sidecar.stepId === 'string' && sidecar.stepId && sidecar.result &&
        typeof sidecar.result === 'object' && !Array.isArray(sidecar.result)) {
        const projection: Record<string, unknown> = { toolUseId: payload.toolCallId, stepId: sidecar.stepId, result: sidecar.result }
        for (const key of ['turnId', 'requestId', 'invocationRequestId', 'lane'] as const) {
          if (typeof sidecar[key] === 'string') projection[key] = sidecar[key]
        }
        add('tool-result', [{ type: 'tool_result', payload: projection }], [`tool_result:${payload.toolCallId}`])
      }
    }
    if (event.kind === 'model-request-started') {
      const header = sidecar.requestHeader
      const context = sidecar.requestContext
      if (header && typeof header === 'object' && !Array.isArray(header) && context && typeof context === 'object' && !Array.isArray(context)) {
        const requestId = (header as Record<string, unknown>).requestId
        const attempt = (header as Record<string, unknown>).attempt
        if (typeof requestId === 'string' && Number.isInteger(attempt) && (context as Record<string, unknown>).requestId === requestId &&
          (context as Record<string, unknown>).attempt === attempt) {
          add('request-projection', [
            { type: 'request_header', payload: header as Record<string, unknown> },
            { type: 'request_context', payload: context as Record<string, unknown> }
          ], [`request_header:${requestId}:${attempt}`, `request_context:${requestId}:${attempt}`])
        }
      }
    }
    if (event.kind === 'provider-retry-scheduled') {
      const retry = sidecar.requestRetry
      if (retry && typeof retry === 'object' && !Array.isArray(retry)) {
        const value = retry as Record<string, unknown>
        if (typeof value.requestId === 'string' && Number.isInteger(value.attempt)) {
          add('request-retry', [{ type: 'request_retry', payload: value }], [`request_retry:${value.requestId}:${value.attempt}`])
        }
      }
    }
    if (event.kind === 'model-response-committed' || event.kind === 'model-attempt-discarded') {
      const usage = sidecar.requestUsage
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const value = usage as Record<string, unknown>
        if (typeof value.requestId === 'string') add('request-usage', [{ type: 'request_usage', payload: value }], [`request_usage:${value.requestId}`])
      }
    }
    if (event.kind === 'model-response-committed') {
      const context = sidecar.requestContext
      if (context && typeof context === 'object' && !Array.isArray(context)) {
        const value = context as Record<string, unknown>
        if (typeof value.requestId === 'string' && Number.isInteger(value.attempt)) {
          const finalContext = { ...value, projectionStage: 'final' }
          add('request-final-context', [{ type: 'request_context', payload: finalContext }], [`request_context_final:${value.requestId}:${value.attempt}`])
        }
      }
    }
    if (event.kind === 'transcript-compacted') {
      const start = sidecar.start
      const summary = sidecar.summary
      if (start && typeof start === 'object' && !Array.isArray(start) && summary && typeof summary === 'object' && !Array.isArray(summary)) {
        const startRecord = start as Record<string, unknown>
        const summaryRecord = summary as Record<string, unknown>
        const compactionId = summaryRecord.compactionId
        if (typeof compactionId === 'string' && startRecord.compactionId === compactionId) {
          add('compaction', [
            { type: 'compaction_start', payload: startRecord },
            { type: 'compaction_summary', payload: summaryRecord }
          ], [`compaction_start:${compactionId}`, `compaction_summary:${compactionId}`])
        }
      }
    }
    if (event.kind === 'invocation-completed' || event.kind === 'invocation-failed' || event.kind === 'invocation-interrupted') {
      const terminal = sidecar
      const turnId = terminal.turnId
      const reason = terminal.reason
      if (typeof turnId === 'string' && ['completed', 'failed', 'interrupted', 'cancelled', 'denied'].includes(String(reason))) {
        add('invocation-terminal', [
          { type: 'turn_start', payload: { turnId } }, { type: 'turn_end', payload: { turnId, reason } }
        ], [`turn_start:${turnId}`, `turn_end:${turnId}`])
      }
    }
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
  const canonical = conn.prepare(`SELECT session_seq AS sequence FROM agent_history_events WHERE event_id=? AND session_id=? ORDER BY session_seq DESC LIMIT 1`)
    .get(target.canonicalEventId, target.sessionId) as { sequence: number } | undefined
  if (!canonical) throw new Error('SESSION_LEDGER_CANONICAL_EVENT_MISSING')
  const eventsJson = stableJson(target.expectedEvents)
  const eventIdsJson = stableJson(target.expectedEventIds)
  const digest = createHash('sha256').update(`${eventsJson}\0${eventIdsJson}`).digest('hex')
  const id = canonicalLedgerProjectionTargetId(target)
  const existing = conn.prepare(`SELECT payload_sha256 FROM session_ledger_projection_outbox WHERE target_id=?`).get(id) as { payload_sha256: string } | undefined
  if (existing && existing.payload_sha256 !== digest) throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
  const insert = conn.prepare(`INSERT OR IGNORE INTO session_ledger_projection_outbox(
    target_id,ledger_location_key,session_id,session_generation,canonical_event_id,canonical_sequence,projection_order,projection_kind,
    expected_events_json,expected_event_ids_json,payload_sha256,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(id, target.ledgerLocationKey, target.sessionId, target.sessionGeneration,
      target.canonicalEventId, canonical.sequence, target.projectionOrder ?? 0, target.projectionKind, eventsJson, eventIdsJson, digest, target.now ?? Date.now()) as { changes: number | bigint }
  const existingTarget = conn.prepare('SELECT status FROM session_ledger_projection_outbox WHERE target_id=?').get(id) as { status: string } | undefined
  if (Number(insert.changes) === 1 || existingTarget?.status === 'pending') {
    conn.prepare(`UPDATE session_ledger_projection_state SET state='dirty',check_token=NULL,checked_at=NULL,updated_at=?
      WHERE ledger_location_key=? AND state IN ('unknown','checking','ready','dirty')`).run(target.now ?? Date.now(), target.ledgerLocationKey)
  }
  return id
}

export function listPendingCanonicalLedgerProjectionTargets(conn: DatabaseSync, ledgerLocationKey: string) {
  return conn.prepare(`SELECT target_id,session_id,session_generation,canonical_event_id,canonical_sequence,projection_order,projection_kind,expected_events_json,expected_event_ids_json,payload_sha256
    FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status='pending'
    ORDER BY canonical_sequence,projection_order,target_id`).all(ledgerLocationKey) as Array<{
      target_id: string; session_id: string; session_generation: string; canonical_event_id: string; canonical_sequence: number; projection_order: number; projection_kind: string; expected_events_json: string
      expected_event_ids_json: string; payload_sha256: string
    }>
}

/** Acknowledges only after the sink confirms the complete expected event identity set. */
export function acknowledgeCanonicalLedgerProjectionTarget(conn: DatabaseSync, targetId: string,
  observed: { eventIds: readonly string[]; events: readonly SessionEventInput[] }, now = Date.now()): boolean {
  const row = conn.prepare(`SELECT ledger_location_key,expected_event_ids_json,expected_events_json,status,projection_kind FROM session_ledger_projection_outbox WHERE target_id=?`)
    .get(targetId) as { ledger_location_key: string; expected_event_ids_json: string; expected_events_json: string; status: string; projection_kind: string } | undefined
  if (!row) return false
  const expected = JSON.parse(row.expected_event_ids_json) as string[]
  const expectedEvents = JSON.parse(row.expected_events_json) as SessionEventInput[]
  if (stableJson(expected) !== stableJson(observed.eventIds) || !projectionEventsMatch(row.projection_kind, expectedEvents, observed.events)) return false
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

function projectionEventsMatch(kind: string, expected: readonly SessionEventInput[], observed: readonly SessionEventInput[]): boolean {
  if (kind !== 'invocation-terminal' || expected.length !== observed.length) return stableJson(expected) === stableJson(observed)
  return expected.every((expectedEvent, index) => {
    const actual = observed[index]
    if (!actual || expectedEvent.type !== 'turn_end' || actual.type !== 'turn_end') return stableJson(expectedEvent) === stableJson(actual)
    const { turnId, reason, ...additionalPayload } = actual.payload
    const valid = Object.keys(additionalPayload).every((key) => key === 'error' || key === 'errorCode' || key === 'finalSurfaceSnapshot') &&
      (additionalPayload.error === undefined || typeof additionalPayload.error === 'string') &&
      (additionalPayload.errorCode === undefined || typeof additionalPayload.errorCode === 'string')
    return valid && turnId === expectedEvent.payload.turnId && reason === expectedEvent.payload.reason
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
