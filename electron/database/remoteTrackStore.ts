import { randomUUID } from 'node:crypto'
import { getDbConnection, type AppDatabase } from './sqliteStore'
import { runInTransaction } from './transaction'
import { changesToNumber } from './transaction'
import { reduceTrackState, type TrackChildWork, type TrackState } from '../remote/trackReducer'
import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'

export type { RemoteTrackChannel } from '../../src/shared/remoteTrack'
export const MAX_ACTIVE_REMOTE_TRACKS_PER_IDENTITY = 10

const ACTIVE_TRACK_STATES: TrackState[] = ['open', 'processing', 'waiting-user', 'waiting-async-approval', 'resuming', 'cancelling', 'reconciliation-blocked']

export type CreateRemoteTrackInput = {
  trackId: string
  eventId: string
  idempotencyKey: string
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rootMessageId: string
  parentTrackId?: string
  originSessionId?: string
  parentEventId?: string
  attributionAudit?: Readonly<Record<string, string | number | boolean | null>>
  occurredAt: number
}

export type RemoteTrackLifecycleEvent =
  | { type: 'execution-started' }
  | { type: 'needs-user-input' }
  | { type: 'confirmation-pending' }
  | { type: 'continuation-accepted' }
  | { type: 'async-approval-pending' }
  | { type: 'resume-accepted' }
  | { type: 'reconciliation-required' }
  | { type: 'terminal-requested'; target: 'completed' | 'cancelled' | 'expired' | 'failed' }

export type RemoteTrackTerminalResult = ReturnType<typeof reduceTrackState> | {
  state: 'reconciliation-blocked'
  rejected: 'child-source-snapshot-unavailable'
}

export type RemoteTrackWorkClaim = Readonly<{
  workId: string
  trackId: string
  sourceMessageId: string
  clarificationId?: string
  workerId: string
  attempt: number
  leaseExpiresAt: number
  sessionId?: string
  requestId?: string
  turnId?: string
  userMessageId?: string
  modelViewVersion?: string
}>

/** Stable event identity shared by router prebinding and Agent-side association verification. */
export function remoteTrackTurnBindingEventId(trackId: string, turnId: string): string {
  if (!trackId.trim() || !turnId.trim()) throw new TypeError('remote Track turn binding identity is required')
  return `track-turn:${trackId}:${turnId}`
}

/** Session deletion is an explicit lifecycle boundary for every Track whose history it owns. */
export function invalidateRemoteTracksForSessionDeletion(
  conn: ReturnType<typeof getDbConnection>, sessionId: string, now: number
): void {
  const tracks = conn.prepare(`SELECT track_id,state FROM remote_tracks WHERE origin_session_id=? ORDER BY track_id`)
    .all(sessionId) as Array<{ track_id: string; state: TrackState }>
  if (!tracks.length) return
  const ids = tracks.map(({ track_id }) => track_id)
  const placeholders = ids.map(() => '?').join(',')

  const pendingClarifications = conn.prepare(`SELECT DISTINCT clarification.clarification_id,clarification.parked_input_ref
    FROM remote_clarifications clarification JOIN remote_clarification_versions version
      ON version.clarification_id=clarification.clarification_id AND version.version=clarification.current_version
    JOIN json_each(version.candidate_snapshot_json) candidate
    JOIN remote_tracks track ON track.track_id=json_extract(candidate.value,'$.trackId')
    WHERE clarification.state='pending' AND version.state='current' AND track.origin_session_id=?`).all(sessionId) as
      Array<{ clarification_id: string; parked_input_ref: string }>
  for (const clarification of pendingClarifications) {
    const source = conn.prepare('SELECT session_id FROM messages WHERE id=?').get(clarification.parked_input_ref) as { session_id: string } | undefined
    conn.prepare(`UPDATE remote_clarifications SET state='invalidated',updated_at=? WHERE clarification_id=? AND state='pending'`)
      .run(now, clarification.clarification_id)
    conn.prepare(`UPDATE remote_clarification_versions SET state='expired' WHERE clarification_id=? AND state='current'`)
      .run(clarification.clarification_id)
    if (source) conn.prepare(`INSERT OR IGNORE INTO im_lifecycle_outbox(event_id,session_id,stage,text,state,created_at,updated_at)
      VALUES(?,?,'failed',?,'pending',?,?)`).run(`clarification-terminal:${clarification.clarification_id}:invalidated`, source.session_id,
      '这项任务依赖的桌面会话已删除，原消息没有执行。请重新发送完整指令。', now, now)
  }

  conn.prepare(`UPDATE remote_track_work_queue SET state='needs-reconciliation',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE track_id IN (${placeholders}) AND state IN ('queued','claimed')`).run(now, ...ids)
  conn.prepare(`UPDATE remote_track_children SET state='invalidated',updated_at=?
    WHERE track_id IN (${placeholders}) AND state NOT IN ('completed','settled','consumed','cancelled','expired','rejected','invalidated','failed','interrupted')
      AND NOT (child_kind='tool-dispatch' AND state IN ('dispatching','outcome-unknown','needs-reconciliation'))`)
    .run(now, ...ids)
  conn.prepare(`UPDATE remote_track_children SET state='needs-reconciliation',updated_at=?
    WHERE track_id IN (${placeholders}) AND child_kind='execution-work' AND child_id IN
      (SELECT work_id FROM remote_track_work_queue WHERE track_id IN (${placeholders}) AND state='needs-reconciliation')`)
    .run(now, ...ids, ...ids)

  const invalidate = conn.prepare(`UPDATE remote_tracks SET state=?,
      terminal_reason=?,origin_session_id=NULL,version=version+1,updated_at=? WHERE track_id=? AND origin_session_id=?`)
  const event = conn.prepare(`INSERT OR IGNORE INTO remote_track_events(
      event_id,track_id,event_kind,parent_event_id,idempotency_key,message_id,request_id,turn_id,tool_use_id,confirmation_id,payload_json,occurred_at
    ) VALUES(?,?, 'track.session.deleted',NULL,?,NULL,NULL,NULL,NULL,NULL,?,?)`)
  for (const track of tracks) {
    const current = conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get(track.track_id) as { state: TrackState } | undefined
    if (!current) continue
    const childSnapshot = readRemoteTrackSourceChildren(conn, track.track_id, () => [])
    const target = childSnapshot === null
      ? { state: 'reconciliation-blocked' as const, rejected: 'child-source-snapshot-unavailable' as const }
      : reduceTrackState(current.state, { type: 'terminal-requested', target: 'failed' }, childSnapshot)
    invalidate.run(target.state, target.state === 'failed' ? 'origin-session-deleted' : null, now, track.track_id, sessionId)
    event.run(`track:${track.track_id}:session-deleted`, track.track_id, `track:${track.track_id}:session-deleted`,
      JSON.stringify({ sessionId, previousState: track.state, result: target }), now)
  }
}

export function claimRemoteTrackWork(
  db: AppDatabase,
  input: { workerId: string; now: number; leaseMs: number; workId?: string }
): RemoteTrackWorkClaim | null {
  if (!input.workerId.trim() || !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error('invalid remote Track work lease')
  }
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const filter = input.workId ? 'AND work_id=?' : ''
    const row = conn.prepare(`SELECT work_id,track_id,source_message_id,clarification_id,session_id,request_id,turn_id,user_message_id,model_view_version,attempt_count
      FROM remote_track_work_queue WHERE (state='queued' OR (state='claimed' AND lease_expires_at<=?)) ${filter}
      ORDER BY created_at,work_id LIMIT 1`).get(input.now, ...(input.workId ? [input.workId] : [])) as
      | { work_id: string; track_id: string; source_message_id: string; clarification_id: string | null; session_id: string | null
        request_id: string | null; turn_id: string | null; user_message_id: string | null; model_view_version: string | null; attempt_count: number }
      | undefined
    if (!row) return null
    const leaseExpiresAt = input.now + input.leaseMs
    const changed = changesToNumber(conn.prepare(`UPDATE remote_track_work_queue SET state='claimed',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
      WHERE work_id=? AND (state='queued' OR (state='claimed' AND lease_expires_at<=?))`)
      .run(input.workerId, leaseExpiresAt, input.now, row.work_id, input.now).changes)
    if (changed !== 1) return null
    return {
      workId: row.work_id, trackId: row.track_id, sourceMessageId: row.source_message_id,
      ...(row.clarification_id ? { clarificationId: row.clarification_id } : {}), workerId: input.workerId,
      attempt: row.attempt_count + 1, leaseExpiresAt,
      ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.request_id ? { requestId: row.request_id } : {}),
      ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
      ...(row.model_view_version ? { modelViewVersion: row.model_view_version } : {})
    }
  })
}

export function bindRemoteTrackWorkExecution(
  db: AppDatabase,
  input: { workId: string; workerId: string; attempt: number; sessionId: string; requestId: string; turnId: string; userMessageId: string; modelViewVersion: string; now: number }
): boolean {
  const values = [input.sessionId, input.requestId, input.turnId, input.userMessageId, input.modelViewVersion]
  if (values.some((value) => !value.trim()) || !Number.isSafeInteger(input.attempt) || input.attempt <= 0) throw new Error('invalid remote Track work execution mapping')
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const row = conn.prepare(`SELECT session_id,request_id,turn_id,user_message_id,model_view_version FROM remote_track_work_queue
      WHERE work_id=? AND state='claimed' AND lease_owner=? AND attempt_count=? AND lease_expires_at>?`)
      .get(input.workId, input.workerId, input.attempt, input.now) as
      | { session_id: string | null; request_id: string | null; turn_id: string | null; user_message_id: string | null; model_view_version: string | null }
      | undefined
    if (!row) throw new Error('remote Track work lease lost')
    const prior = [row.session_id, row.request_id, row.turn_id, row.user_message_id, row.model_view_version]
    if (prior.some((value, index) => value !== null && value !== values[index])) {
      throw new Error('remote Track work execution mapping is immutable')
    }
    conn.prepare(`UPDATE remote_track_work_queue SET session_id=?,request_id=?,turn_id=?,user_message_id=?,model_view_version=?,updated_at=?
      WHERE work_id=? AND state='claimed' AND lease_owner=? AND attempt_count=? AND lease_expires_at>?`)
      .run(...values, input.now, input.workId, input.workerId, input.attempt, input.now)
    return true
  })
}

export function settleRemoteTrackWork(
  db: AppDatabase,
  input: { workId: string; workerId: string; attempt: number; state: 'completed' | 'needs-reconciliation'; now: number; noticeText?: string }
): boolean {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const row = conn.prepare(`SELECT track_id,clarification_id,session_id FROM remote_track_work_queue
      WHERE work_id=? AND state='claimed' AND lease_owner=? AND attempt_count=? AND lease_expires_at>?`)
      .get(input.workId, input.workerId, input.attempt, input.now) as { track_id: string; clarification_id: string | null; session_id: string | null } | undefined
    if (!row) return false
    const changed = changesToNumber(conn.prepare(`UPDATE remote_track_work_queue SET state=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE work_id=? AND state='claimed' AND lease_owner=? AND attempt_count=? AND lease_expires_at>?`)
      .run(input.state, input.now, input.workId, input.workerId, input.attempt, input.now).changes)
    if (changed !== 1) return false
    const childState = input.state === 'completed' ? 'completed' : 'needs-reconciliation'
    conn.prepare(`UPDATE remote_track_children SET state=?,updated_at=? WHERE track_id=? AND child_kind='execution-work' AND child_id=?`)
      .run(childState, input.now, row.track_id, input.workId)
    conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,payload_json,occurred_at)
      VALUES(?,?,?,?,?,?)`).run(
      `work:${input.workId}:${input.attempt}:${input.state}`, row.track_id,
      input.state === 'completed' ? 'track.execution_work.completed' : 'track.execution_work.reconciliation_required',
      `work:${input.workId}:${input.attempt}:${input.state}`,
      JSON.stringify({ workId: input.workId, attempt: input.attempt, state: input.state }), input.now
    )
    if (input.state === 'needs-reconciliation' && row.clarification_id && row.session_id && input.noticeText?.trim()) {
      conn.prepare(`INSERT OR IGNORE INTO im_lifecycle_outbox(event_id,session_id,stage,text,state,created_at,updated_at)
        VALUES(?,?,'failed',?,'pending',?,?)`).run(`track-work-terminal:${input.workId}:needs-reconciliation`, row.session_id,
        input.noticeText.trim(), input.now, input.now)
    }
    return true
  })
}

/** Must read authoritative child source tables using the supplied connection/transaction. Null means incomplete evidence. */
export type RemoteTrackChildSourceReader = (conn: ReturnType<typeof getDbConnection>, trackId: string) => TrackChildWork[] | null
export type ActiveTrackConfirmationReader = (trackId: string) => Array<{ confirmationId: string; state: string }> | null

/** Reads the authoritative source rows in the same SQLite transaction as lifecycle settlement. */
export function readRemoteTrackSourceChildren(
  conn: ReturnType<typeof getDbConnection>,
  trackId: string,
  readActiveConfirmations?: ActiveTrackConfirmationReader
): TrackChildWork[] | null {
  if (!readActiveConfirmations) return null
  try {
    const children: TrackChildWork[] = []
    const turns = conn.prepare('SELECT turn_id,state,outcome,assistant_message_id FROM turns WHERE track_id=?').all(trackId) as
      Array<{ turn_id: string; state: string; outcome: string | null; assistant_message_id: string }>
    for (const turn of turns) {
      const turnState = turn.state === 'terminal' ? (turn.outcome === 'parked' ? 'completed' : turn.outcome ?? 'needs-reconciliation') : turn.state
      children.push({ kind: 'turn', id: turn.turn_id, state: turnState })
      const assistant = conn.prepare('SELECT tool_calls FROM messages WHERE id=?').get(turn.assistant_message_id) as { tool_calls: string | null } | undefined
      if (!assistant) return null
      if (assistant?.tool_calls) {
        const calls = JSON.parse(assistant.tool_calls) as Array<{ id?: unknown; status?: unknown }>
        for (const call of calls) {
          if (typeof call.id !== 'string' || typeof call.status !== 'string') return null
          children.push({ kind: 'tool-dispatch', id: `${turn.turn_id}:${call.id}`, state: call.status })
        }
      }
    }
    const todos = conn.prepare('SELECT todo_id,state FROM deferred_todos WHERE track_id=?').all(trackId) as Array<{ todo_id: string; state: string }>
    children.push(...todos.map(({ todo_id, state }) => ({ kind: 'async-todo' as const, id: todo_id, state })))

    const clarifications = conn.prepare(`SELECT clarification.clarification_id,clarification.state,version.candidate_snapshot_json
      FROM remote_clarifications clarification JOIN remote_clarification_versions version
        ON version.clarification_id=clarification.clarification_id AND version.version=clarification.current_version
      WHERE clarification.state='pending' AND version.state='current'
        AND EXISTS (SELECT 1 FROM json_each(version.candidate_snapshot_json) candidate
          WHERE json_extract(candidate.value,'$.trackId')=?)`).all(trackId) as
      Array<{ clarification_id: string; state: string; candidate_snapshot_json: string }>
    children.push(...clarifications.map((clarification) => ({ kind: 'parked-input' as const, id: clarification.clarification_id, state: 'pending' })))

    const work = conn.prepare('SELECT work_id,state FROM remote_track_work_queue WHERE track_id=?').all(trackId) as Array<{ work_id: string; state: string }>
    children.push(...work.map(({ work_id, state }) => ({ kind: 'execution-work' as const, id: work_id, state })))

    const confirmations = readActiveConfirmations(trackId)
    if (!confirmations) return null
    children.push(...confirmations.map(({ confirmationId, state }) => ({ kind: 'confirmation' as const, id: confirmationId, state })))
    return children
  } catch {
    return null
  }
}

export function createRemoteTrack(db: AppDatabase, input: CreateRemoteTrackInput): { trackId: string; created: boolean } {
  if (!Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch <= 0) {
    throw new Error('remote Track requires a positive durable authorization epoch')
  }
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const prior = conn.prepare(`SELECT event.track_id,track.channel,track.identity_key,track.owner_id,track.authorization_epoch,track.root_message_id
      FROM remote_track_events event JOIN remote_tracks track ON track.track_id=event.track_id WHERE event.idempotency_key=?`).get(input.idempotencyKey) as
      | { track_id: string; channel: string; identity_key: string; owner_id: string; authorization_epoch: number; root_message_id: string }
      | undefined
    if (prior) {
      if (prior.channel !== input.channel || prior.identity_key !== input.identityKey || prior.owner_id !== input.ownerId ||
        prior.authorization_epoch !== input.authorizationEpoch || prior.root_message_id !== input.rootMessageId) {
        throw new Error('remote Track inbound idempotency key collision')
      }
      return { trackId: prior.track_id, created: false }
    }

    const activeCount = (conn.prepare(`SELECT COUNT(*) AS count FROM remote_tracks
      WHERE channel=? AND identity_key=? AND owner_id=? AND state IN (${ACTIVE_TRACK_STATES.map(() => '?').join(',')})`)
      .get(input.channel, input.identityKey, input.ownerId, ...ACTIVE_TRACK_STATES) as { count: number }).count
    if (activeCount >= MAX_ACTIVE_REMOTE_TRACKS_PER_IDENTITY) throw new Error('remote Track active limit reached')

    if (input.parentTrackId) {
      const parent = conn.prepare(`SELECT channel,identity_key,owner_id,authorization_epoch,state FROM remote_tracks WHERE track_id=?`)
        .get(input.parentTrackId) as { channel: string; identity_key: string; owner_id: string; authorization_epoch: number; state: TrackState } | undefined
      if (!parent || parent.channel !== input.channel || parent.identity_key !== input.identityKey || parent.owner_id !== input.ownerId ||
        parent.authorization_epoch !== input.authorizationEpoch || parent.state !== 'completed') {
        throw new Error('remote Track parent is outside the current identity scope or is not completed')
      }
    }

    conn.prepare(`INSERT INTO remote_tracks(
      track_id,channel,identity_key,owner_id,authorization_epoch,state,root_message_id,parent_track_id,origin_session_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,'open',?,?,?,?,?)`).run(
      input.trackId, input.channel, input.identityKey, input.ownerId, input.authorizationEpoch,
      input.rootMessageId, input.parentTrackId ?? null, input.originSessionId ?? null, input.occurredAt, input.occurredAt
    )
    if (input.parentEventId) {
      const parentEvent = conn.prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(input.parentEventId) as { track_id: string } | undefined
      if (!parentEvent || parentEvent.track_id !== input.parentTrackId) throw new Error('remote Track successor event parent mismatch')
    }
    conn.prepare(`INSERT INTO remote_track_events(
      event_id,track_id,event_kind,parent_event_id,idempotency_key,message_id,payload_json,occurred_at
    ) VALUES(?,?,'track.inbound.accepted',?,?,?,?,?)`).run(
      input.eventId, input.trackId, input.parentEventId ?? null, input.idempotencyKey, input.rootMessageId,
      JSON.stringify({ channel: input.channel, identityKey: input.identityKey, ownerId: input.ownerId, authorizationEpoch: input.authorizationEpoch,
        ...(input.attributionAudit ?? {}) }),
      input.occurredAt
    )
    return { trackId: input.trackId, created: true }
  })
}

export function appendRemoteTrackEvent(
  db: AppDatabase,
  input: {
    eventId: string
    trackId: string
    eventKind: string
    idempotencyKey: string
    occurredAt: number
    parentEventId?: string
    messageId?: string
    requestId?: string
    turnId?: string
    toolUseId?: string
    confirmationId?: string
    payload?: Record<string, unknown>
  }
): { created: boolean } {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const existing = conn.prepare('SELECT track_id FROM remote_track_events WHERE idempotency_key=?').get(input.idempotencyKey) as
      | { track_id: string }
      | undefined
    if (existing) {
      if (existing.track_id !== input.trackId) throw new Error('remote Track event idempotency key belongs to another Track')
      return { created: false }
    }
    if (input.parentEventId) {
      const parent = conn.prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(input.parentEventId) as
        | { track_id: string }
        | undefined
      if (!parent || parent.track_id !== input.trackId) throw new Error('remote Track parent event must belong to the same Track')
    }
    conn.prepare(`INSERT INTO remote_track_events(
      event_id,track_id,event_kind,parent_event_id,idempotency_key,message_id,request_id,turn_id,tool_use_id,confirmation_id,payload_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.eventId, input.trackId, input.eventKind, input.parentEventId ?? null, input.idempotencyKey,
      input.messageId ?? null, input.requestId ?? null, input.turnId ?? null, input.toolUseId ?? null,
      input.confirmationId ?? null, JSON.stringify(input.payload ?? {}), input.occurredAt
    )
    return { created: true }
  })
}

export function mapRemoteTrackMessage(
  db: AppDatabase,
  input: { channel: RemoteTrackChannel; platformMessageId: string; trackId: string; eventId: string; direction: 'inbound' | 'outbound' }
): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const event = conn.prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(input.eventId) as { track_id: string } | undefined
    if (!event || event.track_id !== input.trackId) throw new Error('remote Track message map event must belong to the same Track')
    const existing = conn.prepare(`SELECT track_id,event_id,direction FROM remote_track_message_map
      WHERE channel=? AND platform_message_id=?`).get(input.channel, input.platformMessageId) as
      | { track_id: string; event_id: string; direction: string }
      | undefined
    if (existing) {
      if (existing.track_id === input.trackId && existing.event_id === input.eventId && existing.direction === input.direction) return
      throw new Error('remote Track platform message ID is already mapped')
    }
    conn.prepare(`INSERT INTO remote_track_message_map(channel,platform_message_id,track_id,event_id,direction,binding_state)
      VALUES(?,?,?,?,?,'bound')`).run(input.channel, input.platformMessageId, input.trackId, input.eventId, input.direction)
  })
}

export function resolveRemoteTrackMessageReference(
  db: AppDatabase,
  input: { channel: RemoteTrackChannel; platformMessageId: string; identityKey: string; ownerId: string; authorizationEpoch: number }
): { trackId: string; eventId: string; state: TrackState; direction: 'inbound' | 'outbound' } | null {
  const conn = getDbConnection(db)
  const row = conn.prepare(`SELECT map.track_id,map.event_id,map.direction,track.state
    FROM remote_track_message_map map JOIN remote_tracks track ON track.track_id=map.track_id
    WHERE map.channel=? AND map.platform_message_id=? AND map.binding_state='bound'
      AND track.channel=? AND track.identity_key=? AND track.owner_id=? AND track.authorization_epoch=?
      AND track.origin_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id=track.origin_session_id)`).get(
    input.channel, input.platformMessageId, input.channel, input.identityKey, input.ownerId, input.authorizationEpoch
  ) as { track_id: string; event_id: string; direction: 'inbound' | 'outbound'; state: TrackState } | undefined
  return row ? { trackId: row.track_id, eventId: row.event_id, direction: row.direction, state: row.state } : null
}

export function recordRemoteTrackChild(
  db: AppDatabase,
  input: { trackId: string; kind: TrackChildWork['kind']; childId: string; state: string; updatedAt: number }
): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const track = conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get(input.trackId) as { state: TrackState } | undefined
    if (!track) throw new Error(`remote Track not found: ${input.trackId}`)
    if (['completed', 'cancelled', 'expired', 'failed'].includes(track.state)) {
      throw new Error('cannot attach unfinished child work to terminal Track')
    }
    conn.prepare(`INSERT INTO remote_track_children(track_id,child_kind,child_id,state,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(track_id,child_kind,child_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(input.trackId, input.kind, input.childId, input.state, input.updatedAt)
    conn.prepare('UPDATE remote_tracks SET version=version+1,updated_at=? WHERE track_id=?').run(input.updatedAt, input.trackId)
  })
}

export function bindRemoteTrackToTurn(
  db: AppDatabase,
  input: { trackId: string; turnId: string; sessionId: string; channel: RemoteTrackChannel; identityKey: string; ownerId: string; authorizationEpoch: number; eventId: string; occurredAt: number }
): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const track = conn.prepare(`SELECT channel,identity_key,owner_id,authorization_epoch,state FROM remote_tracks WHERE track_id=?`).get(input.trackId) as
      | { channel: string; identity_key: string; owner_id: string; authorization_epoch: number; state: TrackState }
      | undefined
    if (!track || track.channel !== input.channel || track.identity_key !== input.identityKey || track.owner_id !== input.ownerId ||
      track.authorization_epoch !== input.authorizationEpoch || ['completed', 'cancelled', 'expired', 'failed'].includes(track.state)) {
      throw new Error('remote Track turn scope is invalid')
    }
    const turn = conn.prepare('SELECT session_id,state,track_id,request_id FROM turns WHERE turn_id=?').get(input.turnId) as
      | { session_id: string; state: string; track_id: string | null; request_id: string }
      | undefined
    if (!turn || turn.session_id !== input.sessionId) throw new Error('remote Track turn session mismatch')
    if (turn.track_id && turn.track_id !== input.trackId) throw new Error('remote turn is already bound to another Track')
    conn.prepare('UPDATE turns SET track_id=? WHERE turn_id=? AND session_id=? AND (track_id IS NULL OR track_id=?)')
      .run(input.trackId, input.turnId, input.sessionId, input.trackId)
    const event = conn.prepare(`SELECT event_id,track_id,turn_id,event_kind,payload_json FROM remote_track_events WHERE idempotency_key=?`)
      .get(`turn:${input.turnId}`) as { event_id: string; track_id: string; turn_id: string | null; event_kind: string; payload_json: string } | undefined
    if (event) {
      let payload: { sessionId?: unknown }
      try { payload = JSON.parse(event.payload_json) as { sessionId?: unknown } } catch { throw new Error('remote Track turn event is corrupt') }
      if (event.track_id !== input.trackId || event.turn_id !== input.turnId || event.event_kind !== 'track.turn.bound' ||
        payload.sessionId !== input.sessionId) throw new Error('remote Track turn event idempotency conflict')
    } else {
      conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,turn_id,payload_json,occurred_at)
        VALUES(?,?,'track.turn.bound',?,?,?,?)`).run(
        input.eventId, input.trackId, `turn:${input.turnId}`, input.turnId, JSON.stringify({ sessionId: input.sessionId }), input.occurredAt
      )
    }
    const stateEvents: RemoteTrackLifecycleEvent[] = track.state === 'open' || track.state === 'resuming'
      ? [{ type: 'execution-started' }]
      : track.state === 'waiting-user'
        ? [{ type: 'continuation-accepted' }]
      : track.state === 'waiting-async-approval'
          ? [{ type: 'resume-accepted' }, { type: 'execution-started' }]
          : []
    for (const [index, event] of stateEvents.entries()) {
      const transition = applyRemoteTrackLifecycleEvent(db, {
        trackId: input.trackId,
        eventId: `${input.eventId}:state:${index}:${event.type}`,
        idempotencyKey: `turn:${input.turnId}:state:${index}:${event.type}`,
        turnId: input.turnId,
        requestId: turn.request_id,
        occurredAt: input.occurredAt,
        event
      })
      if (transition.rejected) throw new Error(`remote Track turn lifecycle transition rejected: ${transition.rejected}`)
    }
    appendRemoteTrackEvent(db, {
      eventId: `${input.eventId}:started`, trackId: input.trackId, eventKind: 'track.turn.started',
      idempotencyKey: `turn:${input.turnId}:started`, parentEventId: input.eventId,
      requestId: turn.request_id, turnId: input.turnId, occurredAt: input.occurredAt
    })
    recordRemoteTrackChild(db, { trackId: input.trackId, kind: 'turn', childId: input.turnId, state: turn.state, updatedAt: input.occurredAt })
  })
}

export function recordRemoteTrackConfirmationState(
  db: AppDatabase,
  input: { trackId: string; confirmationId: string; attributionEventId: string; state: 'pending' | 'settled'; occurredAt: number; requestId?: string; turnId?: string; toolUseId?: string; toolName?: string; envelopeHash?: string; factsHash?: string; policyBehaviorVersion?: string; policySnapshotRevision?: number; policyRevision?: string; authorizationGeneration?: number }
): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const parent = conn.prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(input.attributionEventId) as { track_id: string } | undefined
    if (!parent || parent.track_id !== input.trackId) throw new Error('remote Track confirmation attribution mismatch')
    const track = conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get(input.trackId) as { state: TrackState } | undefined
    if (!track || ['completed', 'cancelled', 'expired', 'failed'].includes(track.state)) throw new Error('remote Track confirmation target is terminal')
    recordRemoteTrackChild(db, { trackId: input.trackId, kind: 'confirmation', childId: input.confirmationId, state: input.state, updatedAt: input.occurredAt })
    const eventKind = input.state === 'pending' ? 'track.confirmation.created' : 'track.confirmation.settled'
    const idempotencyKey = `confirmation:${input.confirmationId}:${input.state}`
    const prior = conn.prepare('SELECT track_id,event_kind FROM remote_track_events WHERE idempotency_key=?').get(idempotencyKey) as
      | { track_id: string; event_kind: string }
      | undefined
    if (prior) {
      if (prior.track_id !== input.trackId || prior.event_kind !== eventKind) throw new Error('remote Track confirmation event collision')
      return
    }
    conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,parent_event_id,idempotency_key,request_id,turn_id,tool_use_id,confirmation_id,payload_json,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      `event:${idempotencyKey}`, input.trackId, eventKind, input.attributionEventId, idempotencyKey,
      input.requestId ?? null, input.turnId ?? null, input.toolUseId ?? null, input.confirmationId,
      JSON.stringify({ toolName: input.toolName ?? null, envelopeHash: input.envelopeHash ?? null, factsHash: input.factsHash ?? null,
        policyBehaviorVersion: input.policyBehaviorVersion ?? null, policySnapshotRevision: input.policySnapshotRevision ?? null,
        policyRevision: input.policyRevision ?? null, authorizationGeneration: input.authorizationGeneration ?? null }), input.occurredAt
    )
    const current = conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get(input.trackId) as { state: TrackState }
    const hasOtherPendingConfirmations = Boolean(conn.prepare(`SELECT 1 FROM remote_track_children
      WHERE track_id=? AND child_kind='confirmation' AND state='pending' LIMIT 1`).get(input.trackId))
    const lifecycleEvent: RemoteTrackLifecycleEvent | null = input.state === 'pending' && current.state === 'processing'
      ? { type: 'confirmation-pending' }
      : input.state === 'settled' && current.state === 'waiting-user' && !hasOtherPendingConfirmations
        ? { type: 'continuation-accepted' }
        : null
    if (lifecycleEvent) {
      const transition = applyRemoteTrackLifecycleEvent(db, {
        trackId: input.trackId,
        eventId: `event:track:${input.trackId}:confirmation:${input.confirmationId}:state:${lifecycleEvent.type}`,
        idempotencyKey: `track:${input.trackId}:confirmation:${input.confirmationId}:state:${lifecycleEvent.type}`,
        requestId: input.requestId, turnId: input.turnId, occurredAt: input.occurredAt, event: lifecycleEvent
      })
      if (transition.rejected) throw new Error(`remote Track confirmation lifecycle transition rejected: ${transition.rejected}`)
    }
  })
}

export function requestRemoteTrackTerminal(
  db: AppDatabase,
  input: {
    trackId: string
    target: 'completed' | 'cancelled' | 'expired' | 'failed'
    eventId: string
    occurredAt: number
    readSourceChildren?: RemoteTrackChildSourceReader
  }
): RemoteTrackTerminalResult {
  return applyRemoteTrackLifecycleEvent(db, {
    trackId: input.trackId,
    eventId: input.eventId,
    idempotencyKey: `terminal:${input.eventId}`,
    occurredAt: input.occurredAt,
    readSourceChildren: input.readSourceChildren,
    event: { type: 'terminal-requested', target: input.target }
  })
}

/** Re-runs terminal aggregation with a fresh idempotency key after child work settles. */
export function convergeRemoteTrackTerminal(
  db: AppDatabase,
  input: {
    trackId: string
    target: 'completed' | 'cancelled' | 'expired' | 'failed'
    occurredAt: number
    readActiveConfirmations: ActiveTrackConfirmationReader
  }
): RemoteTrackTerminalResult {
  const eventId = `track:${input.trackId}:terminal-convergence:${randomUUID()}`
  return requestRemoteTrackTerminal(db, {
    trackId: input.trackId,
    target: input.target,
    eventId,
    occurredAt: input.occurredAt,
    readSourceChildren: (conn, trackId) => readRemoteTrackSourceChildren(conn, trackId, input.readActiveConfirmations)
  })
}

export function applyRemoteTrackLifecycleEvent(
  db: AppDatabase,
  input: {
    trackId: string
    eventId: string
    idempotencyKey: string
    requestId?: string
    turnId?: string
    occurredAt: number
    event: RemoteTrackLifecycleEvent
    readSourceChildren?: RemoteTrackChildSourceReader
  }
): RemoteTrackTerminalResult {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const prior = conn.prepare('SELECT track_id,payload_json FROM remote_track_events WHERE idempotency_key=?').get(input.idempotencyKey) as
      | { track_id: string; payload_json: string }
      | undefined
    if (prior) {
      if (prior.track_id !== input.trackId) throw new Error('remote Track lifecycle idempotency key belongs to another Track')
      const saved = JSON.parse(prior.payload_json) as { result: RemoteTrackTerminalResult }
      return saved.result
    }
    const row = conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get(input.trackId) as { state: TrackState } | undefined
    if (!row) throw new Error(`remote Track not found: ${input.trackId}`)
    let result: RemoteTrackTerminalResult
    if (input.event.type === 'terminal-requested') {
      const sourceChildren = input.readSourceChildren?.(conn, input.trackId)
      result = sourceChildren === null || sourceChildren === undefined
        ? { state: 'reconciliation-blocked', rejected: 'child-source-snapshot-unavailable' }
        : reduceTrackState(row.state, input.event, sourceChildren)
    } else {
      result = reduceTrackState(row.state, input.event, [])
    }
    const nextState = result.state
    conn.prepare('UPDATE remote_tracks SET state=?,version=version+1,updated_at=?,terminal_reason=? WHERE track_id=?')
      .run(nextState, input.occurredAt, 'target' in input.event && result.state === input.event.target ? input.event.target : null, input.trackId)
    conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,request_id,turn_id,payload_json,occurred_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      input.eventId, input.trackId,
      result.rejected ? 'track.lifecycle.rejected_transition' : lifecycleEventKind(input.event),
      input.idempotencyKey, input.requestId ?? null, input.turnId ?? null,
      JSON.stringify({ event: input.event, result }),
      input.occurredAt
    )
    return result
  })
}

function lifecycleEventKind(event: RemoteTrackLifecycleEvent): string {
  if (event.type === 'execution-started') return 'track.state.changed'
  if (event.type === 'terminal-requested') return 'track.terminal'
  return 'track.state.changed'
}
