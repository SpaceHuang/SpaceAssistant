import { describe, expect, it, vi } from 'vitest'
import { FeishuConfirmManager } from './feishuConfirmManager'
import {
  clearFeishuRemoteProgress,
  publishFeishuRemoteProgress
} from './feishuRemoteProgress'

vi.mock('./feishuReply', () => ({
  replyFeishuText: vi.fn().mockResolvedValue(undefined)
}))

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
    const ok = mgr.tryResolveFromInbound({
      messageId: 'm2',
      chatId: 'c1',
      chatType: 'p2p',
      senderOpenId: 'u',
      content: 'Y',
      createTime: '1',
      mentionsBot: false
    })
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
    mgr.tryResolveFromInbound({
      messageId: 'm2',
      chatId: 'c1',
      chatType: 'p2p',
      senderOpenId: 'u',
      content: 'N',
      createTime: '1',
      mentionsBot: false
    })
    await expect(p).resolves.toBe('n')
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
    const runner = { run: vi.fn().mockResolvedValue({ exitCode: 0 }) } as unknown as import('./larkCliRunner').LarkCliRunner
    await publishFeishuRemoteProgress(runner, 'm1', 's-progress', '微信直连失败，改用镜像站点')
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
    expect(text).toContain('【进度说明】')
    expect(text).toContain('微信直连失败')
    clearFeishuRemoteProgress('s-progress')
  })

  it('cancelAllPending resolves every waiter without waiting for timeout', async () => {
    const mgr = new FeishuConfirmManager()
    const p = mgr.requestConfirm({
      kind: 'plan_execute',
      sessionId: 's3',
      messageId: 'm1',
      chatId: 'c1'
    })
    mgr.cancelAllPending()
    await expect(p).resolves.toBe('n')
    expect(mgr.countPending()).toBe(0)
  })
})
