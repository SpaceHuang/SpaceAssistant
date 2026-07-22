import { describe, expect, it } from 'vitest'
import { projectMarkdownForSearch } from './markdownSearchProjection'

describe('projectMarkdownForSearch', () => {
  it('produces an anchored-text fragment for plain markdown text', () => {
    const result = projectMarkdownForSearch('Hello **world**', 0)

    expect(result.plainTextFragments.length).toBeGreaterThan(0)
    const plain = result.plainTextFragments[0]!
    expect(plain.searchableText).toContain('Hello')
    expect(plain.searchableText).toContain('world')
    expect(plain.anchors).toEqual([])
    expect(plain.fragmentIndex).toBe(0)
  })

  it('extracts fenced and inline code as code-source fragments', () => {
    const markdown = 'Use `inline` and:\n\n```ts\nconst x = 1\n```'
    const result = projectMarkdownForSearch(markdown, 1)

    const inline = result.codeFragments.find((f) => f.inline)
    const block = result.codeFragments.find((f) => !f.inline)

    expect(inline?.searchableText).toBe('inline')
    expect(inline?.codeIndex).toBe(0)
    expect(block?.searchableText).toBe('const x = 1')
    expect(block?.codeIndex).toBe(1)
  })

  it('extracts inline and display math as math-source fragments', () => {
    const markdown = 'Inline $a+b$ and display $$\\int_0^1 x dx$$'
    const result = projectMarkdownForSearch(markdown, 0)

    const inline = result.mathFragments.find((f) => !f.display)
    const display = result.mathFragments.find((f) => f.display)

    expect(inline?.searchableText).toBe('a+b')
    expect(display?.searchableText).toBe('\\int_0^1 x dx')
  })
})
