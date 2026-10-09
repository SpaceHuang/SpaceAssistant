import type { Message } from '../../src/shared/domainTypes'
import { serializeQueueScope, type QueueScope } from '../../src/shared/queueScope'
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

export type ImInboxMessageContext = { messageId: string; channel: ImInboxChannel; platformMessageId: string; contextToken?: string }

export function getImInboxMessageContext(db: AppDatabase, messageId: string): ImInboxMessageContext | null {
  const row = getDbConnection(db).prepare(`SELECT message_id,channel,platform_message_id,context_token FROM im_inbox_message_context WHERE message_id=?`)
    .get(messageId) as { message_id: string; channel: ImInboxChannel; platform_message_id: string; context_token: string | null } | undefined
  return row ? { messageId: row.message_id, channel: row.channel, platformMessageId: row.platform_message_id,
    ...(row.context_token !== null ? { contextToken: row.context_token } : {}) } : null
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
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const message = appendImInboxMessage(db, input)
    const contextToken = input.contextToken?.trim() || null
    const existingContext = conn.prepare('SELECT channel,platform_message_id,context_token FROM im_inbox_message_context WHERE message_id=?')
      .get(message.messageId) as { channel: ImInboxChannel; platform_message_id: string; context_token: string | null } | undefined
    if (existingContext && (existingContext.channel !== input.channel || existingContext.platform_message_id !== input.channelMessageId || existingContext.context_token !== contextToken)) {
      throw new Error('IM_INBOX_PLATFORM_CONTEXT_CONFLICT')
    }
    conn.prepare(`INSERT OR IGNORE INTO im_inbox_message_context(message_id,channel,platform_message_id,context_token,created_at)
      VALUES(?,?,?,?,?)`).run(message.messageId, input.channel, input.channelMessageId, contextToken, Date.now())
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
