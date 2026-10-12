import { describe, expect, it } from 'vitest'
import { inboundSummaryForLog, preprocessWeChatCliFields, quoteWireSummaryForLog } from './weChatCliLogFields'

describe('weChatCliLogFields', () => {
  it('summarizes inbound without message body', () => {
    const summary = inboundSummaryForLog({
      messageId: 'm1',
      userId: 'u@wx',
      text: 'hello world',
      type: 'text',
      timestamp: '2026-07-12T00:00:00.000Z',
      contextToken: 'ctx'
    })
    expect(summary.textLen).toBe(11)
    expect(summary.textHash).toMatch(/^[0-9a-f]{8}$/)
    expect(summary).not.toHaveProperty('text')
  })

  it('reports SDK-parsed quoted content without logging it', () => {
    const summary = inboundSummaryForLog({
      messageId: 'quoted-message', userId: 'u@wx', text: 'Y 07', type: 'text',
      timestamp: '2026-07-12T00:00:00.000Z', contextToken: 'ctx',
      quotedMessageText: 'confirmation prompt', quotedMessageId: 'prompt-id'
    })
    expect(summary).toMatchObject({ hasQuoted: true, quotedMessageIdPresent: true, quotedMessageTextLen: 19 })
    expect(summary).not.toHaveProperty('quotedMessageText')
  })

  it('summarizes raw iLink quote presence without logging quoted content', () => {
    const summary = quoteWireSummaryForLog({
      item_list: [{ ref_msg: { message_item: { text_item: { text: 'quoted private body' } } } }]
    }, { text: 'quoted private body' })
    expect(summary).toEqual({
      rawRefMessagePresent: true,
      rawRefMessageItemPresent: true,
      rawRefMessageItemType: undefined,
      rawRefMessageItemKeys: ['text_item'],
      rawRefMessagePayloadKinds: ['text_item'],
      rawQuoteMessageIdType: 'undefined',
      rawQuoteMessageIdLen: 0,
      rawQuoteMessageIdHash: undefined,
      rawTextItemPresent: true,
      rawTextValueType: 'string',
      rawRefTitlePresent: false,
      rawQuotedTextLen: 19,
      sdkQuotedTextPresent: true,
      sdkQuotedTextLen: 19,
      quoteTextProjectionMatches: true
    })
    expect(JSON.stringify(summary)).not.toContain('quoted private body')
  })

  it('detects when raw wire has a quote but SDK projection dropped it', () => {
    expect(quoteWireSummaryForLog({
      item_list: [{ ref_msg: { message_item: { text_item: { text: 'quoted text' } } } }]
    }, undefined)).toMatchObject({
      rawRefMessagePresent: true,
      rawRefMessageItemPresent: true,
      rawTextItemPresent: true,
      sdkQuotedTextPresent: false,
      quoteTextProjectionMatches: false
    })
  })

  it('does not report an empty raw ref_msg as a successful SDK projection', () => {
    expect(quoteWireSummaryForLog({ item_list: [{ ref_msg: {} }] }, undefined)).toMatchObject({
      rawRefMessagePresent: true,
      rawRefMessageItemPresent: false,
      rawTextItemPresent: false,
      quoteTextProjectionMatches: false
    })
  })

  it('reports only structural keys for unexpected ref message_item variants', () => {
    expect(quoteWireSummaryForLog({ item_list: [{ ref_msg: {
      message_item: { type: 0, msg_id: 'private-message-id', encoded_text: 'private quote content' } as never
    } }] }, undefined)).toMatchObject({
      rawRefMessageItemPresent: true,
      rawRefMessageItemType: 0,
      rawRefMessageItemKeys: ['encoded_text', 'msg_id', 'type'],
      rawQuoteMessageIdType: 'string',
      rawQuoteMessageIdLen: 18,
      rawQuoteMessageIdHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      rawRefMessagePayloadKinds: [],
      rawQuotedTextLen: 0,
      quoteTextProjectionMatches: false
    })
  })

  it('strips qr url and secrets from log fields', () => {
    const out = preprocessWeChatCliFields({
      qrUrl: 'https://liteapp.weixin.qq.com/q/abc?qrcode=123',
      token: 'secret-token',
      summary: 'done'
    })
    expect(out.qrUrl).toBeUndefined()
    expect(out.qrUrlHost).toContain('liteapp.weixin.qq.com')
    expect(out.token).toBeUndefined()
    expect(out.summaryLen).toBe(4)
    expect(out.summaryHash).toMatch(/^[0-9a-f]{8}$/)
  })
})
