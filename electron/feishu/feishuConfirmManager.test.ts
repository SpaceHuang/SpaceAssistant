import { describe, expect, it, vi } from 'vitest'
import { FeishuConfirmManager } from './feishuConfirmManager'

vi.mock('./feishuReply', () => ({
  replyFeishuText: vi.fn().mockResolvedValue(undefined)
}))

const owner = 'ou_owner'
const confirmOpts = { ownerOpenId: owner }

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

describe('FeishuConfirmManager', () => {
  it('resolves Y from inbound', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's1',
      toolName: 'run_lark_cli',
      toolInput: { args: ['message', 'send'] },
      messageId: 'm1',
      chatId: 'c1'
    })
    const cid = mgr.listPending()[0]!.confirmId!
    const ok = mgr.tryResolveFromInbound(p2p({ content: `Y ${cid}` }), confirmOpts)
    expect(ok).toBe(true)
    await expect(p).resolves.toBe('y')
  })

  it('rejects N from inbound', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's2',
      toolName: 'write_file',
      messageId: 'm1',
      chatId: 'c1'
    })
    const cid = mgr.listPending()[0]!.confirmId!
    mgr.tryResolveFromInbound(p2p({ content: `N ${cid}` }), confirmOpts)
    await expect(p).resolves.toBe('n')
  })

  it('bare Y does not approve', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-bare',
      toolName: 'write_file',
      messageId: 'm1',
      chatId: 'c1'
    })
    expect(mgr.tryResolveFromInbound(p2p({ content: 'Y' }), confirmOpts)).toBe(true)
    expect(mgr.countPending()).toBe(1)
    mgr.cancelAllPending()
    await expect(p).resolves.toBe('n')
  })

  it('does not resolve confirm from group chat', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-group',
      toolName: 'write_file',
      messageId: 'm1',
      chatId: 'c1'
    })
    expect(
      mgr.tryResolveFromInbound(p2p({ content: 'Y', chatType: 'group' }), confirmOpts)
    ).toBe(false)
    expect(mgr.countPending()).toBe(1)
    mgr.cancelAllPending()
    await expect(p).resolves.toBe('n')
  })

  it('does not resolve confirm from non-owner', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-nonowner',
      toolName: 'write_file',
      messageId: 'm1',
      chatId: 'c1'
    })
    expect(
      mgr.tryResolveFromInbound(p2p({ content: 'Y', senderOpenId: 'ou_other' }), confirmOpts)
    ).toBe(false)
    expect(mgr.countPending()).toBe(1)
    mgr.cancelAllPending()
    await expect(p).resolves.toBe('n')
  })

  it('does not resolve confirm when owner unbound', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-unbound',
      toolName: 'write_file',
      messageId: 'm1',
      chatId: 'c1'
    })
    expect(mgr.tryResolveFromInbound(p2p({ content: 'Y' }), {})).toBe(false)
    expect(mgr.countPending()).toBe(1)
    mgr.cancelAllPending()
    await expect(p).resolves.toBe('n')
  })

  it('cancelAllPending rejects every waiter', async () => {
    const mgr = new FeishuConfirmManager()
    const p1 = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-a',
      toolName: 'write_file',
      messageId: 'm1',
      chatId: 'c1'
    })
    expect(mgr.countPending()).toBe(1)
    mgr.cancelAllPending()
    await expect(p1).resolves.toBe('n')
    expect(mgr.countPending()).toBe(0)
  })

  it('builds browser navigate confirm text', () => {
    const mgr = new FeishuConfirmManager()
    const text = mgr.buildConfirmPromptText({
      id: '1',
      kind: 'tool_write',
      sessionId: 's',
      toolName: 'browser',
      toolInput: { action: 'navigate', url: 'https://example.com/article' },
      messageId: 'm1',
      chatId: 'c1',
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
    const mgr = new FeishuConfirmManager()
    const text = mgr.buildConfirmPromptText({
      id: '2',
      kind: 'tool_write',
      sessionId: 's-progress',
      toolName: 'browser',
      toolInput: { action: 'navigate', url: 'https://r.jina.ai/example' },
      messageId: 'm1',
      chatId: 'c1',
      createdAt: 0,
      expiresAt: 0
    })
    expect(text).toContain('【进度】')
    expect(text).toContain('微信直连失败')
    clearRemoteProgressSession('s-progress')
  })

  it('rejects bare 信任 without approving', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-trust',
      toolName: 'run_shell',
      toolInput: { command: 'npm test' },
      messageId: 'm1',
      chatId: 'c1',
      trustEligible: true
    })
    const cid = mgr.listPending()[0]!.confirmId!
    expect(
      mgr.tryResolveFromInbound(p2p({ content: '信任' }), confirmOpts)
    ).toBe(true)
    expect(mgr.countPending()).toBe(1)
    mgr.tryResolveFromInbound(p2p({ messageId: 'm3', content: `Y ${cid}` }), confirmOpts)
    await expect(p).resolves.toBe('y')
  })

  it('approve_and_trust without eligibility does not resolve', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'tool_write',
      sessionId: 's-notrust',
      toolName: 'run_shell',
      toolInput: { command: 'rm -rf /' },
      messageId: 'm1',
      chatId: 'c1',
      trustEligible: false
    })
    const cid = mgr.listPending()[0]!.confirmId!
    expect(
      mgr.tryResolveFromInbound(p2p({ content: `Y ${cid} TRUST` }), confirmOpts)
    ).toBe(true)
    expect(mgr.countPending()).toBe(1)
    mgr.tryResolveFromInbound(p2p({ messageId: 'm3', content: `N ${cid}` }), confirmOpts)
    await expect(p).resolves.toBe('n')
  })
})
