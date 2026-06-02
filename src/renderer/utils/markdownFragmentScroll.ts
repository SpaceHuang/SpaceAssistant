import { slugifyMarkdownHeading } from '../../shared/markdownLinkResolve'

function findElementById(root: HTMLElement, id: string): HTMLElement | null {
  if (root.id === id) return root
  for (const el of root.querySelectorAll('[id]')) {
    if (el instanceof HTMLElement && el.id === id) return el
  }
  return null
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment.replace(/^#/, ''))
  } catch {
    return fragment.replace(/^#/, '')
  }
}

function findFragmentElement(root: HTMLElement, fragment: string): HTMLElement | null {
  const decoded = decodeFragment(fragment)
  if (!decoded) return null

  const candidates = [decoded, slugifyMarkdownHeading(decoded)]
  for (const id of candidates) {
    if (!id) continue
    const byId = findElementById(root, id)
    if (byId) return byId
  }

  const slugTarget = slugifyMarkdownHeading(decoded)
  if (slugTarget) {
    const headings = root.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')
    for (const h of headings) {
      if (h.id === slugTarget) return h
    }
  }

  return null
}

/** 在 Markdown 预览容器内滚动到标题锚点 */
export function scrollToMarkdownFragment(fragment: string, root: HTMLElement | null): boolean {
  if (!root) return false
  const el = findFragmentElement(root, fragment)
  if (!el) return false
  el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return true
}
