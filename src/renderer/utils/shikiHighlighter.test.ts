import { describe, expect, it, vi, beforeEach } from 'vitest'

const codeToHtml = vi.fn((_code: string, opts: { lang: string; theme: string }) =>
  `<pre class="shiki ${opts.theme}"><code>${opts.lang}</code></pre>`
)

vi.mock('shiki', () => ({
  createHighlighter: vi.fn().mockResolvedValue({
    getLoadedLanguages: () => ['typescript', 'plaintext'],
    codeToHtml
  })
}))

describe('shikiHighlighter', () => {
  beforeEach(async () => {
    codeToHtml.mockClear()
    const { clearHighlightCacheForTest } = await import('./shikiHighlighter')
    clearHighlightCacheForTest()
  })

  it('strips inline pre styles from shiki output', async () => {
    const { stripShikiPreInlineStyle } = await import('./shikiHighlighter')
    expect(
      stripShikiPreInlineStyle(
        '<pre class="shiki light-plus" style="background-color:#FFFFFF;color:#000000"><code>x</code></pre>'
      )
    ).toBe('<pre class="shiki light-plus"><code>x</code></pre>')
  })

  it('highlights code via shiki', async () => {
    const { highlightCode } = await import('./shikiHighlighter')
    const html = await highlightCode('const x = 1', 'typescript')
    expect(html).toContain('typescript')
    expect(codeToHtml).toHaveBeenCalled()
  })

  it('uses dark-plus on dark surface by default', async () => {
    const { highlightCode } = await import('./shikiHighlighter')
    await highlightCode('x', 'plaintext', 'dark')
    expect(codeToHtml).toHaveBeenCalledWith('x', expect.objectContaining({ theme: 'dark-plus' }))
  })

  it('uses light-plus on light surface', async () => {
    const { highlightCode } = await import('./shikiHighlighter')
    await highlightCode('x', 'plaintext', 'light')
    expect(codeToHtml).toHaveBeenCalledWith('x', expect.objectContaining({ theme: 'light-plus' }))
  })

  it('keeps entry count within MAX_HIGHLIGHT_CACHE_ENTRIES after many unique blocks', async () => {
    const {
      highlightCode,
      getHighlightCacheStats,
      MAX_HIGHLIGHT_CACHE_ENTRIES
    } = await import('./shikiHighlighter')

    for (let i = 0; i < 1000; i++) {
      await highlightCode(`const n = ${i}`, 'typescript')
    }
    const stats = getHighlightCacheStats()
    expect(stats.entries).toBeLessThanOrEqual(MAX_HIGHLIGHT_CACHE_ENTRIES)
    expect(stats.entries).toBeGreaterThan(0)
  })

  it('does not cache oversized code blocks but still returns highlight', async () => {
    const {
      highlightCode,
      getHighlightCacheStats,
      MAX_CACHEABLE_CODE_BYTES
    } = await import('./shikiHighlighter')

    const huge = 'x'.repeat(MAX_CACHEABLE_CODE_BYTES / 2 + 1)
    const html = await highlightCode(huge, 'plaintext')
    expect(html).toContain('plaintext')
    expect(getHighlightCacheStats().entries).toBe(0)
  })

  it('reuses cached highlight without calling shiki again', async () => {
    const { highlightCode } = await import('./shikiHighlighter')
    await highlightCode('same', 'plaintext')
    const calls = codeToHtml.mock.calls.length
    await highlightCode('same', 'plaintext')
    expect(codeToHtml.mock.calls.length).toBe(calls)
  })
})
