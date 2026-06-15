import { describe, expect, it } from 'vitest'
import { resolveChatLocale } from './resolveChatLocale'
import i18n from '../i18n/index'

describe('resolveChatLocale', () => {
  it('I12: returns i18n.language when valid AppLocale', () => {
    const original = i18n.language
    Object.defineProperty(i18n, 'language', { value: 'en-US', configurable: true })
    expect(resolveChatLocale()).toBe('en-US')
    Object.defineProperty(i18n, 'language', { value: original, configurable: true })
  })

  it('falls back to zh-CN for invalid i18n.language', () => {
    const original = i18n.language
    Object.defineProperty(i18n, 'language', { value: 'fr-FR', configurable: true })
    expect(resolveChatLocale()).toBe('zh-CN')
    Object.defineProperty(i18n, 'language', { value: original, configurable: true })
  })
})
