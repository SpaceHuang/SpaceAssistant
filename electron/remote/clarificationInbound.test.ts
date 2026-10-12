import { describe, expect, it, vi } from 'vitest'
import { resolveClarificationControlMessage } from './clarificationInbound'

describe('remote clarification inbound control routing', () => {
  it('reserves malformed clarification selections instead of classifying them as ordinary instructions', async () => {
    await expect(resolveClarificationControlMessage('选择 1234 1')).resolves.toEqual({
      consumed: true, resultKind: 'invalid', reply: expect.stringContaining('选择 <句柄> <选项>')
    })
  })

  it('fails closed for valid-looking handles until a durable resolver is connected', async () => {
    await expect(resolveClarificationControlMessage('选择 ABCD-EFGH-JK345 1')).resolves.toEqual({
      consumed: true, resultKind: 'unavailable', reply: expect.stringContaining('重新描述原问题')
    })
  })

  it('passes strict handle, option, and authenticated identity context to the resolver', async () => {
    const resolve = vi.fn(async () => ({ kind: 'resolved' as const, trackId: 'track', workId: 'work' }))
    await expect(resolveClarificationControlMessage('选择 ABCD-EFGH-JK345 2', {
      channel: 'wechat', identityKey: 'alice', ownerId: 'owner', replyMessageId: 'reply', resolve
    })).resolves.toEqual({ consumed: true, resultKind: 'resolved', reply: '已收到选择，正在继续处理。' })
    expect(resolve).toHaveBeenCalledWith({
      channel: 'wechat', identityKey: 'alice', ownerId: 'owner', replyMessageId: 'reply', handle: 'ABCDEFGHJK345', option: 2
    })
  })

  it('keeps non-protocol user messages in the ordinary route', async () => {
    const resolve = vi.fn()
    await expect(resolveClarificationControlMessage('请继续分析这件事', {
      channel: 'feishu', identityKey: 'alice', ownerId: 'owner', replyMessageId: 'message', resolve
    })).resolves.toEqual({ consumed: false })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('consumes a legacy bare option while a clarification is pending, without treating it as a valid choice', async () => {
    const resolve = vi.fn()
    await expect(resolveClarificationControlMessage('1', {
      channel: 'wechat', identityKey: 'alice', ownerId: 'owner', replyMessageId: 'reply', legacyBareOptionPending: true, resolve
    })).resolves.toMatchObject({ consumed: true, resultKind: 'invalid' })
    expect(resolve).not.toHaveBeenCalled()
  })
})
