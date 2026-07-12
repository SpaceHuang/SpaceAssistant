import { describe, expect, it } from 'vitest'
import { inboundSummaryForLog, preprocessWeChatCliFields } from './weChatCliLogFields'

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
