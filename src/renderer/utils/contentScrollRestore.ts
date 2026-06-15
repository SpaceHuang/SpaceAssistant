export type ScrollSnapshot = {
  scrollTop: number
  distanceFromBottom: number
  element: HTMLElement
}

const SCROLL_CONTAINER_SELECTORS = [
  '.detail-code-content',
  '.shiki-body',
  '.detail-md-render',
  '.detail-file-body'
]

export function findScrollContainer(root: HTMLElement): HTMLElement | null {
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    const el = root.querySelector<HTMLElement>(selector)
    if (el && el.scrollHeight > el.clientHeight) return el
  }
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    const el = root.querySelector<HTMLElement>(selector)
    if (el) return el
  }
  return root
}

export function captureScroll(container: HTMLElement): ScrollSnapshot | null {
  const el = findScrollContainer(container)
  if (!el) return null
  return {
    element: el,
    scrollTop: el.scrollTop,
    distanceFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop
  }
}

export function restoreScroll(
  snapshot: ScrollSnapshot,
  nearBottomThreshold = 50
): void {
  const { element, scrollTop, distanceFromBottom } = snapshot
  if (distanceFromBottom < nearBottomThreshold) {
    element.scrollTop = element.scrollHeight - element.clientHeight
  } else {
    element.scrollTop = scrollTop
  }
}

export function captureScrollFromRoot(root: HTMLElement): ScrollSnapshot | null {
  return captureScroll(root)
}

export function restoreScrollToRoot(
  root: HTMLElement,
  snapshot: ScrollSnapshot,
  nearBottomThreshold = 50
): void {
  const current = findScrollContainer(root)
  if (!current) {
    restoreScroll(snapshot, nearBottomThreshold)
    return
  }
  restoreScroll({ ...snapshot, element: current }, nearBottomThreshold)
}
