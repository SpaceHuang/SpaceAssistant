import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DEFAULT_WECHAT_CONFIG } from '../../src/shared/wechatTypes'
import { WeChatConfirmManager } from './weChatConfirmManager'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'

describe('WeChatConfirmManager', () => {
  const reply = vi.fn(async () => undefined)
  const getReplyBot = () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves Y/N from inbound when remoteWechatConfirm enabled', async () => {
    const mgr = new WeChatConfirmManager(undefined, undefined, getReplyBot)
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig' } })
    const promise = mgr.requestConfirm(
      {
        kind: 'tool_write',
        sessionId: 'sess-1',
        toolName: 'write_file',
        messageId: 'orig',
        userId: 'wx-user@test',
        inboundMsg: inbound
      },
      { ...DEFAULT_WECHAT_CONFIG, remoteWechatConfirm: true }
    )
    const ynMsg = {
      messageId: 'yn-1',
      userId: 'wx-user@test',
      text: 'Y',
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(mgr.tryResolveFromInbound(ynMsg, makeIncomingMessage())).toBe(true)
    await expect(promise).resolves.toBe('y')
    expect(reply).toHaveBeenCalled()
  })

  it('resolves from desktop approval', () => {
    const mgr = new WeChatConfirmManager()
    const inbound = makeIncomingMessage()
    const promise = mgr.requestConfirm(
      {
        kind: 'tool_write',
        sessionId: 'sess-1',
        toolName: 'write_file',
        messageId: 'orig',
        userId: 'wx-user@test',
        inboundMsg: inbound
      },
      DEFAULT_WECHAT_CONFIG
    )
    const pending = mgr.listPending()
    expect(pending).toHaveLength(1)
    expect(mgr.resolveFromDesktop(pending[0]!.id, true)).toBe(true)
    return expect(promise).resolves.toBe('y')
  })
})
