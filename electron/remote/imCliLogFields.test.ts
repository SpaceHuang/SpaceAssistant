import { describe, expect, it } from 'vitest'
import { contentHash, previewText, urlHostOnly } from './imCliLogFields'

describe('imCliLogFields', () => {
  it('contentHash is stable 8-char hex', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{8}$/)
    expect(contentHash('hello')).toBe(contentHash('hello'))
    expect(contentHash('world')).not.toBe(contentHash('hello'))
  })

  it('previewText truncates at maxLen', () => {
    expect(previewText('abc', 10)).toBe('abc')
    expect(previewText('abcdefghij', 5)).toBe('abcde')
  })

  it('urlHostOnly keeps origin and pathname', () => {
    expect(urlHostOnly('https://example.com/path?q=1')).toBe('https://example.com/path')
    expect(urlHostOnly('not-a-url')).toBeUndefined()
    expect(urlHostOnly(undefined)).toBeUndefined()
  })
})
