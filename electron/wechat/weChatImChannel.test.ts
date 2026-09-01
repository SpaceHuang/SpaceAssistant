import { describe, expect, it, vi, beforeEach } from 'vitest'
import { WeChatImChannel, buildWeChatConfirmPrompt } from './weChatImChannel'
import { makeIncomingMessage } from './__mocks__/wechatBotMock'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'

function req(toolName = 'write_file'): ConfirmRequest {
  return {
    facts: {
      toolName,
      actionClass: 'write',
      baseRiskLevel: 'medium',
      signals: [],
      summary: { text: toolName }
    },
    riskLevel: 'medium',
    memoryTiers: [],
    timeoutMs: null
  }
}

describe('WeChatImChannel（原 WeChatConfirmManager 回归）', () => {
  const reply = vi.fn(async () => undefined)
  const getReplyBot = () => ({ reply, sendTyping: vi.fn(), stopTyping: vi.fn() })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends IM prompt with Y/N footer on request', async () => {
    const im = new WeChatImChannel({ getReplyBot })
    const inbound = makeIncomingMessage({ raw: { ...makeIncomingMessage().raw, client_id: 'orig' } })
    const promise = im.request(req(), {
      sessionId: 'sess-1',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    const cid = im.listPending()[0]!.confirmId!
    const ynMsg = {
      messageId: 'yn-1',
      userId: 'wx-user@test',
      text: `Y ${cid}`,
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(im.tryResolveFromInboundMessage(ynMsg, {
      allowedUserIds: ['wx-user@test']
    })).toBe(true)
    await expect(promise).resolves.toEqual({ kind: 'approved' })
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('回复 Y')
    )
  })

  it('heartbeat-style prompt excludes duplicate Y/N when using default builder', () => {
    const prompt = buildWeChatConfirmPrompt({
      id: '1',
      sessionId: 's1',
      toolName: 'write_file',
      messageId: 'm1',
      channel: 'wechat',
      memoryTiers: [],
      createdAt: 1,
      expiresAt: 2,
      confirmId: 'AB12'
    })
    expect(prompt).toContain('【进度】')
    expect(prompt).toContain('AB12')
  })

  it('resolves from desktop approval', () => {
    const im = new WeChatImChannel()
    const inbound = makeIncomingMessage()
    const promise = im.request(req(), {
      sessionId: 'sess-1',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    const pending = im.listPending()
    expect(pending).toHaveLength(1)
    expect(im.resolveFromDesktop(pending[0]!.id, true)).toBe(true)
    return expect(promise).resolves.toEqual({ kind: 'approved' })
  })

  it('does not resolve confirm from non-allowlisted sender', async () => {
    const im = new WeChatImChannel()
    const inbound = makeIncomingMessage()
    const promise = im.request(req(), {
      sessionId: 'sess-deny',
      toolName: 'write_file',
      messageId: 'orig',
      matchKey: 'wx-user@test',
      context: inbound
    })
    const ynMsg = {
      messageId: 'yn-attacker',
      userId: 'attacker@test',
      text: 'Y',
      type: 'text' as const,
      timestamp: new Date().toISOString(),
      contextToken: 'ctx'
    }
    expect(
      im.tryResolveFromInboundMessage(ynMsg, {
        allowedUserIds: ['wx-user@test']
      })
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(promise).resolves.toEqual({ kind: 'rejected' })
  })
})
