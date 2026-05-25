import { describe, expect, it } from 'vitest'
import { FeishuConfirmManager } from './feishuConfirmManager'

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
})
