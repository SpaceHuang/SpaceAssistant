/** 将 Obsidian 式 [[wikilink]] 展开为 Markdown 相对链接 */
export function expandWikilinks(content: string, wikiRootPath: string): string {
  const root = wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return content.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_match, rawName: string) => {
    const name = rawName.trim()
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    return `[${name}](${root}/wiki/${slug}.md)`
  })
}

export function classifyWikiReferencedPath(
  relPath: string,
  wikiRootPath: string
): 'raw' | 'wiki' | 'schema' | null {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const root = wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (normalized === `${root}/SCHEMA.md`) return 'schema'
  if (normalized === `${root}/raw` || normalized.startsWith(`${root}/raw/`)) return 'raw'
  if (normalized === `${root}/wiki` || normalized.startsWith(`${root}/wiki/`)) return 'wiki'
  return null
}

export type WikiIndexEntry = {
  title: string
  relPath: string
  section: string
  summary?: string
}

/** 从 index.md 解析分组条目（简单 Markdown 列表） */
export function parseWikiIndexMarkdown(content: string, wikiRootPath: string): WikiIndexEntry[] {
  const root = wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const entries: WikiIndexEntry[] = []
  let section = 'Other'
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      section = heading[1].trim()
      continue
    }
    const item = line.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s+[—-]\s*(.+))?$/)
    if (!item) continue
    const title = item[1].trim()
    let href = item[2].trim().replace(/^\.\//, '')
    if (!href.startsWith(`${root}/`)) {
      href = `${root}/wiki/${href.replace(/^\.\.\/wiki\//, '').replace(/^wiki\//, '')}`
    }
    entries.push({ title, relPath: href, section, summary: item[3]?.trim() })
  }
  return entries
}
