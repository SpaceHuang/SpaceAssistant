import { describe, expect, it } from 'vitest'
import { appendUiLocaleSystemHint, buildUiLocaleSystemHint } from './llmLocalePrompt'

describe('buildUiLocaleSystemHint', () => {
  it('L1: zh-CN hint contains Simplified Chinese and ui_locale_preference tag', () => {
    const hint = buildUiLocaleSystemHint('zh-CN')
    expect(hint).toContain('<ui_locale_preference>')
    expect(hint).toContain('Simplified Chinese')
    expect(hint).toContain('</ui_locale_preference>')
  })

  it('L2: en-US hint contains English (en-US)', () => {
    const hint = buildUiLocaleSystemHint('en-US')
    expect(hint).toContain('English (en-US)')
    expect(hint).toContain('<ui_locale_preference>')
  })

  it('L3: both locales include explicit language override exception', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const hint = buildUiLocaleSystemHint(locale)
      expect(hint).toMatch(/explicitly asks/)
      expect(hint).toMatch(/thinking still uses/)
    }
  })

  it('L6: both locales require thinking to match UI even when user message differs', () => {
    expect(buildUiLocaleSystemHint('zh-CN')).toMatch(/even when the user's message is in another language/)
    expect(buildUiLocaleSystemHint('en-US')).toMatch(/even when the user's message is in another language/)
  })
})

describe('appendUiLocaleSystemHint', () => {
  it('L4: base system comes before ui_locale_preference', () => {
    const result = appendUiLocaleSystemHint('base prompt', 'zh-CN')!
    expect(result.indexOf('base prompt')).toBeLessThan(result.indexOf('<ui_locale_preference>'))
    expect(result).toContain('Simplified Chinese')
  })

  it('L5: undefined system returns hint only', () => {
    const result = appendUiLocaleSystemHint(undefined, 'en-US')
    expect(result).toContain('English (en-US)')
    expect(result).not.toContain('base')
  })
})
