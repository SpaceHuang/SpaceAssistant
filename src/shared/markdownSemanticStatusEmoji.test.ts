import { describe, expect, it } from 'vitest'
import {
  MD_STATUS_DOT_HREF_PREFIX,
  splitTextWithStatusDots,
  toneForStatusEmoji
} from './markdownSemanticStatusEmoji'

describe('markdownSemanticStatusEmoji', () => {
  it('maps common status emoji to tones', () => {
    expect(toneForStatusEmoji('🟢')).toBe('success')
    expect(toneForStatusEmoji('🟡')).toBe('warning')
    expect(toneForStatusEmoji('🔴')).toBe('error')
    expect(toneForStatusEmoji('⚠️')).toBe('warning')
  })

  it('splits text nodes into dot links', () => {
    const parts = splitTextWithStatusDots({ type: 'text', value: '🟢 可直接复用' })
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({
      type: 'link',
      url: `${MD_STATUS_DOT_HREF_PREFIX}success`
    })
    expect(parts[1]).toMatchObject({ type: 'text', value: ' 可直接复用' })
  })

  it('handles multiple emoji in one line', () => {
    const parts = splitTextWithStatusDots({ type: 'text', value: '🟢是 🟡否 🔴重做' })
    expect(parts.filter((part) => part.type === 'link')).toHaveLength(3)
  })

  it('leaves plain text unchanged', () => {
    const text = { type: 'text', value: 'no emoji here' } as const
    expect(splitTextWithStatusDots(text)).toEqual([text])
  })
})
