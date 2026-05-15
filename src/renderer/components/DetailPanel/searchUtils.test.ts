import { describe, expect, it } from 'vitest'
import { findSearchMatches, getSearchRegexError } from './searchUtils'

describe('searchUtils', () => {
  const content = 'foo bar foo'

  it('finds literal matches case insensitive', () => {
    const matches = findSearchMatches(content, 'FOO', { caseSensitive: false, wholeWord: false, useRegex: false })
    expect(matches).toHaveLength(2)
  })

  it('finds whole word matches', () => {
    const matches = findSearchMatches(content, 'foo', { caseSensitive: false, wholeWord: true, useRegex: false })
    expect(matches).toHaveLength(2)
  })

  it('reports invalid regex', () => {
    expect(getSearchRegexError('[', { caseSensitive: false, wholeWord: false, useRegex: true })).toBe('正则表达式无效')
  })
})
