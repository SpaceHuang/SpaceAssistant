import { describe, expect, it } from 'vitest'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { parseSdkInboundMessage, shouldAcceptWeChatInbound } from './weChatInboundParser'
import type { IncomingMessage } from '@wechatbot/wechatbot'

function makeMsg(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    userId: 'u@test',
    text: 'hello',
    type: 'text',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    images: [],
    voices: [],
    files: [],
    videos: [],
    raw: {
      from_user_id: 'u@test',
      to_user_id: 'bot',
      client_id: 'cid-1',
      create_time_ms: 1,
      message_type: 1,
      message_state: 2,
      context_token: 'tok',
      item_list: []
    },
    _contextToken: 'tok',
    ...partial
  } as IncomingMessage
}

describe('weChatInboundParser', () => {
  it('accepts text messages', () => {
    const msg = parseSdkInboundMessage(makeMsg({ text: 'list files' }))
    const r = shouldAcceptWeChatInbound(msg, DEFAULT_WECHAT_CONFIG)
    expect(r.accept).toBe(true)
    expect(r.userMessage).toBe('list files')
  })

  it('rejects empty text', () => {
    const msg = parseSdkInboundMessage(makeMsg({ text: '   ' }))
    expect(shouldAcceptWeChatInbound(msg, DEFAULT_WECHAT_CONFIG).accept).toBe(false)
  })

  it('rejects non-text type', () => {
    const msg = parseSdkInboundMessage(makeMsg({ type: 'image', text: '[image]' }))
    expect(shouldAcceptWeChatInbound(msg, DEFAULT_WECHAT_CONFIG).reason).toBe('unsupported_type')
  })

  it('truncates long commands', () => {
    const long = 'a'.repeat(5000)
    const msg = parseSdkInboundMessage(makeMsg({ text: long }))
    const r = shouldAcceptWeChatInbound(msg, DEFAULT_WECHAT_CONFIG)
    expect(r.accept).toBe(true)
    expect(r.reason).toBe('truncated')
    expect(r.userMessage?.length).toBe(4000)
  })
})
