import type { DatabaseSync } from 'node:sqlite'
import {
  HistoryBatchError,
  HistoryIdempotencyConflict,
  HistorySequenceConflict,
  HistoryVersionConflict,
  historyEventsEqual,
  validateHistoryBatch,
  validateHistoryTransition,
  type HistoryAppendResult,
  type HistoryEvent
} from '../../packages/agent-sdk/src/history'

type StreamRow = { invocation_id: string; version: number; schema_version: number; session_id: string | null }
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
  options: { schemaVersion?: number; sessionId?: string; now?: () => number } = {}
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
  const stream = conn.prepare('SELECT invocation_id, version, schema_version, session_id FROM agent_history_streams WHERE invocation_id = ?').get(invocationId) as StreamRow | undefined
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
    return { version: actualVersion, duplicate: true }
  }
  if (expectedVersion !== actualVersion) throw new HistoryVersionConflict(expectedVersion, actualVersion)
  if (events[0].schemaVersion !== (stream?.schema_version ?? schemaVersion)) throw new HistoryBatchError(`unsupported history schema version: ${events[0].schemaVersion}`)
  for (let index = 0; index < events.length; index += 1) {
    const expectedSequence = actualVersion + index + 1
    if (events[index].sequence !== expectedSequence) throw new HistorySequenceConflict(expectedSequence, events[index].sequence)
  }
  const previousEvents = conn.prepare(`
    SELECT invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json
    FROM agent_history_events WHERE invocation_id = ? ORDER BY sequence ASC
  `).all(invocationId).map((row) => fromRow(row as EventRow))
  validateHistoryTransition(previousEvents, events)

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
    INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(invocation_id) DO NOTHING
  `).run(invocationId, actualVersion, events[0].schemaVersion, sessionId)
  if (options.sessionId && !stream?.session_id) {
    conn.prepare('UPDATE agent_history_streams SET session_id = ? WHERE invocation_id = ? AND session_id IS NULL').run(options.sessionId, invocationId)
  }
  const insert = conn.prepare(`
    INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at, session_id, commit_order, session_seq)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  events.forEach((event, index) => insert.run(invocationId, event.sequence, event.eventId, event.idempotencyKey, event.turnId, event.schemaVersion,
    event.kind, serialized[index], now(), sessionId, commitOrders[index], sessionSequences[index]))
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
  conn.prepare('UPDATE agent_history_streams SET version = ? WHERE invocation_id = ?').run(version, invocationId)
  if (sessionId) {
    // Canonical writes may advance the session watermark without changing a legacy message row
    // (for example a compaction snapshot or continuation context). Keep the API eligibility
    // fence coupled to every append path, including callers of this low-level transaction API.
    const hasApiEligibilityFence = Boolean(conn.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name='session_message_content_cutover'`).get())
    if (hasApiEligibilityFence) {
      conn.prepare(`UPDATE session_message_content_cutover
        SET api_read_mode=CASE WHEN api_read_mode='canonical' THEN 'revalidation-required' ELSE api_read_mode END,
            updated_at=? WHERE session_id=?`).run(now(), sessionId)
      conn.prepare('DELETE FROM canonical_session_api_context_eligibility WHERE session_id=?').run(sessionId)
    }
  }
  return { version, duplicate: false }
}
