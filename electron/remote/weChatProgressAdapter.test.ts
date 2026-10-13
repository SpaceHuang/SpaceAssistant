import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { createWeChatProgressAdapter } from './weChatProgressAdapter'

describe('WeChat system progress outbound', () => {
  it('does not send progress without authenticated outbound identity', async () => {
    const reply = vi.fn(async () => undefined)
    const adapter = createWeChatProgressAdapter({
      botService: { getBot: () => ({ reply, sendTyping: vi.fn() }) } as never,
      userId: 'owner-user',
      inboundRaw: { messageId: 'inbound-message' } as never,
      getSessionId: () => 'origin-session',
      config: DEFAULT_WECHAT_CONFIG,
      sessionCommands: {} as never
    })

    adapter.reply('progress update')
    await Promise.resolve()
    await Promise.resolve()

    expect(reply).not.toHaveBeenCalled()
  })

  it('binds progress to the authenticated owner and origin message before sending', async () => {
    const reply = vi.fn(async () => undefined)
    const adapter = createWeChatProgressAdapter({
      botService: { getBot: () => ({ reply, sendTyping: vi.fn() }) } as never,
      userId: 'owner-user', ownerId: 'owner-user',
      inboundRaw: { userId: 'owner-user', timestamp: new Date(1), raw: { client_id: 'inbound-message' } } as never,
      getSessionId: () => 'origin-session', config: DEFAULT_WECHAT_CONFIG, sessionCommands: {} as never
    })
    adapter.reply('progress update')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(reply).toHaveBeenCalledOnce()
    expect(reply.mock.calls[0]?.[1]).toContain('progress update')
  })
})
