import { describe, expect, it } from 'vitest'
import { appendImInboxMessage, appendImInboxMessageWithWakeEvent, ackImInboxMessage, claimImInboxMessage, releaseImInboxMessage, renewImInboxClaim, listImInboxMessages, getImInboxMessageContext } from './imInbox'
import { createMemoryAppDb, createTempDatabase } from './testHelpers'
import { createSession } from './operations'
import { listQueuedUserMessages } from './operations'
import { getDbConnection } from './sqliteStore'
import { openDatabase } from './index'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { appendWakeEvent, claimWakeEvents, finalizeWakeEvents, listWakeEvents } from './wakeEvents'
import { createImInboxMutationToolRegistry } from '../remote/imInboxToolContext'
import { getWorkflowState, putWorkflowState } from './workflowState'

describe('IM Inbox persistence', () => {
  it('stores workflow state with revision CAS and does not overwrite on conflict', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-workflow-revision-red' }).id
    const first = getWorkflowState(db, { sessionId, workflowId: 'task-a' })
    expect(first).toBeNull()
    const created = putWorkflowState(db, { sessionId, workflowId: 'task-a', expectedRevision: null, data: { plan: ['one'] }, now: 10 })
    expect(created).toMatchObject({ ok: true, state: { revision: 1, version: 1, data: { plan: ['one'] } } })
    const conflict = putWorkflowState(db, { sessionId, workflowId: 'task-a', expectedRevision: null, data: { plan: ['forged'] }, now: 11 })
    expect(conflict).toMatchObject({ ok: false, error: 'revision_conflict', current: { revision: 1, data: { plan: ['one'] } } })
    expect(getWorkflowState(db, { sessionId, workflowId: 'task-a' })).toMatchObject({ revision: 1, data: { plan: ['one'] } })
    expect(putWorkflowState(db, { sessionId, workflowId: 'task-a', version: 2, expectedRevision: null, data: { plan: ['v2'] }, now: 12 }))
      .toMatchObject({ ok: true, state: { version: 2, revision: 1 } })
    db.close()
  })

  it('exposes claim, ack, release, and renew tools with authenticated owner and scope only', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-tool-boundary' }).id
    const trustedScope = buildImQueueScope('feishu', 'trusted-remote-session')
    const otherScope = buildImQueueScope('wechat', 'other-remote-session')
    const first = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope: trustedScope, channelMessageId: 'boundary-a', content: 'first' })
    const other = appendImInboxMessage(db, { sessionId, channel: 'wechat', queueScope: otherScope, channelMessageId: 'boundary-b', content: 'other' })
    const registry = createImInboxMutationToolRegistry(db)
    expect(registry.entries().map(({ name }) => name)).toEqual(expect.arrayContaining([
      'im_inbox_claim', 'im_inbox_ack', 'im_inbox_release', 'im_inbox_renew'
    ]))

    const run = async (name: string, input: Record<string, unknown>, ownerId: string) => {
      const planning = registry.get(name)!.beginPlanning(input, { requestId: 'inbox-boundary', toolUseId: name })
      const handle = await planning.result
      handle.confirm()
      return handle.execute({
        requestId: 'inbox-boundary', toolUseId: name,
        runtimeContext: { sessionId: 'trusted-remote-session', lane: 'feishu', remoteContext: { source: 'feishu', authOwner: ownerId } }
      } as never)
    }
    const claimed = await run('im_inbox_claim', { messageId: first.messageId, sessionId: 'forged', ownerId: 'forged', queueScope: { kind: 'desktop' } }, 'owner-a') as { success: boolean }
    expect(claimed.success).toBe(true)
    expect(await run('im_inbox_ack', { messageId: first.messageId, ownerId: 'attacker' }, 'owner-b')).toMatchObject({ success: false })
    expect(await run('im_inbox_ack', { messageId: other.messageId, queueScope: { kind: 'im', channel: 'wechat' } }, 'owner-a')).toMatchObject({ success: false })
    expect(await run('im_inbox_renew', { messageId: first.messageId, ownerId: 'forged', leaseDurationMs: 90000 }, 'owner-a')).toMatchObject({ success: true })
    expect(await run('im_inbox_release', { messageId: first.messageId }, 'owner-a')).toMatchObject({ success: true })
    db.close()
  })

  it('lists pending and claimed messages read-only within the requested scope', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-list-read-only' }).id
    const feishu = buildImQueueScope('feishu', 'list-feishu')
    const wechat = buildImQueueScope('wechat', 'list-wechat')
    const first = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope: feishu, channelMessageId: 'list-a', content: 'first' })
    appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope: feishu, channelMessageId: 'list-b', content: 'second' })
    appendImInboxMessage(db, { sessionId, channel: 'wechat', queueScope: wechat, channelMessageId: 'list-c', content: 'other scope' })
    const claimed = claimImInboxMessage(db, { queueScope: feishu, messageId: first.messageId, ownerId: 'list-owner' })!

    const page = listImInboxMessages(db, { queueScope: feishu })
    expect(page.map(({ content }) => content)).toEqual(['first', 'second'])
    expect(listImInboxMessages(db, { queueScope: wechat }).map(({ content }) => content)).toEqual(['other scope'])
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(first.messageId)).toEqual({ status: 'im-inbox-claimed' })
    expect(getDbConnection(db).prepare('SELECT state,owner_id FROM im_inbox_claims WHERE message_id=?').get(first.messageId))
      .toEqual({ state: 'claimed', owner_id: claimed.ownerId })
    const { createImInboxListToolRegistry } = await import('../remote/imInboxToolContext')
    const tool = createImInboxListToolRegistry(db).get('im_inbox_list')!
    const planning = tool.beginPlanning({ limit: 20, sessionId: 'forged-session', queueScope: { kind: 'desktop' } }, {
      requestId: 'list-context', toolUseId: 'list-call'
    })
    const handle = await planning.result
    handle.confirm()
    const result = await handle.execute({
      requestId: 'list-context', toolUseId: 'list-call', runtimeContext: {
        sessionId: 'list-feishu', lane: 'feishu', remoteContext: { source: 'feishu', authOwner: 'list-owner' }
      } as never
    } as never) as { messages: Array<{ messageId: string }> }
    expect(result).toEqual({ success: true, messages: page })
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(first.messageId)).toEqual({ status: 'im-inbox-claimed' })
    db.close()
  })

  it('returns the same stable message ID when a channel message is appended again', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'local-im-session' }).id
    const queueScope = buildImQueueScope('feishu', 'feishu-session-1')
    const input = {
      sessionId: session,
      channel: 'feishu' as const,
      queueScope,
      channelMessageId: 'feishu-message-1',
      content: 'hello from Feishu'
    }

    const first = appendImInboxMessage(db, input)
    const retry = appendImInboxMessage(db, input)

    expect(first.messageId).toBe(retry.messageId)
    expect(retry.duplicate).toBe(true)
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM messages WHERE id=?').get(first.messageId))
      .toEqual({ count: 1 })
    expect(getDbConnection(db).prepare('SELECT queue_scope,status,content FROM messages WHERE id=?').get(first.messageId))
      .toEqual({ queue_scope: 'im:feishu:feishu-session-1', status: 'queued', content: 'hello from Feishu' })
    db.close()
  })

  it('rejects a payload change for the same scope and channel message ID without overwriting the original', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-payload-conflict' }).id
    const input = {
      sessionId,
      channel: 'wechat' as const,
      queueScope: buildImQueueScope('wechat', 'wechat-session-2'),
      channelMessageId: 'wechat-message-conflict',
      content: 'original payload'
    }
    const first = appendImInboxMessage(db, input)

    expect(() => appendImInboxMessage(db, { ...input, content: 'changed payload' }))
      .toThrow('IM_INBOX_PAYLOAD_CONFLICT')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM messages WHERE queue_scope=?').get('im:wechat:wechat-session-2'))
      .toEqual({ count: 1 })
    expect(getDbConnection(db).prepare('SELECT content FROM messages WHERE id=?').get(first.messageId))
      .toEqual({ content: 'original payload' })
    db.close()
  })


  it('claims a pending message atomically at most once and does not claim non-pending messages', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-atomic-claim' }).id
    const queueScope = buildImQueueScope('feishu', 'claim-session')
    const pending = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'claim-message', content: 'pending'
    })
    expect(claimImInboxMessage(db, {
      queueScope: buildImQueueScope('wechat', 'claim-session'), messageId: pending.messageId, ownerId: 'wrong-scope-owner'
    })).toBeNull()
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() =>
      claimImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: `owner-${index}` })
    )))
    const successfulClaims = attempts.filter((claim): claim is NonNullable<typeof claim> => claim !== null)
    expect(successfulClaims).toHaveLength(1)
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(pending.messageId))
      .toEqual({ status: 'im-inbox-claimed' })
    expect(getDbConnection(db).prepare('SELECT queue_scope,owner_id FROM im_inbox_claims WHERE message_id=?').get(pending.messageId))
      .toEqual({ queue_scope: 'im:feishu:claim-session', owner_id: successfulClaims[0]!.ownerId })

    const nonPending = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'non-pending-message', content: 'second'
    })
    getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(nonPending.messageId)
    expect(claimImInboxMessage(db, { queueScope, messageId: nonPending.messageId, ownerId: 'owner-final' })).toBeNull()
    db.close()
  })

  it('acknowledges a durably consumed Inbox message after TurnRuntime marks it sent', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-sent-ack' }).id
    const queueScope = buildImQueueScope('feishu', 'sent-ack-session')
    const message = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope, channelMessageId: 'sent-ack-message', content: 'body' })
    const claim = claimImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'wake-owner' })!
    getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(message.messageId)

    expect(ackImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: claim.ownerId })).toBe(true)
    expect(getDbConnection(db).prepare('SELECT state FROM im_inbox_claims WHERE message_id=?').get(message.messageId)).toEqual({ state: 'acked' })
    db.close()
  })

  it('reclaims a sent message after a crash between turn completion and inbox ack', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-sent-reclaim' }).id
    const queueScope = buildImQueueScope('wechat', 'sent-reclaim-session')
    const message = appendImInboxMessage(db, { sessionId, channel: 'wechat', queueScope, channelMessageId: 'sent-reclaim-message', content: 'body' })
    const first = claimImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'old-owner' })!
    getDbConnection(db).prepare("UPDATE messages SET status='sent' WHERE id=?").run(message.messageId)
    getDbConnection(db).prepare('UPDATE im_inbox_claims SET lease_expires_at=? WHERE message_id=?').run(Date.now() - 1, message.messageId)

    const recovered = claimImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'new-owner' })
    expect(first.ownerId).not.toBe(recovered?.ownerId)
    expect(recovered).toMatchObject({ ownerId: 'new-owner', messageId: message.messageId })
    db.close()
  })

  it('treats an already completed inbox ack as idempotent after event retry', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-acked-retry' }).id
    const queueScope = buildImQueueScope('feishu', 'acked-retry-session')
    const message = appendImInboxMessage(db, { sessionId, channel: 'feishu', queueScope, channelMessageId: 'acked-retry-message', content: 'body' })
    const claim = claimImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'first-owner' })!
    expect(ackImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: claim.ownerId })).toBe(true)
    expect(ackImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'retry-owner' })).toBe(true)
    db.close()
  })


  it('blocks a second owner during a live lease and lets an expired lease be reclaimed without losing the message', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-lease-reclaim' }).id
    const queueScope = buildImQueueScope('wechat', 'lease-session')
    const pending = appendImInboxMessage(db, {
      sessionId, channel: 'wechat', queueScope, channelMessageId: 'lease-message', content: 'lease payload'
    })
    const first = claimImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'lease-owner-1' })
    expect(first).not.toBeNull()
    expect(claimImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'lease-owner-2' })).toBeNull()

    getDbConnection(db).prepare('UPDATE im_inbox_claims SET lease_expires_at=? WHERE message_id=?')
      .run(Date.now() - 1, pending.messageId)
    const reclaimed = claimImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'lease-owner-2' })

    expect(reclaimed?.ownerId).toBe('lease-owner-2')
    expect(getDbConnection(db).prepare('SELECT status,content FROM messages WHERE id=?').get(pending.messageId))
      .toEqual({ status: 'im-inbox-claimed', content: 'lease payload' })
    db.close()
  })


  it('acks idempotently, rejects non-owners, releases back to pending, and renews only for the owner', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-inbox-claim-transitions' }).id
    const queueScope = buildImQueueScope('feishu', 'transition-session')
    const pending = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'transition-ack', content: 'ack body'
    })
    claimImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'owner-a' })
    expect(ackImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'owner-b' })).toBe(false)
    expect(ackImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'owner-a' })).toBe(true)
    expect(ackImInboxMessage(db, { queueScope, messageId: pending.messageId, ownerId: 'owner-a' })).toBe(true)
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(pending.messageId)).toEqual({ status: 'sent' })

    const released = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'transition-release', content: 'release body'
    })
    claimImInboxMessage(db, { queueScope, messageId: released.messageId, ownerId: 'owner-a' })
    expect(releaseImInboxMessage(db, { queueScope, messageId: released.messageId, ownerId: 'owner-b' })).toBe(false)
    expect(releaseImInboxMessage(db, { queueScope, messageId: released.messageId, ownerId: 'owner-a' })).toBe(true)
    expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(released.messageId)).toEqual({ status: 'queued' })
    expect(claimImInboxMessage(db, { queueScope, messageId: released.messageId, ownerId: 'owner-c' })).not.toBeNull()

    const renewed = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'transition-renew', content: 'renew body'
    })
    claimImInboxMessage(db, { queueScope, messageId: renewed.messageId, ownerId: 'owner-a' })
    expect(renewImInboxClaim(db, { queueScope, messageId: renewed.messageId, ownerId: 'owner-b', leaseDurationMs: 60_000 })).toBe(false)
    expect(renewImInboxClaim(db, { queueScope, messageId: renewed.messageId, ownerId: 'owner-a', leaseDurationMs: 60_000 })).toBe(true)
    db.close()
  })

  it('restores pending messages, append receipts, and live claim leases after reopening a file database', () => {
    const temp = createTempDatabase('im-inbox-reopen-')
    const sessionId = createSession(temp.db, { name: 'im-inbox-reopen' }).id
    const queueScope = buildImQueueScope('feishu', 'reopen-session')
    const pending = appendImInboxMessage(temp.db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'reopen-pending', content: 'pending survives restart'
    })
    const claimed = appendImInboxMessage(temp.db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'reopen-claimed', content: 'claim survives restart'
    })
    const claim = claimImInboxMessage(temp.db, {
      queueScope, messageId: claimed.messageId, ownerId: 'persistent-owner', leaseDurationMs: 60_000
    })
    expect(claim).not.toBeNull()
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    expect(appendImInboxMessage(reopened, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'reopen-pending', content: 'pending survives restart'
    })).toMatchObject({ messageId: pending.messageId, duplicate: true })
    expect(getDbConnection(reopened).prepare('SELECT status,content FROM messages WHERE id=?').get(pending.messageId))
      .toEqual({ status: 'queued', content: 'pending survives restart' })
    expect(claimImInboxMessage(reopened, {
      queueScope, messageId: claimed.messageId, ownerId: 'competing-owner'
    })).toBeNull()
    expect(getDbConnection(reopened).prepare('SELECT queue_scope,owner_id,lease_expires_at FROM im_inbox_claims WHERE message_id=?').get(claimed.messageId))
      .toEqual({ queue_scope: 'im:feishu:reopen-session', owner_id: 'persistent-owner', lease_expires_at: claim!.leaseExpiresAt })

    reopened.close()
    temp.cleanup()
  })

  it('recovers an interrupted inbound outbox write without duplicating the message or wake event', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'inbox-wake-outbox-recovery' }).id
    const queueScope = buildImQueueScope('feishu', 'outbox-recovery-session')
    const input = {
      sessionId,
      channel: 'feishu' as const,
      queueScope,
      channelMessageId: 'outbox-recovery-message',
      content: 'durable inbound'
    }
    getDbConnection(db).exec(`CREATE TRIGGER fail_wake_outbox BEFORE INSERT ON wake_event_outbox
      BEGIN SELECT RAISE(ABORT, 'injected wake outbox interruption'); END`)

    expect(() => appendImInboxMessageWithWakeEvent(db, input)).toThrow('injected wake outbox interruption')
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM messages WHERE queue_scope=?').get('im:feishu:outbox-recovery-session'))
      .toEqual({ count: 0 })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM wake_events WHERE session_id=?').get(sessionId))
      .toEqual({ count: 0 })
    getDbConnection(db).exec('DROP TRIGGER fail_wake_outbox')

    const accepted = appendImInboxMessageWithWakeEvent(db, input)
    const retry = appendImInboxMessageWithWakeEvent(db, input)
    expect(retry).toEqual({ ...accepted, duplicate: true })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM messages WHERE id=?').get(accepted.messageId))
      .toEqual({ count: 1 })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM wake_events WHERE event_id=?').get(accepted.eventId))
      .toEqual({ count: 1 })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM wake_event_outbox WHERE event_id=?').get(accepted.eventId))
      .toEqual({ count: 1 })
    expect(getImInboxMessageContext(db, accepted.messageId)).toEqual({ messageId: accepted.messageId, channel: 'feishu', platformMessageId: 'outbox-recovery-message' })
    expect(getDbConnection(db).prepare('SELECT queued_message_id AS queuedMessageId,state FROM queue_input_requests WHERE session_id=? AND request_id=? AND queue_scope=?')
      .get(sessionId, `wake:${accepted.eventId}`, 'im:feishu:outbox-recovery-session'))
      .toEqual({ queuedMessageId: accepted.messageId, state: 'queued' })
    db.close()
  })

  it('persists the per-message WeChat context token with the inbox and wake event', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'wechat-inbox-context' }).id
    const queueScope = buildImQueueScope('wechat', sessionId)
    const accepted = appendImInboxMessageWithWakeEvent(db, { sessionId, channel: 'wechat', queueScope,
      channelMessageId: 'wechat-platform-1', content: 'queued', contextToken: 'context-token-1' })
    expect(getImInboxMessageContext(db, accepted.messageId)).toEqual({ messageId: accepted.messageId, channel: 'wechat',
      platformMessageId: 'wechat-platform-1', contextToken: 'context-token-1' })
    db.close()
  })

  it('does not restart a Loop from a released Inbox message after the run returns wait', () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'inbox-release-wait' }).id
    const queueScope = buildImQueueScope('feishu', 'release-wait-session')
    const message = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope,
      channelMessageId: 'release-wait-message', content: 'waiting for a new event'
    })
    const wakeEvent = appendWakeEvent(db, {
      sessionId, type: 'im-inbound', reasonKey: 'inbound:release-wait-message',
      payloadRef: { kind: 'im-inbox-message', messageId: message.messageId }
    })
    const run = claimWakeEvents(db, { sessionId, runId: 'wait-run', ownerId: 'wait-owner' })
    expect(claimImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'wait-owner' })).not.toBeNull()
    expect(releaseImInboxMessage(db, { queueScope, messageId: message.messageId, ownerId: 'wait-owner' })).toBe(true)
    expect(finalizeWakeEvents(db, {
      sessionId, runId: run.runId, ownerId: 'wait-owner', eventIds: run.eventIds
    })).toEqual([wakeEvent.eventId])

    expect(listQueuedUserMessages(db, { sessionId, queueScope }).map(({ message: queued }) => queued.id))
      .toEqual([message.messageId])
    expect(claimWakeEvents(db, { sessionId, runId: 'should-not-spin', ownerId: 'next-owner' }).eventIds).toEqual([])
    expect(listWakeEvents(db, sessionId).filter(({ status }) => status === 'pending')).toEqual([])
    db.close()
  })

})
