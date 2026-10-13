import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sendFeishuRemoteOutbound, sendFeishuRemoteOutboundWithId } from './feishuRemoteOutbound'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createRemoteTrack, resolveRemoteTrackMessageReference } from '../database/remoteTrackStore'
import { createHostImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'
vi.mock('../remote/remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

vi.mock('./feishuReply', () => ({
  replyFeishuTextRaw: vi.fn().mockResolvedValue(undefined),
  replyFeishuTextRawWithId: vi.fn().mockResolvedValue({ messageId: 'feishu-message-1' })
}))

import { replyFeishuTextRaw, replyFeishuTextRawWithId } from './feishuReply'

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const facts = (body: string, sessionId = SESSION_ID, recipient = 'owner-user') => ({ channel: 'feishu' as const, purpose: 'system-reply' as const, originSessionId: sessionId, activeSessionId: sessionId, identityKey: recipient, ownerId: recipient, trustedRecipient: recipient, recipient, chatType: 'p2p' as const, content: body, contentAssessment: { source: 'host' as const, content: body, classification: 'ordinary' as const, classifierVersion: 'test-host-v1' }, contentCompleteness: 'complete' as const, hasAttachment: false, attachmentAuthorized: false })

describe('sendFeishuRemoteOutbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses system reply without main-process outbound delivery facts', async () => {
    await expect(sendFeishuRemoteOutbound({ runner: { run: vi.fn() } as never, messageId: 'inbound', body: 'system reply' }))
      .rejects.toThrow('FEISHU_OUTBOUND_FINAL_CHECK_REQUIRED')
    expect(replyFeishuTextRaw).not.toHaveBeenCalled()
  })

  it('refuses a host-assessed sensitive system body before the Feishu platform call', async () => {
    const runner = { run: vi.fn() } as never
    const body = 'access_token=abcdef0123456789abcdef0123456789'
    const outboundDeliveryFacts = createHostImOutboundFacts({ channel: 'feishu', body, sessionId: SESSION_ID,
      identityKey: 'owner-user', ownerId: 'owner-user', recipient: 'owner-user', chatType: 'p2p', destinationId: 'inbound' })

    await expect(sendFeishuRemoteOutbound({ runner, messageId: 'inbound', body, sessionId: SESSION_ID,
      recipient: 'owner-user', outboundDeliveryFacts })).rejects.toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')

    expect(replyFeishuTextRaw).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('keeps the feishu session suffix within the 4000-char contract', async () => {
    const runner = { run: vi.fn() } as never
    const longBody = 'x'.repeat(5000)
    await expect(sendFeishuRemoteOutbound({
      runner,
      messageId: 'm1',
      body: longBody,
      sessionId: SESSION_ID, recipient: 'owner-user', outboundDeliveryFacts: facts(longBody),
      touch: { sessionCommands: {} as never, sessionId: SESSION_ID }
    })).resolves.toBeUndefined()
    const sent = vi.mocked(replyFeishuTextRaw).mock.calls[0]![2] as string
    expect(sent.length).toBeLessThanOrEqual(4000)
    expect(sent.endsWith(` 会话#A1B2C3D4`)).toBe(true)
  })

  it('returns the platform message ID on the confirmation delivery path', async () => {
    const runner = { run: vi.fn() } as never
    const outboundDeliveryFacts = { ...facts('confirm'), destinationId: 'm1' }
    await expect(sendFeishuRemoteOutboundWithId({ runner, messageId: 'm1', body: 'confirm', sessionId: SESSION_ID,
      recipient: 'owner-user', outboundDeliveryFacts }))
      .resolves.toEqual({ messageId: 'feishu-message-1' })
  })

  it('refuses the confirmation prompt side effect without bound owner and destination facts', async () => {
    const runner = { run: vi.fn() } as never
    await expect(sendFeishuRemoteOutboundWithId({ runner, messageId: 'm1', body: 'confirm', sessionId: SESSION_ID,
      recipient: 'owner-user', outboundDeliveryFacts: { ...facts('changed body'), destinationId: 'm1' } }))
      .rejects.toThrow('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
    expect(replyFeishuTextRawWithId).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('records a Track result reply and binds the API message ID returned by Feishu', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'feishu-outbound-track', metadata: { source: 'feishu' } })
    createRemoteTrack(db, { trackId: 'feishu-outbound-track', eventId: 'feishu-outbound-root', idempotencyKey: 'feishu-outbound-root-key',
      channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'inbound-root',
      originSessionId: session.id, occurredAt: 1 })
    vi.mocked(replyFeishuTextRaw).mockResolvedValue({ messageId: 'feishu-final-reply' })

    const result = await sendFeishuRemoteOutbound({ runner: { run: vi.fn() } as never, messageId: 'inbound-root', body: 'done', sessionId: SESSION_ID, recipient: 'owner-user', outboundDeliveryFacts: facts('done'),
      trackDelivery: { db, track: { trackId: 'feishu-outbound-track', channel: 'feishu', identityKey: 'chat', ownerId: 'owner',
        authorizationEpoch: 1, rootMessageId: 'inbound-root', attributionEventId: 'feishu-outbound-root' }, requestId: 'request-1', turnId: 'turn-1' } })

    expect(result).toEqual({ messageId: 'feishu-final-reply' })
    expect(resolveRemoteTrackMessageReference(db, { channel: 'feishu', platformMessageId: 'feishu-final-reply',
      identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1 })).toMatchObject({ trackId: 'feishu-outbound-track', direction: 'outbound' })
    db.close()
  })
})
