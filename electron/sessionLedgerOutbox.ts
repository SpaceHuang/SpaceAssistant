import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { runInTransaction } from './database/transaction'
import type { SessionEventInput } from './sessionEvents'
import type { HistoryEvent } from '../packages/agent-sdk/src/history'
import { ensureLegacyLedgerReadiness } from './sessionLedgerReadiness'
import { sessionLedgerLocationIdentity } from './sessionLedgerIdentity'
import { sessionEventProjectionMatches, sessionEventProjectionSchemasCompatible, toolCallProjectionPayloadMatches, toolResultProjectionPayloadMatches } from './sessionLedgerProjectionCompatibility'

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

export type CanonicalLedgerProjectionTargetIdentity = Pick<CanonicalLedgerProjectionTarget,
  'ledgerLocationKey' | 'sessionId' | 'sessionGeneration' | 'canonicalEventId' | 'projectionOrder' | 'projectionKind'> &
  { targetId: string; canonicalSequence: number }
export type CanonicalLedgerProjectionTargetResolver =
  (identity: CanonicalLedgerProjectionTargetIdentity) => Promise<CanonicalLedgerProjectionTarget | undefined> |
  CanonicalLedgerProjectionTarget | undefined

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const CANONICAL_LEDGER_OUTBOX_PAYLOAD_V1 = '{"encoding":"canonical-v1"}'

export type DecodedCanonicalLedgerProjectionPayload =
  | { kind: 'legacy'; expectedEvents: SessionEventInput[]; expectedEventIds: string[] }
  | { kind: 'canonical-v1'; payloadSha256: string }

function assertExpectedProjectionPayload(expectedEvents: readonly SessionEventInput[], expectedEventIds: readonly string[]): void {
  if (!expectedEvents.length || !expectedEventIds.length || expectedEvents.length !== expectedEventIds.length ||
    expectedEventIds.some((id) => !id)) {
    throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_INVALID')
  }
}

/** Digest of the canonical-derived projection material, independent of its persisted representation. */
export function canonicalLedgerProjectionPayloadDigest(expectedEvents: readonly SessionEventInput[], expectedEventIds: readonly string[]): string {
  assertExpectedProjectionPayload(expectedEvents, expectedEventIds)
  return createHash('sha256').update(`${stableJson(expectedEvents)}\0${stableJson(expectedEventIds)}`).digest('hex')
}

/** Versioned identity-only representation; P4-T2 decides when producers start persisting it. */
export function encodeCanonicalLedgerProjectionPayload(expectedEvents: readonly SessionEventInput[], expectedEventIds: readonly string[]) {
  return {
    expectedEventsJson: CANONICAL_LEDGER_OUTBOX_PAYLOAD_V1,
    expectedEventIdsJson: CANONICAL_LEDGER_OUTBOX_PAYLOAD_V1,
    payloadSha256: canonicalLedgerProjectionPayloadDigest(expectedEvents, expectedEventIds)
  }
}

/** Decodes both the legacy JSON arrays and the identity-only v1 marker without conflating them. */
export function decodeCanonicalLedgerProjectionPayload(expectedEventsJson: string, expectedEventIdsJson: string,
  payloadSha256: string): DecodedCanonicalLedgerProjectionPayload {
  if (!/^[a-f0-9]{64}$/.test(payloadSha256)) throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_DIGEST_INVALID')
  let expectedEvents: unknown
  let expectedEventIds: unknown
  try {
    expectedEvents = JSON.parse(expectedEventsJson)
    expectedEventIds = JSON.parse(expectedEventIdsJson)
  } catch {
    throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_ENCODING_INVALID')
  }

  const eventMarker = record(expectedEvents)
  const idMarker = record(expectedEventIds)
  if (eventMarker || idMarker) {
    const eventEncoding = eventMarker?.encoding
    const idEncoding = idMarker?.encoding
    if (eventEncoding === 'canonical-v1' && idEncoding === 'canonical-v1' &&
      Object.keys(eventMarker!).length === 1 && Object.keys(idMarker!).length === 1) {
      return { kind: 'canonical-v1', payloadSha256 }
    }
    if (eventEncoding === 'canonical-v1' || idEncoding === 'canonical-v1') {
      throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_ENCODING_INVALID')
    }
    if (eventEncoding !== undefined || idEncoding !== undefined) {
      throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_ENCODING_UNSUPPORTED')
    }
    throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_ENCODING_INVALID')
  }
  if (!Array.isArray(expectedEvents) || !Array.isArray(expectedEventIds) ||
    expectedEvents.some((event) => !event || typeof event !== 'object' || Array.isArray(event)) ||
    expectedEventIds.some((id) => typeof id !== 'string')) {
    throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_ENCODING_INVALID')
  }
  const events = expectedEvents as SessionEventInput[]
  const eventIds = expectedEventIds as string[]
  assertExpectedProjectionPayload(events, eventIds)
  if (canonicalLedgerProjectionPayloadDigest(events, eventIds) !== payloadSha256) {
    throw new Error('SESSION_LEDGER_OUTBOX_PAYLOAD_DIGEST_MISMATCH')
  }
  return { kind: 'legacy', expectedEvents: events, expectedEventIds: eventIds }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isCanonicalToolCallAttributionEnrichment(input: {
  target: CanonicalLedgerProjectionTarget
  previousEvents: readonly SessionEventInput[]
  previousEventIds: readonly string[]
  canonicalKind: string
  canonicalTurnId: string
  canonicalPayload: unknown
}): boolean {
  const { target, previousEvents, previousEventIds } = input
  if (!target.projectionKind.startsWith('tool-call:') || previousEvents.length !== 1 || target.expectedEvents.length !== 1 ||
    stableJson(previousEventIds) !== stableJson(target.expectedEventIds)) return false
  const previousEvent = previousEvents[0]
  const nextEvent = target.expectedEvents[0]
  if (!previousEvent || !nextEvent || previousEvent.type !== 'tool_call' || nextEvent.type !== 'tool_call') return false
  if ((previousEvent.schemaVersion ?? 1) >= (nextEvent.schemaVersion ?? 1)) return false
  const previousPayload = previousEvent.payload
  const nextPayload = nextEvent.payload
  const toolUseId = nextPayload.toolUseId
  if (typeof toolUseId !== 'string' || target.projectionKind !== `tool-call:${toolUseId}` ||
    stableJson(target.expectedEventIds) !== stableJson([`tool_call:${toolUseId}`]) ||
    input.canonicalTurnId !== nextPayload.turnId || !toolCallProjectionPayloadMatches(previousPayload, nextPayload)) return false
  const addedAttribution = (['requestId', 'invocationRequestId', 'lane'] as const).filter((key) =>
    typeof nextPayload[key] === 'string' && previousPayload[key] === undefined)
  if (addedAttribution.length === 0 && stableJson(previousPayload) !== stableJson(nextPayload)) return false
  if (input.canonicalKind !== 'model-response-committed') return false

  const envelope = record(input.canonicalPayload)
  const sidecar = record(envelope?.sessionLedger)
  const location = record(sidecar?.location)
  const stepId = sidecar?.stepId
  const canonicalCalls = sidecar?.toolCalls
  if (!location || typeof location.workDir !== 'string' || location.sessionId !== target.sessionId ||
    !Number.isSafeInteger(location.createdAt) || !Array.isArray(canonicalCalls) ||
    typeof stepId !== 'string' || stepId !== nextPayload.stepId) return false
  try {
    if (sessionLedgerLocationIdentity({ workDir: location.workDir, sessionId: target.sessionId, createdAt: location.createdAt as number }).key !== target.ledgerLocationKey) return false
  } catch {
    return false
  }
  const matchingCalls = canonicalCalls.map(record).filter((call) => call?.toolUseId === toolUseId)
  const canonicalCall = matchingCalls.length === 1 ? matchingCalls[0] : undefined
  if (!canonicalCall || canonicalCall.name !== nextPayload.name || stableJson(canonicalCall.args) !== stableJson(nextPayload.args)) return false
  return addedAttribution.every((key) => canonicalCall[key] === nextPayload[key])
}

function isCanonicalToolResultSchemaUpgrade(input: {
  target: CanonicalLedgerProjectionTarget
  previousEvents: readonly SessionEventInput[]
  previousEventIds: readonly string[]
  canonicalKind: string
  canonicalPayload: unknown
}): boolean {
  const { target, previousEvents, previousEventIds } = input
  if (target.projectionKind !== 'tool-result' || previousEvents.length !== 1 || target.expectedEvents.length !== 1 ||
    stableJson(previousEventIds) !== stableJson(target.expectedEventIds)) return false
  const previousEvent = previousEvents[0]
  const nextEvent = target.expectedEvents[0]
  if (!previousEvent || !nextEvent || previousEvent.type !== 'tool_result' || nextEvent.type !== 'tool_result' ||
    (previousEvent.schemaVersion ?? 1) >= (nextEvent.schemaVersion ?? 1) || !sessionEventProjectionMatches(previousEvent, nextEvent)) return false
  const toolUseId = nextEvent.payload.toolUseId
  if (typeof toolUseId !== 'string' || stableJson(target.expectedEventIds) !== stableJson([`tool_result:${toolUseId}`])) return false

  const envelope = record(input.canonicalPayload)
  const sidecar = record(envelope?.sessionLedger)
  const location = record(sidecar?.location)
  const canonicalResult = sidecar?.result
  if (!location || typeof location.workDir !== 'string' || location.sessionId !== target.sessionId ||
    !Number.isSafeInteger(location.createdAt) ||
    typeof sidecar?.stepId !== 'string' || sidecar.stepId !== nextEvent.payload.stepId ||
    payloadToolCallId(envelope) !== toolUseId || (input.canonicalKind !== 'tool-call-finished' && input.canonicalKind !== 'tool-call-not-dispatched') ||
    stableJson(canonicalResult) !== stableJson(nextEvent.payload.result)) return false
  try {
    return sessionLedgerLocationIdentity({ workDir: location.workDir, sessionId: target.sessionId, createdAt: location.createdAt as number }).key === target.ledgerLocationKey
  } catch {
    return false
  }
}

function payloadToolCallId(envelope: Record<string, unknown> | undefined): unknown {
  return envelope?.toolCallId
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
        const projection: Record<string, unknown> = {
          toolUseId: call.toolUseId, stepId: sidecar.stepId, name: call.name, args: call.args, turnId: event.turnId
        }
        for (const key of ['requestId', 'invocationRequestId', 'lane'] as const) {
          if (typeof call[key] === 'string') projection[key] = call[key]
        }
        add(`tool-call:${call.toolUseId}`, [{ type: 'tool_call', schemaVersion: 2, payload: projection }], [`tool_call:${call.toolUseId}`])
      }
    }
    if (event.kind === 'tool-call-finished' || event.kind === 'tool-call-not-dispatched') {
      if (typeof payload.toolCallId === 'string' && typeof sidecar.stepId === 'string' && sidecar.stepId && sidecar.result &&
        typeof sidecar.result === 'object' && !Array.isArray(sidecar.result)) {
        const projection: Record<string, unknown> = { toolUseId: payload.toolCallId, stepId: sidecar.stepId, result: sidecar.result, turnId: event.turnId }
        for (const key of ['turnId', 'requestId', 'invocationRequestId', 'lane'] as const) {
          if (typeof sidecar[key] === 'string') projection[key] = sidecar[key]
        }
        add('tool-result', [{ type: 'tool_result', schemaVersion: 2, payload: projection }], [`tool_result:${payload.toolCallId}`])
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
    if (event.kind === 'provider-attempt-result' || event.kind === 'model-response-committed' || event.kind === 'model-attempt-discarded') {
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
  try { assertExpectedProjectionPayload(target.expectedEvents, target.expectedEventIds) }
  catch { throw new Error('SESSION_LEDGER_PROJECTION_TARGET_INVALID') }
  const location = conn.prepare(`SELECT session_id,session_generation FROM session_ledger_projection_state WHERE ledger_location_key=?`)
    .get(target.ledgerLocationKey) as { session_id: string; session_generation: string } | undefined
  if (!location || location.session_id !== target.sessionId || location.session_generation !== target.sessionGeneration) {
    throw new Error('SESSION_LEDGER_PROJECTION_LOCATION_MISMATCH')
  }
  const canonical = conn.prepare(`SELECT session_seq AS sequence,kind,turn_id,payload_json
    FROM agent_history_events WHERE event_id=? AND session_id=? ORDER BY session_seq DESC LIMIT 1`)
    .get(target.canonicalEventId, target.sessionId) as { sequence: number; kind: string; turn_id: string; payload_json: string } | undefined
  if (!canonical) throw new Error('SESSION_LEDGER_CANONICAL_EVENT_MISSING')
  const canonicalPayload = encodeCanonicalLedgerProjectionPayload(target.expectedEvents, target.expectedEventIds)
  const eventsJson = canonicalPayload.expectedEventsJson
  const eventIdsJson = canonicalPayload.expectedEventIdsJson
  const digest = canonicalLedgerProjectionPayloadDigest(target.expectedEvents, target.expectedEventIds)
  const id = canonicalLedgerProjectionTargetId(target)
  const existing = conn.prepare(`SELECT payload_sha256,expected_events_json,expected_event_ids_json,ledger_location_key,session_id,
      session_generation,canonical_event_id,projection_kind FROM session_ledger_projection_outbox WHERE target_id=?`)
    .get(id) as { payload_sha256: string; expected_events_json: string; expected_event_ids_json: string; ledger_location_key: string;
      session_id: string; session_generation: string; canonical_event_id: string; projection_kind: string } | undefined
  if (existing && (existing.ledger_location_key !== target.ledgerLocationKey || existing.session_id !== target.sessionId ||
    existing.session_generation !== target.sessionGeneration || existing.canonical_event_id !== target.canonicalEventId ||
    existing.projection_kind !== target.projectionKind)) throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
  if (existing) {
    let previous: DecodedCanonicalLedgerProjectionPayload
    try { previous = decodeCanonicalLedgerProjectionPayload(existing.expected_events_json, existing.expected_event_ids_json, existing.payload_sha256) }
    catch { throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT') }
    if (previous.kind === 'canonical-v1') {
      if (previous.payloadSha256 !== digest) throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
    } else if (existing.payload_sha256 !== digest) {
      const previousEvents = previous.expectedEvents
      const previousEventIds = previous.expectedEventIds
      const compatibleEnrichment = isCanonicalToolCallAttributionEnrichment({
        target, previousEvents, previousEventIds, canonicalKind: canonical.kind,
        canonicalTurnId: canonical.turn_id, canonicalPayload: JSON.parse(canonical.payload_json)
      })
      const compatibleToolResultUpgrade = isCanonicalToolResultSchemaUpgrade({
        target, previousEvents, previousEventIds, canonicalKind: canonical.kind,
        canonicalPayload: JSON.parse(canonical.payload_json)
      })
      if (!compatibleEnrichment && !compatibleToolResultUpgrade) throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
      // Target identity predates the event schema update. Upgrade only a canonical-proven compatible projection.
      const upgraded = conn.prepare(`UPDATE session_ledger_projection_outbox SET expected_events_json=?,expected_event_ids_json=?,payload_sha256=?
        WHERE target_id=? AND payload_sha256=?`).run(eventsJson, eventIdsJson, digest, id, existing.payload_sha256) as { changes: number | bigint }
      if (Number(upgraded.changes) !== 1) throw new Error('SESSION_LEDGER_PROJECTION_TARGET_CONFLICT')
    }
  }
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
  observed: { eventIds: readonly string[]; events: readonly SessionEventInput[] }, now = Date.now(),
  canonicalTarget?: Pick<CanonicalLedgerProjectionTarget, 'expectedEvents' | 'expectedEventIds'>): boolean {
  const row = conn.prepare(`SELECT ledger_location_key,expected_event_ids_json,expected_events_json,payload_sha256,status,projection_kind FROM session_ledger_projection_outbox WHERE target_id=?`)
    .get(targetId) as { ledger_location_key: string; expected_event_ids_json: string; expected_events_json: string; payload_sha256: string; status: string; projection_kind: string } | undefined
  if (!row) return false
  let expected: readonly string[]
  let expectedEvents: readonly SessionEventInput[]
  try {
    const decoded = decodeCanonicalLedgerProjectionPayload(row.expected_events_json, row.expected_event_ids_json, row.payload_sha256)
    if (decoded.kind === 'canonical-v1') {
      if (!canonicalTarget || canonicalLedgerProjectionPayloadDigest(canonicalTarget.expectedEvents, canonicalTarget.expectedEventIds) !== decoded.payloadSha256) return false
      expected = canonicalTarget.expectedEventIds
      expectedEvents = canonicalTarget.expectedEvents
    } else {
      expected = decoded.expectedEventIds
      expectedEvents = decoded.expectedEvents
      if (canonicalTarget && canonicalLedgerProjectionPayloadDigest(canonicalTarget.expectedEvents, canonicalTarget.expectedEventIds) !== row.payload_sha256) return false
    }
  } catch { return false }
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
  if (kind === 'tool-result') {
    return expected.length === observed.length && expected.every((expectedEvent, index) => {
      const actual = observed[index]
      return expectedEvent?.type === 'tool_result' && actual?.type === 'tool_result' &&
        toolResultProjectionPayloadMatches(actual.payload, expectedEvent.payload)
    })
  }
  if (kind.startsWith('tool-call:')) {
    return expected.length === observed.length && expected.every((expectedEvent, index) => {
      const actual = observed[index]
      return expectedEvent?.type === 'tool_call' && actual?.type === 'tool_call' &&
        sessionEventProjectionMatches(actual, expectedEvent)
    })
  }
  if (kind === 'tool-result') {
    return expected.length === observed.length && expected.every((expectedEvent, index) => {
      const actual = observed[index]
      return expectedEvent?.type === 'tool_result' && actual?.type === 'tool_result' &&
        sessionEventProjectionMatches(actual, expectedEvent)
    })
  }
  if (kind !== 'invocation-terminal' || expected.length !== observed.length) {
    return expected.length === observed.length && expected.every((expectedEvent, index) => sessionEventProjectionMatches(observed[index]!, expectedEvent))
  }
  return expected.every((expectedEvent, index) => {
    const actual = observed[index]
    if (!actual || expectedEvent.type !== 'turn_end' || actual.type !== 'turn_end') return sessionEventProjectionMatches(actual!, expectedEvent)
    if (!sessionEventProjectionSchemasCompatible(actual, expectedEvent)) return false
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
  now = Date.now(),
  resolveCanonicalTarget?: CanonicalLedgerProjectionTargetResolver
): Promise<{ projected: number; failedTargetId?: string; sourceMissing?: Array<{ targetId: string; disposition: 'source-missing' }> }> {
  let projected = 0
  const sourceMissing: Array<{ targetId: string; disposition: 'source-missing' }> = []
  for (const row of listPendingCanonicalLedgerProjectionTargets(conn, ledgerLocationKey)) {
    const identity: CanonicalLedgerProjectionTargetIdentity = {
      targetId: row.target_id,
      ledgerLocationKey,
      sessionId: row.session_id,
      sessionGeneration: row.session_generation,
      canonicalEventId: row.canonical_event_id,
      canonicalSequence: row.canonical_sequence,
      projectionOrder: row.projection_order,
      projectionKind: row.projection_kind
    }
    let decoded: DecodedCanonicalLedgerProjectionPayload
    try { decoded = decodeCanonicalLedgerProjectionPayload(row.expected_events_json, row.expected_event_ids_json, row.payload_sha256) }
    catch { return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) } }
    let canonicalTarget: CanonicalLedgerProjectionTarget | undefined
    if (resolveCanonicalTarget) {
      try { canonicalTarget = await resolveCanonicalTarget(identity) }
      catch { return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) } }
      if (!canonicalTarget) {
        sourceMissing.push({ targetId: row.target_id, disposition: 'source-missing' })
        continue
      }
      if (canonicalLedgerProjectionTargetId(canonicalTarget) !== row.target_id || canonicalTarget.ledgerLocationKey !== ledgerLocationKey ||
        canonicalTarget.sessionId !== row.session_id || canonicalTarget.sessionGeneration !== row.session_generation ||
        canonicalTarget.canonicalEventId !== row.canonical_event_id || canonicalTarget.projectionKind !== row.projection_kind ||
        (canonicalTarget.projectionOrder ?? 0) !== row.projection_order) {
        return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) }
      }
      const canonicalDigest = canonicalLedgerProjectionPayloadDigest(canonicalTarget.expectedEvents, canonicalTarget.expectedEventIds)
      if (decoded.kind === 'canonical-v1' && decoded.payloadSha256 !== canonicalDigest) {
        return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) }
      }
      if (decoded.kind === 'legacy' && canonicalDigest !== row.payload_sha256) {
        try { runInTransaction(conn, () => enqueueCanonicalLedgerProjectionTargetInTransaction(conn, canonicalTarget!)) }
        catch { return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) } }
      }
    } else if (decoded.kind === 'canonical-v1') {
      return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) }
    }
    const target = {
      ...identity,
      ...(canonicalTarget ? { expectedEvents: canonicalTarget.expectedEvents, expectedEventIds: canonicalTarget.expectedEventIds } : {
        expectedEvents: decoded.kind === 'legacy' ? decoded.expectedEvents : [],
        expectedEventIds: decoded.kind === 'legacy' ? decoded.expectedEventIds : []
      })
    }
    try {
      const observed = await apply(target)
      if (!acknowledgeCanonicalLedgerProjectionTarget(conn, row.target_id, observed, now, canonicalTarget)) {
        return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) }
      }
      projected += 1
    } catch {
      return { projected, failedTargetId: row.target_id, ...(sourceMissing.length ? { sourceMissing } : {}) }
    }
  }
  return { projected, ...(sourceMissing.length ? { sourceMissing } : {}) }
}
