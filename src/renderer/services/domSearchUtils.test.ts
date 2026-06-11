import { beforeEach, describe, expect, it } from 'vitest'
import { findSearchMatches } from '../components/DetailPanel/searchUtils'
import {
  applyDomHighlights,
  capMatches,
  clearDomHighlights,
  containsCjk,
  effectiveSearchOptions,
  extractDomSearchText,
  HIGHLIGHT_CLASS,
  mapMatchesToDom,
  updateCurrentHighlight
} from './domSearchUtils'

describe('domSearchUtils', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('detects CJK characters', () => {
    expect(containsCjk('hello')).toBe(false)
    expect(containsCjk('你好')).toBe(true)
    expect(containsCjk('foo日本bar')).toBe(true)
  })

  it('disables wholeWord for CJK query', () => {
    expect(
      effectiveSearchOptions('你好', { caseSensitive: false, wholeWord: true, useRegex: false }).wholeWord
    ).toBe(false)
    expect(
      effectiveSearchOptions('foo', { caseSensitive: false, wholeWord: true, useRegex: false }).wholeWord
    ).toBe(true)
  })

  it('extracts text across blocks with newline separators', () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="block">hello</div>
        <div class="block">world</div>
      </div>
    `
    const root = document.getElementById('root') as HTMLElement
    const { text, offsetMap } = extractDomSearchText(root, { blockSelector: '.block' })
    expect(text).toBe('hello\nworld')
    expect(offsetMap).toHaveLength(2)
    expect(offsetMap[0].textStart).toBe(0)
    expect(offsetMap[1].textStart).toBe(6)
  })

  it('maps character offsets to DOM text nodes', () => {
    document.body.innerHTML = `<div id="root"><p>hello world</p></div>`
    const root = document.getElementById('root') as HTMLElement
    const { offsetMap } = extractDomSearchText(root)
    const matches: SearchMatch[] = [{ start: 6, end: 11 }]
    const domMatches = mapMatchesToDom(offsetMap, matches)
    expect(domMatches).toHaveLength(1)
    expect(domMatches[0].startOffset).toBe(6)
    expect(domMatches[0].endOffset).toBe(11)
    expect(domMatches[0].node.nodeValue).toBe('hello world')
  })

  it('applies and clears highlight marks', () => {
    document.body.innerHTML = `<div id="root"><p>foo bar foo</p></div>`
    const root = document.getElementById('root') as HTMLElement
    const { offsetMap } = extractDomSearchText(root)
    const domMatches = mapMatchesToDom(offsetMap, [
      { start: 0, end: 3 },
      { start: 8, end: 11 }
    ])
    const marks = applyDomHighlights(root, domMatches, 1)
    expect(marks).toHaveLength(2)
    expect(root.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`)).toHaveLength(2)
    expect(marks[1].classList.contains('sa-search-highlight-current')).toBe(true)
    clearDomHighlights(root)
    expect(root.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`)).toHaveLength(0)
    expect(root.textContent).toBe('foo bar foo')
  })

  it('highlights only matched spans within the same text node', () => {
    document.body.innerHTML = `<div id="root"><p>编排 Skill 与排版 Skill 分离</p></div>`
    const root = document.getElementById('root') as HTMLElement
    const { text, offsetMap } = extractDomSearchText(root)
    const matches = findSearchMatches(text, 'Skill', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    const domMatches = mapMatchesToDom(offsetMap, matches)
    const marks = applyDomHighlights(root, domMatches, 0)
    expect(marks).toHaveLength(2)
    marks.forEach((mark) => {
      expect(mark.textContent).toBe('Skill')
    })
    expect(root.textContent).toBe('编排 Skill 与排版 Skill 分离')
  })

  it('updates only current highlight class', () => {
    document.body.innerHTML = `<div id="root"><p>aaa</p></div>`
    const root = document.getElementById('root') as HTMLElement
    const markA = document.createElement('mark')
    markA.className = HIGHLIGHT_CLASS
    const markB = document.createElement('mark')
    markB.className = HIGHLIGHT_CLASS
    root.append(markA, markB)
    updateCurrentHighlight([markA, markB], 1)
    expect(markA.classList.contains('sa-search-highlight-current')).toBe(false)
    expect(markB.classList.contains('sa-search-highlight-current')).toBe(true)
    expect(markB.getAttribute('aria-current')).toBe('true')
  })

  it('caps matches at limit', () => {
    const input = Array.from({ length: 1005 }, (_, i) => i)
    const { matches, overflow } = capMatches(input, 1000)
    expect(matches).toHaveLength(1000)
    expect(overflow).toBe(true)
  })

  it('includes text inside highlight marks by default', () => {
    document.body.innerHTML = `<div id="root"><p>before<mark class="${HIGHLIGHT_CLASS}">hit</mark>after</p></div>`
    const root = document.getElementById('root') as HTMLElement
    const { text } = extractDomSearchText(root)
    expect(text).toBe('beforehitafter')
  })

  it('can exclude text inside highlight marks', () => {
    document.body.innerHTML = `<div id="root"><p>before<mark class="${HIGHLIGHT_CLASS}">hit</mark>after</p></div>`
    const root = document.getElementById('root') as HTMLElement
    const { text } = extractDomSearchText(root, { includeHighlightText: false })
    expect(text).toBe('beforeafter')
  })
})
