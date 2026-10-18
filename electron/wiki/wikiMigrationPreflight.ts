import { createHash } from 'node:crypto'

export interface LegacyWikiCategory { id?: string; name: string; description?: string; status?: string; parentCategoryId?: string }
export interface WikiMigrationPreflightInput {
  categories: LegacyWikiCategory[]
  files: Array<{ path: string; content: string }>
  knownCategoryIds: string[]
}
export interface WikiMigrationDiagnostic { code: string; paths: string[]; message: string }
export interface WikiMigrationPreflightReport {
  categories: Array<{ legacyName: string; categoryId: string; description: string; status: 'active' | 'deprecated'; parentCategoryId?: string }>
  files: Array<{ path: string; sha256: string; kind: 'page' | 'legacy-index' | 'legacy-log' | 'raw' }>
  diagnostics: WikiMigrationDiagnostic[]
  manifestHash: string
  writesFiles: false
}

const STABLE_IDS = new Set(['entity', 'concept', 'topic', 'source', 'query'])

export function createWikiMigrationPreflight(input: WikiMigrationPreflightInput): WikiMigrationPreflightReport {
  const diagnostics: WikiMigrationDiagnostic[] = []
  const usedIds = new Set(input.knownCategoryIds)
  const categories = [...input.categories].map(category => {
    let id = category.id && /^[a-z][a-z0-9_-]*$/.test(category.id)
      ? category.id
      : STABLE_IDS.has(category.name.toLowerCase())
        ? category.name.toLowerCase()
        : slug(category.name)
    if (usedIds.has(id) && !category.id) id = `${id}-${sha(category.name).slice(0, 8)}`
    if (usedIds.has(id)) diagnostics.push({ code: 'wiki-migration-category-id-conflict', paths: [], message: `Category id ${id} is already in use.` })
    usedIds.add(id)
    return { legacyName: category.name, categoryId: id, description: category.description ?? '', status: category.status === 'deprecated' ? 'deprecated' as const : 'active' as const, ...(category.parentCategoryId ? { parentCategoryId: category.parentCategoryId } : {}) }
  }).sort((a, b) => a.legacyName.localeCompare(b.legacyName))

  const files = input.files.map(file => {
    const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '')
    let kind: WikiMigrationPreflightReport['files'][number]['kind']
    if (/^(?:wiki\/)?index\.md$/i.test(normalized)) kind = 'legacy-index'
    else if (/^(?:wiki\/)?log\.md$/i.test(normalized)) kind = 'legacy-log'
    else if (normalized.toLowerCase().startsWith('raw/')) kind = 'raw'
    else if (/^wiki\/.+\.md$/i.test(normalized)) kind = 'page'
    else {
      diagnostics.push({ code: 'wiki-migration-unclassified-file', paths: [normalized], message: 'File cannot be classified as a page, index, log, or raw source.' })
      kind = 'page'
    }
    return { path: normalized, sha256: sha(file.content), kind }
  }).sort((a, b) => a.path.localeCompare(b.path))

  const titles = new Map<string, string[]>()
  for (const file of input.files) {
    const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!/^wiki\/.+\.md$/i.test(normalized) || /^(?:wiki\/)?(?:index|log)\.md$/i.test(normalized)) continue
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(file.content)?.[1]
    if (!title) { diagnostics.push({ code: 'wiki-migration-title-missing', paths: [normalized], message: 'Markdown page has no first-level title.' }); continue }
    const key = normalizeTitle(title)
    const paths = titles.get(key) ?? []
    paths.push(normalized)
    titles.set(key, paths)
  }
  for (const paths of titles.values()) if (paths.length > 1) diagnostics.push({ code: 'wiki-migration-title-conflict', paths: paths.sort(), message: 'Pages have the same normalized title and require an explicit resolution.' })
  const manifestHash = sha(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256])))
  return { categories, files, diagnostics, manifestHash, writesFiles: false }
}

function slug(value: string): string {
  const result = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category'
  return /^[a-z]/.test(result) ? result : `category-${result}`
}
function normalizeTitle(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') }
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
