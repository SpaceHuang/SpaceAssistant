import { describe, expect, it } from 'vitest'
import {
  buildMarkdownCopyText,
  filterInnermostBlocks,
  mdSourceAttrs,
  type MdBlockRange
} from './markdownRenderCopy'

function block(el: HTMLElement, start: number, end: number): MdBlockRange {
  el.setAttribute('data-md-start', String(start))
  el.setAttribute('data-md-end', String(end))
  return { element: el, start, end }
}

function mockSelection(container: HTMLElement, startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return {
    rangeCount: 1,
    getRangeAt: () => range
  } as Selection
}

describe('mdSourceAttrs', () => {
  it('returns data-md offsets when position exists', () => {
    expect(mdSourceAttrs({ position: { start: { offset: 0 }, end: { offset: 10 } } })).toEqual({
      'data-md-start': 0,
      'data-md-end': 10
    })
  })

  it('returns empty object when position is missing or invalid', () => {
    expect(mdSourceAttrs(undefined)).toEqual({})
    expect(mdSourceAttrs({ position: { start: { offset: 5 }, end: { offset: 5 } } })).toEqual({})
    expect(mdSourceAttrs({ position: { start: { offset: NaN }, end: { offset: 10 } } })).toEqual({})
  })
})

describe('filterInnermostBlocks', () => {
  it('drops strict ancestors when nested blocks intersect', () => {
    const outer = document.createElement('blockquote')
    const inner = document.createElement('h2')
    outer.appendChild(inner)
    const blocks = [block(outer, 0, 100), block(inner, 10, 30)]
    expect(filterInnermostBlocks(blocks)).toEqual([blocks[1]])
  })

  it('keeps sibling blocks', () => {
    const h2 = document.createElement('h2')
    const p = document.createElement('p')
    const blocks = [block(h2, 0, 10), block(p, 12, 30)]
    expect(filterInnermostBlocks(blocks)).toHaveLength(2)
  })
})

describe('buildMarkdownCopyText', () => {
  const rendered = [
    '## Section',
    '',
    '- item A',
    '- item B',
    '',
    '```ts',
    'const x = 1',
    '```',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |'
  ].join('\n')

  it('returns null when selection is collapsed or missing blocks', () => {
    const container = document.createElement('div')
    const p = document.createElement('p')
    p.textContent = 'plain'
    container.appendChild(p)
    const range = document.createRange()
    range.selectNodeContents(p)
    range.collapse(true)
    expect(buildMarkdownCopyText(rendered, container, { rangeCount: 1, getRangeAt: () => range } as Selection)).toBeNull()
    expect(buildMarkdownCopyText(rendered, container, null)).toBeNull()
  })

  it('slices a single intersecting block', () => {
    const container = document.createElement('div')
    const tableWrap = document.createElement('div')
    const td = document.createElement('td')
    td.textContent = '1'
    const tr = document.createElement('tr')
    tr.appendChild(td)
    tableWrap.appendChild(document.createElement('table'))
    tableWrap.querySelector('table')!.appendChild(tr)
    block(tableWrap, rendered.indexOf('| A | B |'), rendered.length)
    container.appendChild(tableWrap)

    const textNode = td.firstChild!
    const selection = mockSelection(container, textNode, 0, textNode, 1)
    expect(buildMarkdownCopyText(rendered, container, selection)).toBe(rendered.slice(rendered.indexOf('| A | B |')))
  })

  it('returns union slice for multiple sibling blocks', () => {
    const container = document.createElement('div')
    const h2 = document.createElement('h2')
    h2.textContent = 'Section'
    const ul = document.createElement('ul')
    const li = document.createElement('li')
    li.textContent = 'item A'
    ul.appendChild(li)
    container.append(h2, ul)

    const h2Start = rendered.indexOf('## Section')
    const h2End = rendered.indexOf('- item A')
    const ulStart = h2End
    const ulEnd = rendered.indexOf('```ts')
    block(h2, h2Start, h2End)
    block(ul, ulStart, ulEnd)

    const selection = mockSelection(container, h2.firstChild!, 0, li.firstChild!, 6)
    const text = buildMarkdownCopyText(rendered, container, selection)
    expect(text).toBe(rendered.slice(h2Start, ulEnd))
  })

  it('prefers innermost block inside blockquote', () => {
    const container = document.createElement('div')
    const quote = document.createElement('blockquote')
    const h2 = document.createElement('h2')
    h2.textContent = 'Inner'
    quote.appendChild(h2)
    container.appendChild(quote)

    const innerStart = 10
    const innerEnd = 25
    block(quote, 0, 40)
    block(h2, innerStart, innerEnd)

    const selection = mockSelection(container, h2.firstChild!, 0, h2.firstChild!, 5)
    expect(buildMarkdownCopyText('0123456789012345678901234567890', container, selection)).toBe(
      '0123456789012345678901234567890'.slice(innerStart, innerEnd)
    )
  })

  it('slices task list as whole ul block', () => {
    const taskRendered = '- [ ] todo\n- [x] done'
    const container = document.createElement('div')
    const ul = document.createElement('ul')
    const li = document.createElement('li')
    li.textContent = 'todo'
    ul.appendChild(li)
    container.appendChild(ul)
    block(ul, 0, taskRendered.length)

    const selection = mockSelection(container, li.firstChild!, 0, li.firstChild!, 4)
    expect(buildMarkdownCopyText(taskRendered, container, selection)).toBe(taskRendered)
  })

  it('ignores elements with invalid offsets', () => {
    const container = document.createElement('div')
    const p = document.createElement('p')
    p.textContent = 'hello'
    p.setAttribute('data-md-start', 'bad')
    p.setAttribute('data-md-end', '10')
    container.appendChild(p)
    const selection = mockSelection(container, p.firstChild!, 0, p.firstChild!, 5)
    expect(buildMarkdownCopyText('hello world', container, selection)).toBeNull()
  })
})
