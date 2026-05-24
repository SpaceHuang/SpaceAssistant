export function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function normalizeWikiRoot(wikiRootPath: string): string {
  return wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

export type WikiCollectKind = 'external' | 'raw' | 'wiki-page' | 'wiki-other' | 'schema'

export function classifyWikiCollectPath(relPath: string, wikiRootPath: string): WikiCollectKind {
  const normalized = normalizeRelPath(relPath)
  const root = normalizeWikiRoot(wikiRootPath)
  if (normalized === `${root}/SCHEMA.md`) return 'schema'
  if (normalized.startsWith(`${root}/wiki/`)) return 'wiki-page'
  if (normalized === `${root}/wiki`) return 'wiki-other'
  if (normalized.startsWith(`${root}/raw/`)) return 'raw'
  if (normalized === `${root}/raw`) return 'wiki-other'
  if (normalized === root || normalized.startsWith(`${root}/`)) return 'wiki-other'
  return 'external'
}

export function canCollectToWiki(relPath: string, wikiRootPath: string, isDirectory: boolean): boolean {
  if (isDirectory) return false
  const kind = classifyWikiCollectPath(relPath, wikiRootPath)
  return kind === 'external' || kind === 'raw'
}

export function computeRawDestBasename(srcRelPath: string, wikiRootPath: string): string {
  const root = normalizeWikiRoot(wikiRootPath)
  const basename = normalizeRelPath(srcRelPath).split('/').filter(Boolean).pop() || 'untitled'
  return `${root}/raw/${basename}`
}

export function autoRenameRawPath(baseRawRelPath: string, attempt: number, now = new Date()): string {
  const normalized = normalizeRelPath(baseRawRelPath)
  const lastSlash = normalized.lastIndexOf('/')
  const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
  const file = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  const suffix =
    attempt <= 0
      ? formatTimestamp(now)
      : attempt === 1
        ? '2'
        : String(attempt + 1)
  const nextName = `${stem}-${suffix}${ext}`
  return dir ? `${dir}/${nextName}` : nextName
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
