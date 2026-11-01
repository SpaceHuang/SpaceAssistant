import { describe, expect, it } from 'vitest'
import { ackImInboxMessage, appendImInboxMessage, claimImInboxMessage, listImInboxMessages, releaseImInboxMessage, renewImInboxClaim } from '../database/imInbox'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { claimQueuedTurnAtomicallyInScope, createSession, enqueueQueuedUserMessageInScope, listQueuedUserMessages } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { classifyQueueInputSource } from './queueContract'
import { insertRuntimeTrigger } from './store'

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
        state: 'matched', createdAt: 1, expiresAt: 9, attempts: 0, revision: 1, updatedAt: 1 })
      const valid = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:trigger-1', content: 'wake', queueScope: scope })
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: valid.receipt.requestId, queuedMessageId: valid.persisted.message.id })).toBe('runtime-trigger')
      expect(classifyQueueInputSource(db, { sessionId: receiver, queueScope: scope, requestId: valid.receipt.requestId, queuedMessageId: valid.persisted.message.id, declaresPlatformSource: true })).toBe('invalid')
      expect(listQueuedUserMessages(db, { sessionId: receiver, queueScope: scope })).toEqual([])
      expect(listQueuedUserMessages(db, { sessionId: receiver, queueScope: scope, source: 'runtime-trigger' })).toHaveLength(1)
      expect(() => claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver, userMessageId: valid.persisted.message.id, turnId: 'wrong-source-turn',
        assistantMessageId: 'wrong-source-assistant', requestId: valid.receipt.requestId, queueScope: scope })).toThrow('QUEUE_INPUT_SOURCE_INVALID')
      expect(claimQueuedTurnAtomicallyInScope(db, { sessionId: receiver, userMessageId: valid.persisted.message.id, turnId: 'trigger-turn',
        assistantMessageId: 'trigger-assistant', requestId: valid.receipt.requestId, queueScope: scope, source: 'runtime-trigger' }).user.message.id).toBe(valid.persisted.message.id)
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

  it('keeps a runtime-trigger receipt out of every IM inbox consumer even in the same IM scope', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const commands = createSessionCommands(db)
      const scope = buildImQueueScope('wechat', receiver)
      insertRuntimeTrigger(commands, { id: 'trigger-in-im-scope', ownerSessionId: owner, receiverSessionId: receiver, clientKey: 'key',
        definition: { version: 1, condition: { type: 'turn_completed', targetSessionId: owner, turnId: 'turn-1' }, sourceBaseline: {} },
        state: 'matched', createdAt: 1, expiresAt: 9, attempts: 0, revision: 1, updatedAt: 1 })
      const queued = enqueueQueuedUserMessageInScope(db, { sessionId: receiver, requestId: 'runtime-trigger:trigger-in-im-scope', content: 'wake', queueScope: scope })
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
})
