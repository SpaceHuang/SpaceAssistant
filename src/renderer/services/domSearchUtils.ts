import type { SearchMatch, SearchOptions } from '../components/DetailPanel/searchUtils'

export const HIGHLIGHT_CLASS = 'sa-search-highlight'
export const CURRENT_HIGHLIGHT_CLASS = 'sa-search-highlight-current'
export const SEARCH_MATCH_LIMIT = 1000
export const MAX_BLOCK_TEXT_CHARS = 100_000

export type DomTextOffsetEntry = {
  node: Text
  textStart: number
  textEnd: number
}

export type DomSearchExtraction = {
  text: string
  offsetMap: DomTextOffsetEntry[]
}

export type DomMatchRange = {
  node: Text
  startOffset: number
  endOffset: number
}

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text)
}

export function effectiveSearchOptions(query: string, options: SearchOptions): SearchOptions {
  if (!options.wholeWord || containsCjk(query)) {
    return { ...options, wholeWord: false }
  }
  return options
}

export function capMatches<T>(matches: T[], limit = SEARCH_MATCH_LIMIT): { matches: T[]; overflow: boolean } {
  if (matches.length <= limit) {
    return { matches, overflow: false }
  }
  return { matches: matches.slice(0, limit), overflow: true }
}

function isHiddenElement(el: Element): boolean {
  if (el.closest('[aria-hidden="true"]')) return true
  const style = window.getComputedStyle(el)
  return style.display === 'none' || style.visibility === 'hidden'
}

function shouldSkipNode(node: Node, includeHighlightText: boolean): boolean {
  const parent = node.parentElement
  if (!parent) return true
  const skipTags = includeHighlightText
    ? 'script, style, noscript, textarea, input'
    : 'script, style, noscript, textarea, input, mark'
  if (parent.closest(skipTags)) return true
  if (isHiddenElement(parent)) return true
  return false
}

function collectTextNodes(block: Element, includeHighlightText: boolean): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text)) return NodeFilter.FILTER_REJECT
      if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT
      if (shouldSkipNode(node, includeHighlightText)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Text) nodes.push(current)
    current = walker.nextNode()
  }
  return nodes
}

function appendBlockText(nodes: Text[], parts: string[], offsetMap: DomTextOffsetEntry[], maxBlockChars?: number) {
  let blockText = ''
  for (const node of nodes) {
    const value = node.nodeValue ?? ''
    if (maxBlockChars != null && blockText.length >= maxBlockChars) break
    const remaining = maxBlockChars != null ? maxBlockChars - blockText.length : value.length
    const slice = maxBlockChars != null ? value.slice(0, Math.max(0, remaining)) : value
    if (!slice) continue
    const textStart = parts.join('').length + blockText.length
    blockText += slice
    offsetMap.push({
      node,
      textStart,
      textEnd: textStart + slice.length
    })
  }
  if (blockText.length > 0) {
    parts.push(blockText)
  }
}

export function extractDomSearchText(
  root: HTMLElement,
  options?: { blockSelector?: string; maxBlockChars?: number; includeHighlightText?: boolean }
): DomSearchExtraction {
  const includeHighlightText = options?.includeHighlightText ?? true
  const parts: string[] = []
  const offsetMap: DomTextOffsetEntry[] = []
  const maxBlockChars = options?.maxBlockChars ?? MAX_BLOCK_TEXT_CHARS

  const blocks = options?.blockSelector
    ? Array.from(root.querySelectorAll<HTMLElement>(options.blockSelector))
    : [root]

  blocks.forEach((block, index) => {
    if (index > 0 && parts.length > 0) {
      parts.push('\n')
    }
    appendBlockText(collectTextNodes(block, includeHighlightText), parts, offsetMap, maxBlockChars)
  })

  return { text: parts.join(''), offsetMap }
}

function findOffsetEntry(offsetMap: DomTextOffsetEntry[], position: number): DomTextOffsetEntry | null {
  for (const entry of offsetMap) {
    if (position >= entry.textStart && position < entry.textEnd) return entry
  }
  return null
}

export function mapMatchesToDom(offsetMap: DomTextOffsetEntry[], matches: SearchMatch[]): DomMatchRange[] {
  const domMatches: DomMatchRange[] = []
  for (const match of matches) {
    const startEntry = findOffsetEntry(offsetMap, match.start)
    const endEntry = findOffsetEntry(offsetMap, match.end - 1)
    if (!startEntry || !endEntry) continue
    if (startEntry.node !== endEntry.node) {
      // Match spans multiple text nodes — split into per-node ranges.
      let pos = match.start
      while (pos < match.end) {
        const entry = findOffsetEntry(offsetMap, pos)
        if (!entry) break
        const localStart = pos - entry.textStart
        const localEnd = Math.min(entry.textEnd - entry.textStart, match.end - entry.textStart)
        domMatches.push({
          node: entry.node,
          startOffset: localStart,
          endOffset: localEnd
        })
        pos = entry.textEnd
      }
      continue
    }
    domMatches.push({
      node: startEntry.node,
      startOffset: match.start - startEntry.textStart,
      endOffset: match.end - startEntry.textStart
    })
  }
  return domMatches
}

export function clearDomHighlights(container: HTMLElement): void {
  const marks = Array.from(container.querySelectorAll<HTMLElement>(`mark.${HIGHLIGHT_CLASS}`))
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark)
    }
    parent.removeChild(mark)
    if (parent instanceof HTMLElement || parent instanceof DocumentFragment) {
      parent.normalize?.()
    } else if (parent.parentNode) {
      parent.parentNode.normalize()
    }
  }
}

export function updateCurrentHighlight(marks: HTMLElement[], currentIndex: number): void {
  marks.forEach((mark, index) => {
    const isCurrent = index === currentIndex
    mark.classList.toggle(CURRENT_HIGHLIGHT_CLASS, isCurrent)
    if (isCurrent) {
      mark.setAttribute('aria-current', 'true')
    } else {
      mark.removeAttribute('aria-current')
    }
  })
}

export function applyDomHighlights(
  container: HTMLElement,
  domMatches: DomMatchRange[],
  currentIndex: number,
  options?: { skipClear?: boolean }
): HTMLElement[] {
  if (!options?.skipClear) {
    clearDomHighlights(container)
  }
  if (domMatches.length === 0) return []

  const marks: Array<HTMLElement | null> = new Array(domMatches.length).fill(null)
  const groups = new Map<Text, Array<{ match: DomMatchRange; index: number }>>()

  domMatches.forEach((match, index) => {
    const items = groups.get(match.node) ?? []
    items.push({ match, index })
    groups.set(match.node, items)
  })

  for (const [node, items] of groups) {
    if (!container.contains(node)) continue
    const sorted = [...items].sort((a, b) => b.match.startOffset - a.match.startOffset)
    let textNode: Text = node

    for (const { match, index } of sorted) {
      const { startOffset, endOffset } = match
      if (startOffset < 0 || endOffset <= startOffset || endOffset > textNode.length) continue

      if (endOffset < textNode.length) {
        textNode.splitText(endOffset)
      }
      const middle = textNode.splitText(startOffset)
      const mark = document.createElement('mark')
      mark.className = HIGHLIGHT_CLASS
      middle.parentNode?.insertBefore(mark, middle)
      mark.appendChild(middle)
      marks[index] = mark
    }
  }

  const validMarks = marks.filter((mark): mark is HTMLElement => mark != null)
  const safeIndex = currentIndex >= 0 && currentIndex < validMarks.length ? currentIndex : -1
  updateCurrentHighlight(validMarks, safeIndex)
  return validMarks
}

export function scrollHighlightIntoView(mark: HTMLElement | undefined): void {
  if (!mark || typeof mark.scrollIntoView !== 'function') return
  mark.scrollIntoView({ block: 'center', behavior: 'auto' })
}
