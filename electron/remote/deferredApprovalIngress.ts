import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { buildDeferredApprovalAuditEvent } from '../confirmation/deferredApprovalAudit'

type Channel = 'feishu' | 'wechat'
type NotificationBinding = {
  channel: Channel
  identityKey: string
  ownerId: string
  todoId: string
  notificationVersion: number
  currentNotificationVersion?: number
  trustedMessageId: string
  shortCode: string
  expiresAt: number
  authorizationEpoch: number
  rule: { ruleId: string; factsHash: string }
}
type ParsedReply = { action: 'approve' | 'reject'; shortCode: string }

export function parseDeferredApprovalReply(text: string): ParsedReply | null {
  const match = /^(批准|拒绝) (0[1-9]|[1-9][0-9])$/.exec(text)
  if (!match) return null
  return { action: match[1] === '批准' ? 'approve' : 'reject', shortCode: match[2]! }
}

/** Messages with an approval verb are reserved for the safety ingress, even when malformed. */
export function isDeferredApprovalReplyCandidate(text: string): boolean {
  const normalized = text.trimStart()
  return normalized.startsWith('批准') || normalized.startsWith('拒绝')
}

export function allocateDeferredApprovalShortCode(db: AppDatabase, input: { channel: Channel; identityKey: string; ownerId: string }): string | null {
  if (![input.identityKey, input.ownerId].every((value) => value.trim())) throw new TypeError('DEFERRED_APPROVAL_SCOPE_REQUIRED')
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    conn.prepare(`INSERT OR IGNORE INTO deferred_approval_code_counters(channel,identity_key,owner_id,last_code) VALUES(?,?,?,0)`)
      .run(input.channel, input.identityKey, input.ownerId)
    const row = conn.prepare(`SELECT last_code FROM deferred_approval_code_counters WHERE channel=? AND identity_key=? AND owner_id=?`)
      .get(input.channel, input.identityKey, input.ownerId) as { last_code: number }
    if (row.last_code >= 99) return null
    const next = row.last_code + 1
    conn.prepare(`UPDATE deferred_approval_code_counters SET last_code=? WHERE channel=? AND identity_key=? AND owner_id=? AND last_code=?`)
      .run(next, input.channel, input.identityKey, input.ownerId, row.last_code)
    db.save()
    return String(next).padStart(2, '0')
  })
}

export function createDeferredApprovalIngress(input: {
  db: AppDatabase
  isEnabled: () => boolean
  resolveNotification(channel: Channel, identityKey: string, ownerId: string, shortCode: string): NotificationBinding[]
  requestResume(request: {
    requestId: string; todoId: string; channel: Channel; identityKey: string; ownerId: string
    authorizationEpoch: number; rule: { ruleId: string; factsHash: string }; notificationVersion: number
    messageId: string; reasonKey: string; now: number
  }, commitReceipt?: () => boolean): Promise<{ status: 'resume_requested' | 'invalidated'; duplicate?: boolean }>
  getTodo?(todoId: string, binding: NotificationBinding): { status: string; authorizationEpoch: number; rule: { ruleId: string; factsHash: string }; expiresAt: number; invocationId?: string; originSessionId?: string } | null
  audit?(event: SecurityAuditEvent): void
}) {
  const conn = getDbConnection(input.db)
  return {
    async handle(request: { channel: Channel; identityKey: string; ownerId: string; messageId: string; replyToMessageId?: string; text: string; now?: number }) {
      const parsed = parseDeferredApprovalReply(request.text)
      const now = request.now ?? Date.now()
      if (!input.isEnabled()) return { status: 'rejected' as const }
      if (!parsed || ![request.identityKey, request.ownerId, request.messageId].every((value) => typeof value === 'string' && value.trim())) {
        return { status: 'rejected' as const }
      }
      const bindings = input.resolveNotification(request.channel, request.identityKey, request.ownerId, parsed.shortCode)
      if (parsed.action !== 'approve' || bindings.length !== 1) return { status: 'rejected' as const }
      const binding = bindings[0]!
      if (binding.channel !== request.channel || binding.identityKey !== request.identityKey || binding.ownerId !== request.ownerId ||
        binding.shortCode !== parsed.shortCode || binding.currentNotificationVersion !== binding.notificationVersion ||
        binding.expiresAt <= now || request.replyToMessageId !== binding.trustedMessageId) return { status: 'rejected' as const }
      const seen = conn.prepare(`SELECT 1 FROM deferred_approval_ingress_receipts WHERE channel=? AND identity_key=? AND message_id=?`)
        .get(request.channel, request.identityKey, request.messageId)
      if (seen) return { status: 'rejected' as const }
      const todo = input.getTodo?.(binding.todoId, binding)
      if (input.getTodo && (!todo || todo.status !== 'pending' || todo.expiresAt <= now)) return { status: 'rejected' as const }
      if (!todo) return { status: 'rejected' as const }
      const reasonKey = `${request.channel}:${request.messageId}:${binding.todoId}:${binding.notificationVersion}`
      const commitReceipt = () => {
        const changed = conn.prepare(`INSERT OR IGNORE INTO deferred_approval_ingress_receipts(channel,identity_key,message_id,created_at) VALUES(?,?,?,?)`)
          .run(request.channel, request.identityKey, request.messageId, now)
        return Number(changed.changes) === 1
      }
      const result = await input.requestResume({
        requestId: `approval:${reasonKey}`, todoId: binding.todoId, channel: binding.channel,
        identityKey: binding.identityKey, ownerId: binding.ownerId, authorizationEpoch: todo.authorizationEpoch,
        rule: todo.rule, notificationVersion: binding.notificationVersion, messageId: binding.trustedMessageId,
        reasonKey, now
      }, commitReceipt)
      if (result.status !== 'resume_requested') return { status: 'rejected' as const }
      if (todo.invocationId && todo.originSessionId) input.audit?.(buildDeferredApprovalAuditEvent({
        kind: 'approved', lane: request.channel, sessionId: todo.originSessionId,
        todoId: binding.todoId, invocationId: todo.invocationId, ts: now
      }))
      if (!todo.originSessionId?.trim()) return { status: 'rejected' as const }
      return { status: 'resume_requested' as const, duplicate: result.duplicate ?? false,
        requestId: `approval:${reasonKey}`, sessionId: todo.originSessionId }
    }
  }
}
