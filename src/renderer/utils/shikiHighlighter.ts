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

let highlighterPromise: Promise<Highlighter> | null = null

export function preloadShiki(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['light-plus'],
      langs: [...LANGS]
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, lang: string): Promise<string | null> {
  try {
    const highlighter = await preloadShiki()
    const loaded = highlighter.getLoadedLanguages()
    const language = loaded.includes(lang as (typeof LANGS)[number]) ? lang : 'plaintext'
    return highlighter.codeToHtml(code, { lang: language, theme: 'light-plus' })
  } catch {
    return null
  }
}
