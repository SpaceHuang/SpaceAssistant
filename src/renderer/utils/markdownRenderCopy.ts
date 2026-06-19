/** mdast / hast 节点上可能携带的源码偏移 */
export type MdSourceNode = {
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

export type MdBlockRange = {
  element: Element
  start: number
  end: number
}

const MD_START_ATTR = 'data-md-start'
const MD_END_ATTR = 'data-md-end'

/** 从 mdast 节点 position 生成块级源码标注属性 */
export function mdSourceAttrs(node: MdSourceNode | undefined): Record<string, number | undefined> {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {}
  }
  return {
    [MD_START_ATTR]: start,
    [MD_END_ATTR]: end
  }
}

function parseBlockRange(el: Element): MdBlockRange | null {
  const start = Number(el.getAttribute(MD_START_ATTR))
  const end = Number(el.getAttribute(MD_END_ATTR))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { element: el, start, end }
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  if (typeof range.intersectsNode === 'function') {
    return range.intersectsNode(node)
  }
  const nodeRange = document.createRange()
  nodeRange.selectNodeContents(node)
  return (
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
  )
}

/** 去掉严格祖先，保留最内层相交块 */
export function filterInnermostBlocks(blocks: MdBlockRange[]): MdBlockRange[] {
  return blocks.filter(
    (candidate) =>
      !blocks.some(
        (other) =>
          other.element !== candidate.element &&
          candidate.element !== other.element &&
          candidate.element.contains(other.element)
      )
  )
}

/** 根据选区与块标注，从 rendered 字符串切片输出 Markdown 源片段 */
export function buildMarkdownCopyText(
  rendered: string,
  container: HTMLElement,
  selection: Selection | null
): string | null {
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (!range || range.collapsed) return null

  const annotated = [...container.querySelectorAll(`[${MD_START_ATTR}][${MD_END_ATTR}]`)]
    .map((el) => parseBlockRange(el))
    .filter((block): block is MdBlockRange => block != null)
    .filter(({ element }) => rangeIntersectsNode(range, element))

  if (annotated.length === 0) return null

  const blocks = filterInnermostBlocks(annotated)
  const from = Math.min(...blocks.map((b) => b.start))
  const to = Math.max(...blocks.map((b) => b.end))
  return rendered.slice(from, to)
}

/** 绑定渲染 Markdown 的结构化 copy 监听 */
export function attachMarkdownRenderCopy(
  container: HTMLElement,
  getRendered: () => string
): { dispose: () => void } {
  const onCopy = (event: ClipboardEvent) => {
    const text = buildMarkdownCopyText(getRendered(), container, window.getSelection())
    if (text == null) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', text)
  }

  container.addEventListener('copy', onCopy)
  return {
    dispose: () => container.removeEventListener('copy', onCopy)
  }
}
