import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sendWeChatRemoteOutbound } from './weChatRemoteOutbound'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'
import type { WeChatReplyBot } from './weChatReplyService'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createRemoteTrack } from '../database/remoteTrackStore'
import { getDbConnection } from '../database/sqliteStore'

vi.mock('../remote/remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

describe('sendWeChatRemoteOutbound', () => {
  const reply = vi.fn().mockResolvedValue(undefined)
  const bot = { reply, sendTyping: vi.fn() } as unknown as WeChatReplyBot
  const inbound = { messageId: 'm1', userId: 'owner-user' } as never
const facts = (body: string, sessionId = SESSION_ID) => ({ channel: 'wechat' as const, purpose: 'system-reply' as const, originSessionId: sessionId, activeSessionId: sessionId, identityKey: 'owner-user', ownerId: 'owner-user', trustedRecipient: 'owner-user', recipient: 'owner-user', chatType: 'p2p' as const, content: body, contentAssessment: { source: 'host' as const, content: body, classification: 'ordinary' as const, classifierVersion: 'test-host-v1' }, contentCompleteness: 'complete' as const, hasAttachment: false, attachmentAuthorized: false })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses system reply without main-process outbound delivery facts', async () => {
    await expect(sendWeChatRemoteOutbound({ bot, inbound, body: 'system reply' }))
      .rejects.toThrow('WECHAT_OUTBOUND_FINAL_CHECK_REQUIRED')
    expect(reply).not.toHaveBeenCalled()
  })

  it('appends suffix after footer for Tier-1 summary', async () => {
    await sendWeChatRemoteOutbound({
      bot,
      inbound,
      body: '任务完成',
      sessionId: SESSION_ID,
      touch: { sessionCommands: {} as never, sessionId: SESSION_ID },
      outboundDeliveryFacts: facts('任务完成')
    })
    const sent = reply.mock.calls[0]![1] as string
    expect(sent).not.toContain('完整过程请查看 SpaceAssistant 桌面会话')
    expect(sent.endsWith(` 会话#A1B2C3D4`)).toBe(true)
    expect(touchRemoteSessionActivity).toHaveBeenCalledOnce()
  })

  it('keeps suffix within 2000 char budget (A8)', async () => {
    const longBody = '段落。\n\n'.repeat(500)
    await sendWeChatRemoteOutbound({
      bot,
      inbound,
      body: longBody,
      sessionId: SESSION_ID,
      touch: { sessionCommands: {} as never, sessionId: SESSION_ID },
      outboundDeliveryFacts: facts(longBody)
    })
    const sent = reply.mock.calls[0]![1] as string
    expect(sent.length).toBeLessThanOrEqual(2000)
    expect(sent.endsWith(` 会话#A1B2C3D4`)).toBe(true)
  })

  it('records a fulfilled Track reply as unbound because the WeChat SDK returns no message ID', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'wechat-outbound-track', metadata: { source: 'wechat' } })
    createRemoteTrack(db, { trackId: 'wechat-outbound-track', eventId: 'wechat-outbound-root', idempotencyKey: 'wechat-outbound-root-key',
      channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'inbound-root',
      originSessionId: session.id, occurredAt: 1 })

    await sendWeChatRemoteOutbound({ bot, inbound, body: 'done', sessionId: session.id, outboundDeliveryFacts: facts('done', session.id), trackDelivery: { db,
      track: { trackId: 'wechat-outbound-track', channel: 'wechat', identityKey: 'user', ownerId: 'owner',
        authorizationEpoch: 1, rootMessageId: 'inbound-root', attributionEventId: 'wechat-outbound-root' },
      requestId: 'request-1', turnId: 'turn-1' } })

    const event = getDbConnection(db).prepare(`SELECT event_kind,payload_json FROM remote_track_events
      WHERE track_id='wechat-outbound-track' AND event_kind='track.outbound.send_result'`).get() as { event_kind: string; payload_json: string }
    expect(JSON.parse(event.payload_json)).toMatchObject({ outcome: 'fulfilled', bindingState: 'unavailable', platformMessageId: null })
    db.close()
  })
})
