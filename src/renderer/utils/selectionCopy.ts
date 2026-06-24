/** 获取容器内当前非空选区文本；选区不在容器内时返回 null */
export function getSelectionTextInContainer(
  container: HTMLElement,
  selection: Selection | null = window.getSelection()
): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const range = selection.getRangeAt(0)
  const anchorNode = range.commonAncestorContainer
  const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement
  if (!anchorElement || !container.contains(anchorElement)) return null

  const text = selection.toString()
  return text.length > 0 ? text : null
}

/** 写入剪贴板；clipboard API 不可用时回退到 execCommand */
export async function writeClipboardText(text: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      /* ignore */
    }
  }
}

/** 绑定 copy 事件，使 Ctrl/Cmd+C 在只读选区上也能复制纯文本 */
export function attachSelectionCopy(container: HTMLElement): { dispose: () => void } {
  const onCopy = (event: ClipboardEvent) => {
    const text = getSelectionTextInContainer(container)
    if (!text) return
    event.preventDefault()
    event.clipboardData?.setData('text/plain', text)
  }

  container.addEventListener('copy', onCopy)
  return {
    dispose: () => container.removeEventListener('copy', onCopy)
  }
}
