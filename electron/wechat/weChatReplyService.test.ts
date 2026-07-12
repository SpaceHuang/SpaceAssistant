import { describe, expect, it } from 'vitest'
import { formatWeChatSummary, stripMarkdownForWeChat } from './weChatReplyService'

describe('weChatReplyService', () => {
  it('strips markdown links', () => {
    expect(stripMarkdownForWeChat('see [doc](https://x.com)')).toContain('doc (https://x.com)')
  })

  it('appends footer and truncates at paragraph boundary', () => {
    const long = `${'段落内容。\n\n'.repeat(400)}END`
    const out = formatWeChatSummary(long)
    expect(out).toContain('完整过程请查看 SpaceAssistant 桌面会话')
    expect(out.length).toBeLessThanOrEqual(2000 + 50)
  })
})
