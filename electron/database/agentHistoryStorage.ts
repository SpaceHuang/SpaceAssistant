import type { DatabaseSync } from 'node:sqlite'
import { assertSpillReferencePayloadStrict, replaceSpillReferenceOwnerInTransaction, spillHistoryOwnerKey } from '../storage/spillReferenceIndex'
import { enqueueCanonicalLedgerProjectionTargetInTransaction, type CanonicalLedgerProjectionTarget } from '../sessionLedgerOutbox'
import {
  HistoryBatchError,
  HistoryIdempotencyConflict,
  HistorySequenceConflict,
  HistoryVersionConflict,
  advanceHistoryTransitionState,
  createHistoryTransitionState,
  historyEventsEqual,
  validateHistoryBatch,
  type HistoryAppendResult,
  type HistoryEvent,
  type HistoryTransitionState
} from '../../packages/agent-sdk/src/history'

type StreamRow = { invocation_id: string; version: number; schema_version: number; session_id: string | null; transition_state_version: number | null; transition_state_json: string | null }
type EventRow = {
  invocation_id: string; sequence: number; event_id: string; idempotency_key: string; turn_id: string
  schema_version: number; kind: HistoryEvent['kind']; payload_json: string
}

function fromRow(row: EventRow): HistoryEvent {
  return {
    invocationId: row.invocation_id, sequence: row.sequence, eventId: row.event_id,
    idempotencyKey: row.idempotency_key, turnId: row.turn_id, schemaVersion: row.schema_version,
    kind: row.kind, payload: JSON.parse(row.payload_json)
  }
}

/** Append a canonical batch inside a transaction already owned by the caller. */
export function appendSqliteAgentHistoryBatchInTransaction(
  conn: DatabaseSync,
  events: readonly HistoryEvent[],
  expectedVersion: number,
  options: { schemaVersion?: number; sessionId?: string; now?: () => number; processGeneration?: number; projectionTargets?: readonly CanonicalLedgerProjectionTarget[] } = {}
): HistoryAppendResult {
  const schemaVersion = options.schemaVersion ?? 1
  const now = options.now ?? Date.now
  validateHistoryBatch(events)
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new HistoryBatchError('expectedVersion must be a non-negative integer')
  const serialized = events.map((event) => {
    try {
      const payloadJson = JSON.stringify(event.payload)
      if (payloadJson === undefined) throw new Error('undefined payload')
      return payloadJson
    } catch {
      throw new HistoryBatchError(`history payload is not serializable: ${event.eventId}`)
    }
  })
  const invocationId = events[0].invocationId
  if (options.processGeneration !== undefined) {
    const owner = conn.prepare('SELECT current_generation FROM process_generation_state WHERE singleton_id=1').get() as
      { current_generation: number } | undefined
    if (!owner || owner.current_generation !== options.processGeneration) throw new HistoryBatchError('HISTORY_PROCESS_GENERATION_FENCED')
  }
  for (const payloadJson of serialized) assertSpillReferencePayloadStrict(payloadJson)
  const stream = conn.prepare('SELECT invocation_id, version, schema_version, session_id, transition_state_version, transition_state_json FROM agent_history_streams WHERE invocation_id = ?').get(invocationId) as StreamRow | undefined
  if (stream?.session_id && options.sessionId && stream.session_id !== options.sessionId) {
    throw new HistoryBatchError(`history invocation ${invocationId} belongs to ${stream.session_id}, not ${options.sessionId}`)
  }
  const actualVersion = stream?.version ?? 0
  const actualSchemaVersion = stream?.schema_version ?? schemaVersion
  if (events.some((event) => event.schemaVersion !== actualSchemaVersion)) throw new HistoryBatchError(`unsupported history schema version: ${events[0].schemaVersion}`)

  const existing = events.map((event) => conn.prepare(
    'SELECT invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json FROM agent_history_events WHERE invocation_id = ? AND (idempotency_key = ? OR event_id = ?)'
  ).get(invocationId, event.idempotencyKey, event.eventId) as EventRow | undefined)
  if (existing.some(Boolean)) {
    const exactDuplicate = existing.every((row, index) => row !== undefined && historyEventsEqual(fromRow(row), { ...events[index], payload: JSON.parse(serialized[index]) }))
    if (!exactDuplicate) {
      const conflicting = events.find((event, index) => existing[index] && !historyEventsEqual(fromRow(existing[index]!), { ...event, payload: JSON.parse(serialized[index]) }))
      throw new HistoryIdempotencyConflict(conflicting?.idempotencyKey ?? events[0].idempotencyKey)
    }
    for (const target of options.projectionTargets ?? []) {
      if (!options.sessionId || target.sessionId !== options.sessionId || !events.some((event) => event.eventId === target.canonicalEventId)) {
        throw new HistoryBatchError('projection target must be coupled to this session and an event in the canonical batch')
      }
      enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target)
    }
    return { version: actualVersion, duplicate: true }
  }
  if (expectedVersion !== actualVersion) throw new HistoryVersionConflict(expectedVersion, actualVersion)
  if (events[0].schemaVersion !== (stream?.schema_version ?? schemaVersion)) throw new HistoryBatchError(`unsupported history schema version: ${events[0].schemaVersion}`)
  for (let index = 0; index < events.length; index += 1) {
    const expectedSequence = actualVersion + index + 1
    if (events[index].sequence !== expectedSequence) throw new HistorySequenceConflict(expectedSequence, events[index].sequence)
  }
  let transitionState: HistoryTransitionState
  if (stream && stream.version > 0 && stream.transition_state_version === 1 && stream.transition_state_json !== null) {
    transitionState = decodeTransitionState(stream.transition_state_json, invocationId)
  } else if (stream && (stream.transition_state_version !== null || stream.transition_state_json !== null)) {
    throw new HistoryBatchError('HISTORY_TRANSITION_STATE_UNSUPPORTED')
  } else if (stream && stream.version > 0) {
    throw new HistoryBatchError('HISTORY_TRANSITION_STATE_REQUIRES_PREPARE')
  } else {
    transitionState = createHistoryTransitionState([])
  }
  const nextTransitionState = advanceHistoryTransitionState(transitionState, events)

  const sessionId = options.sessionId ?? stream?.session_id ?? null
  const sessionSequences = new Array<number | null>(events.length).fill(null)
  if (sessionId) {
    conn.prepare(`INSERT INTO session_event_cursor(session_id, next_seq) VALUES(?, 0)
      ON CONFLICT(session_id) DO NOTHING`).run(sessionId)
    const cursor = conn.prepare('SELECT next_seq FROM session_event_cursor WHERE session_id=?').get(sessionId) as { next_seq: number }
    const firstSessionSeq = cursor.next_seq + 1
    conn.prepare('UPDATE session_event_cursor SET next_seq=next_seq+? WHERE session_id=?').run(events.length, sessionId)
    for (let index = 0; index < events.length; index += 1) sessionSequences[index] = firstSessionSeq + index
  }
  const allocateCommitOrder = conn.prepare('INSERT INTO agent_history_commit_cursor(allocated_at) VALUES(?)')
  const commitOrders = events.map(() => {
    const allocation = allocateCommitOrder.run(now()) as { lastInsertRowid: number | bigint }
    const order = Number(allocation.lastInsertRowid)
    if (!Number.isSafeInteger(order) || order < 1) throw new HistoryBatchError('canonical commit order exceeded SQLite integer identity range')
    return order
  })

  conn.prepare(`
    INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id, transition_state_version, transition_state_json)
    VALUES(?, ?, ?, ?, 1, ?)
    ON CONFLICT(invocation_id) DO NOTHING
  `).run(invocationId, actualVersion, events[0].schemaVersion, sessionId, JSON.stringify(transitionState))
  if (options.sessionId && !stream?.session_id) {
    conn.prepare('UPDATE agent_history_streams SET session_id = ? WHERE invocation_id = ? AND session_id IS NULL').run(options.sessionId, invocationId)
  }
  const insert = conn.prepare(`
    INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id, commit_order, session_seq)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  events.forEach((event, index) => {
    insert.run(invocationId, event.sequence, event.eventId, event.idempotencyKey, event.turnId, event.schemaVersion,
      event.kind, serialized[index], now(), sessionId, commitOrders[index], sessionSequences[index])
    replaceSpillReferenceOwnerInTransaction(conn, 'agent_history_events', spillHistoryOwnerKey(invocationId, event.eventId), serialized[index], now())
  })
  const registerRepair = conn.prepare(`
    INSERT OR IGNORE INTO canonical_projection_repairs(
      repair_id, session_id, invocation_id, repair_kind, target_key, status,
      attempts, idempotency_key, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `)
  for (const event of events) {
    const eventPayload = event.payload && typeof event.payload === 'object' ? event.payload as { sessionLedger?: unknown } : undefined
    const eventLedger = eventPayload?.sessionLedger && typeof eventPayload.sessionLedger === 'object'
      ? eventPayload.sessionLedger as { location?: unknown }
      : undefined
    const eventLocation = eventLedger?.location && typeof eventLedger.location === 'object'
      ? eventLedger.location as { workDir?: unknown; sessionId?: unknown; createdAt?: unknown }
      : undefined
    if (!eventLocation || typeof eventLocation.workDir !== 'string' || typeof eventLocation.sessionId !== 'string' || !Number.isFinite(eventLocation.createdAt)) continue
    registerRepair.run(
      `${invocationId}:invocation-projections:${event.eventId}`, sessionId, invocationId,
      'invocation-projections', event.eventId, `${invocationId}:repair:invocation-projections:${event.eventId}`, now()
    )
  }
  const version = actualVersion + events.length
  conn.prepare('UPDATE agent_history_streams SET version = ?, transition_state_version = 1, transition_state_json = ? WHERE invocation_id = ?')
    .run(version, JSON.stringify(nextTransitionState), invocationId)
  for (const target of options.projectionTargets ?? []) {
    if (!options.sessionId || target.sessionId !== options.sessionId || !events.some((event) => event.eventId === target.canonicalEventId)) {
      throw new HistoryBatchError('projection target must be coupled to this session and an event in the canonical batch')
    }
    enqueueCanonicalLedgerProjectionTargetInTransaction(conn, target)
  }
  if (options.processGeneration !== undefined) {
    conn.prepare('UPDATE canonical_history_recovery_work SET owner_generation=? WHERE invocation_id=?')
      .run(options.processGeneration, invocationId)
  }
  return { version, duplicate: false }
}

function decodeTransitionState(json: string, invocationId: string): HistoryTransitionState {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new HistoryBatchError('HISTORY_TRANSITION_STATE_CORRUPT') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HistoryBatchError('HISTORY_TRANSITION_STATE_CORRUPT')
  const state = value as HistoryTransitionState
  const keys = Object.keys(value).sort()
  const expectedKeys = ['approvalIdentityByPendingId', 'deferredTodoIds', 'invocationId', 'pendingApprovals', 'pendingToolCalls', 'terminalKind', 'turnId', 'unconsumedRetryApprovals'].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
    JSON.stringify(state) !== json || state.invocationId !== invocationId || typeof state.turnId !== 'string' || !state.turnId ||
    !Array.isArray(state.pendingToolCalls) || !Array.isArray(state.pendingApprovals) ||
    !Array.isArray(state.approvalIdentityByPendingId) || !Array.isArray(state.deferredTodoIds) ||
    !Array.isArray(state.unconsumedRetryApprovals) ||
    !isSortedUniqueStrings(state.pendingToolCalls) || !isSortedUniqueStrings(state.pendingApprovals) ||
    !isSortedUniqueStrings(state.deferredTodoIds) ||
    !Array.isArray(state.approvalIdentityByPendingId) || state.approvalIdentityByPendingId.some((entry) =>
      !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || typeof entry[1] !== 'string' || !entry[1]) ||
    !isSortedUniquePairs(state.approvalIdentityByPendingId) ||
    state.approvalIdentityByPendingId.some(([pendingId]) => !state.pendingApprovals.includes(pendingId)) ||
    !Array.isArray(state.unconsumedRetryApprovals) || state.unconsumedRetryApprovals.some((entry) =>
      !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] ||
      !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1]) ||
      Object.keys(entry[1]).sort().join(',') !== 'inputHash,toolName' || typeof entry[1].toolName !== 'string' || !entry[1].toolName.trim() ||
      typeof entry[1].inputHash !== 'string' || !/^[a-f0-9]{64}$/i.test(entry[1].inputHash)) ||
    !isSortedUniquePairs(state.unconsumedRetryApprovals) ||
    (state.terminalKind !== null && !['invocation-parked', 'invocation-interrupted', 'invocation-completed', 'invocation-failed'].includes(state.terminalKind)) ||
    ((state.terminalKind === 'invocation-completed' || state.terminalKind === 'invocation-failed') &&
      (state.pendingToolCalls.length > 0 || state.pendingApprovals.length > 0))) {
    throw new HistoryBatchError('HISTORY_TRANSITION_STATE_CORRUPT')
  }
  return state
}

function isSortedUniqueStrings(values: readonly unknown[]): values is readonly string[] {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    const previous = values[index - 1]
    if (typeof value !== 'string' || !value || (index > 0 && typeof previous === 'string' && previous >= value)) return false
  }
  return true
}

function isSortedUniquePairs<T>(values: readonly (readonly [string, T])[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1][0] < value[0])
}
