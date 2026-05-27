import { describe, expect, it } from 'vitest'
import { inboundSummaryForLog, redactLarkCliArgsForLog } from './feishuCliLogFields'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'

describe('feishuCliLogFields', () => {
  it('redacts --data in lark-cli args', () => {
    const r = redactLarkCliArgsForLog(['api', 'POST', '/x', '--data', '{"token":"secret"}', '--secret', 'x'])
    expect(r.argsRedacted).toContain('--data <len=')
    expect(r.dataHash).toMatch(/^[0-9a-f]{8}$/)
    expect(r.argsRedacted).not.toContain('secret')
  })

  it('omits message body from inbound summary', () => {
    const msg: FeishuInboundMessage = {
      messageId: 'm1',
      chatId: 'c1',
      chatType: 'p2p',
      senderOpenId: 'ou_xxx',
      content: 'hello world',
      createTime: '1',
      mentionsBot: false
    }
    const s = inboundSummaryForLog(msg)
    expect(s.content).toBeUndefined()
    expect(s.contentLen).toBe(11)
    expect(s.contentHash).toMatch(/^[0-9a-f]{8}$/)
  })
})
