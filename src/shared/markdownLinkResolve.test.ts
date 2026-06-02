import { describe, expect, it } from 'vitest'
import {
  resolveMarkdownHrefTarget,
  resolveMarkdownInternalLink,
  resolveWikiAbsolutePathLink,
  slugifyMarkdownHeading
} from './markdownLinkResolve'

describe('resolveWikiAbsolutePathLink', () => {
  it('resolves wiki root and shorthand paths', () => {
    expect(resolveWikiAbsolutePathLink('llm-wiki/wiki/index.md')).toBe('llm-wiki/wiki/index.md')
    expect(resolveWikiAbsolutePathLink('wiki/entities/foo.md')).toBe('llm-wiki/wiki/entities/foo.md')
  })

  it('rejects external and non-markdown', () => {
    expect(resolveWikiAbsolutePathLink('https://example.com')).toBeNull()
    expect(resolveWikiAbsolutePathLink('llm-wiki/raw/note.txt')).toBeNull()
  })
})

describe('resolveMarkdownInternalLink', () => {
  it('resolves relative links from base file', () => {
    expect(resolveMarkdownInternalLink('./b.md', 'docs/a.md')).toBe('docs/b.md')
    expect(
      resolveMarkdownInternalLink('./feishu-integration-requirement.md', 'docs/requirement/x.md')
    ).toBe('docs/requirement/feishu-integration-requirement.md')
  })

  it('resolves wiki-relative paths', () => {
    expect(resolveMarkdownInternalLink('../raw/x.md', 'llm-wiki/wiki/page.md')).toBe('llm-wiki/raw/x.md')
    expect(resolveMarkdownInternalLink('entities/foo.md', 'llm-wiki/wiki/page.md')).toBe(
      'llm-wiki/wiki/entities/foo.md'
    )
  })

  it('resolves wiki absolute without base', () => {
    expect(resolveMarkdownInternalLink('llm-wiki/wiki/index.md')).toBe('llm-wiki/wiki/index.md')
    expect(resolveMarkdownInternalLink('wiki/entities/foo.md', null, { wikiRootPath: 'llm-wiki' })).toBe(
      'llm-wiki/wiki/entities/foo.md'
    )
  })

  it('parses local dev server markdown URLs', () => {
    expect(resolveMarkdownInternalLink('http://127.0.0.1:9240/docs/foo.md')).toBe('docs/foo.md')
    expect(resolveMarkdownInternalLink('http://localhost:9240/llm-wiki/wiki/a.md')).toBe('llm-wiki/wiki/a.md')
  })

  it('returns null for external and anchors', () => {
    expect(resolveMarkdownInternalLink('https://example.com')).toBeNull()
    expect(resolveMarkdownInternalLink('#section')).toBeNull()
    expect(resolveMarkdownInternalLink('./other.ts', 'docs/a.md')).toBeNull()
  })

  it('returns null for relative links without base', () => {
    expect(resolveMarkdownInternalLink('./b.md')).toBeNull()
  })
})

describe('slugifyMarkdownHeading', () => {
  it('slugifies heading text', () => {
    expect(slugifyMarkdownHeading('Section Name')).toBe('section-name')
    expect(slugifyMarkdownHeading('  Hello: World!  ')).toBe('hello-world')
  })
})

describe('resolveMarkdownHrefTarget', () => {
  it('resolves same-page fragment links', () => {
    expect(resolveMarkdownHrefTarget('#intro', 'docs/a.md')).toEqual({ kind: 'fragment', fragment: 'intro' })
    expect(resolveMarkdownHrefTarget('docs/a.md#section', 'docs/a.md')).toEqual({
      kind: 'fragment',
      fragment: 'section'
    })
  })

  it('resolves cross-file links with fragment', () => {
    expect(resolveMarkdownHrefTarget('./b.md#intro', 'docs/a.md')).toEqual({
      kind: 'file',
      relPath: 'docs/b.md',
      fragment: 'intro'
    })
  })

  it('resolves file-only links', () => {
    expect(resolveMarkdownHrefTarget('./b.md', 'docs/a.md')).toEqual({ kind: 'file', relPath: 'docs/b.md' })
  })
})
