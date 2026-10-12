import { createHash } from 'node:crypto'
import { getDbConnection, type AppDatabase } from './sqliteStore'
import { runInTransaction } from './transaction'
import { appendRemoteTrackEvent, createRemoteTrack, recordRemoteTrackChild } from './remoteTrackStore'
import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'

export type ClarificationCandidate = {
  trackId: string
  option: number
  label: string
  stateAtIssue: 'open' | 'processing' | 'waiting-user' | 'waiting-async-approval' | 'resuming' | 'completed'
}

type ClarificationScope = {
  clarificationId: string
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  sourceMessageId: string
  parkedInputRef: string
  createdAt: number
  expiresAt: number
}

type ClarificationVersionInput = ClarificationScope & {
  version: number
  handle: string
  candidates: ClarificationCandidate[]
}

const MAX_CANDIDATES = 5
const HANDLE_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/
const ACTIVE_TRACK_STATES = ['open', 'processing', 'waiting-user', 'waiting-async-approval', 'resuming'] as const

/** True only for an unexpired clarification in the caller's current authenticated scope. */
export function hasPendingClarificationForScope(
  db: AppDatabase,
  input: { channel: RemoteTrackChannel; identityKey: string; ownerId: string; authorizationEpoch: number; now?: number }
): boolean {
  const now = input.now ?? Date.now()
  return Boolean(getDbConnection(db).prepare(`SELECT 1 FROM remote_clarifications clarification
    JOIN remote_authorization_epochs authorization ON authorization.channel=clarification.channel
      AND authorization.epoch=clarification.authorization_epoch
    WHERE clarification.channel=? AND clarification.identity_key=? AND clarification.owner_id=?
      AND clarification.authorization_epoch=? AND clarification.state='pending' AND clarification.expires_at>?
    LIMIT 1`).get(input.channel, input.identityKey, input.ownerId, input.authorizationEpoch, now))
}

function validateVersion(input: ClarificationVersionInput): { snapshotJson: string; snapshotHash: string } {
  if (!Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch <= 0) throw new Error('clarification requires a durable authorization epoch')
  if (!Number.isSafeInteger(input.version) || input.version <= 0) throw new Error('clarification version must be a positive integer')
  if (!HANDLE_RE.test(input.handle)) throw new Error('invalid clarification handle')
  if (input.expiresAt <= input.createdAt) throw new Error('clarification expiry must follow creation')
  if (input.candidates.length < 1 || input.candidates.length > MAX_CANDIDATES) throw new Error('clarification candidate count must be between 1 and 5')
  const seen = new Set<string>()
  const snapshot = input.candidates.map((candidate, index) => {
    if (candidate.option !== index + 1 || seen.has(candidate.trackId)) throw new Error('clarification options must be ordered, contiguous, and unique')
    if (!candidate.label.trim() || candidate.label.length > 120) throw new Error('invalid clarification candidate label')
    seen.add(candidate.trackId)
    return { trackId: candidate.trackId, option: candidate.option, label: candidate.label, stateAtIssue: candidate.stateAtIssue }
  })
  const snapshotJson = JSON.stringify(snapshot)
  return { snapshotJson, snapshotHash: createHash('sha256').update(snapshotJson).digest('hex') }
}

function readClarificationByHandle(dbConn: ReturnType<typeof getDbConnection>, handle: string) {
  return dbConn.prepare(`SELECT clarification.clarification_id,clarification.channel,clarification.identity_key,clarification.owner_id,
    clarification.authorization_epoch,clarification.source_message_id,clarification.parked_input_ref,clarification.state,
    clarification.current_version,clarification.expires_at,clarification.resolved_by_message_id,clarification.selected_track_id,
    clarification.selected_option,version.version,version.candidate_snapshot_json,version.snapshot_hash,version.state AS version_state
    FROM remote_clarification_versions version JOIN remote_clarifications clarification
      ON clarification.clarification_id=version.clarification_id WHERE version.handle=?`).get(handle) as {
    clarification_id: string
    channel: RemoteTrackChannel
    identity_key: string
    owner_id: string
    authorization_epoch: number
    source_message_id: string
    parked_input_ref: string
    state: 'pending' | 'resolved' | 'expired' | 'invalidated'
    current_version: number
    expires_at: number
    resolved_by_message_id: string | null
    selected_track_id: string | null
    selected_option: number | null
    version: number
    candidate_snapshot_json: string
    snapshot_hash: string
    version_state: 'current' | 'superseded' | 'expired'
  } | undefined
}

function terminateParkedClarificationInput(
  conn: ReturnType<typeof getDbConnection>,
  row: { clarification_id: string; parked_input_ref: string; source_message_id: string },
  state: 'expired' | 'invalidated', now: number
): void {
  const source = conn.prepare(`SELECT message.session_id,context.channel FROM messages message
    JOIN im_inbox_message_context context ON context.message_id=message.id WHERE message.id=?`).get(row.parked_input_ref) as
    { session_id: string; channel: RemoteTrackChannel } | undefined
  if (!source) throw new Error('CLARIFICATION_PARKED_INPUT_MISSING')
  const status = state === 'expired' ? 'clarification-expired' : 'clarification-invalidated'
  conn.prepare('UPDATE messages SET status=? WHERE id=? AND status=\'parked\'').run(status, row.parked_input_ref)
  conn.prepare("UPDATE queue_input_requests SET state=?,updated_at=? WHERE session_id=? AND request_id=? AND state='parked'")
    .run(state, now, source.session_id, row.source_message_id)
  const text = state === 'expired' ? '这条澄清已超时，原消息没有执行。请重新发送原指令。' : '原任务已失效，澄清已取消，原消息没有执行。请重新描述。'
  conn.prepare(`INSERT OR IGNORE INTO im_lifecycle_outbox(event_id,session_id,stage,text,state,created_at,updated_at)
    VALUES(?,?,'failed',?,'pending',?,?)`).run(`clarification-terminal:${row.clarification_id}:${state}`, source.session_id, text, now, now)
}

/** Terminalizes due clarifications even when the owner sends no later reply. */
export function expireDuePendingClarifications(
  db: AppDatabase,
  now = Date.now(),
  channel?: RemoteTrackChannel
): Array<{ clarificationId: string; channel: RemoteTrackChannel; identityKey: string; ownerId: string; sessionId: string; eventId: string; stage: 'failed'; text: string }> {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const rows = conn.prepare(`SELECT clarification_id,channel,identity_key,owner_id,parked_input_ref,source_message_id
      FROM remote_clarifications WHERE state='pending' AND expires_at<=?${channel ? ' AND channel=?' : ''}
      ORDER BY expires_at,clarification_id`).all(...(channel ? [now, channel] : [now])) as Array<{
        clarification_id: string; channel: RemoteTrackChannel; identity_key: string; owner_id: string
        parked_input_ref: string; source_message_id: string
      }>
    const expired: Array<{ clarificationId: string; channel: RemoteTrackChannel; identityKey: string; ownerId: string; sessionId: string; eventId: string; stage: 'failed'; text: string }> = []
    for (const row of rows) {
      const changed = conn.prepare(`UPDATE remote_clarifications SET state='expired',updated_at=?
        WHERE clarification_id=? AND state='pending' AND expires_at<=?`).run(now, row.clarification_id, now)
      if (Number(changed.changes) !== 1) continue
      conn.prepare(`UPDATE remote_clarification_versions SET state='expired'
        WHERE clarification_id=? AND state='current'`).run(row.clarification_id)
      terminateParkedClarificationInput(conn, row, 'expired', now)
      const notice = conn.prepare(`SELECT message.session_id FROM messages message WHERE message.id=?`)
        .get(row.parked_input_ref) as { session_id: string } | undefined
      if (!notice) throw new Error('CLARIFICATION_PARKED_INPUT_MISSING')
      expired.push({ clarificationId: row.clarification_id, channel: row.channel, identityKey: row.identity_key, ownerId: row.owner_id,
        sessionId: notice.session_id, eventId: `clarification-terminal:${row.clarification_id}:expired`, stage: 'failed',
        text: '这条澄清已超时，原消息没有执行。请重新发送原指令。' })
    }
    return expired
  })
}

/** Pending terminal notices survive a crash between expiration and platform delivery. */
export function listPendingClarificationNotices(db: AppDatabase, channel: RemoteTrackChannel): Array<{
  clarificationId: string; channel: RemoteTrackChannel; identityKey: string; ownerId: string; sessionId: string
  eventId: string; stage: 'failed'; text: string
}> {
  const rows = getDbConnection(db).prepare(`SELECT clarification.clarification_id,clarification.channel,clarification.identity_key,
    clarification.owner_id,outbox.session_id,outbox.event_id,outbox.stage,outbox.text
    FROM im_lifecycle_outbox outbox JOIN remote_clarifications clarification
      ON outbox.event_id LIKE 'clarification-terminal:' || clarification.clarification_id || ':%'
    JOIN remote_authorization_epochs authorization ON authorization.channel=clarification.channel
      AND authorization.epoch=clarification.authorization_epoch
    WHERE outbox.state='pending' AND outbox.stage='failed' AND clarification.channel=?
    UNION ALL
    SELECT clarification.clarification_id,track.channel,track.identity_key,track.owner_id,outbox.session_id,outbox.event_id,outbox.stage,outbox.text
    FROM im_lifecycle_outbox outbox JOIN remote_track_work_queue work
      ON outbox.event_id LIKE 'track-work-terminal:' || work.work_id || ':%'
    JOIN remote_clarifications clarification ON clarification.clarification_id=work.clarification_id
    JOIN remote_tracks track ON track.track_id=work.track_id
    JOIN remote_authorization_epochs authorization ON authorization.channel=track.channel AND authorization.epoch=track.authorization_epoch
    WHERE outbox.state='pending' AND outbox.stage='failed' AND track.channel=?
    ORDER BY 5,6`).all(channel, channel) as Array<{
      clarification_id: string; channel: RemoteTrackChannel; identity_key: string; owner_id: string; session_id: string
      event_id: string; stage: 'failed'; text: string
  }>
  return rows.map((row) => ({ clarificationId: row.clarification_id, channel: row.channel, identityKey: row.identity_key,
    ownerId: row.owner_id, sessionId: row.session_id, eventId: row.event_id, stage: row.stage, text: row.text }))
}

export function listRecoverableClarificationPrompts(db: AppDatabase, channel: RemoteTrackChannel, now = Date.now()): Array<{
  clarificationId: string; version: number; handle: string; channel: RemoteTrackChannel; identityKey: string; ownerId: string
  sessionId: string; candidates: ClarificationCandidate[]; latestAttemptState: string | null
}> {
  const rows = getDbConnection(db).prepare(`SELECT clarification.clarification_id,version.version,version.handle,clarification.channel,
    clarification.identity_key,clarification.owner_id,message.session_id,version.candidate_snapshot_json,
    attempt.state AS latest_attempt_state,attempt.started_at AS latest_attempt_started_at
    FROM remote_clarifications clarification JOIN remote_authorization_epochs authorization
      ON authorization.channel=clarification.channel AND authorization.epoch=clarification.authorization_epoch
    JOIN remote_clarification_versions version
      ON version.clarification_id=clarification.clarification_id AND version.version=clarification.current_version AND version.state='current'
    JOIN messages message ON message.id=clarification.parked_input_ref
    LEFT JOIN remote_clarification_send_attempts attempt ON attempt.send_attempt_id=(
      SELECT send_attempt_id FROM remote_clarification_send_attempts WHERE clarification_id=clarification.clarification_id
        AND version=clarification.current_version ORDER BY started_at DESC,send_attempt_id DESC LIMIT 1)
    WHERE clarification.state='pending' AND clarification.expires_at>? AND clarification.channel=? AND message.status='parked'
      AND (attempt.send_attempt_id IS NULL OR attempt.state IN ('send-rejected','send-outcome-unknown')
        OR (attempt.state='attempt-started' AND attempt.started_at<=?))
    ORDER BY clarification.created_at,clarification.clarification_id`).all(now, channel, now - 60_000) as Array<{
      clarification_id: string; version: number; handle: string; channel: RemoteTrackChannel; identity_key: string; owner_id: string
      session_id: string; candidate_snapshot_json: string; latest_attempt_state: string | null; latest_attempt_started_at: number | null
    }>
  return rows.map((row) => ({ clarificationId: row.clarification_id, version: row.version, handle: row.handle, channel: row.channel,
    identityKey: row.identity_key, ownerId: row.owner_id, sessionId: row.session_id,
    candidates: JSON.parse(row.candidate_snapshot_json) as ClarificationCandidate[], latestAttemptState: row.latest_attempt_state }))
}

export function getClarificationResumeIdentity(db: AppDatabase, handle: string): { clarificationId: string; trackEventId?: string } | null {
  const conn = getDbConnection(db)
  const row = conn.prepare('SELECT clarification_id FROM remote_clarification_versions WHERE handle=?').get(handle) as { clarification_id: string } | undefined
  if (!row) return null
  const event = conn.prepare('SELECT event_id FROM remote_track_events WHERE idempotency_key=?').get(`clarification:${row.clarification_id}`) as { event_id: string } | undefined
  return { clarificationId: row.clarification_id, ...(event ? { trackEventId: event.event_id } : {}) }
}

export function createClarification(db: AppDatabase, input: ClarificationVersionInput): {
  clarificationId: string
  version: number
  handle: string
  snapshotHash: string
  created: boolean
} {
  const { snapshotJson, snapshotHash } = validateVersion(input)
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const existing = conn.prepare(`SELECT clarification_id,channel,identity_key,owner_id,authorization_epoch,parked_input_ref,state,current_version
      FROM remote_clarifications WHERE channel=? AND identity_key=? AND source_message_id=?`)
      .get(input.channel, input.identityKey, input.sourceMessageId) as {
        clarification_id: string; channel: RemoteTrackChannel; identity_key: string; owner_id: string; authorization_epoch: number
        parked_input_ref: string; state: 'pending' | 'resolved' | 'expired' | 'invalidated'; current_version: number
      } | undefined

    if (!existing) {
      if (input.version !== 1) throw new Error('first clarification version must be 1')
      conn.prepare(`INSERT INTO remote_clarifications(
        clarification_id,channel,identity_key,owner_id,authorization_epoch,source_message_id,parked_input_ref,state,current_version,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'pending',1,?,?,?)`).run(
        input.clarificationId, input.channel, input.identityKey, input.ownerId, input.authorizationEpoch,
        input.sourceMessageId, input.parkedInputRef, input.expiresAt, input.createdAt, input.createdAt
      )
      conn.prepare(`INSERT INTO remote_clarification_versions(
        clarification_id,version,handle,candidate_snapshot_json,snapshot_hash,state,created_at
      ) VALUES(?,1,?,?,?,'current',?)`).run(input.clarificationId, input.handle, snapshotJson, snapshotHash, input.createdAt)
      return { clarificationId: input.clarificationId, version: 1, handle: input.handle, snapshotHash, created: true }
    }

    if (existing.channel !== input.channel || existing.identity_key !== input.identityKey || existing.owner_id !== input.ownerId ||
      existing.authorization_epoch !== input.authorizationEpoch || existing.parked_input_ref !== input.parkedInputRef ||
      existing.clarification_id !== input.clarificationId) {
      throw new Error('clarification source-message identity collision')
    }
    const current = conn.prepare(`SELECT version,handle,snapshot_hash FROM remote_clarification_versions
      WHERE clarification_id=? AND state='current'`).get(existing.clarification_id) as
      | { version: number; handle: string; snapshot_hash: string }
      | undefined
    if (!current) throw new Error('clarification current version is missing')
    if (snapshotHash === current.snapshot_hash) {
      return { clarificationId: existing.clarification_id, version: current.version, handle: current.handle, snapshotHash, created: false }
    }
    if (existing.state !== 'pending') throw new Error('cannot publish a version for a terminal clarification')
    if (input.version !== current.version + 1) throw new Error('clarification version must advance monotonically')
    conn.prepare(`UPDATE remote_clarification_versions SET state='superseded'
      WHERE clarification_id=? AND version=? AND state='current'`).run(existing.clarification_id, current.version)
    conn.prepare(`INSERT INTO remote_clarification_versions(
      clarification_id,version,handle,candidate_snapshot_json,snapshot_hash,state,created_at
    ) VALUES(?,?,?,?,?,'current',?)`).run(existing.clarification_id, input.version, input.handle, snapshotJson, snapshotHash, input.createdAt)
    conn.prepare(`UPDATE remote_clarifications SET current_version=?,updated_at=? WHERE clarification_id=? AND state='pending'`)
      .run(input.version, input.createdAt, existing.clarification_id)
    return { clarificationId: existing.clarification_id, version: input.version, handle: input.handle, snapshotHash, created: true }
  })
}

export function startClarificationSendAttempt(
  db: AppDatabase,
  input: { sendAttemptId: string; clarificationId: string; version: number; startedAt: number }
): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const current = conn.prepare(`SELECT clarification.current_version,clarification.state,clarification.expires_at,version.state AS version_state
      FROM remote_clarifications clarification JOIN remote_clarification_versions version
        ON version.clarification_id=clarification.clarification_id AND version.version=?
      WHERE clarification.clarification_id=?`).get(input.version, input.clarificationId) as
      | { current_version: number; state: string; expires_at: number; version_state: string }
      | undefined
    if (!current || current.current_version !== input.version || current.version_state !== 'current' || current.state !== 'pending') {
      throw new Error('clarification send attempt is not for the current pending version')
    }
    if (input.startedAt >= current.expires_at) throw new Error('clarification has expired')
    conn.prepare(`INSERT INTO remote_clarification_send_attempts(send_attempt_id,clarification_id,version,state,started_at)
      VALUES(?,?,?,'attempt-started',?)`).run(input.sendAttemptId, input.clarificationId, input.version, input.startedAt)
  })
}

export function finishClarificationSendAttempt(
  db: AppDatabase,
  input: { sendAttemptId: string; state: 'send-fulfilled' | 'send-rejected' | 'send-outcome-unknown'; finishedAt: number; platformMessageId?: string }
): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const attempt = conn.prepare('SELECT state,finished_at,platform_message_id FROM remote_clarification_send_attempts WHERE send_attempt_id=?')
      .get(input.sendAttemptId) as { state: string; finished_at: number | null; platform_message_id: string | null } | undefined
    if (!attempt) throw new Error('clarification send attempt not found')
    if (attempt.state !== 'attempt-started') {
      if (attempt.state === input.state && attempt.finished_at === input.finishedAt && attempt.platform_message_id === (input.platformMessageId ?? null)) return
      throw new Error('clarification send attempt already settled')
    }
    conn.prepare(`UPDATE remote_clarification_send_attempts SET state=?,finished_at=?,platform_message_id=?
      WHERE send_attempt_id=? AND state='attempt-started'`).run(input.state, input.finishedAt, input.platformMessageId ?? null, input.sendAttemptId)
  })
}

type ResolveClarificationInput = {
  handle: string
  option: number
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  replyMessageId: string
  trackEventId: string
  workId: string
  now: number
  successorTrackId?: string
}

export type ResolveClarificationResult =
  | { kind: 'resolved'; trackId: string; workId: string; parentTrackId?: string }
  | { kind: 'already-resolved'; trackId: string; workId: string }
  | { kind: 'unknown' | 'stale' | 'expired' | 'unauthorized' | 'not-sent' | 'invalid-option' | 'candidate-invalidated' }

export function resolveClarificationSelection(db: AppDatabase, input: ResolveClarificationInput): ResolveClarificationResult {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const row = readClarificationByHandle(conn, input.handle)
    if (!row) return { kind: 'unknown' }
    if (row.channel !== input.channel || row.identity_key !== input.identityKey || row.owner_id !== input.ownerId ||
      row.authorization_epoch !== input.authorizationEpoch) return { kind: 'unauthorized' }
    if (row.version_state === 'superseded' || row.version !== row.current_version) return { kind: 'stale' }
    if (row.state === 'expired' || row.version_state === 'expired') return { kind: 'expired' }
    if (row.state === 'resolved') {
      const work = conn.prepare(`SELECT work_id,track_id FROM remote_track_work_queue WHERE clarification_id=?`).get(row.clarification_id) as
        | { work_id: string; track_id: string }
        | undefined
      return work ? { kind: 'already-resolved', trackId: work.track_id, workId: work.work_id } : { kind: 'stale' }
    }
    if (row.state !== 'pending') return { kind: 'stale' }
    if (input.now >= row.expires_at) {
      conn.prepare(`UPDATE remote_clarifications SET state='expired',updated_at=? WHERE clarification_id=? AND state='pending'`).run(input.now, row.clarification_id)
      conn.prepare(`UPDATE remote_clarification_versions SET state='expired' WHERE clarification_id=? AND version=? AND state='current'`)
        .run(row.clarification_id, row.version)
      terminateParkedClarificationInput(conn, row, 'expired', input.now)
      return { kind: 'expired' }
    }
    const hasAttempt = conn.prepare(`SELECT 1 FROM remote_clarification_send_attempts WHERE clarification_id=? AND version=? LIMIT 1`)
      .get(row.clarification_id, row.version)
    if (!hasAttempt) return { kind: 'not-sent' }

    const snapshot = JSON.parse(row.candidate_snapshot_json) as ClarificationCandidate[]
    const candidate = snapshot.find((entry) => entry.option === input.option)
    if (!candidate) return { kind: 'invalid-option' }
    const selected = conn.prepare(`SELECT channel,identity_key,owner_id,authorization_epoch,state,origin_session_id FROM remote_tracks WHERE track_id=?`)
      .get(candidate.trackId) as { channel: string; identity_key: string; owner_id: string; authorization_epoch: number; state: string; origin_session_id: string | null } | undefined
    if (!selected || selected.channel !== input.channel || selected.identity_key !== input.identityKey || selected.owner_id !== input.ownerId ||
      selected.authorization_epoch !== input.authorizationEpoch ||
      !(ACTIVE_TRACK_STATES as readonly string[]).includes(selected.state) && selected.state !== 'completed') {
      conn.prepare(`UPDATE remote_clarifications SET state='invalidated',updated_at=? WHERE clarification_id=? AND state='pending'`)
        .run(input.now, row.clarification_id)
      conn.prepare(`UPDATE remote_clarification_versions SET state='expired' WHERE clarification_id=? AND version=? AND state='current'`)
        .run(row.clarification_id, row.version)
      terminateParkedClarificationInput(conn, row, 'invalidated', input.now)
      return { kind: 'candidate-invalidated' }
    }
    if (!selected.origin_session_id || !conn.prepare('SELECT 1 FROM sessions WHERE id=?').get(selected.origin_session_id)) {
      conn.prepare(`UPDATE remote_clarifications SET state='invalidated',updated_at=? WHERE clarification_id=? AND state='pending'`)
        .run(input.now, row.clarification_id)
      conn.prepare(`UPDATE remote_clarification_versions SET state='expired' WHERE clarification_id=? AND version=? AND state='current'`)
        .run(row.clarification_id, row.version)
      terminateParkedClarificationInput(conn, row, 'invalidated', input.now)
      return { kind: 'candidate-invalidated' }
    }

    let trackId = candidate.trackId
    let parentTrackId: string | undefined
    if (selected.state === 'completed') {
      if (!input.successorTrackId) throw new Error('completed candidate requires a successor Track ID')
      parentTrackId = candidate.trackId
      createRemoteTrack(db, {
        trackId: input.successorTrackId,
        eventId: input.trackEventId,
        idempotencyKey: `clarification:${row.clarification_id}`,
        channel: input.channel,
        identityKey: input.identityKey,
        ownerId: input.ownerId,
        authorizationEpoch: input.authorizationEpoch,
        rootMessageId: row.source_message_id,
        parentTrackId,
        originSessionId: selected.origin_session_id,
        occurredAt: input.now
      })
      trackId = input.successorTrackId
    } else {
      appendRemoteTrackEvent(db, {
        eventId: input.trackEventId,
        trackId,
        eventKind: 'track.inbound.consumed',
        idempotencyKey: `clarification:${row.clarification_id}`,
        messageId: row.source_message_id,
        occurredAt: input.now,
        payload: { clarificationId: row.clarification_id, sourceMessageId: row.source_message_id }
      })
    }

    conn.prepare(`UPDATE remote_clarifications SET state='resolved',resolved_by_message_id=?,selected_track_id=?,selected_option=?,updated_at=?
      WHERE clarification_id=? AND state='pending' AND current_version=?`).run(
      input.replyMessageId, trackId, input.option, input.now, row.clarification_id, row.version
    )
    conn.prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,clarification_id,source_message_id,state,session_id,created_at,updated_at)
      VALUES(?,?,?, ?,?,'queued',?,?,?)`).run(
      input.workId, `clarification:${row.clarification_id}`, trackId, row.clarification_id, row.source_message_id, selected.origin_session_id, input.now, input.now
    )
    recordRemoteTrackChild(db, { trackId, kind: 'execution-work', childId: input.workId, state: 'queued', updatedAt: input.now })
    return { kind: 'resolved', trackId, workId: input.workId, ...(parentTrackId ? { parentTrackId } : {}) }
  })
}
