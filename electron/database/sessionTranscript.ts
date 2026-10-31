import type { AppDatabase } from './sqliteStore'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDbConnection } from './sqliteStore'
import { runInTransaction } from './transaction'
import path from 'node:path'
import { readSourceTruthSpillSync, type SpillDescriptor } from '../storage/spillProtocol'
import { assertSpillReferencePayloadStrict, replaceSpillReferenceOwnerInTransaction, spillTranscriptOwnerKey } from '../storage/spillReferenceIndex'
import { restoreLegacySessionContextSnapshot, restoreSessionContext } from '../../packages/agent-sdk/src/sessionContext'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import type { CanonicalModelMessage } from '../../packages/agent-sdk/src/model'
import { appendSqliteAgentHistoryBatchInTransaction } from './agentHistoryStorage'

export type TranscriptMessage = Readonly<Record<string, unknown>>
export type SessionTranscript = Readonly<{ sessionId: string; version: number; lastTurnId?: string; status: 'ready' | 'commit_uncertain' | 'blocked'; messages: readonly TranscriptMessage[] }>

function transcriptPayloadHash(outcome: string, messagesJson: string): string {
  return createHash('sha256').update(JSON.stringify({ outcome, messagesJson })).digest('hex')
}

function stableReviewEncode(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableReviewEncode).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableReviewEncode(record[key])}`).join(',')}}`
}

function sessionReviewPayloadHash(input: {
  sessionId: string; sessionGeneration: string; turnId: string; expectedVersion: number
  outcome: string; messages: readonly TranscriptMessage[]; operatorId: string; rationale: string
}, sourceInvocationId: string | null, sourceTerminalEventId: string | null): string {
  return createHash('sha256').update(stableReviewEncode({
    protocol: 2, sessionId: input.sessionId, sessionGeneration: input.sessionGeneration,
    sourceTurnId: input.turnId, sourceInvocationId, sourceTerminalEventId,
    expectedVersion: input.expectedVersion, outcome: input.outcome, messages: input.messages,
    operatorId: input.operatorId.trim(), rationale: input.rationale.trim()
  })).digest('hex')
}

export function readSessionTranscript(db: AppDatabase, sessionId: string, options: Readonly<{ version?: number }> = {}): SessionTranscript {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
  const row = conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get(sessionId) as { version: number; last_turn_id: string | null; status: SessionTranscript['status'] } | undefined
  const currentVersion = row?.version ?? 0
  const version = options.version ?? currentVersion
  if (!Number.isSafeInteger(version) || version < 0 || version > currentVersion) throw new Error('SESSION_TRANSCRIPT_VERSION_NOT_FOUND')
  if (version === 0) return { sessionId, version: 0,
    ...(options.version === undefined && row?.last_turn_id ? { lastTurnId: row.last_turn_id } : {}),
    status: row?.status ?? 'ready', messages: [] }
  const entry = conn.prepare(`SELECT turn_id,messages_json,base_version,version,outcome,context_selection_json
    FROM session_transcript_entries WHERE session_id=? AND version=?`).get(sessionId, version) as
    { turn_id: string; messages_json: string; base_version: number; version: number; outcome: string; context_selection_json: string | null } | undefined
  const receipt = conn.prepare(`SELECT turn_id,payload_sha256,base_version,next_version,outcome,event_start,event_end
    FROM session_turn_commit_receipts WHERE session_id=? AND next_version=?`).get(sessionId, version) as
    { turn_id: string; payload_sha256: string; base_version: number; next_version: number; outcome: string; event_start: number | null; event_end: number | null } | undefined
  if (!entry && !receipt) throw new Error('SESSION_TRANSCRIPT_VERSION_NOT_FOUND')

  let entrySelection: { contextProtocol?: unknown; target?: unknown } | undefined
  if (entry?.context_selection_json) {
    entrySelection = JSON.parse(entry.context_selection_json) as { contextProtocol?: unknown; target?: unknown }
    if (entrySelection.contextProtocol !== 2 || !['working', 'failure', 'park-baseline'].includes(String(entrySelection.target))) {
      throw new Error('SESSION_TRANSCRIPT_SELECTION_INVALID')
    }
  }
  const receiptTerminalRow = receipt && Number.isSafeInteger(receipt.event_end)
    ? conn.prepare(`SELECT invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,session_seq
        FROM agent_history_events WHERE session_id=? AND session_seq=?`).get(sessionId, receipt.event_end!) as
      { invocation_id: string; sequence: number; event_id: string; idempotency_key: string; turn_id: string; schema_version: number; kind: HistoryEvent['kind']; payload_json: string; session_seq: number } | undefined
    : undefined
  const receiptTerminalPayload = receiptTerminalRow?.payload_json
    ? JSON.parse(receiptTerminalRow.payload_json) as { contextSelection?: { contextProtocol?: unknown; target?: unknown }; review?: { sourceTurnId?: unknown } }
    : undefined
  const receiptSelection = receiptTerminalPayload?.contextSelection
  const receiptSelectsProtocol2 = receiptSelection?.contextProtocol === 2
  if (entrySelection && (!receipt || !receiptSelectsProtocol2)) throw new Error('SESSION_TRANSCRIPT_SELECTION_RECEIPT_MISSING')
  const selection = entrySelection ?? (receiptSelectsProtocol2 ? receiptSelection : undefined)
  if (selection) {
    const isReviewReceipt = Boolean(receipt?.turn_id.startsWith('session-review-turn:'))
    if (!receipt || !Number.isSafeInteger(receipt.event_start) || !Number.isSafeInteger(receipt.event_end) ||
      receipt.event_start! > receipt.event_end! || !receiptTerminalRow || receiptTerminalRow.turn_id !== receipt.turn_id ||
      !['invocation-completed', 'invocation-failed', 'invocation-interrupted', 'invocation-parked'].includes(receiptTerminalRow.kind) ||
      selection.contextProtocol !== 2 || !['working', 'failure', 'park-baseline'].includes(String(selection.target)) ||
      receiptSelection?.contextProtocol !== 2 || receiptSelection.target !== selection.target ||
      (entry && (entry.version !== receipt.next_version || entry.base_version !== receipt.base_version || entry.outcome !== receipt.outcome))) {
      throw new Error('SESSION_TRANSCRIPT_SELECTION_TERMINAL_MISMATCH')
    }
    const receiptFirstEvent = conn.prepare(`SELECT turn_id FROM agent_history_events WHERE session_id=? AND session_seq=?`)
      .get(sessionId, receipt.event_start) as { turn_id: string } | undefined
    if (!receiptFirstEvent || receiptFirstEvent.turn_id !== receipt.turn_id) throw new Error('SESSION_TRANSCRIPT_SELECTION_RECEIPT_RANGE_INVALID')
    const eventRows = conn.prepare(`SELECT invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json
      FROM agent_history_events WHERE session_id=? AND session_seq<=? ORDER BY session_seq ASC`)
      .all(sessionId, receipt.event_end) as Array<{ invocation_id: string; sequence: number; event_id: string; idempotency_key: string; turn_id: string; schema_version: number; kind: HistoryEvent['kind']; payload_json: string }>
    const events: HistoryEvent[] = eventRows.map((event) => ({ invocationId: event.invocation_id, sequence: event.sequence,
      eventId: event.event_id, idempotencyKey: event.idempotency_key, turnId: event.turn_id, schemaVersion: event.schema_version,
      kind: event.kind, payload: JSON.parse(event.payload_json) as unknown }))
    const restored = restoreSessionContext({ committedVersion: version, events })
    const terminal = events.find((event) => event.eventId === receiptTerminalRow!.event_id)
    const terminalSelection = terminal?.payload && typeof terminal.payload === 'object'
      ? (terminal.payload as { contextSelection?: { contextProtocol?: unknown; target?: unknown; baseVersion?: unknown } }).contextSelection
      : undefined
    if (!terminal || terminal.turnId !== receipt.turn_id || terminalSelection?.contextProtocol !== 2 ||
      terminalSelection.target !== selection.target ||
      (terminalSelection.baseVersion !== undefined && terminalSelection.baseVersion !== receipt.base_version)) {
      throw new Error('SESSION_TRANSCRIPT_SELECTION_TERMINAL_MISMATCH')
    }
    const reviewSourceTurnId = receiptTerminalPayload?.review?.sourceTurnId
    if (isReviewReceipt) {
      const reviewSeed = events.find((event) => event.turnId === receipt.turn_id && event.kind === 'invocation-context-committed')
      const reviewMetadata = reviewSeed?.payload && typeof reviewSeed.payload === 'object'
        ? (reviewSeed.payload as { review?: { resolutionId?: unknown; sourceTurnId?: unknown; baseVersion?: unknown; reviewPayloadSha256?: unknown; outcome?: unknown } }).review
        : undefined
      const audit = typeof reviewMetadata?.resolutionId === 'string'
        ? conn.prepare(`SELECT turn_id,resolved_version FROM session_transcript_reconciliations WHERE resolution_id=? AND session_id=?`)
          .get(reviewMetadata.resolutionId, sessionId) as { turn_id: string; resolved_version: number } | undefined
        : undefined
      if (!reviewMetadata || typeof reviewSourceTurnId !== 'string' || reviewMetadata.sourceTurnId !== reviewSourceTurnId ||
        (entry && reviewMetadata.sourceTurnId !== entry.turn_id) || reviewMetadata.outcome !== receipt.outcome ||
        reviewMetadata.baseVersion !== receipt.base_version || reviewMetadata.reviewPayloadSha256 !== receipt.payload_sha256 ||
        !audit || audit.turn_id !== reviewMetadata.sourceTurnId || audit.resolved_version !== version) {
        throw new Error('SESSION_TRANSCRIPT_REVIEW_RECEIPT_MISMATCH')
      }
    } else if (entry && entry.turn_id !== receipt.turn_id) throw new Error('SESSION_TRANSCRIPT_SELECTION_TERMINAL_MISMATCH')
    const outcomeMatches = isReviewReceipt ? receiptTerminalRow.kind === 'invocation-completed'
      : receiptTerminalRow.kind === 'invocation-completed' ? receipt.outcome === 'completed'
        : receiptTerminalRow.kind === 'invocation-failed' ? receipt.outcome === 'failed' || receipt.outcome === 'timed_out'
          : receiptTerminalRow.kind === 'invocation-parked' ? receipt.outcome === 'interrupted'
            : receipt.outcome === 'cancelled' || receipt.outcome === 'interrupted'
    if (!outcomeMatches) throw new Error('SESSION_TRANSCRIPT_SELECTION_OUTCOME_MISMATCH')
    return { sessionId, version, lastTurnId: isReviewReceipt ? reviewSourceTurnId as string : entry?.turn_id ?? receipt.turn_id,
      status: row?.status ?? 'ready', messages: [...restored.committed] as unknown as TranscriptMessage[] }
  }

  if (!entry) throw new Error('SESSION_TRANSCRIPT_VERSION_NOT_FOUND')
  let messages = JSON.parse(entry.messages_json) as unknown
  if (messages && typeof messages === 'object' && '__spaceassistant_session_transcript_spill_v1' in messages) {
    const descriptor = (messages as { __spaceassistant_session_transcript_spill_v1: SpillDescriptor }).__spaceassistant_session_transcript_spill_v1
    const main = conn.prepare('PRAGMA database_list').all().find((database) => (database as { name?: string }).name === 'main') as { file?: string } | undefined
    if (!main?.file) throw new Error('session transcript spill requires a file-backed database')
    messages = JSON.parse(readSourceTruthSpillSync(path.join(path.dirname(main.file), 'spill'), descriptor)) as unknown
  }
  if (!Array.isArray(messages)) throw new Error('SESSION_TRANSCRIPT_LEGACY_SNAPSHOT_INVALID')
  const restored = restoreLegacySessionContextSnapshot({ invocationId: `legacy-transcript:${sessionId}`,
    turnId: entry.turn_id, committedVersion: version, messages: messages as CanonicalModelMessage[] })
  return { sessionId, version, lastTurnId: entry.turn_id, status: row?.status ?? 'ready',
    messages: [...restored.committed] as unknown as TranscriptMessage[] }
  })
}

export type CommitSessionTranscriptInput = { sessionId: string; turnId: string; baseVersion: number; outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; protocol?: 2; messages?: readonly TranscriptMessage[]; contextSelection?: Readonly<{ contextProtocol: 2; target: 'working' | 'failure' | 'park-baseline' }>; storedMessagesJson?: string; executionLease?: { sessionId: string; turnId: string; ownerId: string; generation: number }; now?: number }
export type CommitSessionTranscriptResult = { committed: true; version: number } | { committed: false; reason: 'version-conflict' | 'commit-uncertain' | 'idempotency-conflict'; version: number }

export function commitSessionTranscriptInTransaction(conn: DatabaseSync, input: CommitSessionTranscriptInput): CommitSessionTranscriptResult {
  const now = input.now ?? Date.now()
  if (input.protocol === 2
    ? !input.contextSelection || input.messages !== undefined
    : !input.messages || input.contextSelection !== undefined) {
    throw new Error('session transcript commit intent does not match its protocol')
  }
  const messagesJson = input.messages ? JSON.stringify(input.messages) : '[]'
  const contextSelectionJson = input.contextSelection ? JSON.stringify(input.contextSelection) : null
  const storedMessagesJson = input.storedMessagesJson ?? messagesJson
  assertSpillReferencePayloadStrict(storedMessagesJson)
  const payloadSha256 = input.contextSelection
    ? transcriptPayloadHash(input.outcome, JSON.stringify({ contextSelection: input.contextSelection }))
    : transcriptPayloadHash(input.outcome, messagesJson)
  return runInTransaction(conn, () => {
    const receipt = conn.prepare('SELECT payload_sha256,next_version FROM session_turn_commit_receipts WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId) as { payload_sha256: string; next_version: number } | undefined
    if (receipt) return receipt.payload_sha256 === payloadSha256
      ? { committed: true as const, version: receipt.next_version }
      : { committed: false as const, reason: 'idempotency-conflict' as const, version: receipt.next_version }
    if (input.executionLease) {
      const lease = input.executionLease
      // final-check / invariant SYS-SESSIONLEASE-001: prove both durable owner records before this terminal commit.
      const claim = conn.prepare(`SELECT owner_id,generation,status FROM session_execution_claims WHERE session_id=? AND turn_id=?`)
        .get(input.sessionId, input.turnId) as { owner_id: string; generation: number; status: string } | undefined
      const queue = conn.prepare(`SELECT owner_id,generation,status FROM session_execution_queue WHERE session_id=? AND turn_id=?`)
        .get(input.sessionId, input.turnId) as { owner_id: string; generation: number; status: string } | undefined
      const liveStatuses = ['claimed', 'executing']
      if (lease.sessionId !== input.sessionId || lease.turnId !== input.turnId || !lease.ownerId.trim() ||
        !Number.isSafeInteger(lease.generation) || lease.generation < 1 ||
        !claim || claim.owner_id !== lease.ownerId || claim.generation !== lease.generation || !liveStatuses.includes(claim.status) ||
        !queue || queue.owner_id !== lease.ownerId || queue.generation !== lease.generation || !liveStatuses.includes(queue.status) ||
        claim.status !== queue.status) {
        throw new Error('SESSION_EXECUTION_CLAIM_FENCED')
      }
    }
    const existing = conn.prepare('SELECT base_version,version,outcome,messages_json,context_selection_json FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId) as { base_version: number; version: number; outcome: string; messages_json: string; context_selection_json: string | null } | undefined
    if (existing) {
      if (existing.outcome !== input.outcome || existing.messages_json !== storedMessagesJson || existing.context_selection_json !== contextSelectionJson) return { committed: false as const, reason: 'idempotency-conflict' as const, version: existing.version }
      const eventRange = conn.prepare(`SELECT MIN(session_seq) AS event_start, MAX(session_seq) AS event_end
        FROM agent_history_events WHERE session_id=? AND turn_id=? AND session_seq IS NOT NULL`).get(input.sessionId, input.turnId) as { event_start: number | null; event_end: number | null } | undefined
      conn.prepare(`INSERT OR IGNORE INTO session_turn_commit_receipts(session_id,turn_id,payload_sha256,base_version,next_version,outcome,event_start,event_end,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(input.sessionId, input.turnId, payloadSha256, existing.base_version, existing.version, existing.outcome,
        eventRange?.event_start ?? null, eventRange?.event_end ?? null, now)
      return { committed: true as const, version: existing.version }
    }
    const checkpoint = conn.prepare('SELECT version,status FROM session_transcript_checkpoints WHERE session_id=?').get(input.sessionId) as { version: number; status: 'ready' | 'commit_uncertain' | 'blocked' } | undefined
    const currentVersion = checkpoint?.version ?? 0
    if (checkpoint?.status !== undefined && checkpoint.status !== 'ready') return { committed: false as const, reason: 'commit-uncertain' as const, version: currentVersion }
    if (currentVersion !== input.baseVersion) {
      conn.prepare(`INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,?,?,'commit_uncertain',?)
        ON CONFLICT(session_id) DO UPDATE SET status='commit_uncertain',updated_at=excluded.updated_at`).run(input.sessionId, currentVersion, input.turnId, now)
      return { committed: false as const, reason: 'version-conflict' as const, version: currentVersion }
    }
    const nextVersion = currentVersion + 1
    const eventRange = conn.prepare(`SELECT MIN(session_seq) AS event_start, MAX(session_seq) AS event_end
      FROM agent_history_events WHERE session_id=? AND turn_id=? AND session_seq IS NOT NULL`).get(input.sessionId, input.turnId) as { event_start: number | null; event_end: number | null } | undefined
    conn.prepare('INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,context_selection_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(input.sessionId, input.turnId, input.baseVersion, nextVersion, input.outcome, storedMessagesJson, contextSelectionJson, now)
    replaceSpillReferenceOwnerInTransaction(conn, 'session_transcript_entries', spillTranscriptOwnerKey(input.sessionId, nextVersion), storedMessagesJson, now)
    conn.prepare(`INSERT INTO session_turn_commit_receipts(session_id,turn_id,payload_sha256,base_version,next_version,outcome,event_start,event_end,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.sessionId, input.turnId, payloadSha256, input.baseVersion, nextVersion, input.outcome, eventRange?.event_start ?? null, eventRange?.event_end ?? null, now)
    conn.prepare(`INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,?,?,'ready',?)
      ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,last_turn_id=excluded.last_turn_id,status='ready',updated_at=excluded.updated_at`).run(input.sessionId, nextVersion, input.turnId, now)
    if (input.executionLease) {
      const lease = input.executionLease
      const claimUpdated = conn.prepare(`UPDATE session_execution_claims SET status='transcript_committed',updated_at=?
        WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('claimed','executing')`)
        .run(now, input.sessionId, input.turnId, lease.ownerId, lease.generation)
      const queueUpdated = conn.prepare(`UPDATE session_execution_queue SET status='transcript_committed',updated_at=?
        WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('claimed','executing')`)
        .run(now, input.sessionId, input.turnId, lease.ownerId, lease.generation)
      if (Number(claimUpdated.changes) !== 1 || Number(queueUpdated.changes) !== 1) throw new Error('SESSION_EXECUTION_CLAIM_FENCED')
    } else {
      conn.prepare(`UPDATE session_execution_claims SET status='transcript_committed',updated_at=?
        WHERE session_id=? AND turn_id=? AND status IN ('claimed','executing')`).run(now, input.sessionId, input.turnId)
      conn.prepare(`UPDATE session_execution_queue SET status='transcript_committed',updated_at=?
        WHERE session_id=? AND turn_id=? AND status IN ('claimed','executing')`).run(now, input.sessionId, input.turnId)
    }
    return { committed: true as const, version: nextVersion }
  })
}

export function commitSessionTranscript(db: AppDatabase, input: CommitSessionTranscriptInput): CommitSessionTranscriptResult {
  const result = commitSessionTranscriptInTransaction(getDbConnection(db), input)
  db.save()
  return result
}

export function claimSessionExecution(db: AppDatabase, input: { sessionId: string; turnId: string; ownerId: string; now?: number }): { acquired: true; generation: number } | { acquired: false; reason: 'owned' | 'blocked' } {
  const conn = getDbConnection(db)
  const now = input.now ?? Date.now()
  const result = runInTransaction(conn, () => {
    const checkpoint = conn.prepare('SELECT status FROM session_transcript_checkpoints WHERE session_id=?').get(input.sessionId) as { status: string } | undefined
    if (checkpoint && checkpoint.status !== 'ready') return { acquired: false as const, reason: 'blocked' as const }
    const claim = conn.prepare('SELECT turn_id,owner_id,generation,status FROM session_execution_claims WHERE session_id=?').get(input.sessionId) as { turn_id: string; owner_id: string; generation: number; status: string } | undefined
    const queue = conn.prepare('SELECT generation,status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId) as { generation: number; status: string } | undefined
    if (!queue) conn.prepare(`INSERT INTO session_execution_queue(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at) VALUES(?,?,?,0,'queued',?,?)`).run(input.sessionId, input.turnId, input.ownerId, now, now)
    if (claim?.status === 'transcript_committed') return { acquired: false as const, reason: 'owned' as const }
    if (claim && claim.status !== 'queued' && claim.turn_id === input.turnId && claim.owner_id === input.ownerId) return { acquired: true as const, generation: claim.generation }
    if (claim && claim.status !== 'queued' && claim.turn_id) return { acquired: false as const, reason: 'owned' as const }
    const head = conn.prepare(`SELECT turn_id FROM session_execution_queue WHERE session_id=? AND status='queued' ORDER BY enqueued_at ASC, rowid ASC LIMIT 1`).get(input.sessionId) as { turn_id: string } | undefined
    if (head?.turn_id !== input.turnId) return { acquired: false as const, reason: 'owned' as const }
    const generation = (claim?.generation ?? queue?.generation ?? 0) + 1
    conn.prepare(`UPDATE session_execution_queue SET status='claimed',owner_id=?,generation=?,updated_at=? WHERE session_id=? AND turn_id=? AND status='queued'`).run(input.ownerId, generation, now, input.sessionId, input.turnId)
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at) VALUES(?,?,?,?, 'claimed',?,?)
      ON CONFLICT(session_id) DO UPDATE SET turn_id=excluded.turn_id,owner_id=excluded.owner_id,generation=excluded.generation,status='claimed',updated_at=excluded.updated_at`).run(input.sessionId, input.turnId, input.ownerId, generation, now, now)
    return { acquired: true as const, generation }
  })
  db.save()
  return result
}

export function releaseSessionExecution(db: AppDatabase, input: { sessionId: string; turnId: string; ownerId: string; generation: number }): boolean {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const released = conn.prepare(`UPDATE session_execution_claims SET turn_id='',owner_id='',status='queued',updated_at=?
    WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('claimed','executing','transcript_committed')`).run(Date.now(), input.sessionId, input.turnId, input.ownerId, input.generation)
    if (Number(released.changes) > 0) conn.prepare(`DELETE FROM session_execution_queue WHERE session_id=? AND turn_id=? AND owner_id=?`).run(input.sessionId, input.turnId, input.ownerId)
    return Number(released.changes) > 0
  })
  if (result) db.save()
  return result
}

/** Removes a turn that left the FIFO wait before it acquired execution ownership. */
export function cancelQueuedSessionExecution(db: AppDatabase, input: { sessionId: string; turnId: string; ownerId: string }): boolean {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => conn.prepare(`DELETE FROM session_execution_queue
    WHERE session_id=? AND turn_id=? AND owner_id=? AND status='queued'`).run(input.sessionId, input.turnId, input.ownerId))
  const removed = Number(result.changes) > 0
  if (removed) db.save()
  return removed
}


export function markSessionExecutionStarted(db: AppDatabase, input: { sessionId: string; turnId: string; ownerId: string; generation: number }): boolean {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const changed = conn.prepare(`UPDATE session_execution_claims SET status='executing',updated_at=?
    WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='claimed'`).run(Date.now(), input.sessionId, input.turnId, input.ownerId, input.generation)
    if (Number(changed.changes) > 0) conn.prepare(`UPDATE session_execution_queue SET status='executing',updated_at=? WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='claimed'`).run(Date.now(), input.sessionId, input.turnId, input.ownerId, input.generation)
    return Number(changed.changes) > 0
  })
  if (result) db.save()
  return result
}

export function markSessionExecutionUncertain(db: AppDatabase, input: { sessionId: string; turnId: string; ownerId: string; generation: number }): boolean {
  const conn = getDbConnection(db)
  const now = Date.now()
  let changed: boolean
  try {
    changed = runInTransaction(conn, () => {
      const result = conn.prepare(`UPDATE session_execution_claims SET status='commit_uncertain',updated_at=?
        WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('claimed','executing','transcript_committed')`).run(now, input.sessionId, input.turnId, input.ownerId, input.generation)
      if (Number(result.changes) === 0) return false
      conn.prepare(`UPDATE session_execution_queue SET status='commit_uncertain',updated_at=? WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=?`).run(now, input.sessionId, input.turnId, input.ownerId, input.generation)
      conn.prepare(`INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,0,?,'commit_uncertain',?)
        ON CONFLICT(session_id) DO UPDATE SET status='commit_uncertain',last_turn_id=excluded.last_turn_id,updated_at=excluded.updated_at`).run(input.sessionId, input.turnId, now)
      return true
    })
  } catch (checkpointError) {
    // Keep the execution fence durable even if writing the checkpoint itself failed.
    // Startup recovery will recreate the uncertain checkpoint after storage recovers.
    changed = runInTransaction(conn, () => {
      const result = conn.prepare(`UPDATE session_execution_claims SET status='commit_uncertain',updated_at=?
        WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('claimed','executing','transcript_committed')`).run(now, input.sessionId, input.turnId, input.ownerId, input.generation)
      if (Number(result.changes) === 0) return false
      conn.prepare(`UPDATE session_execution_queue SET status='commit_uncertain',updated_at=? WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=?`).run(now, input.sessionId, input.turnId, input.ownerId, input.generation)
      return true
    })
    if (!changed) throw checkpointError
  }
  if (changed) db.save()
  return changed
}

/** Startup recovery for claims owned by the process that exited before recovery began. */
export function recoverStaleSessionExecutionClaims(db: AppDatabase, now = Date.now()): { releasedUnstarted: number; markedUncertain: number; repairedCheckpoints: number } {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const claims = conn.prepare(`SELECT session_id,turn_id,owner_id,generation,status FROM session_execution_claims
      WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')`).all() as Array<{ session_id: string; turn_id: string; owner_id: string; generation: number; status: 'claimed' | 'executing' | 'transcript_committed' | 'commit_uncertain' }>
    let releasedUnstarted = 0
    let markedUncertain = 0
    let repairedCheckpoints = 0
    for (const claim of claims) {
      if (claim.status === 'claimed') {
        const released = conn.prepare(`UPDATE session_execution_claims SET turn_id='',owner_id='',status='queued',updated_at=?
          WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='claimed'`)
          .run(now, claim.session_id, claim.turn_id, claim.owner_id, claim.generation)
        if (Number(released.changes) === 0) continue
        conn.prepare(`DELETE FROM session_execution_queue WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='claimed'`)
          .run(claim.session_id, claim.turn_id, claim.owner_id, claim.generation)
        releasedUnstarted += 1
        continue
      }

      const uncertain = claim.status === 'executing' || claim.status === 'transcript_committed'
        ? conn.prepare(`UPDATE session_execution_claims SET status='commit_uncertain',updated_at=?
          WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('executing','transcript_committed')`)
          .run(now, claim.session_id, claim.turn_id, claim.owner_id, claim.generation)
        : { changes: 1 }
      if (Number(uncertain.changes) === 0) continue
      conn.prepare(`UPDATE session_execution_queue SET status='commit_uncertain',updated_at=?
        WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status IN ('executing','transcript_committed','commit_uncertain')`)
        .run(now, claim.session_id, claim.turn_id, claim.owner_id, claim.generation)
      const checkpoint = conn.prepare('SELECT version,status,last_turn_id FROM session_transcript_checkpoints WHERE session_id=?')
        .get(claim.session_id) as { version: number; status: string; last_turn_id: string | null } | undefined
      if (!checkpoint) {
        conn.prepare(`INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,0,?,'commit_uncertain',?)`)
          .run(claim.session_id, claim.turn_id, now)
        repairedCheckpoints += 1
      } else if (checkpoint.status === 'ready' || (checkpoint.status === 'commit_uncertain' && checkpoint.last_turn_id === claim.turn_id)) {
        conn.prepare(`UPDATE session_transcript_checkpoints SET last_turn_id=?,status='commit_uncertain',updated_at=? WHERE session_id=?`)
          .run(claim.turn_id, now, claim.session_id)
      }
      if (claim.status === 'executing' || claim.status === 'transcript_committed') markedUncertain += 1
    }
    return { releasedUnstarted, markedUncertain, repairedCheckpoints }
  })
  if (result.releasedUnstarted > 0 || result.markedUncertain > 0 || result.repairedCheckpoints > 0) db.save()
  return result
}

/**
 * Startup reconciliation for the narrow crash window where the checkpoint entry
 * committed durably but a later persistence/response step marked the session uncertain.
 * A missing or mismatched entry stays blocked for explicit operator reconciliation.
 */
export function reconcileCommittedSessionTranscripts(db: AppDatabase, now = Date.now()): number {
  const conn = getDbConnection(db)
  const reconciled = runInTransaction(conn, () => {
    const uncertain = conn.prepare(`SELECT session_id,version,last_turn_id FROM session_transcript_checkpoints WHERE status='commit_uncertain'`).all() as Array<{ session_id: string; version: number; last_turn_id: string | null }>
    let count = 0
    for (const checkpoint of uncertain) {
      if (!checkpoint.last_turn_id) continue
      const entry = conn.prepare(`SELECT version FROM session_transcript_entries WHERE session_id=? AND turn_id=?`).get(checkpoint.session_id, checkpoint.last_turn_id) as { version: number } | undefined
      if (!entry || entry.version !== checkpoint.version) continue
      conn.prepare(`UPDATE session_transcript_checkpoints SET status='ready',updated_at=? WHERE session_id=? AND version=? AND last_turn_id=? AND status='commit_uncertain'`).run(now, checkpoint.session_id, checkpoint.version, checkpoint.last_turn_id)
      conn.prepare(`UPDATE session_execution_claims SET turn_id='',owner_id='',status='queued',updated_at=? WHERE session_id=? AND turn_id=? AND status='commit_uncertain'`).run(now, checkpoint.session_id, checkpoint.last_turn_id)
      conn.prepare(`DELETE FROM session_execution_queue WHERE session_id=? AND turn_id=? AND status='commit_uncertain'`).run(checkpoint.session_id, checkpoint.last_turn_id)
      count += 1
    }
    return count
  })
  if (reconciled > 0) db.save()
  return reconciled
}

/**
 * Resolve a missing/ambiguous transcript commit only after an operator reviewed
 * canonical History. The reviewed projection and audit receipt become durable in
 * one transaction; this path never infers messages or replays the turn.
 */
export function reconcileUncertainSessionTranscript(db: AppDatabase, input: {
  sessionId: string
  turnId: string
  expectedVersion: number
  sessionGeneration: string
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'
  messages: readonly TranscriptMessage[]
  operatorId: string
  rationale: string
  resolutionId?: string
  now?: number
}): { reconciled: true; version: number } | { reconciled: false; reason: 'invalid-review' | 'not-uncertain' | 'turn-mismatch' | 'version-mismatch' | 'already-committed' | 'idempotency-conflict' } {
  if (!input.operatorId.trim() || !input.rationale.trim() || !input.sessionId.trim() || !input.turnId.trim() || !input.sessionGeneration.trim() ||
    !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) return { reconciled: false, reason: 'invalid-review' }
  const conn = getDbConnection(db)
  const now = input.now ?? Date.now()
  const reviewKey = createHash('sha256').update(stableReviewEncode([
    'session-review-v1', input.sessionId, input.sessionGeneration, input.turnId, input.expectedVersion
  ])).digest('hex')
  const resolutionId = `session-review:${reviewKey}`
  if (input.resolutionId !== undefined && input.resolutionId !== resolutionId) return { reconciled: false, reason: 'invalid-review' }
  const repairInvocationId = `session-review-invocation:${reviewKey}`
  const repairTurnId = `session-review-turn:${reviewKey}`
  const messagesJson = JSON.stringify(input.messages)
  assertSpillReferencePayloadStrict(messagesJson)
  const result = runInTransaction(conn, () => {
    const existingAudit = conn.prepare('SELECT session_id,turn_id,resolved_version,operator_id,rationale FROM session_transcript_reconciliations WHERE resolution_id=?')
      .get(resolutionId) as { session_id: string; turn_id: string; resolved_version: number; operator_id: string; rationale: string } | undefined
    const existingStream = conn.prepare('SELECT version,session_id FROM agent_history_streams WHERE invocation_id=?').get(repairInvocationId) as
      { version: number; session_id: string | null } | undefined
    const existingReceipt = conn.prepare('SELECT payload_sha256,base_version,next_version,outcome,event_start,event_end FROM session_turn_commit_receipts WHERE session_id=? AND turn_id=?')
      .get(input.sessionId, repairTurnId) as { payload_sha256: string; base_version: number; next_version: number; outcome: string; event_start: number | null; event_end: number | null } | undefined
    const existingEvents = conn.prepare(`SELECT event_id,kind,payload_json,session_seq FROM agent_history_events
      WHERE invocation_id=? ORDER BY sequence ASC`).all(repairInvocationId) as Array<{ event_id: string; kind: string; payload_json: string; session_seq: number | null }>
    if (existingAudit || existingReceipt || existingEvents.length) {
      const priorReview = existingEvents[0]
        ? (JSON.parse(existingEvents[0].payload_json) as { review?: { sourceInvocationId?: string | null; sourceTerminalEventId?: string | null } }).review
        : undefined
      const reviewPayloadSha256 = sessionReviewPayloadHash(input, priorReview?.sourceInvocationId ?? null,
        priorReview?.sourceTerminalEventId ?? null)
      const complete = existingAudit && existingReceipt && existingEvents.length === 2 &&
        existingStream?.version === 2 && existingStream.session_id === input.sessionId &&
        existingAudit.session_id === input.sessionId && existingAudit.turn_id === input.turnId &&
        existingAudit.resolved_version === existingReceipt.next_version && existingAudit.operator_id === input.operatorId.trim() &&
        existingAudit.rationale === input.rationale.trim() && existingReceipt.payload_sha256 === reviewPayloadSha256 &&
        existingReceipt.base_version === input.expectedVersion && existingReceipt.outcome === input.outcome &&
        existingReceipt.event_start === existingEvents[0]?.session_seq && existingReceipt.event_end === existingEvents[1]?.session_seq &&
        existingEvents[0]?.event_id === `${reviewKey}:seed` && existingEvents[0]?.kind === 'invocation-context-committed' &&
        existingEvents[1]?.event_id === `${reviewKey}:terminal` && existingEvents[1]?.kind === 'invocation-completed' &&
        (JSON.parse(existingEvents[0].payload_json) as { contextProtocol?: number; review?: { reviewPayloadSha256?: string }; replacement?: { reason?: string; messages?: unknown } })
          .contextProtocol === 2 &&
        (JSON.parse(existingEvents[0].payload_json) as { review?: { reviewPayloadSha256?: string } }).review?.reviewPayloadSha256 === reviewPayloadSha256 &&
        (JSON.parse(existingEvents[0].payload_json) as { replacement?: { reason?: string; messages?: unknown } }).replacement?.reason === 'manual-review' &&
        stableReviewEncode((JSON.parse(existingEvents[0].payload_json) as { replacement?: { messages?: unknown } }).replacement?.messages) === stableReviewEncode(input.messages) &&
        (JSON.parse(existingEvents[1].payload_json) as { review?: { reviewPayloadSha256?: string }; contextSelection?: { contextProtocol?: number; target?: string } })
          .review?.reviewPayloadSha256 === reviewPayloadSha256 &&
        (JSON.parse(existingEvents[1].payload_json) as { contextSelection?: { contextProtocol?: number; target?: string } })
          .contextSelection?.contextProtocol === 2 &&
        (JSON.parse(existingEvents[1].payload_json) as { contextSelection?: { target?: string } }).contextSelection?.target === 'working'
      return complete ? { reconciled: true as const, version: existingReceipt.next_version }
        : { reconciled: false as const, reason: 'idempotency-conflict' as const }
    }
    const checkpoint = conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get(input.sessionId) as { version: number; last_turn_id: string | null; status: string } | undefined
    if (!checkpoint || checkpoint.status !== 'commit_uncertain') return { reconciled: false as const, reason: 'not-uncertain' as const }
    if (checkpoint.last_turn_id !== input.turnId) return { reconciled: false as const, reason: 'turn-mismatch' as const }
    if (checkpoint.version !== input.expectedVersion) return { reconciled: false as const, reason: 'version-mismatch' as const }
    const session = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(input.sessionId) as { generation: string } | undefined
    if (!session || session.generation !== input.sessionGeneration) return { reconciled: false as const, reason: 'idempotency-conflict' as const }
    const originalReceipt = conn.prepare(`SELECT payload_sha256,base_version,next_version,outcome,event_start,event_end
      FROM session_turn_commit_receipts WHERE session_id=? AND turn_id=?`).get(input.sessionId, input.turnId) as
      { payload_sha256: string; base_version: number; next_version: number; outcome: string; event_start: number | null; event_end: number | null } | undefined
    const originalEntry = conn.prepare(`SELECT base_version,version,outcome FROM session_transcript_entries
      WHERE session_id=? AND turn_id=?`).get(input.sessionId, input.turnId) as
      { base_version: number; version: number; outcome: string } | undefined
    if (originalReceipt || originalEntry) {
      if (!originalReceipt || !originalEntry || originalReceipt.next_version !== originalEntry.version ||
        originalReceipt.base_version !== originalEntry.base_version || originalReceipt.outcome !== originalEntry.outcome ||
        originalReceipt.next_version !== checkpoint.version ||
        (originalReceipt.event_end !== null && !conn.prepare(`SELECT 1 FROM agent_history_events WHERE session_id=? AND turn_id=?
          AND session_seq=? AND kind IN ('invocation-completed','invocation-failed','invocation-interrupted','invocation-parked')`).get(
          input.sessionId, input.turnId, originalReceipt.event_end))) {
        return { reconciled: false as const, reason: 'already-committed' as const }
      }
      const existingClaim = conn.prepare('SELECT owner_id,generation,status FROM session_execution_claims WHERE session_id=? AND turn_id=?')
        .get(input.sessionId, input.turnId) as { owner_id: string; generation: number; status: string } | undefined
      const existingQueue = conn.prepare('SELECT owner_id,generation,status FROM session_execution_queue WHERE session_id=? AND turn_id=?')
        .get(input.sessionId, input.turnId) as { owner_id: string; generation: number; status: string } | undefined
      const checkpointUpdate = conn.prepare(`UPDATE session_transcript_checkpoints SET status='ready',updated_at=?
        WHERE session_id=? AND version=? AND last_turn_id=? AND status='commit_uncertain'`)
        .run(now, input.sessionId, checkpoint.version, input.turnId)
      if (Number(checkpointUpdate.changes) !== 1) throw new Error('SESSION_REVIEW_CHECKPOINT_CAS_FAILED')
      if (existingClaim) {
        const claimUpdate = conn.prepare(`UPDATE session_execution_claims SET turn_id='',owner_id='',status='queued',updated_at=?
          WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='commit_uncertain'`)
          .run(now, input.sessionId, input.turnId, existingClaim.owner_id, existingClaim.generation)
        if (Number(claimUpdate.changes) !== 1) throw new Error('SESSION_REVIEW_EXECUTION_FENCE_CHANGED')
      }
      if (existingQueue) {
        const queueDelete = conn.prepare(`DELETE FROM session_execution_queue WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='commit_uncertain'`)
          .run(input.sessionId, input.turnId, existingQueue.owner_id, existingQueue.generation)
        if (Number(queueDelete.changes) !== 1) throw new Error('SESSION_REVIEW_EXECUTION_FENCE_CHANGED')
      }
      return { reconciled: true as const, version: originalReceipt.next_version }
    }
    const claim = conn.prepare('SELECT turn_id,owner_id,generation,status FROM session_execution_claims WHERE session_id=?').get(input.sessionId) as
      { turn_id: string; owner_id: string; generation: number; status: string } | undefined
    const queue = conn.prepare('SELECT owner_id,generation,status FROM session_execution_queue WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId) as
      { owner_id: string; generation: number; status: string } | undefined
    if (!claim || !queue || claim.turn_id !== input.turnId || claim.status !== 'commit_uncertain' ||
      queue.status !== 'commit_uncertain' || claim.owner_id !== queue.owner_id || claim.generation !== queue.generation) {
      return { reconciled: false as const, reason: 'idempotency-conflict' as const }
    }
    const source = conn.prepare(`SELECT invocation_id,event_id,kind FROM agent_history_events
      WHERE session_id=? AND turn_id=? ORDER BY session_seq DESC`).all(input.sessionId, input.turnId) as Array<{ invocation_id: string; event_id: string; kind: string }>
    const sourceInvocationId = source[0]?.invocation_id ?? null
    const sourceTerminal = source.find((event) => ['invocation-completed','invocation-failed','invocation-interrupted','invocation-parked'].includes(event.kind))
    const reviewPayloadSha256 = sessionReviewPayloadHash(input, sourceInvocationId, sourceTerminal?.event_id ?? null)
    const review = {
      resolutionId, sourceTurnId: input.turnId, sourceInvocationId,
      sourceTerminalEventId: sourceTerminal?.event_id ?? null, sessionGeneration: input.sessionGeneration,
      baseVersion: input.expectedVersion, reviewPayloadSha256, operatorId: input.operatorId.trim(),
      rationale: input.rationale.trim(), outcome: input.outcome
    }
    const nextVersion = checkpoint.version + 1
    const seedPayload = {
      contextProtocol: 2, replacement: { reason: 'manual-review', messages: input.messages },
      scope: { kind: 'session', sessionId: input.sessionId }, review
    }
    const terminalPayload = {
      status: 'completed', review,
      contextSelection: { contextProtocol: 2, target: 'working', baseVersion: input.expectedVersion }
    }
    const historyEvents: HistoryEvent[] = [
      { invocationId: repairInvocationId, turnId: repairTurnId, sequence: 1, schemaVersion: 1,
        eventId: `${reviewKey}:seed`, idempotencyKey: `${reviewKey}:seed`, kind: 'invocation-context-committed', payload: seedPayload },
      { invocationId: repairInvocationId, turnId: repairTurnId, sequence: 2, schemaVersion: 1,
        eventId: `${reviewKey}:terminal`, idempotencyKey: `${reviewKey}:terminal`, kind: 'invocation-completed', payload: terminalPayload }
    ]
    const historyResult = appendSqliteAgentHistoryBatchInTransaction(conn, historyEvents, 0, { schemaVersion: 1, sessionId: input.sessionId, now: () => now })
    if (historyResult.version !== 2) throw new Error('SESSION_REVIEW_HISTORY_APPEND_INCOMPLETE')
    const eventRange = conn.prepare('SELECT MIN(session_seq) AS event_start,MAX(session_seq) AS event_end FROM agent_history_events WHERE invocation_id=?')
      .get(repairInvocationId) as { event_start: number | null; event_end: number | null }
    if (!Number.isSafeInteger(eventRange.event_start) || !Number.isSafeInteger(eventRange.event_end)) throw new Error('SESSION_REVIEW_EVENT_RANGE_MISSING')
    conn.prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,context_selection_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(input.sessionId, input.turnId, checkpoint.version, nextVersion, input.outcome, '[]',
      JSON.stringify({ contextProtocol: 2, target: 'working' }), now)
    conn.prepare(`INSERT INTO session_turn_commit_receipts(session_id,turn_id,payload_sha256,base_version,next_version,outcome,event_start,event_end,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.sessionId, repairTurnId, reviewPayloadSha256, checkpoint.version, nextVersion,
      input.outcome, eventRange.event_start, eventRange.event_end, now)
    conn.prepare(`INSERT INTO session_transcript_reconciliations(resolution_id,session_id,turn_id,resolved_version,resolution,operator_id,rationale,created_at)
      VALUES(?,?,?,?,'commit-reviewed',?,?,?)`).run(resolutionId, input.sessionId, input.turnId, nextVersion, input.operatorId.trim(), input.rationale.trim(), now)
    const checkpointUpdate = conn.prepare(`UPDATE session_transcript_checkpoints SET version=?,status='ready',updated_at=?
      WHERE session_id=? AND version=? AND last_turn_id=? AND status='commit_uncertain'`).run(nextVersion, now, input.sessionId, checkpoint.version, input.turnId)
    if (Number(checkpointUpdate.changes) !== 1) throw new Error('SESSION_REVIEW_CHECKPOINT_CAS_FAILED')
    const claimUpdate = conn.prepare(`UPDATE session_execution_claims SET turn_id='',owner_id='',status='queued',updated_at=?
      WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='commit_uncertain'`)
      .run(now, input.sessionId, input.turnId, claim.owner_id, claim.generation)
    const queueDelete = conn.prepare(`DELETE FROM session_execution_queue WHERE session_id=? AND turn_id=? AND owner_id=? AND generation=? AND status='commit_uncertain'`)
      .run(input.sessionId, input.turnId, queue.owner_id, queue.generation)
    if (Number(claimUpdate.changes) !== 1 || Number(queueDelete.changes) !== 1) throw new Error('SESSION_REVIEW_EXECUTION_FENCE_CHANGED')
    return { reconciled: true as const, version: nextVersion }
  })
  if (result.reconciled) db.save()
  return result
}
