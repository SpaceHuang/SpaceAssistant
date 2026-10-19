import { createHash } from 'node:crypto'
import path from 'node:path'
import { lstat, readdir } from 'node:fs/promises'
import type { WikiFileStore } from './wikiFileStore'
import { parseWikiSchema } from './wikiSchema'
import { parseWikiPageMarker, serializeWikiPageMarker, type WikiPageMarker } from './wikiReconciler'
import { normalizeWikiRelativePath } from './wikiPaths'
import { buildWikiIndex, buildWikiLog, type WikiProjectionPage } from './wikiProjection'

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
  changes?: Array<{ objectKind: string; relativePath: string; oldHash: string; newBytes: string }>
  review: { indexNotes: Array<{ sourcePath: string; targetTitle: string; content: string }>; unclassifiedIndexContent: Array<{ sourcePath: string; content: string }>; readonlyLogArchives: Array<{ sourcePath: string; archivePath: string; sha256: string }> }
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
    const normalized = normalizeWikiRelativePath(file.path)
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
    const normalized = normalizeWikiRelativePath(file.path)
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
  return { categories, files, diagnostics, manifestHash, writesFiles: false, review: { indexNotes: [], unclassifiedIndexContent: [], readonlyLogArchives: [] } }
}

export function buildWikiMigrationPreflight(input: { schema: string; files: Array<{ path: string; content: string }> }): WikiMigrationPreflightReport {
  const parsedSchema = parseWikiSchema(input.schema)
  const legacyRows = [...input.schema.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)]
    .map(match => ({ name: match[1].trim(), directory: match[2].trim().replace(/`/g, ''), description: match[3].trim() }))
    .filter(row => row.name.toLowerCase() !== '类型' && !/^-+$/.test(row.name))
  const categories = parsedSchema.valid
    ? parsedSchema.categories.map(category => ({ legacyName: category.name, categoryId: category.id, description: category.description, status: category.status }))
    : legacyRows.map(row => ({ legacyName: row.name, categoryId: stableCategoryId(row.name, row.directory), description: row.description || row.name, status: 'active' as const }))
  const schema = parsedSchema.valid || legacyRows.length > 0
    ? { valid: true as const, categories: categories.map(category => ({ id: category.categoryId, name: category.legacyName, description: category.description, status: category.status })) }
    : parsedSchema
  const diagnostics: WikiMigrationDiagnostic[] = parsedSchema.valid || legacyRows.length > 0 ? [] : parsedSchema.diagnostics.map(item => ({ code: item.code, paths: ['SCHEMA.md'], message: item.message }))
  const categoryByDirectory = new Map(legacyRows.map(row => [row.directory.replace(/^wiki\//i, '').replace(/\/$/, '').toLowerCase(), stableCategoryId(row.name, row.directory)]))
  for (const category of categories) categoryByDirectory.set(category.categoryId.toLowerCase(), category.categoryId)
  const changes: NonNullable<WikiMigrationPreflightReport['changes']> = []
  const files: WikiMigrationPreflightReport['files'] = []
  const review: WikiMigrationPreflightReport['review'] = { indexNotes: [], unclassifiedIndexContent: [], readonlyLogArchives: [] }
  const pageIds = new Set<string>()
  for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const normalized = normalizeWikiRelativePath(file.path)
    const sha256 = sha(file.content)
    let kind: WikiMigrationPreflightReport['files'][number]['kind']
    if (/^(?:wiki\/)?index\.md$/i.test(normalized)) kind = 'legacy-index'
    else if (/^(?:wiki\/)?log\.md$/i.test(normalized)) kind = 'legacy-log'
    else if (normalized.toLowerCase().startsWith('raw/')) kind = 'raw'
    else if (/^wiki\/.+\.md$/i.test(normalized)) kind = 'page'
    else {
      diagnostics.push({ code: 'wiki-migration-unclassified-file', paths: [normalized], message: 'File cannot be classified as a page, index, log, or raw source.' })
      continue
    }
    files.push({ path: normalized, sha256, kind })
    if (kind === 'legacy-index') {
      const indexReview = reviewLegacyIndex(normalized, file.content)
      review.indexNotes.push(...indexReview.notes)
      review.unclassifiedIndexContent.push(...indexReview.unclassified)
      for (const note of indexReview.notes) {
        const targetPath = `wiki/migrated-notes/${slug(note.targetTitle)}.md`
        if (input.files.some(item => normalizeWikiRelativePath(item.path) === targetPath)) {
          diagnostics.push({ code: 'wiki-migration-index-note-target-conflict', paths: [normalized, targetPath], message: `A page already exists at ${targetPath}.` })
          continue
        }
        const pageId = `page-${sha(targetPath).slice(0, 20)}`
        const firstCategory = schema.valid ? schema.categories.find(category => category.status === 'active')?.id : undefined
        if (!firstCategory) { diagnostics.push({ code: 'wiki-migration-index-note-category-missing', paths: [normalized], message: 'No active category is available for the migrated index note.' }); continue }
        const body = `${serializeWikiPageMarker({ pageId, categoryId: firstCategory, summary: '', parentPageId: null, sourceRefs: [], revision: 1 })}\n# ${note.targetTitle}\n\n${note.content.trim()}\n`
        changes.push({ objectKind: 'index-note', relativePath: targetPath, oldHash: sha(''), newBytes: body })
      }
      if (indexReview.unclassified.length) diagnostics.push({ code: 'wiki-migration-index-content-unclassified', paths: [normalized], message: 'Some index content could not be safely classified as generated navigation or a note.' })
      continue
    }
    if (kind === 'legacy-log') {
      if (!file.content.trim()) continue
      const archivePath = `.wiki-service/migrations/history/${sha(normalized).slice(0, 12)}-${pathSafeBase(normalized)}`
      review.readonlyLogArchives.push({ sourcePath: normalized, archivePath, sha256 })
      changes.push({ objectKind: 'legacy-log-archive', relativePath: archivePath, oldHash: sha(''), newBytes: file.content })
      continue
    }
    if (kind === 'raw') continue
    const parsed = parseWikiPageMarker(file.content)
    if (parsed.marker) {
      if (!schema.valid || !schema.categories.some(category => category.id === parsed.marker!.categoryId && category.status === 'active')) {
        diagnostics.push({ code: 'wiki-migration-page-category-invalid', paths: [normalized], message: 'Page marker refers to a missing or inactive category.' })
        continue
      }
      if (pageIds.has(parsed.marker.pageId)) diagnostics.push({ code: 'wiki-migration-page-id-conflict', paths: [normalized], message: 'Page id is duplicated.' })
      pageIds.add(parsed.marker.pageId)
      continue
    }
    if (parsed.diagnostic !== 'wiki-page-marker-missing') {
      diagnostics.push({ code: 'wiki-migration-page-marker-invalid', paths: [normalized], message: 'Page marker exists but is invalid.' })
      continue
    }
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(file.content)?.[1]?.trim()
    if (!title) {
      diagnostics.push({ code: 'wiki-migration-title-missing', paths: [normalized], message: 'Markdown page has no first-level title.' })
      continue
    }
    const directoryCategory = normalized.split('/').slice(1, -1).join('/').toLowerCase()
    const categoryId = categoryByDirectory.get(directoryCategory) ?? (schema.valid ? schema.categories.find(category => category.status === 'active')?.id : undefined)
    if (!categoryId) {
      diagnostics.push({ code: 'wiki-migration-category-ambiguous', paths: [normalized], message: 'Page directory does not map to a unique active category.' })
      continue
    }
    const pageId = `page-${sha(normalized).slice(0, 20)}`
    const marker: WikiPageMarker = { pageId, categoryId, summary: '', parentPageId: null, sourceRefs: [], revision: 1 }
    const body = `${serializeWikiPageMarker(marker)}\n${file.content.replace(/^\s+/, '')}`
    changes.push({ objectKind: 'page', relativePath: normalized, oldHash: sha256, newBytes: body })
  }
  if (!parsedSchema.valid && legacyRows.length > 0) {
    const categoryBlock = `<!-- wiki-categories:start -->\n${JSON.stringify({ formatVersion: 1, categories: categories.map(({ categoryId, legacyName, description, status }) => ({ id: categoryId, name: legacyName, description, status })) }, null, 2)}\n<!-- wiki-categories:end -->`
    const rules = input.schema.replace(/^## 页面类型\s*$[\s\S]*?(?=^##\s|$(?!\n))/m, '').trim()
    const newBytes = `${rules}\n\n${categoryBlock}\n`
    changes.push({ objectKind: 'schema', relativePath: 'SCHEMA.md', oldHash: sha(input.schema), newBytes })
  }
  const pageTitles = new Map<string, string[]>()
  for (const file of input.files) {
    const normalized = file.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!/^wiki\/.+\.md$/i.test(normalized) || /^(?:wiki\/)?(?:index|log)\.md$/i.test(normalized)) continue
    const { body } = parseWikiPageMarker(file.content)
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]
    if (!title) continue
    const key = normalizeTitle(title)
    pageTitles.set(key, [...(pageTitles.get(key) ?? []), normalized])
  }
  for (const note of review.indexNotes) {
    const targetPath = `wiki/migrated-notes/${slug(note.targetTitle)}.md`
    const key = normalizeTitle(note.targetTitle)
    pageTitles.set(key, [...(pageTitles.get(key) ?? []), targetPath])
  }
  for (const paths of pageTitles.values()) if (paths.length > 1) diagnostics.push({ code: 'wiki-migration-title-conflict', paths: paths.sort(), message: 'Pages have the same normalized title and require an explicit resolution.' })
  // Stage service-owned projections in the migration journal so it can back up the
  // exact legacy bytes and atomically verify the new generated views with other changes.
  const projectionPages: WikiProjectionPage[] = []
  const migratedPageByPath = new Map(changes.filter(change => change.objectKind === 'page' || change.objectKind === 'index-note').map(change => [change.relativePath, change.newBytes]))
  for (const file of input.files) {
    const normalized = normalizeWikiRelativePath(file.path)
    if (!/^wiki\/.+\.md$/i.test(normalized) || /^(?:wiki\/)?(?:index|log)\.md$/i.test(normalized)) continue
    const content = migratedPageByPath.get(normalized) ?? file.content
    const { marker, body } = parseWikiPageMarker(content)
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim()
    if (!marker || !title) continue
    projectionPages.push({ pageId: marker.pageId, title, categoryId: marker.categoryId, summary: marker.summary, path: normalized, revision: marker.revision, parentPageId: marker.parentPageId })
  }
  for (const change of changes.filter(item => item.objectKind === 'index-note')) {
    const { marker, body } = parseWikiPageMarker(change.newBytes)
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim()
    if (marker && title) projectionPages.push({ pageId: marker.pageId, title, categoryId: marker.categoryId, summary: marker.summary, path: change.relativePath, revision: marker.revision, parentPageId: marker.parentPageId })
  }
  for (const [relativePath, objectKind, newBytes] of [
    ['wiki/index.md', 'index-projection', buildWikiIndex(projectionPages)],
    ['wiki/log.md', 'log-projection', buildWikiLog([])],
  ] as const) {
    const existing = input.files.find(file => normalizeWikiRelativePath(file.path) === relativePath)
    if (existing) changes.push({ objectKind, relativePath, oldHash: sha(existing.content), newBytes })
  }
  const manifestHash = sha(JSON.stringify({ files: files.map(({ path, sha256 }) => [path, sha256]), changes: changes.map(({ relativePath, oldHash, newBytes }) => [relativePath, oldHash, sha(newBytes)]), review }))
  return { categories, files, diagnostics, manifestHash, writesFiles: false, changes, review }
}

/** Read-only scan; follows no symlink and accepts no caller-provided absolute paths. */
export async function scanWikiMigrationPreflight(store: WikiFileStore): Promise<WikiMigrationPreflightReport> {
  const files: Array<{ path: string; content: string }> = []
  const diagnostics: WikiMigrationDiagnostic[] = []
  const schema = await store.readText('SCHEMA.md').catch(() => '')
  for (const top of ['wiki', 'raw']) {
    const visit = async (relative: string): Promise<void> => {
      const absolute = store.absolutePath(relative)
      let directoryInfo
      try { directoryInfo = await lstat(absolute) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        diagnostics.push({ code: 'wiki-migration-directory-rejected', paths: [relative], message: 'Wiki paths must be real directories during migration preflight.' })
        return
      }
      let entries
      try { entries = await readdir(absolute, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${relative}/${entry.name}`
        const childAbs = store.absolutePath(child)
        const metadata = await lstat(childAbs)
        if (metadata.isSymbolicLink()) {
          diagnostics.push({ code: 'wiki-migration-symlink-rejected', paths: [child], message: 'Symbolic links are not followed during migration preflight.' })
        } else if (metadata.isDirectory()) await visit(child)
        else if (metadata.isFile()) files.push({ path: child, content: await store.readText(child) })
        else diagnostics.push({ code: 'wiki-migration-special-file-rejected', paths: [child], message: 'Non-regular filesystem entries cannot be migrated.' })
      }
    }
    await visit(top)
  }
  const report = buildWikiMigrationPreflight({ schema, files })
  return { ...report, diagnostics: [...diagnostics, ...report.diagnostics], manifestHash: sha(JSON.stringify([report.manifestHash, diagnostics])) }
}

function reviewLegacyIndex(sourcePath: string, content: string): { notes: Array<{ sourcePath: string; targetTitle: string; content: string }>; unclassified: Array<{ sourcePath: string; content: string }> } {
  const lines = content.split(/\r?\n/)
  const notes: Array<{ sourcePath: string; targetTitle: string; content: string }> = []
  const unclassified: Array<{ sourcePath: string; content: string }> = []
  let heading = ''
  let block: string[] = []
  const flush = () => {
    const text = block.join('\n').trim()
    if (!text) { block = []; return }
    const generated = /^[-*]\s+\[[^\]]+\]\([^)]*\.md\)\s*$/m.test(text) || /^(?:（暂无）|\(none\))$/i.test(text) || /^>\s*(?:由|generated|auto)/i.test(text)
    if (generated) { block = []; return }
    if (heading && !/^\|/.test(text) && !/^>\s*(?:由|generated|auto)/i.test(text)) notes.push({ sourcePath, targetTitle: `Wiki 旧索引说明（${heading}）`, content: text })
    else unclassified.push({ sourcePath, content: text })
    block = []
  }
  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) { flush(); heading = line.replace(/^#{1,3}\s+/, '').trim(); continue }
    if (!line.trim()) { flush(); continue }
    block.push(line)
  }
  flush()
  return { notes, unclassified }
}

function pathSafeBase(relativePath: string): string { return relativePath.split('/').at(-1)?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? 'log.md' }

function stableCategoryId(name: string, directory: string): string {
  const known = new Map([['wiki/entities/', 'entity'], ['wiki/concepts/', 'concept'], ['wiki/topics/', 'topic'], ['wiki/sources/', 'source'], ['wiki/queries/', 'query']])
  const legacy = known.get(directory.toLowerCase())
  if (legacy) return legacy
  const normalized = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const id = normalized || `category-${sha(name).slice(0, 8)}`
  return /^[a-z]/.test(id) ? id : `category-${id}`
}

function slug(value: string): string {
  const result = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category'
  return /^[a-z]/.test(result) ? result : `category-${result}`
}
function normalizeTitle(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') }
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
