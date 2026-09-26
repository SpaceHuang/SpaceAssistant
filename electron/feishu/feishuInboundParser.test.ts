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

  it('retains previously supported compact field aliases', () => {
    const msg = parseCompactInboundEvent({
      messageId: 'm-legacy', chatId: 'c-legacy', chatType: 'p2p', sender_open_id: 'ou_legacy',
      msg_type: 'image', content: 'please read'
    })
    expect(msg).toMatchObject({
      messageId: 'm-legacy', chatId: 'c-legacy', senderOpenId: 'ou_legacy', msgType: 'image'
    })
  })

  it('keeps only structured inbound attachments with a local path', () => {
    const msg = parseCompactInboundEvent({
      message_id: 'm2', chat_id: 'c1', sender_open_id: 'u1', content: 'please read', msg_type: 'image',
      attachments: [
        { type: 'image', local_path: '/user/feishu-media/cache/m2/pic.png', file_name: 'pic.png', mime_type: 'image/png' },
        { type: 'image', image_key: 'remote-only-key' },
        { type: 'file', local_path: '../outside.txt' }
      ]
    })
    expect(msg?.attachments).toEqual([
      { kind: 'image', localPath: '/user/feishu-media/cache/m2/pic.png', fileName: 'pic.png', mimeType: 'image/png' },
      { kind: 'file', localPath: '../outside.txt' }
    ])
  })

  it('extracts command text from a post containing an attachment block', () => {
    const msg = parseCompactInboundEvent({
      message_id: 'm-post', chat_id: 'c1', chat_type: 'p2p', sender_open_id: 'ou_owner', msg_type: 'post',
      content: JSON.stringify({
        title: '',
        content: [[
          { tag: 'text', text: '/sa 请读取附件内容' },
          { tag: 'file', file_key: 'file_123', file_name: 'notes.txt' }
        ]]
      })
    })
    expect(msg?.content).toBe('/sa 请读取附件内容')
    expect(msg?.msgType).toBe('post')
    expect(msg && shouldAcceptInbound(msg, { ...DEFAULT_FEISHU_CONFIG, remoteSenderAllowlist: ['ou_owner'] }).accept).toBe(true)
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
