import { describe, expect, it } from 'vitest'
import { parseCompactInboundEvent, shouldAcceptInbound } from './feishuInboundParser'
import { DEFAULT_FEISHU_CONFIG } from '../../src/shared/feishuTypes'

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

  it('accepts p2p messages', () => {
    const r = shouldAcceptInbound(
      {
        messageId: 'm',
        chatId: 'c',
        chatType: 'p2p',
        senderOpenId: 'u',
        content: 'hi',
        createTime: '1',
        mentionsBot: false
      },
      DEFAULT_FEISHU_CONFIG
    )
    expect(r.accept).toBe(true)
  })

  it('requires mention in group when trigger=mention', () => {
    const r = shouldAcceptInbound(
      {
        messageId: 'm',
        chatId: 'c',
        chatType: 'group',
        senderOpenId: 'u',
        content: 'hi',
        createTime: '1',
        mentionsBot: false
      },
      DEFAULT_FEISHU_CONFIG
    )
    expect(r.accept).toBe(false)
  })

  it('accepts prefix in group', () => {
    const r = shouldAcceptInbound(
      {
        messageId: 'm',
        chatId: 'c',
        chatType: 'group',
        senderOpenId: 'u',
        content: '/sa run tests',
        createTime: '1',
        mentionsBot: false
      },
      { ...DEFAULT_FEISHU_CONFIG, remoteGroupTrigger: 'prefix' }
    )
    expect(r.accept).toBe(true)
    expect(r.userMessage).toBe('run tests')
  })
})
