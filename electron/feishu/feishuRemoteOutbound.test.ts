import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'
import { touchRemoteSessionActivity } from '../remote/remoteSessionActivity'

vi.mock('./feishuReply', () => ({
  replyFeishuTextRaw: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../remote/remoteSessionActivity', () => ({
  touchRemoteSessionActivity: vi.fn()
}))

import { replyFeishuTextRaw } from './feishuReply'

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

describe('sendFeishuRemoteOutbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('appends session suffix for Tier-1 replies', async () => {
    const runner = { run: vi.fn() } as never
    await sendFeishuRemoteOutbound({
      runner,
      messageId: 'm1',
      body: '【进度】读取文件',
      sessionId: SESSION_ID,
      touch: { db: {} as never, sessionId: SESSION_ID }
    })
    const sent = vi.mocked(replyFeishuTextRaw).mock.calls[0]![2] as string
    expect(sent).toContain(` 会话$${SESSION_ID}$`)
    expect(touchRemoteSessionActivity).toHaveBeenCalledOnce()
  })

  it('does not append suffix for processing placeholder', async () => {
    const runner = { run: vi.fn() } as never
    await sendFeishuRemoteOutbound({
      runner,
      messageId: 'm1',
      body: '已收到，正在处理…',
      sessionId: SESSION_ID,
      touch: { db: {} as never, sessionId: SESSION_ID }
    })
    const sent = vi.mocked(replyFeishuTextRaw).mock.calls[0]![2] as string
    expect(sent).toBe('已收到，正在处理…')
    expect(touchRemoteSessionActivity).toHaveBeenCalledOnce()
  })

  it('Tier-0 does not touch activity', async () => {
    const runner = { run: vi.fn() } as never
    await sendFeishuRemoteOutbound({
      runner,
      messageId: 'm1',
      body: '权限拒绝'
    })
    expect(touchRemoteSessionActivity).not.toHaveBeenCalled()
  })

  it('keeps suffix intact for very long body (A12)', async () => {
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
