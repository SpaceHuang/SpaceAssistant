import { describe, expect, it } from 'vitest'
import { detectLocale } from './detectLocale'

describe('detectLocale', () => {
  it('returns stored locale when valid', () => {
    expect(detectLocale('en-US', 'zh-CN')).toBe('en-US')
    expect(detectLocale('zh-CN', 'en-US')).toBe('zh-CN')
  })

  it('maps zh system languages to zh-CN', () => {
    expect(detectLocale(null, 'zh-CN')).toBe('zh-CN')
    expect(detectLocale(null, 'zh-TW')).toBe('zh-CN')
    expect(detectLocale(undefined, 'zh-HK')).toBe('zh-CN')
  })

  it('maps non-zh system languages to en-US', () => {
    expect(detectLocale(null, 'en-US')).toBe('en-US')
    expect(detectLocale(null, 'ja-JP')).toBe('en-US')
  })

  it('falls back to zh-CN when no hints', () => {
    expect(detectLocale(null, undefined)).toBe('zh-CN')
  })
})
