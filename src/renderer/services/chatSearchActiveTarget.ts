import type {
  ChatSearchMatch,
  SearchFragment,
  SearchRevealPath,
  SearchSource
} from '../../shared/chatSearchFragments'

/** 当前选中的搜索目标（含 fragment 身份与 reveal，供气泡展开/高亮）。 */
export type ChatSearchActiveTarget = {
  messageId: string
  fragmentId: string
  start: number
  end: number
  order: ChatSearchMatch['order']
  source: SearchSource
  renderStrategy: SearchFragment['renderStrategy']
  revealPath?: SearchRevealPath
  searchableText: string
}

export function resolveChatSearchActiveTarget(
  match: ChatSearchMatch | null | undefined,
  fragments: SearchFragment[]
): ChatSearchActiveTarget | null {
  if (!match) return null
  const fragment = fragments.find((f) => f.fragmentId === match.fragmentId)
  if (!fragment) return null
  return {
    messageId: match.messageId,
    fragmentId: match.fragmentId,
    start: match.start,
    end: match.end,
    order: match.order,
    source: fragment.source,
    renderStrategy: fragment.renderStrategy,
    revealPath: fragment.revealPath,
    searchableText: fragment.searchableText
  }
}

/** 在指定 fragment 容器内按 range 打 mark；找不到 range 时对容器做片段级 fallback。 */
export function applyActiveTargetHighlight(
  root: ParentNode,
  target: ChatSearchActiveTarget
): HTMLElement | null {
  const host = root.querySelector(
    `[data-search-fragment-id="${escapeAttrSelector(target.fragmentId)}"]`
  ) as HTMLElement | null
  if (!host) return null

  clearFragmentHighlights(root)

  if (target.renderStrategy === 'math-source') {
    host.classList.add('sa-search-highlight', 'sa-search-highlight-current')
    host.setAttribute('aria-current', 'true')
    return host
  }

  const preserveWhitespace = host.tagName === 'PRE' || target.source.kind === 'thinking' || target.source.kind === 'tool-input' || target.source.kind === 'tool-result'
  const textMap = collectHostSearchableText(host, preserveWhitespace)
  const start = Math.max(0, Math.min(target.start, textMap.text.length))
  const end = Math.max(start, Math.min(target.end, textMap.text.length))
  if (end <= start || textMap.text.slice(start, end).length === 0) {
    host.classList.add('sa-search-highlight', 'sa-search-highlight-current')
    host.setAttribute('aria-current', 'true')
    return host
  }

  const mark = wrapTextRange(host, textMap.map, start, end)
  if (!mark) {
    host.classList.add('sa-search-highlight', 'sa-search-highlight-current')
    host.setAttribute('aria-current', 'true')
    return host
  }
  mark.classList.add('sa-search-highlight', 'sa-search-highlight-current')
  mark.setAttribute('aria-current', 'true')
  return mark
}

export function clearFragmentHighlights(root: ParentNode): void {
  for (const el of root.querySelectorAll('.sa-search-highlight')) {
    if (el.tagName === 'MARK') {
      const parent = el.parentNode
      if (!parent) continue
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      parent.removeChild(el)
      if (parent instanceof HTMLElement) parent.normalize()
    } else {
      el.classList.remove('sa-search-highlight', 'sa-search-highlight-current')
      el.removeAttribute('aria-current')
    }
  }
}

function wrapTextRange(host: HTMLElement, map: Array<{ node: Text; start: number; end: number; rawOffset: (offset: number) => number; rawEndOffset: (offset: number) => number }>, start: number, end: number): HTMLElement | null {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (isInsideNestedFragment(node, host)) continue
    const entry = map.find((item) => item.node === node)
    if (!entry) continue
    if (!startNode && entry.end > start) {
      startNode = node
      startOffset = entry.rawOffset(start)
    }
    if (entry.end >= end) {
      endNode = node
      endOffset = entry.rawEndOffset(end)
      break
    }
  }

  if (!startNode || !endNode) return null

  try {
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const mark = document.createElement('mark')
    range.surroundContents(mark)
    return mark
  } catch {
    return null
  }
}

/** 跳过宿主内嵌套的其他 fragment 容器（如 prose 内的 code/math）。 */
function isInsideNestedFragment(node: Node, host: HTMLElement): boolean {
  let el = node.parentElement
  while (el && el !== host) {
    if (el.hasAttribute('data-search-fragment-id')) return true
    el = el.parentElement
  }
  return false
}

function collectHostSearchableText(host: HTMLElement, preserveWhitespace: boolean): { text: string; map: Array<{ node: Text; start: number; end: number; rawOffset: (offset: number) => number; rawEndOffset: (offset: number) => number }> } {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let text = ''
  const map: Array<{ node: Text; start: number; end: number; rawOffset: (offset: number) => number; rawEndOffset: (offset: number) => number }> = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (isInsideNestedFragment(node, host)) continue
    const start = text.length
    const rawOffsets: number[] = []
    for (let i = 0; i < node.data.length; i += 1) {
      const char = node.data[i]!
      if (!preserveWhitespace && /\s/.test(char)) {
        if (text.length > 0 && !text.endsWith(' ')) {
          text += ' '
          rawOffsets.push(i)
        }
      } else {
        text += char
        rawOffsets.push(i)
      }
    }
    const end = text.length
    if (end > start) map.push({
      node,
      start,
      end,
      rawOffset: (offset) => {
        const local = Math.max(0, Math.min(rawOffsets.length, offset - start))
        if (local >= rawOffsets.length) return node.data.length
        return rawOffsets[local]!
      },
      rawEndOffset: (offset) => {
        const local = Math.max(0, Math.min(rawOffsets.length, offset - start))
        if (local >= rawOffsets.length) return node.data.length
        if (local <= 0) return rawOffsets[0]!
        return Math.min(node.data.length, rawOffsets[local - 1]! + 1)
      }
    })
  }
  if (text.endsWith(' ')) text = text.slice(0, -1)
  return { text, map }
}

function escapeAttrSelector(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
