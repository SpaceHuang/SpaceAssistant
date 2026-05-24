import { describe, expect, it } from 'vitest'
import { classifyWikiReferencedPath, expandWikilinks, parseWikiIndexMarkdown } from './wikiMarkdown'

describe('wikiMarkdown', () => {
  it('expands wikilinks', () => {
    const out = expandWikilinks('See [[foo]] and [[bar|Bar Label]]', 'llm-wiki')
    expect(out).toContain('[foo](llm-wiki/wiki/foo.md)')
    expect(out).toContain('[bar](llm-wiki/wiki/bar.md)')
  })

  it('classifies wiki referenced paths', () => {
    expect(classifyWikiReferencedPath('llm-wiki/raw/a.md', 'llm-wiki')).toBe('raw')
    expect(classifyWikiReferencedPath('llm-wiki/wiki/x.md', 'llm-wiki')).toBe('wiki')
    expect(classifyWikiReferencedPath('src/main.ts', 'llm-wiki')).toBeNull()
  })

  it('parses index markdown sections', () => {
    const md = `## Entities
- [foo](entities/foo.md) — summary
`
    const entries = parseWikiIndexMarkdown(md, 'llm-wiki')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('foo')
    expect(entries[0].relPath).toBe('llm-wiki/wiki/entities/foo.md')
  })
})
