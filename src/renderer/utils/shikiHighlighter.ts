import { createHighlighter, type Highlighter } from 'shiki'

const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'csharp',
  'cpp',
  'c',
  'bash',
  'powershell',
  'bat',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'ini',
  'xml',
  'sql',
  'html',
  'css',
  'scss',
  'vue',
  'svelte',
  'markdown',
  'mdx',
  'plaintext'
] as const

/** 与 --sa-code-bg 配套的 Shiki 主题；浅色面板仍用 light-plus */
export type ShikiSurface = 'dark' | 'light'

const SHIKI_THEME: Record<ShikiSurface, string> = {
  dark: 'dark-plus',
  light: 'light-plus'
}

export const MAX_HIGHLIGHT_CACHE_ENTRIES = 200
export const MAX_HIGHLIGHT_CACHE_BYTES = 8 * 1024 * 1024
export const MAX_CACHEABLE_CODE_BYTES = 256 * 1024

let highlighterPromise: Promise<Highlighter> | null = null

type CacheEntry = { html: string; bytes: number }

const highlightCache = new Map<string, CacheEntry>()
let highlightCacheBytes = 0

function utf16ByteLength(s: string): number {
  return s.length * 2
}

function cacheKey(surface: ShikiSurface, lang: string, code: string): string {
  return `${surface}\0${lang}\0${code}`
}

function touchCacheEntry(key: string, entry: CacheEntry): void {
  highlightCache.delete(key)
  highlightCache.set(key, entry)
}

function evictUntilWithinLimits(): void {
  while (
    highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES ||
    highlightCacheBytes > MAX_HIGHLIGHT_CACHE_BYTES
  ) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    const entry = highlightCache.get(oldest)
    highlightCache.delete(oldest)
    if (entry) highlightCacheBytes -= entry.bytes
  }
}

function setCacheEntry(key: string, html: string): void {
  const bytes = utf16ByteLength(key) + utf16ByteLength(html)
  const existing = highlightCache.get(key)
  if (existing) {
    highlightCacheBytes -= existing.bytes
    highlightCache.delete(key)
  }
  highlightCache.set(key, { html, bytes })
  highlightCacheBytes += bytes
  evictUntilWithinLimits()
}

/** 测试用：缓存条数与估算字节 */
export function getHighlightCacheStats(): { entries: number; bytes: number } {
  return { entries: highlightCache.size, bytes: highlightCacheBytes }
}

/** 测试用：清空高亮缓存 */
export function clearHighlightCacheForTest(): void {
  highlightCache.clear()
  highlightCacheBytes = 0
}

/** 去掉 Shiki pre 上的 inline background，由外层 --sa-code-bg 或面板底承载 */
export function stripShikiPreInlineStyle(html: string): string {
  return html.replace(/(<pre[^>]*)\sstyle="[^"]*"/i, '$1')
}

export function getCachedHighlight(
  code: string,
  lang: string,
  surface: ShikiSurface = 'dark'
): string | null {
  const key = cacheKey(surface, lang, code)
  const entry = highlightCache.get(key)
  if (!entry) return null
  touchCacheEntry(key, entry)
  return entry.html
}

export function preloadShiki(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEME.dark, SHIKI_THEME.light],
      langs: [...LANGS]
    })
  }
  return highlighterPromise
}

export async function highlightCode(
  code: string,
  lang: string,
  surface: ShikiSurface = 'dark'
): Promise<string | null> {
  const key = cacheKey(surface, lang, code)
  const cached = highlightCache.get(key)
  if (cached) {
    touchCacheEntry(key, cached)
    return cached.html
  }

  try {
    const highlighter = await preloadShiki()
    const loaded = highlighter.getLoadedLanguages()
    const language = loaded.includes(lang as (typeof LANGS)[number]) ? lang : 'plaintext'
    const html = highlighter.codeToHtml(code, { lang: language, theme: SHIKI_THEME[surface] })
    const normalized = stripShikiPreInlineStyle(html)
    if (utf16ByteLength(code) <= MAX_CACHEABLE_CODE_BYTES) {
      setCacheEntry(key, normalized)
    }
    return normalized
  } catch {
    return null
  }
}
