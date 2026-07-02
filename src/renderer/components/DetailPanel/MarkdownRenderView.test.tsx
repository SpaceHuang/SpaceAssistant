import { fireEvent, render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expandWikilinks } from '../../../shared/wikiMarkdown'
import { buildMarkdownCopyText } from '../../utils/markdownRenderCopy'
import { MarkdownRenderView } from './MarkdownRenderView'

const FIXTURE = [
  '## Section',
  '',
  '> quoted',
  '',
  '- alpha',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '| Col | Val |',
  '| --- | --- |',
  '| a   | 1   |'
].join('\n')

function expectBlockOffsets(root: HTMLElement, rendered: string) {
  const blocks = root.querySelectorAll('[data-md-start][data-md-end]')
  expect(blocks.length).toBeGreaterThan(0)
  for (const el of blocks) {
    const start = Number(el.getAttribute('data-md-start'))
    const end = Number(el.getAttribute('data-md-end'))
    expect(Number.isFinite(start)).toBe(true)
    expect(Number.isFinite(end)).toBe(true)
    expect(end).toBeGreaterThan(start)
    expect(rendered.slice(start, end).length).toBeGreaterThan(0)
  }
}

describe('MarkdownRenderView', () => {
  it('annotates block nodes with source offsets', () => {
    const rendered = expandWikilinks(FIXTURE, 'llm-wiki')
    const { container } = render(<MarkdownRenderView content={FIXTURE} />)
    const root = container.querySelector('.detail-md-render') as HTMLElement
    expect(root.querySelector('h2[data-md-start][data-md-end]')).toBeTruthy()
    expect(root.querySelector('ul[data-md-start][data-md-end]')).toBeTruthy()
    expect(root.querySelector('pre[data-md-start][data-md-end]')).toBeTruthy()
    expect(root.querySelector('blockquote[data-md-start][data-md-end]')).toBeTruthy()
    expectBlockOffsets(root, rendered)
  })

  it('renders box-drawing ascii table as HTML table', () => {
    const content = [
      '    ┌──────┬──────┐',
      '    │ 行为信号 │ 含义     │',
      '    ├──────┼──────┤',
      '    │ accepted_as_is │ 直接可用 │',
      '    └──────┴──────┘'
    ].join('\n')
    const { container } = render(<MarkdownRenderView content={content} />)
    const root = container.querySelector('.detail-md-render') as HTMLElement
    expect(root.querySelector('.detail-md-table-wrap table')).toBeTruthy()
    expect(within(root).getByRole('columnheader', { name: '行为信号' })).toBeTruthy()
  })

  it('wraps tables for horizontal scrolling', () => {
    const { container } = render(<MarkdownRenderView content={FIXTURE} />)
    const wrap = container.querySelector('.detail-md-table-wrap')
    expect(wrap).toBeTruthy()
    expect(wrap?.querySelector('table')).toBeTruthy()
    expect(wrap?.hasAttribute('data-md-start')).toBe(true)
  })

  it('copies GFM table markdown when selecting a cell', () => {
    const rendered = expandWikilinks(FIXTURE, 'llm-wiki')
    const { container } = render(<MarkdownRenderView content={FIXTURE} />)
    const root = container.querySelector('.detail-md-render') as HTMLElement
    const tableWrap = root.querySelector('.detail-md-table-wrap') as HTMLElement
    const cell = within(root).getByRole('cell', { name: 'a' })
    const range = document.createRange()
    range.selectNodeContents(cell)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const tableStart = rendered.indexOf('| Col | Val |')
    expect(buildMarkdownCopyText(rendered, root, selection)).toBe(rendered.slice(tableStart))

    const clipboardData = createClipboardData()
    fireEvent.copy(root, { clipboardData })
    expect(clipboardData.getData('text/plain')).toBe(rendered.slice(tableStart))
    expect(tableWrap.getAttribute('data-md-start')).toBe(String(tableStart))
  })

  it('renders inline and block LaTeX math', () => {
    const content = ['Inline $E=mc^2$ and block:', '', '$$', '\\frac{a}{b}', '$$'].join('\n')
    const { container } = render(<MarkdownRenderView content={content} />)
    const root = container.querySelector('.detail-md-render') as HTMLElement
    expect(root.querySelector('.katex')).toBeTruthy()
    expect(root.querySelector('.katex-display')).toBeTruthy()
    expect(root.textContent).toContain('E=mc')
  })

  it('expands wikilinks in copied markdown', () => {
    const content = 'See [[My Page]] for details.'
    const rendered = expandWikilinks(content, 'llm-wiki')
    const { container } = render(<MarkdownRenderView content={content} />)
    const root = container.querySelector('.detail-md-render') as HTMLElement
    const paragraph = root.querySelector('p') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const copied = buildMarkdownCopyText(rendered, root, selection)
    expect(copied).toContain('[My Page](llm-wiki/wiki/my-page.md)')
    expect(copied).not.toContain('[[My Page]]')
    expect(copied).toBe(rendered.slice(Number(paragraph.getAttribute('data-md-start'))))

    const clipboardData = createClipboardData()
    fireEvent.copy(root, { clipboardData })
    expect(clipboardData.getData('text/plain')).toBe(copied)
  })
})

function createClipboardData(): DataTransfer {
  const store: Record<string, string> = {}
  return {
    setData(type: string, value: string) {
      store[type] = value
    },
    getData(type: string) {
      return store[type] ?? ''
    }
  } as DataTransfer
}
