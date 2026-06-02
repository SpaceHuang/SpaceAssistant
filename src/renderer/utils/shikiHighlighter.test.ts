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
  beforeEach(() => {
    codeToHtml.mockClear()
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
})
