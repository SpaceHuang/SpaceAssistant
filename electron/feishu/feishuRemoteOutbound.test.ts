import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sendFeishuRemoteOutbound, sendFeishuRemoteOutboundWithId } from './feishuRemoteOutbound'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createRemoteTrack, resolveRemoteTrackMessageReference } from '../database/remoteTrackStore'
vi.mock('../remote/remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

vi.mock('./feishuReply', () => ({
  replyFeishuTextRaw: vi.fn().mockResolvedValue(undefined),
  replyFeishuTextRawWithId: vi.fn().mockResolvedValue({ messageId: 'feishu-message-1' })
}))

import { replyFeishuTextRaw } from './feishuReply'

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

describe('sendFeishuRemoteOutbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the feishu session suffix within the 4000-char contract', async () => {
    const runner = { run: vi.fn() } as never
    const longBody = 'x'.repeat(5000)
    await expect(sendFeishuRemoteOutbound({
      runner,
      messageId: 'm1',
      body: longBody,
      sessionId: SESSION_ID,
      touch: { sessionCommands: {} as never, sessionId: SESSION_ID }
    })).resolves.toBeUndefined()
    const sent = vi.mocked(replyFeishuTextRaw).mock.calls[0]![2] as string
    expect(sent.length).toBeLessThanOrEqual(4000)
    expect(sent.endsWith(` 会话$${SESSION_ID}$`)).toBe(true)
  })

  it('returns the platform message ID on the confirmation delivery path', async () => {
    const runner = { run: vi.fn() } as never
    await expect(sendFeishuRemoteOutboundWithId({ runner, messageId: 'm1', body: 'confirm' }))
      .resolves.toEqual({ messageId: 'feishu-message-1' })
  })

  it('records a Track result reply and binds the API message ID returned by Feishu', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'feishu-outbound-track', metadata: { source: 'feishu' } })
    createRemoteTrack(db, { trackId: 'feishu-outbound-track', eventId: 'feishu-outbound-root', idempotencyKey: 'feishu-outbound-root-key',
      channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'inbound-root',
      originSessionId: session.id, occurredAt: 1 })
    vi.mocked(replyFeishuTextRaw).mockResolvedValue({ messageId: 'feishu-final-reply' })

    const result = await sendFeishuRemoteOutbound({ runner: { run: vi.fn() } as never, messageId: 'inbound-root', body: 'done',
      trackDelivery: { db, track: { trackId: 'feishu-outbound-track', channel: 'feishu', identityKey: 'chat', ownerId: 'owner',
        authorizationEpoch: 1, rootMessageId: 'inbound-root', attributionEventId: 'feishu-outbound-root' }, requestId: 'request-1', turnId: 'turn-1' } })

    expect(result).toEqual({ messageId: 'feishu-final-reply' })
    expect(resolveRemoteTrackMessageReference(db, { channel: 'feishu', platformMessageId: 'feishu-final-reply',
      identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1 })).toMatchObject({ trackId: 'feishu-outbound-track', direction: 'outbound' })
    db.close()
  })
})
