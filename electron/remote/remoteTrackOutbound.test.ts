import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createRemoteTrack, resolveRemoteTrackMessageReference } from '../database/remoteTrackStore'
import { getDbConnection } from '../database/sqliteStore'
import { recordRemoteTrackOutboundAttempt, settleRemoteTrackOutboundAttempt } from './remoteTrackOutbound'

describe('Track outbound delivery facts', () => {
  it('records a fulfilled send and binds its stable platform message ID', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'outbound-feishu', metadata: { source: 'feishu' } })
    createRemoteTrack(db, { trackId: 'outbound-track', eventId: 'outbound-root', idempotencyKey: 'outbound-root-key',
      channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1,
      rootMessageId: 'inbound-root', originSessionId: session.id, occurredAt: 1 })
    const context = { trackId: 'outbound-track', attributionEventId: 'outbound-root', channel: 'feishu' as const,
      identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'inbound-root' }
    const attempt = recordRemoteTrackOutboundAttempt(db, { track: context, requestId: 'request-1', turnId: 'turn-1', now: 10 })

    settleRemoteTrackOutboundAttempt(db, { track: context, attempt, outcome: 'fulfilled', platformMessageId: 'feishu-reply-1', now: 20 })

    expect(resolveRemoteTrackMessageReference(db, { channel: 'feishu', platformMessageId: 'feishu-reply-1',
      identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1 })).toMatchObject({
      trackId: 'outbound-track', eventId: attempt.boundEventId, direction: 'outbound'
    })
    expect(getDbConnection(db).prepare('SELECT event_kind FROM remote_track_events WHERE event_id=?').get(attempt.boundEventId))
      .toEqual({ event_kind: 'track.outbound.message_bound' })
    db.close()
  })

  it('records a fulfilled send as unbound when the platform SDK returns no message ID', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'outbound-wechat', metadata: { source: 'wechat' } })
    createRemoteTrack(db, { trackId: 'outbound-wechat-track', eventId: 'outbound-wechat-root', idempotencyKey: 'outbound-wechat-root-key',
      channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
      rootMessageId: 'inbound-root', originSessionId: session.id, occurredAt: 1 })
    const track = { trackId: 'outbound-wechat-track', attributionEventId: 'outbound-wechat-root', channel: 'wechat' as const,
      identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'inbound-root' }
    const attempt = recordRemoteTrackOutboundAttempt(db, { track, requestId: 'request-1', turnId: 'turn-1', now: 10 })

    settleRemoteTrackOutboundAttempt(db, { track, attempt, outcome: 'fulfilled', now: 20 })

    const result = getDbConnection(db).prepare('SELECT event_kind,payload_json FROM remote_track_events WHERE event_id=?')
      .get(attempt.resultEventId) as { event_kind: string; payload_json: string }
    expect(result.event_kind).toBe('track.outbound.send_result')
    expect(JSON.parse(result.payload_json)).toMatchObject({ outcome: 'fulfilled', bindingState: 'unavailable', platformMessageId: null })
    expect(resolveRemoteTrackMessageReference(db, { channel: 'wechat', platformMessageId: 'unknown',
      identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1 })).toBeNull()
    db.close()
  })
})
