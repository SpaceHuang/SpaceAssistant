import { describe, expect, it } from 'vitest'
import { ackImInboxMessage, appendImInboxMessage, claimImInboxMessage, listImInboxMessages, releaseImInboxMessage, renewImInboxClaim } from '../database/imInbox'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { claimQueuedTurnAtomicallyInScope, createSession, deleteQueuedUserMessageInScope, enqueueAgentSessionMessageInScope, enqueueQueuedUserMessageInScope, getNextDesktopQueueInput, listQueuedUserMessages } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { classifyQueueInputSource } from './queueContract'
import { insertRuntimeTrigger } from './store'

function authorization(id: string, ownerSessionId: string, receiverSessionId: string, queueScope: { kind: 'desktop' } | { kind: 'im'; channel: 'feishu' | 'wechat'; sessionId: string }) {
  return { authorization: { bindingVersion: 1, requestId: `runtime-trigger:${id}`, ownerSessionId, receiverSessionId, queueScope,
    sourceIdentity: { kind: 'test-source' }, payloadDigest: 'source-digest', policyRevision: 'policy-1', authorizationGeneration: 'auth-1', runtimeGeneration: 'runtime-1' } }
}

describe('trusted queue input source classification', () => {
  it('requires a real receipt and trigger record; a runtime prefix alone is invalid', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const commands = createSessionCommands(db)
      const scope = { kind: 'desktop' } as const
      const queued = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:missing', content: 'wake', queueScope: scope })
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: queued.receipt.requestId, queuedMessageId: queued.persisted.message.id })).toBe('invalid')
      insertRuntimeTrigger(commands, { id: 'trigger-1', ownerSessionId: owner, receiverSessionId: receiver, clientKey: 'key',
        definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner, turnId: 'turn-1' }, sourceBaseline: {} },
        state: 'matched', result: authorization('trigger-1', owner, receiver, scope), createdAt: 1, expiresAt: 9, attempts: 0, revision: 1, updatedAt: 1 })
      const valid = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:trigger-1', content: '运行时事件待处理：trigger-1', queueScope: scope })
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: valid.receipt.requestId, queuedMessageId: valid.persisted.message.id })).toBe('runtime-trigger')
      getDbConnection(db).prepare("UPDATE runtime_triggers SET result_json='{}' WHERE id='trigger-1'").run()
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: valid.receipt.requestId, queuedMessageId: valid.persisted.message.id })).toBe('invalid')
      getDbConnection(db).prepare('UPDATE runtime_triggers SET result_json=? WHERE id=?').run(JSON.stringify(authorization('trigger-1', owner, receiver, scope)), 'trigger-1')
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: valid.receipt.requestId, queuedMessageId: valid.persisted.message.id, declaresPlatformSource: true })).toBe('invalid')
      expect(listQueuedUserMessages(db, { sessionId: receiver, queueScope: scope })).toEqual([])
      expect(listQueuedUserMessages(db, { sessionId: receiver, queueScope: scope, source: 'runtime-trigger' })).toHaveLength(1)
      expect(() => claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver, userMessageId: valid.persisted.message.id, turnId: 'wrong-source-turn',
        assistantMessageId: 'wrong-source-assistant', requestId: valid.receipt.requestId, queueScope: scope })).toThrow('QUEUE_INPUT_SOURCE_INVALID')
      expect(deleteQueuedUserMessageInScope(db, queued.persisted.message.id, scope).ok).toBe(true)
      expect(claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver, userMessageId: valid.persisted.message.id, turnId: 'trigger-turn',
        assistantMessageId: 'trigger-assistant', requestId: valid.receipt.requestId, queueScope: scope, source: 'runtime-trigger' }).user.message.id).toBe(valid.persisted.message.id)
    } finally { db.close() }
  })

  it('does not let a later desktop runtime-trigger claim bypass an earlier cross-session message', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'fifo-trigger-owner' })
      const receiver = createSession(db, { name: 'fifo-trigger-receiver' })
      const commands = createSessionCommands(db)
      const scope = { kind: 'desktop' } as const
      enqueueAgentSessionMessageInScope(db, { ownerSessionId: owner.id, targetSessionId: receiver.id,
        requestId: 'earlier-agent-input', content: 'earlier', authorizationBinding: {} })
      insertRuntimeTrigger(commands, { id: 'later-trigger', ownerSessionId: owner.id, receiverSessionId: receiver.id, clientKey: 'key',
        definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner.id, turnId: 'turn-1' }, sourceBaseline: {} },
        state: 'matched', result: authorization('later-trigger', owner.id, receiver.id, scope), createdAt: 1, expiresAt: 9,
        attempts: 0, revision: 1, updatedAt: 1 })
      const trigger = enqueueQueuedUserMessageInScope(db, { sessionId: receiver.id, requestId: 'runtime-trigger:later-trigger',
        content: '运行时事件待处理：later-trigger', queueScope: scope })

      expect(getNextDesktopQueueInput(db, receiver.id)?.requestId).toBe('earlier-agent-input')
      expect(() => claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver.id, userMessageId: trigger.persisted.message.id,
        turnId: 'later-trigger-turn', assistantMessageId: 'later-trigger-assistant', requestId: 'runtime-trigger:later-trigger',
        queueScope: scope, source: 'runtime-trigger' })).toThrow('DESKTOP_QUEUE_HEAD_CHANGED')
      expect(getNextDesktopQueueInput(db, receiver.id)?.requestId).toBe('earlier-agent-input')
    } finally { db.close() }
  })

  it('separates authenticated platform facts from ordinary desktop input', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'receiver' }).id
      const desktop = { kind: 'desktop' } as const
      const ordinary = enqueueQueuedUserMessageInScope(db, { sessionId: session, requestId: 'desktop-1', content: 'hello', queueScope: desktop })
      expect(classifyQueueInputSource(db, { sessionId: session, queueScope: desktop, requestId: 'desktop-1', queuedMessageId: ordinary.persisted.message.id })).toBe('ordinary-desktop')
      const imScope = buildImQueueScope('feishu', session)
      const platform = appendImInboxMessage(db, { sessionId: session, channel: 'feishu', queueScope: imScope, channelMessageId: 'platform-1',
        accountId: 'account', conversationId: 'conversation', senderId: 'sender', content: 'hello' })
      expect(classifyQueueInputSource(db, { sessionId: session, queueScope: imScope, requestId: 'platform-1', queuedMessageId: platform.messageId })).toBe('platform-im')
      expect(classifyQueueInputSource(db, { sessionId: session, queueScope: desktop, requestId: 'platform-1', queuedMessageId: platform.messageId })).toBe('invalid')
    } finally { db.close() }
  })

  it('cancels a claimed but undispatched prepared trigger turn without making its receipt reclaimable', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const commands = createSessionCommands(db)
      const scope = { kind: 'desktop' } as const
      insertRuntimeTrigger(commands, { id: 'cancel-trigger', ownerSessionId: owner, receiverSessionId: receiver, clientKey: 'key',
        definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner, turnId: 'source-turn' }, sourceBaseline: {} },
        state: 'matched', result: authorization('cancel-trigger', owner, receiver, scope), createdAt: 1, expiresAt: 9, attempts: 0, revision: 1, updatedAt: 1 })
      const queued = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:cancel-trigger', content: '运行时事件待处理：cancel-trigger', queueScope: scope })
      claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver, userMessageId: queued.persisted.message.id, turnId: 'prepared-trigger-turn',
        assistantMessageId: 'prepared-trigger-assistant', requestId: queued.receipt.requestId, queueScope: scope, source: 'runtime-trigger' })
      expect(commands.scopedQueue.cancelUndispatchedRuntimeInput({ sessionId: receiver, requestId: queued.receipt.requestId, queueScope: scope, expectedTurnId: 'prepared-trigger-turn' })).toBe(true)
      expect(commands.scopedQueue.readReceipt({ sessionId: receiver, requestId: queued.receipt.requestId, queueScope: scope })).toMatchObject({ state: 'cancelled', turnId: 'prepared-trigger-turn' })
      expect(getDbConnection(db).prepare("SELECT state,outcome FROM turns WHERE turn_id='prepared-trigger-turn'").get()).toEqual({ state: 'terminal', outcome: 'cancelled' })
      expect(commands.scopedQueue.cancelUndispatchedRuntimeInput({ sessionId: receiver, requestId: queued.receipt.requestId, queueScope: scope })).toBe(false)
      expect(() => claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver, userMessageId: queued.persisted.message.id, turnId: 'second-turn',
        assistantMessageId: 'second-assistant', requestId: queued.receipt.requestId, queueScope: scope, source: 'runtime-trigger' })).toThrow()
    } finally { db.close() }
  })

  it('keeps a runtime-trigger receipt out of every IM inbox consumer even in the same IM scope', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const commands = createSessionCommands(db)
      const scope = buildImQueueScope('wechat', receiver)
      insertRuntimeTrigger(commands, { id: 'trigger-in-im-scope', ownerSessionId: owner, receiverSessionId: receiver, clientKey: 'key',
        definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner, turnId: 'turn-1' }, sourceBaseline: {} },
        state: 'matched', result: authorization('trigger-in-im-scope', owner, receiver, scope), createdAt: 1, expiresAt: 9, attempts: 0, revision: 1, updatedAt: 1 })
      const queued = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:trigger-in-im-scope', content: '运行时事件待处理：trigger-in-im-scope', queueScope: scope })
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: queued.receipt.requestId, queuedMessageId: queued.persisted.message.id })).toBe('runtime-trigger')
      expect(listImInboxMessages(db, { queueScope: scope })).toEqual([])
      expect(claimImInboxMessage(db, { queueScope: scope, messageId: queued.persisted.message.id, ownerId: 'inbox-owner' })).toBeNull()
      expect(ackImInboxMessage(db, { queueScope: scope, messageId: queued.persisted.message.id, ownerId: 'inbox-owner' })).toBe(false)
      expect(releaseImInboxMessage(db, { queueScope: scope, messageId: queued.persisted.message.id, ownerId: 'inbox-owner' })).toBe(false)
      expect(renewImInboxClaim(db, { queueScope: scope, messageId: queued.persisted.message.id, ownerId: 'inbox-owner', leaseDurationMs: 1000 })).toBe(false)
      expect(getDbConnection(db).prepare('SELECT status FROM messages WHERE id=?').get(queued.persisted.message.id)).toEqual({ status: 'queued' })
      expect(getDbConnection(db).prepare('SELECT state FROM queue_input_requests WHERE request_id=?').get(queued.receipt.requestId)).toEqual({ state: 'queued' })
    } finally { db.close() }
  })

  it('exposes scoped enqueue, read-only receipt, and one-shot unstarted cancellation through SessionCommands', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'scoped-port' }).id
      const commands = createSessionCommands(db)
      const scope = { kind: 'desktop' } as const
      const input = { sessionId: session, requestId: 'cancel-me', content: 'wake', queueScope: scope }
      const first = commands.scopedQueue.enqueue(input)
      expect(commands.scopedQueue.enqueue(input).duplicate).toBe(true)
      expect(() => commands.scopedQueue.enqueue({ ...input, content: 'changed' })).toThrow('QUEUE_REQUEST_FINGERPRINT_MISMATCH')
      expect(commands.scopedQueue.readReceipt({ sessionId: session, requestId: input.requestId, queueScope: scope })).toMatchObject({ queuedMessageId: first.persisted.message.id, state: 'queued' })
      expect(commands.scopedQueue.cancelUnstartedInput({ sessionId: session, requestId: input.requestId, queueScope: scope, expectedSource: 'ordinary-desktop' })).toBe(true)
      expect(commands.scopedQueue.readReceipt({ sessionId: session, requestId: input.requestId, queueScope: scope })?.state).toBe('cancelled')
      expect(commands.scopedQueue.cancelUnstartedInput({ sessionId: session, requestId: input.requestId, queueScope: scope, expectedSource: 'ordinary-desktop' })).toBe(false)
    } finally { db.close() }
  })

  it('removes a queued trigger marker after the trigger has atomically entered cancelled state', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'cancelled trigger owner' }).id
      const receiver = createSession(db, { name: 'cancelled trigger receiver' }).id
      const commands = createSessionCommands(db)
      const scope = { kind: 'desktop' } as const
      insertRuntimeTrigger(commands, { id: 'cancelled-trigger', ownerSessionId: owner, receiverSessionId: receiver, clientKey: 'key',
        definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner, turnId: 'turn-1' }, sourceBaseline: {} },
        state: 'matched', result: authorization('cancelled-trigger', owner, receiver, scope), createdAt: 1, expiresAt: 9, attempts: 0, revision: 1, updatedAt: 1 })
      const queued = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:cancelled-trigger',
        content: '运行时事件待处理：cancelled-trigger', queueScope: scope })
      getDbConnection(db).prepare("UPDATE runtime_triggers SET state='cancelled' WHERE id='cancelled-trigger'").run()
      expect(commands.scopedQueue.cancelUndispatchedRuntimeInput({ sessionId: receiver, requestId: queued.receipt.requestId, queueScope: scope })).toBe(true)
      expect(commands.scopedQueue.readReceipt({ sessionId: receiver, requestId: queued.receipt.requestId, queueScope: scope })?.state).toBe('cancelled')
      expect(listQueuedUserMessages(db, { sessionId: receiver, queueScope: scope })).toEqual([])
    } finally { db.close() }
  })
})
