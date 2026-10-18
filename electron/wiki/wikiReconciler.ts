import { createHash } from 'node:crypto'

export interface WikiPageMarker {
  pageId: string
  categoryId: string
  summary: string
  parentPageId: string | null
  sourceRefs: Array<{ sourceId: string; sourceRevision: number }>
  revision: number
}

export interface WikiReconcileCatalogEntry { pageId: string; path: string; revision: number; contentHash: string }
export interface WikiReconcileInput { path: string; content: string }
export interface WikiReconcilePage extends WikiReconcileCatalogEntry {
  title: string
  categoryId: string
  parentPageId: string | null
  summary: string
  sourceRefs: WikiPageMarker['sourceRefs']
  externalEdit: boolean
}
export interface WikiReconcileDiagnostic { code: string; path: string; pageId?: string; message: string }
export interface WikiReconcileResult { pages: WikiReconcilePage[]; diagnostics: WikiReconcileDiagnostic[] }

const START = '<!-- wiki-page:start -->'
const END = '<!-- wiki-page:end -->'

export function serializeWikiPageMarker(marker: WikiPageMarker): string {
  return `${START}\n${JSON.stringify({ formatVersion: 1, ...marker })}\n${END}`
}

export function parseWikiPageMarker(content: string): { marker?: WikiPageMarker; body: string; diagnostic?: string } {
  const lines = content.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => line.trim() === START ? [index] : [])
  const ends = lines.flatMap((line, index) => line.trim() === END ? [index] : [])
  if (starts.length === 0 && ends.length === 0) return { body: content, diagnostic: 'wiki-page-marker-missing' }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0] || ends[0] - starts[0] !== 2) return { body: content, diagnostic: 'wiki-page-marker-invalid' }
  let data: Record<string, unknown>
  try { data = JSON.parse(lines[starts[0] + 1]) as Record<string, unknown> } catch { return { body: content, diagnostic: 'wiki-page-marker-invalid' } }
  if (data.formatVersion !== 1 || typeof data.pageId !== 'string' || !data.pageId || typeof data.categoryId !== 'string' || !data.categoryId || typeof data.summary !== 'string' || !(data.parentPageId === null || typeof data.parentPageId === 'string') || !Number.isSafeInteger(data.revision) || (data.revision as number) < 1 || !Array.isArray(data.sourceRefs)) return { body: content, diagnostic: 'wiki-page-marker-invalid' }
  const sourceRefs = data.sourceRefs.filter((ref): ref is { sourceId: string; sourceRevision: number } => !!ref && typeof ref === 'object' && typeof (ref as { sourceId?: unknown }).sourceId === 'string' && Number.isSafeInteger((ref as { sourceRevision?: unknown }).sourceRevision) && ((ref as { sourceRevision: number }).sourceRevision > 0))
  if (sourceRefs.length !== data.sourceRefs.length) return { body: content, diagnostic: 'wiki-page-marker-invalid' }
  const body = [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)].join('\n').replace(/^\n/, '')
  return { marker: { pageId: data.pageId, categoryId: data.categoryId, summary: data.summary, parentPageId: data.parentPageId as string | null, sourceRefs, revision: data.revision as number }, body }
}

export function reconcileWikiFiles(files: WikiReconcileInput[], catalog: WikiReconcileCatalogEntry[]): WikiReconcileResult {
  const previousByPath = new Map(catalog.map(entry => [entry.path, entry]))
  const byId = new Map<string, WikiReconcileInput[]>()
  const parsed: Array<{ file: WikiReconcileInput; marker: WikiPageMarker; body: string; hash: string }> = []
  const diagnostics: WikiReconcileDiagnostic[] = []
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const result = parseWikiPageMarker(file.content)
    if (!result.marker) {
      diagnostics.push({ code: result.diagnostic ?? 'wiki-page-marker-invalid', path: file.path, message: 'Page identity marker is missing or invalid.' })
      continue
    }
    const pages = byId.get(result.marker.pageId) ?? []
    pages.push(file)
    byId.set(result.marker.pageId, pages)
    parsed.push({ file, marker: result.marker, body: result.body, hash: sha256(file.content) })
  }
  const duplicateIds = new Set([...byId.entries()].filter(([, matches]) => matches.length > 1).map(([id]) => id))
  for (const pageId of duplicateIds) for (const file of byId.get(pageId) ?? []) diagnostics.push({ code: 'wiki-page-identity-duplicate', path: file.path, pageId, message: 'Page id appears in more than one active file.' })

  const pages: WikiReconcilePage[] = []
  for (const item of parsed) {
    if (duplicateIds.has(item.marker.pageId)) continue
    const previous = previousByPath.get(item.file.path)
    const externalEdit = !!previous && previous.contentHash !== item.hash
    const revision = previous ? (externalEdit ? previous.revision + 1 : previous.revision) : 1
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(item.body)?.[1]?.trim()
    if (!title) {
      diagnostics.push({ code: 'wiki-page-title-missing', path: item.file.path, pageId: item.marker.pageId, message: 'Page must contain a first-level title.' })
      continue
    }
    pages.push({ pageId: item.marker.pageId, path: item.file.path, revision, contentHash: item.hash, title, categoryId: item.marker.categoryId, parentPageId: item.marker.parentPageId, summary: item.marker.summary, sourceRefs: item.marker.sourceRefs, externalEdit })
  }
  return { pages, diagnostics }
}

function sha256(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex') }
