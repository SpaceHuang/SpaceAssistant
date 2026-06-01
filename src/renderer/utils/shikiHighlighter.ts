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

const SHIKI_THEME = 'light-plus'

let highlighterPromise: Promise<Highlighter> | null = null
const highlightCache = new Map<string, string>()

function cacheKey(lang: string, code: string): string {
  return `${lang}\0${code}`
}

/** 去掉 Shiki pre 上的 inline background，避免与 .sa-prose pre 深色底交替闪烁 */
export function stripShikiPreInlineStyle(html: string): string {
  return html.replace(/(<pre[^>]*)\sstyle="[^"]*"/i, '$1')
}

export function getCachedHighlight(code: string, lang: string): string | null {
  return highlightCache.get(cacheKey(lang, code)) ?? null
}

export function preloadShiki(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEME],
      langs: [...LANGS]
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const key = cacheKey(lang, code)
  const cached = highlightCache.get(key)
  if (cached) return cached

  try {
    const highlighter = await preloadShiki()
    const loaded = highlighter.getLoadedLanguages()
    const language = loaded.includes(lang as (typeof LANGS)[number]) ? lang : 'plaintext'
    const html = highlighter.codeToHtml(code, { lang: language, theme: SHIKI_THEME })
    const normalized = stripShikiPreInlineStyle(html)
    highlightCache.set(key, normalized)
    return normalized
  } catch {
    return null
  }
}
