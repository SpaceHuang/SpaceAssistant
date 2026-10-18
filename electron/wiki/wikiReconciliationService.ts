import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import type { WikiFileStore } from './wikiFileStore'
import { parseWikiSchema } from './wikiSchema'
import { parseWikiPageMarker, reconcileWikiFiles, serializeWikiPageMarker } from './wikiReconciler'
import { buildWikiIndex, buildWikiLog, type WikiSuccessEvent } from './wikiProjection'

export interface WikiReconciliationResult { pages: number; changed: number; tombstones: Array<{ pageId: string; path: string; revision: number; deleted: true }>; diagnostics: Array<{ code: string; path: string; pageId?: string; message: string }> }

/** Facts and reconciliation only; schema-invalid or incomplete history never mutates active files. */
export async function reconcileExternalWikiChanges(store: WikiFileStore): Promise<WikiReconciliationResult> {
  const schemaText = await store.readText('SCHEMA.md').catch(() => '')
  const schema = parseWikiSchema(schemaText)
  if (!schema.valid) return { pages: 0, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-schema-invalid', path: 'SCHEMA.md', message: 'SCHEMA must parse before external files can be reconciled.' }] }
  const schemaHash = hashText(schemaText)
  const schemaStateText = await store.readText('.wiki-service/schema-state.json').catch(() => undefined)
  let schemaState: { formatVersion: 1; schemaVersion: number; contentHash: string } | undefined
  if (schemaStateText !== undefined) {
    try {
      const value = JSON.parse(schemaStateText) as { formatVersion?: unknown; schemaVersion?: unknown; contentHash?: unknown }
      if (value.formatVersion !== 1 || !Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1 || typeof value.contentHash !== 'string') throw new Error('invalid')
      schemaState = value as { formatVersion: 1; schemaVersion: number; contentHash: string }
    } catch { return { pages: 0, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-schema-state-invalid', path: '.wiki-service/schema-state.json', message: 'Schema state is invalid.' }] } }
  }
  const files: Array<{ path: string; content: string }> = []
  const diagnostics: WikiReconciliationResult['diagnostics'] = []
  const visit = async (relative: string): Promise<void> => {
    const absolute = store.absolutePath(relative)
    let directoryInfo
    try { directoryInfo = await lstat(absolute) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      diagnostics.push({ code: 'wiki-path-symlink', path: relative, message: 'Wiki directories must be real directories during reconciliation.' })
      return
    }
    let entries
    try { entries = await readdir(absolute, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`
      const childAbsolute = store.absolutePath(child)
      const info = await lstat(childAbsolute)
      if (info.isSymbolicLink()) diagnostics.push({ code: 'wiki-path-symlink', path: child, message: 'Symlinks are not followed during Wiki reconciliation.' })
      else if (info.isDirectory()) await visit(child)
      else if (info.isFile() && /^wiki\/.+\.md$/i.test(child) && !/^wiki\/(?:index|log)\.md$/i.test(child)) files.push({ path: child, content: await store.readText(child) })
      else if (!info.isFile()) diagnostics.push({ code: 'wiki-path-special-file', path: child, message: 'Only regular files can be reconciled.' })
    }
  }
  await visit('wiki')
  const catalog = await store.readCatalog() ?? { formatVersion: 1 as const, pages: [] }
  const reconciled = reconcileWikiFiles(files, catalog.pages.map(page => ({ pageId: page.pageId, path: page.path, revision: page.revision ?? 1, contentHash: page.contentHash ?? '' })), schema)
  diagnostics.push(...reconciled.diagnostics)
  if (diagnostics.length) return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics }

  if (schemaState && schemaState.contentHash !== schemaHash) {
    try {
      const previous = await store.read(`.wiki-service/schema-history/${schemaState.schemaVersion}.md`)
      if (hashText(previous.toString('utf8')) !== schemaState.contentHash) throw new Error('hash-mismatch')
    } catch { return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-schema-history-missing', path: 'SCHEMA.md', message: 'Previous schema snapshot is missing or invalid; external schema change is preserved for manual recovery.' }] } }
  }
  const nextSchemaState = schemaState
    ? schemaState.contentHash === schemaHash ? schemaState : { formatVersion: 1 as const, schemaVersion: schemaState.schemaVersion + 1, contentHash: schemaHash }
    : { formatVersion: 1 as const, schemaVersion: 1, contentHash: schemaHash }
  if (!schemaState && !(await store.identity('.wiki-service/schema-history/1.md'))) await store.writeImmutable('.wiki-service/schema-history/1.md', schemaText)
  if (schemaState && schemaState.contentHash !== schemaHash && !(await store.identity(`.wiki-service/schema-history/${nextSchemaState.schemaVersion}.md`))) {
    await store.writeImmutable(`.wiki-service/schema-history/${nextSchemaState.schemaVersion}.md`, schemaText)
  }
  await store.write('.wiki-service/schema-state.json', `${JSON.stringify(nextSchemaState, null, 2)}\n`)

  const changedPages = reconciled.pages.filter(page => page.externalEdit)
  const updatedBodies = new Map<string, string>()
  for (const page of changedPages) {
    const old = catalog.pages.find(item => item.pageId === page.pageId)
    if (!old) continue
    try { await store.read(`.wiki-service/page-history/${page.pageId}/${old.revision ?? 1}.md`) }
    catch { diagnostics.push({ code: 'wiki-history-missing', path: page.path, pageId: page.pageId, message: 'Previous page snapshot is missing; external change is preserved for manual recovery.' }) }
  }
  if (diagnostics.length) return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics }

  for (const page of changedPages) {
    const source = files.find(file => file.path === page.path)!
    const parsed = parseWikiPageMarker(source.content)
    if (!parsed.marker) continue
    const marker = serializeWikiPageMarker({ ...parsed.marker, revision: page.revision })
    const updated = `${marker}\n${parsed.body.replace(/^\s+/, '')}`
    updatedBodies.set(page.path, updated)
    const historyPath = `.wiki-service/page-history/${page.pageId}/${page.revision}.md`
    if (!(await store.identity(historyPath))) await store.writeImmutable(historyPath, Buffer.from(updated))
    const identity = await store.identity(page.path)
    if (!identity) return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-target-changed', path: page.path, pageId: page.pageId, message: 'Page disappeared during reconciliation.' }] }
    await store.write(page.path, updated, identity)
  }
  const pages = reconciled.pages.map(page => ({
    pageId: page.pageId, path: page.path, revision: page.revision, contentHash: hashText(updatedBodies.get(page.path) ?? files.find(file => file.path === page.path)!.content), title: page.title,
    categoryId: page.categoryId, summary: page.summary, parentPageId: page.parentPageId, sourceRefs: page.sourceRefs
  }))
  const tombstoneMap = new Map<string, NonNullable<typeof catalog.tombstones>[number]>([
    ...(catalog.tombstones ?? []).map(item => [item.pageId, item] as const),
    ...reconciled.tombstones.map(item => [item.pageId, item] as const)
  ])
  const nextCatalog = { formatVersion: 1 as const, pages, tombstones: [...tombstoneMap.values()] }
  await store.writeCatalog(nextCatalog)
  try {
    const operations = await readOperationEvents(store)
    await rebuildProjection(store, 'index', buildWikiIndex(pages.filter(page => page.title && page.categoryId).map(page => ({ pageId: page.pageId, path: page.path, revision: page.revision ?? 1, title: page.title!, categoryId: page.categoryId!, summary: page.summary, parentPageId: page.parentPageId }))))
    await rebuildProjection(store, 'log', buildWikiLog(operations))
  } catch (error) {
    return { pages: pages.length, changed: changedPages.length, tombstones: reconciled.tombstones, diagnostics: [{ code: 'wiki-projection-rebuild-failed', path: 'wiki/index.md', message: error instanceof Error ? error.message : String(error) }] }
  }
  return { pages: pages.length, changed: changedPages.length, tombstones: reconciled.tombstones, diagnostics: [] }
}

function hashText(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }

async function rebuildProjection(store: WikiFileStore, kind: 'index' | 'log', generated: string): Promise<void> {
  const target = `wiki/${kind}.md`
  const existing = await store.readText(target).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing === generated) return
  if (existing !== undefined) {
    const backup = `.wiki-service/projection-backups/${hashText(existing)}-${kind}.md`
    if (!(await store.identity(backup))) await store.writeImmutable(backup, existing)
    else if (hashText(await store.readText(backup)) !== hashText(existing)) throw new Error('wiki-projection-backup-conflict')
  }
  const identity = await store.identity(target)
  await store.write(target, generated, identity)
}

async function readOperationEvents(store: WikiFileStore): Promise<WikiSuccessEvent[]> {
  const dir = store.absolutePath('.wiki-service/operations')
  try {
    const directoryInfo = await lstat(dir)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('wiki-operation-directory-invalid')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  let names: string[]
  try { names = await readdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const events: WikiSuccessEvent[] = []
  for (const name of names.sort()) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) continue
    try {
      const operation = JSON.parse(await store.readText(`.wiki-service/operations/${name}`)) as { status?: unknown; successEvent?: unknown }
      const event = operation.successEvent
      if ((operation.status === 'domain_committed' || operation.status === 'completed') && event && typeof event === 'object' &&
        typeof (event as WikiSuccessEvent).operationId === 'string' && typeof (event as WikiSuccessEvent).type === 'string' &&
        typeof (event as WikiSuccessEvent).title === 'string' && Number.isSafeInteger((event as WikiSuccessEvent).revision) && typeof (event as WikiSuccessEvent).committedAt === 'string') events.push(event as WikiSuccessEvent)
    } catch { /* corrupt operation records never become success facts */ }
  }
  return events
}
