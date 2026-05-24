import { describe, expect, it } from 'vitest'
import {
  autoRenameRawPath,
  canCollectToWiki,
  classifyWikiCollectPath,
  computeRawDestBasename
} from './wikiImportPaths'

describe('wikiImportPaths', () => {
  it('classifies collect paths', () => {
    expect(classifyWikiCollectPath('docs/a.md', 'llm-wiki')).toBe('external')
    expect(classifyWikiCollectPath('llm-wiki/raw/a.md', 'llm-wiki')).toBe('raw')
    expect(classifyWikiCollectPath('llm-wiki/wiki/x.md', 'llm-wiki')).toBe('wiki-page')
    expect(classifyWikiCollectPath('llm-wiki/SCHEMA.md', 'llm-wiki')).toBe('schema')
  })

  it('allows external and raw files only', () => {
    expect(canCollectToWiki('docs/a.md', 'llm-wiki', false)).toBe(true)
    expect(canCollectToWiki('llm-wiki/raw/a.md', 'llm-wiki', false)).toBe(true)
    expect(canCollectToWiki('llm-wiki/wiki/x.md', 'llm-wiki', false)).toBe(false)
    expect(canCollectToWiki('docs/a.md', 'llm-wiki', true)).toBe(false)
  })

  it('computes flat raw destination', () => {
    expect(computeRawDestBasename('src/deep/note.md', 'llm-wiki')).toBe('llm-wiki/raw/note.md')
  })

  it('auto renames on conflict', () => {
    const base = 'llm-wiki/raw/note.md'
    const ts = new Date('2026-05-24T10:11:12')
    expect(autoRenameRawPath(base, 0, ts)).toBe('llm-wiki/raw/note-20260524-101112.md')
    expect(autoRenameRawPath(base, 1, ts)).toBe('llm-wiki/raw/note-2.md')
  })
})
