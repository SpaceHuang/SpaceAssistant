import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'
vi.mock('../remote/remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

vi.mock('./feishuReply', () => ({
  replyFeishuTextRaw: vi.fn().mockResolvedValue(undefined)
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
    await sendFeishuRemoteOutbound({
      runner,
      messageId: 'm1',
      body: longBody,
      sessionId: SESSION_ID,
      touch: { db: {} as never, sessionId: SESSION_ID }
    })
    const sent = vi.mocked(replyFeishuTextRaw).mock.calls[0]![2] as string
    expect(sent.length).toBeLessThanOrEqual(4000)
    expect(sent.endsWith(` 会话$${SESSION_ID}$`)).toBe(true)
  })
})
