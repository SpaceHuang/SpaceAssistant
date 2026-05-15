import { describe, expect, it } from 'vitest'
import {
  findSearchMatches,
  getSearchRegexError,
  replaceAll,
  replaceOneAt
} from './searchUtils'

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

  it('replaces one match', () => {
    const matches = findSearchMatches(content, 'foo', { caseSensitive: false, wholeWord: false, useRegex: false })
    const next = replaceOneAt(content, matches[0], 'baz', 'foo', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    expect(next).toBe('baz bar foo')
  })

  it('replaces all matches', () => {
    const next = replaceAll(content, 'foo', 'baz', { caseSensitive: false, wholeWord: false, useRegex: false })
    expect(next).toBe('baz bar baz')
  })
})
