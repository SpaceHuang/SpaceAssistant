import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeishuImChannel, buildFeishuConfirmPromptText } from './feishuImChannel'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'

vi.mock('./feishuReply', () => ({
  replyFeishuText: vi.fn().mockResolvedValue(undefined)
}))

const owner = 'ou_owner'
const confirmOpts = { ownerOpenId: owner }

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

function p2p(overrides: {
  messageId?: string
  chatId?: string
  senderOpenId?: string
  content?: string
  chatType?: 'p2p' | 'group'
} = {}) {
  return {
    messageId: overrides.messageId ?? 'm2',
    chatId: overrides.chatId ?? 'c1',
    chatType: overrides.chatType ?? ('p2p' as const),
    senderOpenId: overrides.senderOpenId ?? owner,
    content: overrides.content ?? 'Y',
    createTime: '1',
    mentionsBot: false
  }
}

describe('FeishuImChannel（原 FeishuConfirmManager 回归）', () => {
  it('resolves Y from inbound', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req('run_lark_cli'), {
      sessionId: 's1',
      toolName: 'run_lark_cli',
      toolInput: { args: ['message', 'send'] },
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    const cid = im.listPending()[0]!.confirmId!
    const ok = im.tryResolveFromInboundMessage(p2p({ content: `Y ${cid}` }), confirmOpts)
    expect(ok).toBe(true)
    await expect(p).resolves.toEqual({ kind: 'approved' })
  })

  it('rejects N from inbound', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's2',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    const cid = im.listPending()[0]!.confirmId!
    im.tryResolveFromInboundMessage(p2p({ content: `N ${cid}` }), confirmOpts)
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })

  it('bare Y does not approve', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-bare',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(im.tryResolveFromInboundMessage(p2p({ content: 'Y' }), confirmOpts)).toBe(true)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })

  it('does not resolve confirm from group chat', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-group',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: 'Y', chatType: 'group' }), confirmOpts)
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })

  it('does not resolve confirm from non-owner', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-nonowner',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: 'Y', senderOpenId: 'ou_other' }), confirmOpts)
    ).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })

  it('does not resolve confirm when owner unbound', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-unbound',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(im.tryResolveFromInboundMessage(p2p({ content: 'Y' }), {})).toBe(false)
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })

  it('cancelAllPending rejects every waiter', async () => {
    const im = new FeishuImChannel()
    const p1 = im.request(req(), {
      sessionId: 's-a',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    expect(im.countPending()).toBe(1)
    im.cancelAllPending()
    await expect(p1).resolves.toEqual({ kind: 'rejected' })
    expect(im.countPending()).toBe(0)
  })

  it('超时未回答 → timeout', async () => {
    vi.useFakeTimers()
    try {
      const im = new FeishuImChannel()
      const p = im.request(req(), {
        sessionId: 's-timeout',
        toolName: 'write_file',
        messageId: 'm1',
        matchKey: 'c1',
        context: 'c1'
      })
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000)
      await expect(p).resolves.toEqual({ kind: 'timeout' })
      expect(im.countPending()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolveFromDesktop 桌面代答', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req(), {
      sessionId: 's-desktop',
      toolName: 'write_file',
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1'
    })
    const id = im.listPending()[0]!.id
    expect(im.resolveFromDesktop(id, true)).toBe(true)
    await expect(p).resolves.toEqual({ kind: 'approved' })
  })

  it('builds browser navigate confirm text', () => {
    const text = buildFeishuConfirmPromptText({
      id: '1',
      sessionId: 's',
      toolName: 'browser',
      toolInput: { action: 'navigate', url: 'https://example.com/article' },
      messageId: 'm1',
      channel: 'feishu',
      memoryTiers: [],
      createdAt: 0,
      expiresAt: 0
    })
    expect(text).toContain('https://example.com/article')
    expect(text).toContain('回复 Y')
  })

  it('includes progress prefix in confirm text', async () => {
    const { updateRemoteProgressSnapshot, clearRemoteProgressSession } = await import('../remote/remoteProgressStore')
    updateRemoteProgressSnapshot('s-progress', {
      kind: 'tool',
      label: '微信直连失败，改用镜像站点',
      publishable: true
    })
    const text = buildFeishuConfirmPromptText({
      id: '2',
      sessionId: 's-progress',
      toolName: 'browser',
      toolInput: { action: 'navigate', url: 'https://r.jina.ai/example' },
      messageId: 'm1',
      channel: 'feishu',
      memoryTiers: [],
      createdAt: 0,
      expiresAt: 0
    })
    expect(text).toContain('【进度】')
    expect(text).toContain('微信直连失败')
    clearRemoteProgressSession('s-progress')
  })

  it('rejects bare 信任 without approving', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req('run_shell'), {
      sessionId: 's-trust',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1',
      trustEligible: true
    })
    const cid = im.listPending()[0]!.confirmId!
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: '信任' }), confirmOpts)
    ).toBe(true)
    expect(im.countPending()).toBe(1)
    im.tryResolveFromInboundMessage(p2p({ messageId: 'm3', content: `Y ${cid}` }), confirmOpts)
    await expect(p).resolves.toEqual({ kind: 'approved' })
  })

  it('approve_and_trust without eligibility does not resolve', async () => {
    const im = new FeishuImChannel()
    const p = im.request(req('run_shell'), {
      sessionId: 's-notrust',
      toolName: 'run_shell',
      toolInput: { command: 'rm -rf /' },
      messageId: 'm1',
      matchKey: 'c1',
      context: 'c1',
      trustEligible: false
    })
    const cid = im.listPending()[0]!.confirmId!
    expect(
      im.tryResolveFromInboundMessage(p2p({ content: `Y ${cid} TRUST` }), confirmOpts)
    ).toBe(true)
    expect(im.countPending()).toBe(1)
    im.tryResolveFromInboundMessage(p2p({ messageId: 'm3', content: `N ${cid}` }), confirmOpts)
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })
})
