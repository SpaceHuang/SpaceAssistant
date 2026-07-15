import { describe, expect, it } from 'vitest'
import { parseCompactInboundEvent, shouldAcceptInbound } from './feishuInboundParser'
import { DEFAULT_FEISHU_CONFIG } from '../../src/shared/feishuTypes'

const p2p = (overrides: Partial<Parameters<typeof shouldAcceptInbound>[0]> = {}) => ({
  messageId: 'm',
  chatId: 'c',
  chatType: 'p2p' as const,
  senderOpenId: 'ou_owner',
  content: 'hi',
  createTime: '1',
  mentionsBot: false,
  ...overrides
})

describe('feishuInboundParser', () => {
  it('parses compact text message', () => {
    const msg = parseCompactInboundEvent({
      message_id: 'm1',
      chat_id: 'c1',
      chat_type: 'p2p',
      sender_open_id: 'u1',
      content: JSON.stringify({ text: 'hello' })
    })
    expect(msg?.content).toBe('hello')
    expect(msg?.messageId).toBe('m1')
  })

  it('accepts p2p from bound owner', () => {
    const r = shouldAcceptInbound(p2p(), {
      ...DEFAULT_FEISHU_CONFIG,
      remoteSenderAllowlist: ['ou_owner']
    })
    expect(r.accept).toBe(true)
  })

  it('rejects p2p when unbound', () => {
    const r = shouldAcceptInbound(p2p(), DEFAULT_FEISHU_CONFIG)
    expect(r.accept).toBe(false)
    expect(r.reason).toBe('unbound')
  })

  it('rejects non-owner p2p', () => {
    const r = shouldAcceptInbound(p2p({ senderOpenId: 'ou_other' }), {
      ...DEFAULT_FEISHU_CONFIG,
      remoteSenderAllowlist: ['ou_owner']
    })
    expect(r.accept).toBe(false)
    expect(r.reason).toBe('non_owner')
  })

  it('accepts any p2p during bind window', () => {
    const r = shouldAcceptInbound(p2p({ senderOpenId: 'ou_any' }), DEFAULT_FEISHU_CONFIG, {
      bindingActive: true
    })
    expect(r.accept).toBe(true)
    expect(r.reason).toBe('bind_window')
  })

  it('always rejects group regardless of remoteGroupTrigger', () => {
    const r = shouldAcceptInbound(
      {
        messageId: 'm',
        chatId: 'c',
        chatType: 'group',
        senderOpenId: 'ou_owner',
        content: '/sa run tests',
        createTime: '1',
        mentionsBot: true
      },
      {
        ...DEFAULT_FEISHU_CONFIG,
        remoteGroupTrigger: 'both',
        remoteSenderAllowlist: ['ou_owner']
      }
    )
    expect(r.accept).toBe(false)
    expect(r.reason).toBe('group_disabled')
  })
})
