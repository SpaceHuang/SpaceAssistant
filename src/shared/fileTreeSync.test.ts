import { describe, expect, it } from 'vitest'
import { dirsToRefreshForPath, isPathUnderRoot, parentDirKey } from './fileTreeSync'

describe('fileTreeSync', () => {
  it('parentDirKey returns immediate parent', () => {
    expect(parentDirKey('src/app.ts')).toBe('src')
    expect(parentDirKey('README.md')).toBe('')
  })

  it('isPathUnderRoot respects wiki root', () => {
    expect(isPathUnderRoot('llm-wiki/a.md', 'llm-wiki')).toBe(true)
    expect(isPathUnderRoot('src/a.ts', 'llm-wiki')).toBe(false)
  })

  it('dirsToRefreshForPath refreshes expanded parent', () => {
    const expanded = new Set(['src'])
    expect(dirsToRefreshForPath('src/app.ts', '', expanded)).toEqual(['src'])
  })

  it('dirsToRefreshForPath walks up to expanded ancestor for new nested paths', () => {
    const expanded = new Set([''])
    expect(dirsToRefreshForPath('newdir/file.txt', '', expanded)).toEqual([''])
  })

  it('dirsToRefreshForPath skips collapsed branches', () => {
    const expanded = new Set(['src'])
    expect(dirsToRefreshForPath('src/deep/hidden.ts', '', expanded)).toEqual(['src'])
  })

  it('dirsToRefreshForPath returns empty when no ancestor expanded', () => {
    const expanded = new Set<string>()
    expect(dirsToRefreshForPath('src/app.ts', '', expanded)).toEqual([])
  })
})
