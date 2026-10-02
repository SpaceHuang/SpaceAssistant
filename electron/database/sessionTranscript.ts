import type { AppDatabase } from './sqliteStore'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDbConnection } from './sqliteStore'
import { runInTransaction } from './transaction'
import path from 'node:path'
import { readSourceTruthSpillSync, type SpillDescriptor } from '../storage/spillProtocol'

export type TranscriptMessage = Readonly<Record<string, unknown>>
export type SessionTranscript = Readonly<{ sessionId: string; version: number; lastTurnId?: string; status: 'ready' | 'commit_uncertain' | 'blocked'; messages: readonly TranscriptMessage[] }>

function transcriptPayloadHash(outcome: string, messagesJson: string): string {
  return createHash('sha256').update(JSON.stringify({ outcome, messagesJson })).digest('hex')
}

export function readSessionTranscript(db: AppDatabase, sessionId: string): SessionTranscript {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get(sessionId) as { version: number; last_turn_id: string | null; status: SessionTranscript['status'] } | undefined
  if (!row) return { sessionId, version: 0, status: 'ready', messages: [] }
  const entry = row.version > 0 ? conn.prepare('SELECT messages_json FROM session_transcript_entries WHERE session_id=? AND version=?').get(sessionId, row.version) as { messages_json: string } | undefined : undefined
  let messages: TranscriptMessage[] = []
  if (entry) {
    const stored = JSON.parse(entry.messages_json) as unknown
    if (stored && typeof stored === 'object' && '__spaceassistant_session_transcript_spill_v1' in stored) {
      const descriptor = (stored as { __spaceassistant_session_transcript_spill_v1: SpillDescriptor }).__spaceassistant_session_transcript_spill_v1
      const main = conn.prepare('PRAGMA database_list').all().find((database) => (database as { name?: string }).name === 'main') as { file?: string } | undefined
      if (!main?.file) throw new Error('session transcript spill requires a file-backed database')
      messages = JSON.parse(readSourceTruthSpillSync(path.join(path.dirname(main.file), 'spill'), descriptor)) as TranscriptMessage[]
    } else messages = stored as TranscriptMessage[]
  }
  return { sessionId, version: row.version, ...(row.last_turn_id ? { lastTurnId: row.last_turn_id } : {}), status: row.status, messages }
}

export type CommitSessionTranscriptInput = { sessionId: string; turnId: string; baseVersion: number; outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; messages: readonly TranscriptMessage[]; storedMessagesJson?: string; now?: number }
export type CommitSessionTranscriptResult = { committed: true; version: number } | { committed: false; reason: 'version-conflict' | 'commit-uncertain' | 'idempotency-conflict'; version: number }

export function commitSessionTranscriptInTransaction(conn: DatabaseSync, input: CommitSessionTranscriptInput): CommitSessionTranscriptResult {
  const now = input.now ?? Date.now()
  const messagesJson = JSON.stringify(input.messages)
  const storedMessagesJson = input.storedMessagesJson ?? messagesJson
  const payloadSha256 = transcriptPayloadHash(input.outcome, messagesJson)
  return runInTransaction(conn, () => {
    const receipt = conn.prepare('SELECT payload_sha256,next_version FROM session_turn_commit_receipts WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId) as { payload_sha256: string; next_version: number } | undefined
    if (receipt) return receipt.payload_sha256 === payloadSha256
      ? { committed: true as const, version: receipt.next_version }
      : { committed: false as const, reason: 'idempotency-conflict' as const, version: receipt.next_version }
    const existing = conn.prepare('SELECT base_version,version,outcome,messages_json FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId) as { base_version: number; version: number; outcome: string; messages_json: string } | undefined
    if (existing) {
      if (existing.outcome !== input.outcome || existing.messages_json !== storedMessagesJson) return { committed: false as const, reason: 'idempotency-conflict' as const, version: existing.version }
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
    conn.prepare('INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at) VALUES(?,?,?,?,?,?,?)').run(input.sessionId, input.turnId, input.baseVersion, nextVersion, input.outcome, storedMessagesJson, now)
    conn.prepare(`INSERT INTO session_turn_commit_receipts(session_id,turn_id,payload_sha256,base_version,next_version,outcome,event_start,event_end,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.sessionId, input.turnId, payloadSha256, input.baseVersion, nextVersion, input.outcome, eventRange?.event_start ?? null, eventRange?.event_end ?? null, now)
    conn.prepare(`INSERT INTO session_transcript_checkpoints(session_id,version,last_turn_id,status,updated_at) VALUES(?,?,?,'ready',?)
      ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,last_turn_id=excluded.last_turn_id,status='ready',updated_at=excluded.updated_at`).run(input.sessionId, nextVersion, input.turnId, now)
    conn.prepare(`UPDATE session_execution_claims SET status='transcript_committed',updated_at=?
      WHERE session_id=? AND turn_id=? AND status IN ('claimed','executing')`).run(now, input.sessionId, input.turnId)
    conn.prepare(`UPDATE session_execution_queue SET status='transcript_committed',updated_at=?
      WHERE session_id=? AND turn_id=? AND status IN ('claimed','executing')`).run(now, input.sessionId, input.turnId)
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
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'
  messages: readonly TranscriptMessage[]
  operatorId: string
  rationale: string
  resolutionId?: string
  now?: number
}): { reconciled: true; version: number } | { reconciled: false; reason: 'invalid-review' | 'not-uncertain' | 'turn-mismatch' | 'version-mismatch' | 'already-committed' } {
  if (!input.operatorId.trim() || !input.rationale.trim() || !input.sessionId.trim() || !input.turnId.trim() ||
    !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) return { reconciled: false, reason: 'invalid-review' }
  const conn = getDbConnection(db)
  const now = input.now ?? Date.now()
  const resolutionId = input.resolutionId ?? `${input.sessionId}:${input.turnId}:${now}`
  const messagesJson = JSON.stringify(input.messages)
  const result = runInTransaction(conn, () => {
    const checkpoint = conn.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id=?').get(input.sessionId) as { version: number; last_turn_id: string | null; status: string } | undefined
    if (!checkpoint || checkpoint.status !== 'commit_uncertain') return { reconciled: false as const, reason: 'not-uncertain' as const }
    if (checkpoint.last_turn_id !== input.turnId) return { reconciled: false as const, reason: 'turn-mismatch' as const }
    if (checkpoint.version !== input.expectedVersion) return { reconciled: false as const, reason: 'version-mismatch' as const }
    const existing = conn.prepare('SELECT version FROM session_transcript_entries WHERE session_id=? AND turn_id=?').get(input.sessionId, input.turnId)
    if (existing) return { reconciled: false as const, reason: 'already-committed' as const }
    const nextVersion = checkpoint.version + 1
    conn.prepare('INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(input.sessionId, input.turnId, checkpoint.version, nextVersion, input.outcome, messagesJson, now)
    conn.prepare(`UPDATE session_transcript_checkpoints SET version=?,status='ready',updated_at=? WHERE session_id=? AND version=? AND last_turn_id=? AND status='commit_uncertain'`)
      .run(nextVersion, now, input.sessionId, checkpoint.version, input.turnId)
    conn.prepare(`UPDATE session_execution_claims SET turn_id='',owner_id='',status='queued',updated_at=? WHERE session_id=? AND turn_id=? AND status='commit_uncertain'`)
      .run(now, input.sessionId, input.turnId)
    conn.prepare(`DELETE FROM session_execution_queue WHERE session_id=? AND turn_id=? AND status='commit_uncertain'`).run(input.sessionId, input.turnId)
    conn.prepare(`INSERT INTO session_transcript_reconciliations(resolution_id,session_id,turn_id,resolved_version,resolution,operator_id,rationale,created_at) VALUES(?,?,?,?, 'commit-reviewed',?,?,?)`)
      .run(resolutionId, input.sessionId, input.turnId, nextVersion, input.operatorId.trim(), input.rationale.trim(), now)
    return { reconciled: true as const, version: nextVersion }
  })
  if (result.reconciled) db.save()
  return result
}
