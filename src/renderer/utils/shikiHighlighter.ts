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

let highlighterPromise: Promise<Highlighter> | null = null
const highlightCache = new Map<string, string>()

function cacheKey(surface: ShikiSurface, lang: string, code: string): string {
  return `${surface}\0${lang}\0${code}`
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
  return highlightCache.get(cacheKey(surface, lang, code)) ?? null
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
  if (cached) return cached

  try {
    const highlighter = await preloadShiki()
    const loaded = highlighter.getLoadedLanguages()
    const language = loaded.includes(lang as (typeof LANGS)[number]) ? lang : 'plaintext'
    const html = highlighter.codeToHtml(code, { lang: language, theme: SHIKI_THEME[surface] })
    const normalized = stripShikiPreInlineStyle(html)
    highlightCache.set(key, normalized)
    return normalized
  } catch {
    return null
  }
}
