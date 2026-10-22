import { describe, expect, it } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { createRemoteTrack } from '../database/remoteTrackStore'
import { getDbConnection } from '../database/sqliteStore'
import { buildTrackModelInputViewRef, recordTrackModelMessage } from './trackModelInputViewStore'

describe('persisted Track model input view', () => {
  it('builds a complete view from only the selected Track event ledger in a shared session', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'shared-session' })
      for (const [trackId, root, user, turn] of [
        ['track-a', 'root-a', 'message-a', 'turn-a'], ['track-b', 'root-b', 'message-b', 'turn-b']
      ]) {
        createRemoteTrack(db, { trackId, eventId: root, idempotencyKey: `inbound:${root}`, channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: root, originSessionId: session.id, occurredAt: 1 })
        appendMessage(db, { id: user, sessionId: session.id, role: 'user', content: `${trackId} private input`, timestamp: 2, status: 'sent' })
        recordTrackModelMessage(db, { trackId, eventId: `${trackId}:input`, idempotencyKey: `${trackId}:input`, sessionId: session.id, messageId: user, invocationId: turn, occurredAt: 3 })
      }
      const view = buildTrackModelInputViewRef(db, { trackId: 'track-a', sessionId: session.id, acceptedUserMessageId: 'message-a', currentInvocationId: 'turn-a', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', attributionEventId: 'root-a' })
      expect(view).toMatchObject({ completeness: 'complete', includedMessageIds: ['message-a'], includedInvocationIds: ['turn-a'] })
      expect(view.includedMessageIds).not.toContain('message-b')
    } finally {
      db.close()
    }
  })

  it('marks the view unavailable when the current accepted message is not bound to the Track', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'missing-binding' })
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'root-a', idempotencyKey: 'inbound:a', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', originSessionId: session.id, occurredAt: 1 })
      appendMessage(db, { id: 'message-a', sessionId: session.id, role: 'user', content: 'unbound', timestamp: 2, status: 'sent' })
      const view = buildTrackModelInputViewRef(db, { trackId: 'track-a', sessionId: session.id, acceptedUserMessageId: 'message-a', currentInvocationId: 'turn-a', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', attributionEventId: 'root-a' })
      expect(view.completeness).toBe('unavailable')
    } finally {
      db.close()
    }
  })

  it.each(['wechat', 'feishu'] as const)('keeps %s async approval resume complete when it reuses the accepted user message across invocations', (channel) => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'approval-resume' })
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'root-a', idempotencyKey: 'inbound:a', channel, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', originSessionId: session.id, occurredAt: 1 })
      appendMessage(db, { id: 'message-a', sessionId: session.id, role: 'user', content: 'run the approved action', timestamp: 2, status: 'sent' })
      recordTrackModelMessage(db, { trackId: 'track-a', eventId: 'original:user', idempotencyKey: 'original:user', sessionId: session.id, messageId: 'message-a', invocationId: 'original-turn', occurredAt: 3 })
      recordTrackModelMessage(db, { trackId: 'track-a', eventId: 'resume:user', idempotencyKey: 'resume:user', sessionId: session.id, messageId: 'message-a', invocationId: 'resume-turn', occurredAt: 4 })

      const view = buildTrackModelInputViewRef(db, { trackId: 'track-a', sessionId: session.id, acceptedUserMessageId: 'message-a', currentInvocationId: 'resume-turn', channel, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', attributionEventId: 'root-a' })

      expect(view.completeness).toBe('complete')
      expect(view.includedMessageIds).toEqual(['message-a'])
      expect(view.includedInvocationIds).toEqual(['original-turn', 'resume-turn'])
      expect(view.includedEventIds).toEqual(['original:user', 'resume:user'])
    } finally {
      db.close()
    }
  })

  it('rejects attempts to bind another session message to the Track', () => {
    const db = createMemoryAppDb()
    try {
      const sessionA = createSession(db, { name: 'session-a' })
      const sessionB = createSession(db, { name: 'session-b' })
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'root-a', idempotencyKey: 'inbound:a', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', originSessionId: sessionA.id, occurredAt: 1 })
      appendMessage(db, { id: 'message-b', sessionId: sessionB.id, role: 'user', content: 'other session', timestamp: 2, status: 'sent' })
      expect(() => recordTrackModelMessage(db, { trackId: 'track-a', eventId: 'cross-session', idempotencyKey: 'cross-session', sessionId: sessionA.id, messageId: 'message-b', invocationId: 'turn-b', occurredAt: 3 }))
        .toThrow('TRACK_MODEL_MESSAGE_SESSION_MISMATCH')
    } finally {
      db.close()
    }
  })

  it('includes only explicitly ledgered messages across sessions in the same Track view', () => {
    const db = createMemoryAppDb()
    try {
      const origin = createSession(db, { name: 'track-origin-session' })
      const current = createSession(db, { name: 'track-current-session' })
      createRemoteTrack(db, { trackId: 'track-cross-session', eventId: 'cross-root', idempotencyKey: 'cross-root', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root', originSessionId: origin.id, occurredAt: 1 })
      appendMessage(db, { id: 'origin-user', sessionId: origin.id, role: 'user', content: 'origin request', timestamp: 2, status: 'sent' })
      appendMessage(db, { id: 'current-user', sessionId: current.id, role: 'user', content: 'follow up', timestamp: 3, status: 'sent' })
      appendMessage(db, { id: 'unrelated-user', sessionId: current.id, role: 'user', content: 'another Track', timestamp: 4, status: 'sent' })
      recordTrackModelMessage(db, { trackId: 'track-cross-session', eventId: 'origin-input', idempotencyKey: 'origin-input', sessionId: origin.id, messageId: 'origin-user', invocationId: 'origin-turn', occurredAt: 5 })
      recordTrackModelMessage(db, { trackId: 'track-cross-session', eventId: 'current-input', idempotencyKey: 'current-input', sessionId: current.id, messageId: 'current-user', invocationId: 'current-turn', occurredAt: 6 })
      const view = buildTrackModelInputViewRef(db, { trackId: 'track-cross-session', sessionId: current.id, acceptedUserMessageId: 'current-user', currentInvocationId: 'current-turn',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root', attributionEventId: 'cross-root' })
      expect(view).toMatchObject({ completeness: 'complete', includedMessageIds: ['origin-user', 'current-user'],
        includedSessionIds: [current.id, origin.id].sort(),
        messageSessionMap: { 'origin-user': origin.id, 'current-user': current.id },
        invocationSessionMap: { 'origin-turn': origin.id, 'current-turn': current.id } })
      expect(view.includedMessageIds).not.toContain('unrelated-user')
    } finally { db.close() }
  })

  it('includes only the completed parent Track explicitly linked by a successor', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'successor-context' })
      createRemoteTrack(db, { trackId: 'parent-track', eventId: 'parent-root', idempotencyKey: 'parent-inbound', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'parent-platform-root', originSessionId: session.id, occurredAt: 1 })
      appendMessage(db, { id: 'parent-user', sessionId: session.id, role: 'user', content: 'parent intent', timestamp: 2, status: 'sent' })
      appendMessage(db, { id: 'parent-assistant', sessionId: session.id, role: 'assistant', content: 'parent result', timestamp: 3, status: 'sent' })
      recordTrackModelMessage(db, { trackId: 'parent-track', eventId: 'parent-user-event', idempotencyKey: 'parent-user-event', sessionId: session.id, messageId: 'parent-user', invocationId: 'parent-turn', occurredAt: 4 })
      recordTrackModelMessage(db, { trackId: 'parent-track', eventId: 'parent-assistant-event', idempotencyKey: 'parent-assistant-event', sessionId: session.id, messageId: 'parent-assistant', invocationId: 'parent-turn', occurredAt: 5 })
      getDbConnection(db).prepare("UPDATE remote_tracks SET state='completed' WHERE track_id='parent-track'").run()
      createRemoteTrack(db, { trackId: 'successor-track', eventId: 'successor-root', idempotencyKey: 'successor-inbound', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'successor-platform-root', parentTrackId: 'parent-track', originSessionId: session.id, occurredAt: 6 })
      appendMessage(db, { id: 'successor-user', sessionId: session.id, role: 'user', content: 'follow up', timestamp: 7, status: 'sent' })
      recordTrackModelMessage(db, { trackId: 'successor-track', eventId: 'successor-user-event', idempotencyKey: 'successor-user-event', sessionId: session.id, messageId: 'successor-user', invocationId: 'successor-turn', occurredAt: 8 })

      const view = buildTrackModelInputViewRef(db, { trackId: 'successor-track', sessionId: session.id, acceptedUserMessageId: 'successor-user',
        currentInvocationId: 'successor-turn', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        rootMessageId: 'successor-platform-root', attributionEventId: 'successor-root' })
      expect(view).toMatchObject({ completeness: 'complete', permittedParentTrackIds: ['parent-track'],
        includedMessageIds: ['parent-user', 'parent-assistant', 'successor-user'] })
    } finally { db.close() }
  })

  it('rejects building a view after the Track owner or durable authorization epoch changes', () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'stale-owner-view' })
      createRemoteTrack(db, { trackId: 'track-a', eventId: 'root-a', idempotencyKey: 'inbound:a', channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-a', originSessionId: session.id, occurredAt: 1 })
      expect(() => buildTrackModelInputViewRef(db, {
        trackId: 'track-a', sessionId: session.id, acceptedUserMessageId: 'message-a', currentInvocationId: 'turn-a',
        channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 2, rootMessageId: 'root-a', attributionEventId: 'root-a'
      })).toThrow('TRACK_MODEL_INPUT_AUTH_SCOPE_MISMATCH')
    } finally {
      db.close()
    }
  })
})
