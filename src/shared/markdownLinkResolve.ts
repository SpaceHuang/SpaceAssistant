import { normalizeRelPath, normalizeWikiRoot } from './wikiImportPaths'

const MARKDOWN_EXT = new Set(['.md', '.mdx', '.rst'])

export type ResolveMarkdownInternalLinkOptions = {
  wikiRootPath?: string
}

function isMarkdownPath(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  for (const ext of MARKDOWN_EXT) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

function dirname(relPath: string): string {
  const n = normalizeRelPath(relPath)
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(0, i) : ''
}

function joinPosix(baseDir: string, hrefPath: string): string {
  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : []
  const hrefParts = hrefPath.replace(/\\/g, '/').split('/')
  const stack = [...baseParts]
  for (const part of hrefParts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

/** Wiki 绝对或简写路径（不依赖 baseRelPath） */
export function resolveWikiAbsolutePathLink(href: string, wikiRootPath = 'llm-wiki'): string | null {
  if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) {
    return null
  }
  const root = normalizeWikiRoot(wikiRootPath)
  const normalized = normalizeRelPath(href.replace(/^\.\//, ''))
  if (normalized.startsWith(`${root}/`)) {
    return isMarkdownPath(normalized) ? normalized : null
  }
  if (normalized.startsWith('wiki/')) {
    const resolved = `${root}/${normalized}`
    return isMarkdownPath(resolved) ? resolved : null
  }
  return null
}

function parseLocalDevMarkdownUrl(href: string): string | null {
  try {
    const url = new URL(href)
    const host = url.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost') return null
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!path || !isMarkdownPath(path)) return null
    return normalizeRelPath(path)
  } catch {
    return null
  }
}

export function splitMarkdownHref(href: string): { pathPart: string; fragment: string | null } {
  const hash = href.indexOf('#')
  if (hash < 0) return { pathPart: href, fragment: null }
  const pathPart = href.slice(0, hash)
  const raw = href.slice(hash + 1)
  const fragment = raw.length > 0 ? decodeURIComponent(raw) : null
  return { pathPart, fragment }
}

function stripFragment(href: string): string {
  return splitMarkdownHref(href).pathPart
}

/** GitHub 风格标题锚点 id（与常见 Markdown 预览一致） */
export function slugifyMarkdownHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+=\[\]{}|\\:;"'<>,.?/]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export type MarkdownHrefTarget =
  | { kind: 'fragment'; fragment: string }
  | { kind: 'file'; relPath: string; fragment?: string }

/**
 * 解析 Markdown 链接点击目标：同页锚点或打开工作区内 Markdown 文件（可带锚点）。
 */
export function resolveMarkdownHrefTarget(
  href: string,
  baseRelPath?: string | null,
  options?: ResolveMarkdownInternalLinkOptions
): MarkdownHrefTarget | null {
  if (!href || href.startsWith('mailto:')) return null

  const { pathPart, fragment } = splitMarkdownHref(href)

  if (!pathPart || pathPart === '#') {
    if (fragment) return { kind: 'fragment', fragment }
    return null
  }

  if (pathPart.startsWith('#')) {
    const frag = pathPart.slice(1) || fragment
    if (frag) return { kind: 'fragment', fragment: frag }
    return null
  }

  const base = baseRelPath ? normalizeRelPath(baseRelPath) : null
  const pathNorm = normalizeRelPath(pathPart.replace(/^\.\//, ''))
  if (fragment && base && pathNorm === base) {
    return { kind: 'fragment', fragment }
  }

  const relPath = resolveMarkdownInternalLink(pathPart, baseRelPath, options)
  if (!relPath) return null

  if (fragment && base && normalizeRelPath(relPath) === base) {
    return { kind: 'fragment', fragment }
  }

  return fragment ? { kind: 'file', relPath, fragment } : { kind: 'file', relPath }
}

/**
 * 解析可在工作区内打开的 Markdown 内链，返回相对工作目录的路径；无法解析时返回 null。
 */
export function resolveMarkdownInternalLink(
  href: string,
  baseRelPath?: string | null,
  options?: ResolveMarkdownInternalLinkOptions
): string | null {
  const wikiRootPath = options?.wikiRootPath ?? 'llm-wiki'
  if (!href || href === '#') return null
  if (href.startsWith('#')) return null
  if (href.startsWith('mailto:')) return null

  const pathPart = stripFragment(href)
  if (!pathPart) return null

  if (pathPart.startsWith('http://') || pathPart.startsWith('https://')) {
    return parseLocalDevMarkdownUrl(pathPart)
  }

  const wikiAbs = resolveWikiAbsolutePathLink(pathPart, wikiRootPath)
  if (wikiAbs) return wikiAbs

  if (!baseRelPath) return null

  const baseDir = dirname(baseRelPath)
  const resolved = joinPosix(baseDir, pathPart.replace(/^\.\//, ''))
  if (!resolved || !isMarkdownPath(resolved)) return null
  return resolved
}
