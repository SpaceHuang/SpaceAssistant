import { describe, expect, it } from 'vitest'
import { canonicalQueueInput } from './queueInputFingerprint'

describe('canonicalQueueInput', () => {
  it('固定版本、trim 规则和附件顺序，忽略未参与身份的字段', () => {
    expect(canonicalQueueInput({ text: '  hello  ', attachments: [{ id: 'a', stagingKey: 's/a', fileName: 'a.png', mimeType: 'image/png', byteLength: 10, width: 2, height: 3 }] })).toBe(
      '{"v":1,"text":"hello","attachments":[{"id":"a","stagingKey":"s/a","fileName":"a.png","mimeType":"image/png","byteLength":10,"width":2,"height":3}]}'
    )
    expect(canonicalQueueInput({ text: 'hello' })).toBe(canonicalQueueInput({ text: '  hello  ', attachments: [] }))
  })
})
