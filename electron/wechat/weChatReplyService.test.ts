import { describe, expect, it } from 'vitest'
import { formatWeChatSummary, requireWeChatSentMessageId, sendWeChatTextToUser, sendWeChatTextToUserWithReceipt, stripMarkdownForWeChat } from './weChatReplyService'

describe('weChatReplyService', () => {
  it('strips markdown links', () => {
    expect(stripMarkdownForWeChat('see [doc](https://x.com)')).toContain('doc (https://x.com)')
  })

  it('does not send users to the desktop by default and truncates at paragraph boundary', () => {
    const long = `${'段落内容。\n\n'.repeat(400)}END`
    const out = formatWeChatSummary(long)
    expect(out).not.toContain('完整过程请查看 SpaceAssistant 桌面会话')
    expect(out.length).toBeLessThanOrEqual(2000 + 50)
  })

  it('sends a formatted automation result to the configured user', async () => {
    const send = async (userId: string, content: string) => { expect(userId).toBe('user-1'); expect(content).not.toContain('完整过程请查看 SpaceAssistant 桌面会话') }
    await sendWeChatTextToUser({ send } as never, ' user-1 ', 'result')
  })

  it('extracts the trusted message ID from a bound confirmation-channel send result', () => {
    expect(requireWeChatSentMessageId({ kind: 'sent', sendCall: 'fulfilled', delivery: 'bound',
      binding: { kind: 'message-id', value: 'trusted-notification-id' } }))
      .toEqual({ messageId: 'trusted-notification-id' })
  })

  it('does not accept an unbound confirmation-channel send as a delivered message', () => {
    expect(() => requireWeChatSentMessageId({ kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound',
      errorCategory: 'message-binding-unavailable' })).toThrow('WECHAT_DELIVERY_MESSAGE_ID_MISSING')
  })

  it('sends approval notifications through the receipt-aware channel adapter', async () => {
    const sendToUser = async (userId: string, content: string) => {
      expect(userId).toBe('user-1')
      expect(content).toContain('异步审批待办 01')
      return { kind: 'sent', sendCall: 'fulfilled', delivery: 'bound', binding: { kind: 'message-id', value: 'notice-01' } }
    }
    await expect(sendWeChatTextToUserWithReceipt({ sendToUser }, ' user-1 ', '异步审批待办 01'))
      .resolves.toEqual({ messageId: 'notice-01' })
  })

})
