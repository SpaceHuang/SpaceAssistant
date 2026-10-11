import { createHash } from 'node:crypto'
import type { Message } from '../../src/shared/domainTypes'
import { buildImQueueScope, serializeQueueScope, type QueueScope } from '../../src/shared/queueScope'
import { createQueueInputReceiptInScope, enqueueQueuedUserMessageInScope } from './operations'
import { queueInputFingerprint } from '../queueInputFingerprint'
import { getDbConnection, type AppDatabase } from './sqliteStore'
import { changesToNumber, runInTransaction } from './transaction'
import { appendWakeEvent } from './wakeEvents'

export type ImInboxChannel = 'feishu' | 'wechat'

export type AppendImInboxMessageInput = {
  sessionId: string
  channel: ImInboxChannel
  queueScope: Extract<QueueScope, { kind: 'im' }>
  channelMessageId: string
  content: string
  attachments?: Message['attachments']
  contextToken?: string
  trackId?: string
  trackEventId?: string
}

export type AppendImInboxMessageResult = {
  messageId: string
  sequence: number
  duplicate: boolean
}

export type AppendImInboxMessageWithWakeEventResult = {
  messageId: string
  eventId: string
  duplicate: boolean
}

export type ParkImInboxMessageInput = AppendImInboxMessageInput & {
  clarificationId: string
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  handle: string
  candidates: Array<{ trackId: string; option: number; label: string; stateAtIssue: 'open' | 'processing' | 'waiting-user' | 'waiting-async-approval' | 'resuming' | 'completed' }>
  expiresAt: number
  now?: number
}

export type ClaimedImInboxMessage = {
  messageId: string
  queueScope: Extract<QueueScope, { kind: 'im' }>
  ownerId: string
  claimedAt: number
  leaseExpiresAt: number
}

export type ImInboxMessage = {
  messageId: string
  sessionId: string
  role: 'user'
  content: string
  status: string
  sequence: number
  timestamp: number
}

export type ImInboxMessageContext = { messageId: string; channel: ImInboxChannel; platformMessageId: string; contextToken?: string; trackId?: string; trackEventId?: string; clarificationWorkId?: string }

export function getImInboxMessageContext(db: AppDatabase, messageId: string): ImInboxMessageContext | null {
  const row = getDbConnection(db).prepare(`SELECT message_id,channel,platform_message_id,context_token,track_id,track_event_id,clarification_work_id FROM im_inbox_message_context WHERE message_id=?`)
    .get(messageId) as { message_id: string; channel: ImInboxChannel; platform_message_id: string; context_token: string | null; track_id: string | null; track_event_id: string | null; clarification_work_id: string | null } | undefined
  return row ? { messageId: row.message_id, channel: row.channel, platformMessageId: row.platform_message_id,
    ...(row.context_token !== null ? { contextToken: row.context_token } : {}), ...(row.track_id !== null ? { trackId: row.track_id } : {}),
    ...(row.track_event_id !== null ? { trackEventId: row.track_event_id } : {}),
    ...(row.clarification_work_id !== null ? { clarificationWorkId: row.clarification_work_id } : {}) } : null
}

export const DEFAULT_IM_INBOX_CLAIM_LEASE_MS = 30_000
const CLAIM_STATE_CONFLICT = 'IM_INBOX_CLAIM_STATE_CONFLICT'

function withClaimTransitionFallback<T>(operation: () => T, fallback: T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof Error && error.message === CLAIM_STATE_CONFLICT) return fallback
    throw error
  }
}

/** Read pending or claimed Inbox messages for one authenticated IM scope without consuming them. */
export function listImInboxMessages(
  db: AppDatabase,
  input: { queueScope: Extract<QueueScope, { kind: 'im' }>; limit?: number }
): ImInboxMessage[] {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)))
  const rows = getDbConnection(db).prepare(`SELECT id,session_id,role,content,status,sequence,timestamp FROM messages
    WHERE queue_scope=? AND role='user' AND status IN ('queued','im-inbox-claimed')
    ORDER BY sequence ASC,id ASC LIMIT ?`)
    .all(serializeQueueScope(input.queueScope), limit) as Array<{
      id: string; session_id: string; role: 'user'; content: string; status: string; sequence: number; timestamp: number
    }>
  return rows.map((row) => ({
    messageId: row.id, sessionId: row.session_id, role: row.role, content: row.content,
    status: row.status, sequence: row.sequence, timestamp: row.timestamp
  }))
}

export function appendImInboxMessage(
  db: AppDatabase,
  input: AppendImInboxMessageInput
): AppendImInboxMessageResult {
  if (input.channel !== input.queueScope.channel) {
    throw new TypeError('IM channel does not match queue scope')
  }
  if (input.channelMessageId.trim().length === 0) {
    throw new TypeError('IM channelMessageId must not be empty')
  }
  let result: ReturnType<typeof enqueueQueuedUserMessageInScope>
  try {
    result = enqueueQueuedUserMessageInScope(db, {
      sessionId: input.sessionId,
      requestId: input.channelMessageId,
      content: input.content,
      attachments: input.attachments,
      queueScope: input.queueScope
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'QUEUE_REQUEST_FINGERPRINT_MISMATCH') {
      throw new Error('IM_INBOX_PAYLOAD_CONFLICT', { cause: error })
    }
    throw error
  }
  return {
    messageId: result.persisted.message.id,
    sequence: result.persisted.sequence,
    duplicate: result.duplicate
  }
}

export function appendImInboxMessageWithWakeEvent(
  db: AppDatabase,
  input: AppendImInboxMessageInput
): AppendImInboxMessageWithWakeEventResult {
  if (Boolean(input.trackId) !== Boolean(input.trackEventId)) throw new TypeError('IM inbox Track ID and event ID must be provided together')
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const message = appendImInboxMessage(db, input)
    const contextToken = input.contextToken?.trim() || null
    const existingContext = conn.prepare('SELECT channel,platform_message_id,context_token,track_id,track_event_id FROM im_inbox_message_context WHERE message_id=?')
      .get(message.messageId) as { channel: ImInboxChannel; platform_message_id: string; context_token: string | null; track_id: string | null; track_event_id: string | null } | undefined
    if (existingContext && (existingContext.channel !== input.channel || existingContext.platform_message_id !== input.channelMessageId || existingContext.context_token !== contextToken ||
      (existingContext.track_id != null && input.trackId != null && existingContext.track_id !== input.trackId) ||
      (existingContext.track_event_id != null && input.trackEventId != null && existingContext.track_event_id !== input.trackEventId))) {
      throw new Error('IM_INBOX_PLATFORM_CONTEXT_CONFLICT')
    }
    if (input.trackId && input.trackEventId) {
      const event = conn.prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(input.trackEventId) as { track_id: string } | undefined
      if (!event || event.track_id !== input.trackId) throw new Error('IM_INBOX_TRACK_ATTRIBUTION_INVALID')
    }
    conn.prepare(`INSERT OR IGNORE INTO im_inbox_message_context(message_id,channel,platform_message_id,context_token,created_at,track_id,track_event_id)
      VALUES(?,?,?,?,?,?,?)`).run(message.messageId, input.channel, input.channelMessageId, contextToken, Date.now(), input.trackId ?? null, input.trackEventId ?? null)
    if (existingContext && ((input.trackId && existingContext.track_id == null) || (input.trackEventId && existingContext.track_event_id == null))) {
      conn.prepare(`UPDATE im_inbox_message_context SET track_id=COALESCE(track_id,?),track_event_id=COALESCE(track_event_id,?) WHERE message_id=?`)
        .run(input.trackId ?? null, input.trackEventId ?? null, message.messageId)
    }
    const wake = appendWakeEvent(db, {
      sessionId: input.sessionId,
      type: 'im-inbound',
      reasonKey: `im-inbound:${input.channel}:${input.channelMessageId}`,
      payloadRef: { kind: 'im-inbox-message', messageId: message.messageId }
    })
    const turnRequestId = `wake:${wake.eventId}`
    const existingTurnReceipt = conn.prepare(`SELECT 1 FROM queue_input_requests WHERE session_id=? AND request_id=? AND queue_scope=?`)
      .get(input.sessionId, turnRequestId, serializeQueueScope(input.queueScope))
    if (!existingTurnReceipt) {
      createQueueInputReceiptInScope(db, {
        sessionId: input.sessionId,
        requestId: turnRequestId,
        fingerprint: queueInputFingerprint({ text: input.content, attachments: input.attachments }),
        queuedMessageId: message.messageId,
        state: 'queued'
      }, input.queueScope)
    }
    const now = Date.now()
    conn.prepare(`INSERT OR IGNORE INTO wake_event_outbox(event_id,session_id,state,created_at,updated_at)
      VALUES(?,?,'pending',?,?)`).run(wake.eventId, input.sessionId, now, now)
    return { messageId: message.messageId, eventId: wake.eventId, duplicate: message.duplicate && wake.duplicate }
  })
}

/** Persist an ambiguous IM input for a Clarification without making it executable yet. */
export function parkImInboxMessageForClarification(db: AppDatabase, input: ParkImInboxMessageInput): AppendImInboxMessageResult {
  if (input.channel !== input.queueScope.channel) throw new TypeError('IM channel does not match queue scope')
  if (!input.clarificationId.trim() || !input.identityKey.trim() || !input.ownerId.trim() || !Number.isSafeInteger(input.authorizationEpoch) ||
    input.authorizationEpoch <= 0 || input.expiresAt <= (input.now ?? Date.now()) || input.candidates.length < 1 || input.candidates.length > 5) {
    throw new TypeError('invalid IM clarification parking scope')
  }
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const prior = conn.prepare(`SELECT clarification_id,message_id FROM im_inbox_clarification_park WHERE clarification_id=?`)
      .get(input.clarificationId) as { clarification_id: string; message_id: string } | undefined
    const message = appendImInboxMessage(db, input)
    if (prior && prior.message_id !== message.messageId) throw new Error('IM_INBOX_CLARIFICATION_SOURCE_CONFLICT')
    const now = input.now ?? Date.now()
    const snapshot = input.candidates.map((candidate, index) => {
      if (candidate.option !== index + 1 || !candidate.label.trim() || candidate.label.length > 120) throw new Error('invalid clarification candidate snapshot')
      return candidate
    })
    const snapshotJson = JSON.stringify(snapshot)
    const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex')
    const priorClarification = conn.prepare(`SELECT channel,identity_key,owner_id,authorization_epoch,source_message_id,parked_input_ref,state,current_version
      FROM remote_clarifications WHERE clarification_id=?`).get(input.clarificationId) as {
        channel: string; identity_key: string; owner_id: string; authorization_epoch: number; source_message_id: string; parked_input_ref: string; state: string; current_version: number
      } | undefined
    if (!priorClarification) {
      conn.prepare(`INSERT INTO remote_clarifications(clarification_id,channel,identity_key,owner_id,authorization_epoch,source_message_id,
        parked_input_ref,state,current_version,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',1,?,?,?)`)
        .run(input.clarificationId, input.channel, input.identityKey, input.ownerId, input.authorizationEpoch,
          input.channelMessageId, message.messageId, input.expiresAt, now, now)
      conn.prepare(`INSERT INTO remote_clarification_versions(clarification_id,version,handle,candidate_snapshot_json,snapshot_hash,state,created_at)
        VALUES(?,1,?,?,?,'current',?)`).run(input.clarificationId, input.handle, snapshotJson, snapshotHash, now)
    } else {
      if (priorClarification.channel !== input.channel || priorClarification.identity_key !== input.identityKey || priorClarification.owner_id !== input.ownerId ||
        priorClarification.authorization_epoch !== input.authorizationEpoch || priorClarification.source_message_id !== input.channelMessageId ||
        priorClarification.parked_input_ref !== message.messageId || priorClarification.state !== 'pending' || priorClarification.current_version !== 1) {
        throw new Error('IM_INBOX_CLARIFICATION_IDENTITY_CONFLICT')
      }
      const version = conn.prepare(`SELECT handle,snapshot_hash,state FROM remote_clarification_versions WHERE clarification_id=? AND version=1`)
        .get(input.clarificationId) as { handle: string; snapshot_hash: string; state: string } | undefined
      if (!version || version.handle !== input.handle || version.snapshot_hash !== snapshotHash || version.state !== 'current') throw new Error('IM_INBOX_CLARIFICATION_VERSION_CONFLICT')
    }
    const existing = conn.prepare('SELECT channel,platform_message_id,context_token FROM im_inbox_message_context WHERE message_id=?')
      .get(message.messageId) as { channel: string; platform_message_id: string; context_token: string | null } | undefined
    const contextToken = input.contextToken?.trim() || null
    if (existing && (existing.channel !== input.channel || existing.platform_message_id !== input.channelMessageId || existing.context_token !== contextToken)) {
      throw new Error('IM_INBOX_PLATFORM_CONTEXT_CONFLICT')
    }
    conn.prepare(`INSERT OR IGNORE INTO im_inbox_message_context(message_id,channel,platform_message_id,context_token,created_at)
      VALUES(?,?,?,?,?)`).run(message.messageId, input.channel, input.channelMessageId, contextToken, now)
    const changed = conn.prepare(`UPDATE messages SET status='parked' WHERE id=? AND queue_scope=? AND status='queued'`)
      .run(message.messageId, serializeQueueScope(input.queueScope))
    const parked = conn.prepare('SELECT status FROM messages WHERE id=?').get(message.messageId) as { status: string } | undefined
    if (!parked || (Number(changed.changes) !== 1 && parked.status !== 'parked')) throw new Error('IM_INBOX_CLARIFICATION_PARK_FAILED')
    conn.prepare("UPDATE queue_input_requests SET state='parked',updated_at=? WHERE session_id=? AND request_id=? AND queue_scope=? AND state='queued'")
      .run(now, input.sessionId, input.channelMessageId, serializeQueueScope(input.queueScope))
    conn.prepare('INSERT OR IGNORE INTO im_inbox_clarification_park(message_id,clarification_id,created_at) VALUES(?,?,?)')
      .run(message.messageId, input.clarificationId, now)
    db.save()
    return message
  })
}

/** Atomically attaches a selected Track and makes the parked original input claimable exactly once. */
export function resumeClarificationInboxMessage(db: AppDatabase, input: {
  clarificationId: string; trackId: string; trackEventId: string; now?: number
}): { kind: 'resumed' | 'already-resumed'; messageId: string; sessionId: string; eventId: string } {
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const row = conn.prepare(`SELECT clarification.channel,clarification.source_message_id,clarification.parked_input_ref,
      clarification.state,work.session_id,work.state AS work_state,work.track_id AS work_track_id,message.status,message.session_id AS message_session_id,
      message.queue_scope AS message_queue_scope,context.channel AS context_channel,context.platform_message_id,
      clarification.identity_key,clarification.owner_id,work.work_id
      FROM remote_clarifications clarification JOIN remote_track_work_queue work ON work.clarification_id=clarification.clarification_id
      JOIN messages message ON message.id=clarification.parked_input_ref JOIN im_inbox_message_context context ON context.message_id=message.id
      WHERE clarification.clarification_id=?`).get(input.clarificationId) as {
        channel: ImInboxChannel; source_message_id: string; parked_input_ref: string; state: string; session_id: string | null;
        work_state: string; work_track_id: string; work_id: string; status: string; message_session_id: string; message_queue_scope: string;
        context_channel: string; platform_message_id: string; identity_key: string; owner_id: string
      } | undefined
    if (!row || row.state !== 'resolved' || !row.session_id || row.context_channel !== row.channel || row.status === 'sent') throw new Error('IM_INBOX_CLARIFICATION_RESUME_SCOPE_INVALID')
    const trackEvent = conn.prepare('SELECT track_id FROM remote_track_events WHERE event_id=?').get(input.trackEventId) as { track_id: string } | undefined
    if (!trackEvent || trackEvent.track_id !== input.trackId) throw new Error('IM_INBOX_TRACK_ATTRIBUTION_INVALID')
    if (row.work_track_id !== input.trackId) throw new Error('IM_INBOX_CLARIFICATION_WORK_TRACK_MISMATCH')
    if (row.status === 'parked' && row.work_state === 'queued') {
      const context = conn.prepare('SELECT track_id,track_event_id FROM im_inbox_message_context WHERE message_id=?')
        .get(row.parked_input_ref) as { track_id: string | null; track_event_id: string | null }
      if ((context.track_id && context.track_id !== input.trackId) || (context.track_event_id && context.track_event_id !== input.trackEventId)) throw new Error('IM_INBOX_CLARIFICATION_RESUME_CONFLICT')
      conn.prepare('UPDATE im_inbox_message_context SET track_id=?,track_event_id=? WHERE message_id=? AND track_id IS NULL AND track_event_id IS NULL')
        .run(input.trackId, input.trackEventId, row.parked_input_ref)
      const targetQueueScope = serializeQueueScope(buildImQueueScope(row.channel, row.session_id))
      const movedMessage = conn.prepare(`UPDATE messages SET session_id=?,queue_scope=?,status='queued'
        WHERE id=? AND session_id=? AND queue_scope=? AND status='parked'`)
        .run(row.session_id, targetQueueScope, row.parked_input_ref, row.message_session_id, row.message_queue_scope)
      if (Number(movedMessage.changes) !== 1) throw new Error('IM_INBOX_CLARIFICATION_MESSAGE_MOVE_FAILED')
      const wake = appendWakeEvent(db, { sessionId: row.session_id, type: 'im-inbound',
        reasonKey: `clarification-resume:${input.clarificationId}`, payloadRef: { kind: 'im-inbox-message', messageId: row.parked_input_ref } })
      const scope = buildImQueueScope(row.channel, row.session_id)
      const requestId = `wake:${wake.eventId}`
      const message = conn.prepare('SELECT content,attachments FROM messages WHERE id=?').get(row.parked_input_ref) as { content: string; attachments: string | null }
      const attachments = message.attachments ? JSON.parse(message.attachments) as Message['attachments'] : undefined
      createQueueInputReceiptInScope(db, { sessionId: row.session_id, requestId,
        fingerprint: queueInputFingerprint({ text: message.content, attachments }), queuedMessageId: row.parked_input_ref, state: 'queued' }, scope)
      const now = input.now ?? Date.now()
      conn.prepare(`INSERT OR IGNORE INTO wake_event_outbox(event_id,session_id,state,created_at,updated_at) VALUES(?,?,'pending',?,?)`)
        .run(wake.eventId, row.session_id, now, now)
      conn.prepare(`UPDATE im_inbox_message_context SET clarification_work_id=? WHERE message_id=? AND clarification_work_id IS NULL`)
        .run(row.work_id, row.parked_input_ref)
      const movedReceipt = conn.prepare(`UPDATE queue_input_requests SET session_id=?,queue_scope=?,state='consumed',updated_at=?
        WHERE session_id=? AND request_id=? AND queue_scope=? AND state='parked'`)
        .run(row.session_id, targetQueueScope, input.now ?? Date.now(), row.message_session_id, row.source_message_id, row.message_queue_scope)
      if (Number(movedReceipt.changes) !== 1) throw new Error('IM_INBOX_CLARIFICATION_RECEIPT_MOVE_FAILED')
      db.save()
      return { kind: 'resumed', messageId: row.parked_input_ref, sessionId: row.session_id, eventId: wake.eventId }
    }
    if (row.status === 'queued' || row.status === 'im-inbox-claimed' || row.status === 'sent') {
      const wake = conn.prepare("SELECT event_id FROM wake_events WHERE session_id=? AND reason_key=?")
        .get(row.session_id, `clarification-resume:${input.clarificationId}`) as { event_id: string } | undefined
      if (wake) return { kind: 'already-resumed', messageId: row.parked_input_ref, sessionId: row.session_id, eventId: wake.event_id }
    }
    throw new Error('IM_INBOX_CLARIFICATION_RESUME_STATE_INVALID')
  })
}

export function claimImInboxMessage(
  db: AppDatabase,
  input: { queueScope: Extract<QueueScope, { kind: 'im' }>; messageId: string; ownerId: string; leaseDurationMs?: number }
): ClaimedImInboxMessage | null {
  if (input.ownerId.trim().length === 0) throw new TypeError('IM Inbox claim ownerId must not be empty')
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_IM_INBOX_CLAIM_LEASE_MS
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new TypeError('IM Inbox claim leaseDurationMs must be positive')
  const serializedScope = serializeQueueScope(input.queueScope)
  const conn = getDbConnection(db)
  return withClaimTransitionFallback(() => runInTransaction(conn, () => {
    const claimedAt = Date.now()
    const leaseExpiresAt = claimedAt + leaseDurationMs
    const message = conn.prepare(`SELECT status FROM messages WHERE id=? AND queue_scope=? AND role='user'`)
      .get(input.messageId, serializedScope) as { status: string } | undefined
    if (!message) return null

    if (message.status === 'queued') {
      const prior = conn.prepare('SELECT state FROM im_inbox_claims WHERE message_id=? AND queue_scope=?')
        .get(input.messageId, serializedScope) as { state: string } | undefined
      if (prior && prior.state !== 'released') return null
      if (prior) {
        const reclaimed = conn.prepare(`UPDATE im_inbox_claims SET owner_id=?,claimed_at=?,lease_expires_at=?,updated_at=?,state='claimed'
          WHERE message_id=? AND queue_scope=? AND state='released'`)
          .run(input.ownerId, claimedAt, leaseExpiresAt, claimedAt, input.messageId, serializedScope)
        if (changesToNumber(reclaimed.changes) !== 1) return null
      }
      const update = conn.prepare(`UPDATE messages SET status='im-inbox-claimed'
        WHERE id=? AND queue_scope=? AND role='user' AND status='queued'`)
        .run(input.messageId, serializedScope)
      if (changesToNumber(update.changes) !== 1) {
        if (prior) throw new Error(CLAIM_STATE_CONFLICT)
        return null
      }
      if (!prior) {
        conn.prepare(`INSERT INTO im_inbox_claims(message_id,queue_scope,owner_id,claimed_at,lease_expires_at,updated_at,state)
          VALUES(?,?,?,?,?,?, 'claimed')`).run(input.messageId, serializedScope, input.ownerId, claimedAt, leaseExpiresAt, claimedAt)
      }
    } else if (message.status === 'im-inbox-claimed') {
      const reclaimed = conn.prepare(`UPDATE im_inbox_claims SET owner_id=?,claimed_at=?,lease_expires_at=?,updated_at=?,state='claimed'
        WHERE message_id=? AND queue_scope=? AND state='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`)
        .run(input.ownerId, claimedAt, leaseExpiresAt, claimedAt, input.messageId, serializedScope, claimedAt)
      if (changesToNumber(reclaimed.changes) !== 1) return null
    } else if (message.status === 'sent') {
      const reclaimed = conn.prepare(`UPDATE im_inbox_claims SET owner_id=?,claimed_at=?,lease_expires_at=?,updated_at=?,state='claimed'
        WHERE message_id=? AND queue_scope=? AND state='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`)
        .run(input.ownerId, claimedAt, leaseExpiresAt, claimedAt, input.messageId, serializedScope, claimedAt)
      if (changesToNumber(reclaimed.changes) !== 1) return null
    } else {
      return null
    }
    db.save()
    return { messageId: input.messageId, queueScope: input.queueScope, ownerId: input.ownerId, claimedAt, leaseExpiresAt }
  }), null)
}

export function ackImInboxMessage(
  db: AppDatabase,
  input: { queueScope: Extract<QueueScope, { kind: 'im' }>; messageId: string; ownerId: string }
): boolean {
  const serializedScope = serializeQueueScope(input.queueScope)
  const conn = getDbConnection(db)
  return withClaimTransitionFallback(() => runInTransaction(conn, () => {
    const claim = conn.prepare(`SELECT owner_id,state,lease_expires_at FROM im_inbox_claims
      WHERE message_id=? AND queue_scope=?`).get(input.messageId, serializedScope) as
      { owner_id: string; state: string; lease_expires_at: number | null } | undefined
    if (claim?.state === 'acked') return true
    if (!claim || claim.owner_id !== input.ownerId) return false
    const now = Date.now()
    if (claim.state !== 'claimed' || claim.lease_expires_at == null || claim.lease_expires_at <= now) return false
    const message = conn.prepare(`UPDATE messages SET status='sent'
      WHERE id=? AND queue_scope=? AND status='im-inbox-claimed'`).run(input.messageId, serializedScope)
    const currentMessage = conn.prepare('SELECT status FROM messages WHERE id=? AND queue_scope=?').get(input.messageId, serializedScope) as { status: string } | undefined
    if (changesToNumber(message.changes) !== 1 && currentMessage?.status !== 'sent') return false
    const acknowledged = conn.prepare(`UPDATE im_inbox_claims SET state='acked',updated_at=?
      WHERE message_id=? AND queue_scope=? AND owner_id=? AND state='claimed'`).run(now, input.messageId, serializedScope, input.ownerId)
    if (changesToNumber(acknowledged.changes) !== 1) throw new Error(CLAIM_STATE_CONFLICT)
    db.save()
    return true
  }), false)
}

export function releaseImInboxMessage(
  db: AppDatabase,
  input: { queueScope: Extract<QueueScope, { kind: 'im' }>; messageId: string; ownerId: string }
): boolean {
  const serializedScope = serializeQueueScope(input.queueScope)
  const conn = getDbConnection(db)
  return withClaimTransitionFallback(() => runInTransaction(conn, () => {
    const now = Date.now()
    const message = conn.prepare(`UPDATE messages SET status='queued'
      WHERE id=? AND queue_scope=? AND status='im-inbox-claimed'
        AND EXISTS(SELECT 1 FROM im_inbox_claims WHERE message_id=? AND queue_scope=?
          AND owner_id=? AND state='claimed' AND lease_expires_at>?)`)
      .run(input.messageId, serializedScope, input.messageId, serializedScope, input.ownerId, now)
    if (changesToNumber(message.changes) !== 1) return false
    const released = conn.prepare(`UPDATE im_inbox_claims SET state='released',updated_at=?
      WHERE message_id=? AND queue_scope=? AND owner_id=? AND state='claimed'`).run(now, input.messageId, serializedScope, input.ownerId)
    if (changesToNumber(released.changes) !== 1) throw new Error(CLAIM_STATE_CONFLICT)
    db.save()
    return true
  }), false)
}

export function renewImInboxClaim(
  db: AppDatabase,
  input: { queueScope: Extract<QueueScope, { kind: 'im' }>; messageId: string; ownerId: string; leaseDurationMs: number }
): boolean {
  if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) throw new TypeError('IM Inbox claim leaseDurationMs must be positive')
  const serializedScope = serializeQueueScope(input.queueScope)
  const conn = getDbConnection(db)
  const now = Date.now()
  const result = conn.prepare(`UPDATE im_inbox_claims SET lease_expires_at=?,updated_at=?
    WHERE message_id=? AND queue_scope=? AND owner_id=? AND state='claimed' AND lease_expires_at>?`)
    .run(now + input.leaseDurationMs, now, input.messageId, serializedScope, input.ownerId, now)
  const renewed = changesToNumber(result.changes) === 1
  if (renewed) db.save()
  return renewed
}
