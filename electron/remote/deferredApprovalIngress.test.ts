import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { allocateDeferredApprovalShortCode, createDeferredApprovalIngress } from './deferredApprovalIngress'

type NotificationBinding = {
  channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; todoId: string
  notificationVersion: number; trustedMessageId: string; shortCode: string; expiresAt: number
  currentNotificationVersion?: number
  authorizationEpoch: number; rule: { ruleId: string; factsHash: string }
}

function setup(bindings: NotificationBinding[], todoStatus: string = 'pending', resumeStatus: 'resume_requested' | 'invalidated' = 'resume_requested', enabled = true) {
  const db = createMemoryAppDb()
  const requestResume = vi.fn(async (_request: unknown, commitReceipt?: () => boolean) => {
    if (resumeStatus !== 'resume_requested') return { status: resumeStatus, duplicate: false }
    if (commitReceipt && !commitReceipt()) return { status: 'invalidated' as const, duplicate: false }
    return { status: resumeStatus, duplicate: false }
  })
  const audit = vi.fn()
  const ingress = createDeferredApprovalIngress({
    db,
    isEnabled: () => enabled,
    resolveNotification: (channel, identityKey, ownerId, shortCode) => bindings.filter((binding) =>
      binding.channel === channel && binding.identityKey === identityKey && binding.ownerId === ownerId && binding.shortCode === shortCode),
    requestResume, audit,
    getTodo: (todoId) => bindings.some(({ todoId: id }) => id === todoId)
      ? { status: todoStatus, authorizationEpoch: 3, rule: { ruleId: 'write', factsHash: 'a'.repeat(64) }, expiresAt: 10_000,
          invocationId: 'invocation-a', originSessionId: 'origin-session' }
      : null
  })
  return { db, ingress, requestResume, audit }
}

const binding: NotificationBinding = {
  channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', todoId: 'todo-a',
  notificationVersion: 3, currentNotificationVersion: 3, trustedMessageId: 'trusted-origin-message', shortCode: '07', expiresAt: 10_000,
  authorizationEpoch: 3, rule: { ruleId: 'write', factsHash: 'a'.repeat(64) }
}

describe('deferred approval ingress binding contract', () => {
  it.each(['feishu', 'wechat'] as const)('parses the dedicated short approval syntax for %s only', async (channel) => {
    const channelBinding = { ...binding, channel }
    const { db, ingress, requestResume } = setup([channelBinding])
    await expect(ingress.handle({ channel, identityKey: 'identity-a', ownerId: 'owner-a', messageId: `${channel}-reply`,
      replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })).resolves.toMatchObject({ status: 'resume_requested' })
    expect(requestResume).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('allocates monotonic non-reusable two-digit codes and fails closed when exhausted', () => {
    const db = createMemoryAppDb()
    const scope = { channel: 'wechat' as const, identityKey: 'identity-a', ownerId: 'owner-a' }
    expect(allocateDeferredApprovalShortCode(db, scope)).toBe('01')
    expect(allocateDeferredApprovalShortCode(db, scope)).toBe('02')
    const conn = getDbConnection(db)
    conn.prepare(`UPDATE deferred_approval_code_counters SET last_code=99 WHERE channel=? AND identity_key=? AND owner_id=?`)
      .run(scope.channel, scope.identityKey, scope.ownerId)
    expect(allocateDeferredApprovalShortCode(db, scope)).toBeNull()
    db.close()
  })

  it('accepts only an exact current notification binding and passes trusted identifiers to idempotent resume', async () => {
    const { db, ingress, requestResume, audit } = setup([binding])
    await expect(ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'reply-1', replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 }))
      .resolves.toMatchObject({ status: 'resume_requested', requestId: 'approval:wechat:reply-1:todo-a:3', sessionId: 'origin-session' })
    expect(requestResume).toHaveBeenCalledWith(expect.objectContaining({ todoId: 'todo-a', notificationVersion: 3,
      messageId: 'trusted-origin-message', reasonKey: 'wechat:reply-1:todo-a:3' }), expect.any(Function))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'deferred-approval.approved', actor: 'user',
      todoId: 'todo-a', invocationId: 'invocation-a' }))
    db.close()
  })

  it.each([
    ['wrong channel', { channel: 'feishu', identityKey: 'identity-a', ownerId: 'owner-a' }],
    ['wrong identity', { channel: 'wechat', identityKey: 'identity-b', ownerId: 'owner-a' }],
    ['wrong owner', { channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-b' }]
  ])('rejects %s without requesting resume', async (_name, scope) => {
    const { db, ingress, requestResume } = setup([binding])
    await expect(ingress.handle({ ...scope, messageId: 'reply-1', replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 } as never)).resolves.toMatchObject({ status: 'rejected' })
    expect(requestResume).not.toHaveBeenCalled()
    db.close()
  })

  it.each(['批准', '同意', 'Y', 'N', '批准 7', '批准 007', '批准 100', '批准 07 please', '计划确认 Y'])
    ('rejects ambiguous or non-canonical approval text %s', async (text) => {
      const { db, ingress, requestResume } = setup([binding])
      await expect(ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'reply-1', replyToMessageId: 'trusted-origin-message', text, now: 100 }))
        .resolves.toMatchObject({ status: 'rejected' })
      expect(requestResume).not.toHaveBeenCalled()
      db.close()
    })

  it('rejects stale version, untrusted origin message, expired, duplicate and ambiguous parallel todo bindings', async () => {
    const stale = { ...binding, notificationVersion: 2, currentNotificationVersion: 3 }
    const wrongOrigin = { ...binding, trustedMessageId: 'different-origin' }
    const expired = { ...binding, expiresAt: 99 }
    const ambiguous = { ...binding, todoId: 'todo-b' }
    for (const bindings of [[stale], [wrongOrigin], [expired], [binding, ambiguous]]) {
      const { db, ingress, requestResume } = setup(bindings)
      const result = await ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'reply-1', replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })
      expect(result).toMatchObject({ status: 'rejected' })
      expect(requestResume).not.toHaveBeenCalled()
      db.close()
    }
    const duplicate = setup([binding])
    await duplicate.ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'reply-1', replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })
    await expect(duplicate.ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'reply-1', replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 }))
      .resolves.toMatchObject({ status: 'rejected' })
    expect(duplicate.requestResume).toHaveBeenCalledTimes(1)
    duplicate.db.close()
  })

  it.each(['consumed', 'invalidated', 'expired'])('rejects a todo already marked %s and does not request resume', async (status) => {
    const { db, ingress, requestResume } = setup([binding], status)
    await expect(ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'used-reply',
      replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })).resolves.toMatchObject({ status: 'rejected' })
    expect(requestResume).not.toHaveBeenCalled()
    db.close()
  })

  it('returns fail-closed when the current authorization/task revision check invalidates resume', async () => {
    const { db, ingress, requestResume } = setup([binding], 'pending', 'invalidated')
    await expect(ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'stale-plan-reply',
      replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })).resolves.toMatchObject({ status: 'rejected' })
    expect(requestResume).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('rejects directly at the ingress boundary while the durable gate is closed', async () => {
    const { db, ingress, requestResume } = setup([binding], 'pending', 'resume_requested', false)
    await expect(ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'closed-gate-reply',
      replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })).resolves.toEqual({ status: 'rejected' })
    expect(requestResume).not.toHaveBeenCalled()
    expect(getDbConnection(db).prepare('SELECT count(*) AS count FROM deferred_approval_ingress_receipts').get()).toEqual({ count: 0 })
    db.close()
  })

  it('never leaves a durable resume request when persisting its reply receipt fails', async () => {
    const { db, ingress } = setup([binding])
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_approval_receipt BEFORE INSERT ON deferred_approval_ingress_receipts
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`)
    await expect(ingress.handle({ channel: 'wechat', identityKey: 'identity-a', ownerId: 'owner-a', messageId: 'receipt-failure',
      replyToMessageId: 'trusted-origin-message', text: '批准 07', now: 100 })).rejects.toThrow('injected receipt failure')
    expect(conn.prepare('SELECT count(*) AS count FROM deferred_approval_ingress_receipts').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT count(*) AS count FROM deferred_resume_requests').get()).toEqual({ count: 0 })
    db.close()
  })
})
