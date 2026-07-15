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

  it('sends instant IM prompt with Y/N when imPrompt provided', async () => {
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
      DEFAULT_WECHAT_CONFIG,
      undefined,
      { imPrompt: '【进度】等待确认：写入 a.txt\n回复 Y 确认，N 取消（5 分钟内有效）' }
    )
    const ynMsg = {
      messageId: 'yn-1',
      userId: 'wx-user@test',
      text: 'Y',
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(mgr.tryResolveFromInbound(ynMsg, makeIncomingMessage(), {
      allowedUserIds: ['wx-user@test']
    })).toBe(true)
    await expect(promise).resolves.toBe('y')
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('回复 Y 确认')
    )
  })

  it('heartbeat-style prompt excludes duplicate Y/N when using default builder', () => {
    const mgr = new WeChatConfirmManager(undefined, undefined, getReplyBot)
    const prompt = mgr.buildWeChatYnPrompt({
      id: '1',
      kind: 'tool_write',
      sessionId: 's1',
      toolName: 'write_file',
      messageId: 'm1',
      userId: 'u1',
      inboundMsg: makeIncomingMessage(),
      createdAt: 1,
      expiresAt: 2
    })
    expect(prompt).toContain('【进度】')
    expect(prompt).toContain('Y 确认')
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

  it('does not resolve confirm from non-allowlisted sender', async () => {
    const mgr = new WeChatConfirmManager()
    const inbound = makeIncomingMessage()
    const promise = mgr.requestConfirm(
      {
        kind: 'tool_write',
        sessionId: 'sess-deny',
        toolName: 'write_file',
        messageId: 'orig',
        userId: 'wx-user@test',
        inboundMsg: inbound
      },
      DEFAULT_WECHAT_CONFIG
    )
    const ynMsg = {
      messageId: 'yn-attacker',
      userId: 'attacker@test',
      text: 'Y',
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(
      mgr.tryResolveFromInbound(ynMsg, makeIncomingMessage(), {
        allowedUserIds: ['wx-user@test']
      })
    ).toBe(false)
    expect(mgr.countPending()).toBe(1)
    mgr.cancelAllPending()
    await expect(promise).resolves.toBe('n')
  })
})
