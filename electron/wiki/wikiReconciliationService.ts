import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'
import type { FileIdentity } from '../safeAtomicWrite'
import { parseWikiSchema } from './wikiSchema'
import { parseWikiPageMarker, reconcileWikiFiles, serializeWikiPageMarker } from './wikiReconciler'
import { buildWikiIndex, buildWikiLog, type WikiSuccessEvent } from './wikiProjection'
import { withWikiWriteMutex } from './wikiWriteMutex'
import { listPendingWikiOperationTargets } from './wikiDomainCoordinator'

export interface WikiReconciliationResult { pages: number; changed: number; tombstones: Array<{ pageId: string; path: string; revision: number; deleted: true }>; diagnostics: Array<{ code: string; path: string; pageId?: string; message: string }> }

/** Facts and reconciliation only; schema-invalid or incomplete history never mutates active files. */
export function reconcileExternalWikiChanges(store: WikiFileStore): Promise<WikiReconciliationResult> {
  return withWikiWriteMutex(path.join(store.root, '.wiki-domain-lock'), () => reconcileExternalWikiChangesLocked(store))
}

async function reconcileExternalWikiChangesLocked(store: WikiFileStore): Promise<WikiReconciliationResult> {
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
  let files: Array<{ path: string; content: string; identity: FileIdentity }> = []
  const diagnostics: WikiReconciliationResult['diagnostics'] = []
  const directorySnapshots = new Map<string, string[]>()
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
    directorySnapshots.set(relative, entries.map(entry => entry.name).sort((a, b) => a.localeCompare(b)))
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`
      const childAbsolute = store.absolutePath(child)
      const info = await lstat(childAbsolute)
      if (info.isSymbolicLink()) diagnostics.push({ code: 'wiki-path-symlink', path: child, message: 'Symlinks are not followed during Wiki reconciliation.' })
      else if (info.isDirectory()) await visit(child)
      else if (info.isFile() && /^wiki\/.+\.md$/i.test(child) && !/^wiki\/(?:index|log)\.md$/i.test(child)) {
        const before = await store.identity(child)
        const content = await store.readText(child)
        const identity = await store.identity(child)
        if (!before || !identity || !sameIdentity(before, identity)) {
          diagnostics.push({ code: 'wiki-target-changed', path: child, message: 'Page changed while reconciliation was scanning it.' })
          continue
        }
        files.push({ path: child, content, identity })
      }
      else if (!info.isFile()) diagnostics.push({ code: 'wiki-path-special-file', path: child, message: 'Only regular files can be reconciled.' })
    }
  }
  await visit('wiki')
  const catalog = await store.readCatalog() ?? { formatVersion: 1 as const, pages: [] }
  const observedFiles = files.map(file => ({ ...file }))
  const pendingByPath = new Map((await listPendingWikiOperationTargets(store)).map(operation => [operation.targetPath, operation]))
  const ignoredPendingCreates = new Set<string>()
  // Keep journal-owned bytes at their prior catalog baseline while still coordinating SCHEMA and unrelated external edits.
  for (const file of files) {
    const operation = pendingByPath.get(file.path)
    if (!operation || hashText(file.content) !== operation.newHash) continue
    const existing = catalog.pages.find(page => page.pageId === operation.pageId)
    if (existing && existing.path === operation.targetPath && existing.revision === operation.revision && existing.contentHash === operation.newHash) {
      continue
    }
    if (operation.oldHash === null) {
      if (existing) {
        diagnostics.push({ code: 'wiki-pending-operation-baseline-conflict', path: file.path, pageId: operation.pageId, message: 'Pending page creation conflicts with an existing catalog entry.' })
        continue
      }
      ignoredPendingCreates.add(file.path)
      continue
    }
    const previous = existing
    const previousRevision = operation.revision - 1
    if (!previous || previous.path !== operation.targetPath || previous.revision !== previousRevision || previous.contentHash !== operation.oldHash) {
      diagnostics.push({ code: 'wiki-pending-operation-baseline-conflict', path: file.path, pageId: operation.pageId, message: 'Pending page operation no longer matches its catalog baseline.' })
      continue
    }
    try {
      const previousText = await store.readText(`.wiki-service/page-history/${operation.pageId}/${previousRevision}.md`)
      if (hashText(previousText) !== operation.oldHash) throw new Error('history-hash-mismatch')
      file.content = previousText
    } catch {
      diagnostics.push({ code: 'wiki-pending-operation-history-missing', path: file.path, pageId: operation.pageId, message: 'Pending page operation has no verified prior snapshot.' })
    }
  }
  if (diagnostics.length) return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics }
  files = files.filter(file => !ignoredPendingCreates.has(file.path))
  const catalogIdentity = await store.identity('.wiki-service/catalog.json')
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
  const changedPages = reconciled.pages.filter(page => page.externalEdit)
  const newlyRegisteredPages = reconciled.pages.filter(page => !catalog.pages.some(item => item.pageId === page.pageId || item.path === page.path))
  const updatedBodies = new Map<string, string>()
  for (const page of changedPages) {
    const old = catalog.pages.find(item => item.pageId === page.pageId)
    if (!old) continue
    try { await store.read(`.wiki-service/page-history/${page.pageId}/${old.revision ?? 1}.md`) }
    catch { diagnostics.push({ code: 'wiki-history-missing', path: page.path, pageId: page.pageId, message: 'Previous page snapshot is missing; external change is preserved for manual recovery.' }) }
  }
  for (const page of newlyRegisteredPages) {
    const source = files.find(file => file.path === page.path)
    const parsed = source ? parseWikiPageMarker(source.content) : undefined
    if (!source || !parsed?.marker) {
      diagnostics.push({ code: 'wiki-page-marker-invalid', path: page.path, pageId: page.pageId, message: 'New page marker could not be read for its initial history snapshot.' })
      continue
    }
    const normalized = parsed.marker.revision === page.revision
      ? source.content
      : `${serializeWikiPageMarker({ ...parsed.marker, revision: page.revision })}\n${parsed.body.replace(/^\s+/, '')}`
    if (normalized !== source.content) updatedBodies.set(page.path, normalized)
    const historyPath = `.wiki-service/page-history/${page.pageId}/${page.revision}.md`
    if (await store.identity(historyPath)) {
      if (hashText(await store.readText(historyPath)) !== hashText(normalized)) {
        diagnostics.push({ code: 'wiki-history-conflict', path: page.path, pageId: page.pageId, message: 'An initial page history snapshot already exists with different content.' })
      }
    }
  }
  if (diagnostics.length) return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics }

  const latestCatalog = await store.readCatalog() ?? { formatVersion: 1 as const, pages: [] }
  if (!sameIdentity(catalogIdentity, await store.identity('.wiki-service/catalog.json')) || JSON.stringify(latestCatalog) !== JSON.stringify(catalog)) {
    return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-target-changed', path: '.wiki-service/catalog.json', message: 'Catalog changed after reconciliation scanned its snapshot.' }] }
  }
  for (const file of observedFiles) {
    const identity = await store.identity(file.path)
    if (!sameIdentity(file.identity, identity) || hashText(await store.readText(file.path)) !== hashText(file.content)) {
      return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-target-changed', path: file.path, message: 'Page changed after reconciliation scanned its snapshot.' }] }
    }
  }
  for (const [relative, names] of directorySnapshots) {
    let currentNames: string[]
    try { currentNames = (await readdir(store.absolutePath(relative))).sort((a, b) => a.localeCompare(b)) }
    catch { return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-target-changed', path: relative, message: 'Wiki directory changed after reconciliation scanned its snapshot.' }] } }
    if (JSON.stringify(currentNames) !== JSON.stringify(names)) {
      return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-target-changed', path: relative, message: 'Wiki directory changed after reconciliation scanned its snapshot.' }] }
    }
  }
  if (hashText(await store.readText('SCHEMA.md').catch(() => '')) !== schemaHash) {
    return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-target-changed', path: 'SCHEMA.md', message: 'Schema changed after reconciliation scanned its snapshot.' }] }
  }

  if (!schemaState && !(await store.identity('.wiki-service/schema-history/1.md'))) await store.writeImmutable('.wiki-service/schema-history/1.md', schemaText)
  if (schemaState && schemaState.contentHash !== schemaHash && !(await store.identity(`.wiki-service/schema-history/${nextSchemaState.schemaVersion}.md`))) {
    await store.writeImmutable(`.wiki-service/schema-history/${nextSchemaState.schemaVersion}.md`, schemaText)
  }
  await store.write('.wiki-service/schema-state.json', `${JSON.stringify(nextSchemaState, null, 2)}\n`)

  for (const page of changedPages) {
    const source = files.find(file => file.path === page.path)!
    const parsed = parseWikiPageMarker(source.content)
    if (!parsed.marker) continue
    let revision = page.revision
    let updated = serializeWikiPageMarker({ ...parsed.marker, revision }) + `\n${parsed.body.replace(/^\s+/, '')}`
    while (await store.identity(`.wiki-service/page-history/${page.pageId}/${revision}.md`)) {
      const existingSnapshot = await store.readText(`.wiki-service/page-history/${page.pageId}/${revision}.md`)
      if (hashText(existingSnapshot) === hashText(updated)) break
      revision += 1
      updated = serializeWikiPageMarker({ ...parsed.marker, revision }) + `\n${parsed.body.replace(/^\s+/, '')}`
    }
    page.revision = revision
    page.contentHash = hashText(updated)
    updatedBodies.set(page.path, updated)
    const historyPath = `.wiki-service/page-history/${page.pageId}/${page.revision}.md`
    if (!(await store.identity(historyPath))) await store.writeImmutable(historyPath, Buffer.from(updated))
    else if (hashText(await store.readText(historyPath)) !== hashText(updated)) {
      return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-history-conflict', path: page.path, pageId: page.pageId, message: 'An immutable revision snapshot already exists with different content.' }] }
    }
    const revisionMetadataPath = `.wiki-service/page-revision-metadata/${page.pageId}/${page.revision}.json`
    const revisionMetadata = { formatVersion: 1, pageId: page.pageId, revision: page.revision, externalEdit: true, changeSummary: `外部编辑：${page.title}` }
    const existingMetadata = await store.identity(revisionMetadataPath)
    if (!existingMetadata) await store.writeImmutable(revisionMetadataPath, `${JSON.stringify(revisionMetadata, null, 2)}\n`)
    else {
      try {
        const savedMetadata = JSON.parse(await store.readText(revisionMetadataPath)) as { pageId?: unknown; revision?: unknown; externalEdit?: unknown }
        if (savedMetadata.pageId !== page.pageId || savedMetadata.revision !== page.revision || savedMetadata.externalEdit !== true) throw new Error('wiki-revision-metadata-conflict')
      } catch { return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-revision-metadata-conflict', path: revisionMetadataPath, pageId: page.pageId, message: 'External revision metadata conflicts with the existing immutable record.' }] } }
    }
    const operationId = hashText(`${page.pageId}\0${page.revision}\0${hashText(source.content)}`)
    const operationPath = `.wiki-service/operations/${operationId}.json`
    const operationIdentity = await store.identity(operationPath)
    if (!operationIdentity) {
      const successEvent: WikiSuccessEvent = { operationId, type: 'externally_edited', title: page.title, revision: page.revision,
        committedAt: new Date(source.identity.mtimeMs).toISOString(), pageId: page.pageId, sourceIds: page.sourceRefs.map(sourceRef => sourceRef.sourceId), changeSummary: `外部编辑：${page.title}` }
      await store.writeImmutable(operationPath, `${JSON.stringify({ formatVersion: 1, operationId, status: 'completed', successEvent, externalEdit: true }, null, 2)}\n`)
    } else {
      try {
        const savedOperation = JSON.parse(await store.readText(operationPath)) as { operationId?: unknown; status?: unknown; successEvent?: { pageId?: unknown; revision?: unknown; type?: unknown } }
        if (savedOperation.operationId !== operationId || savedOperation.status !== 'completed' || savedOperation.successEvent?.pageId !== page.pageId || savedOperation.successEvent?.revision !== page.revision || savedOperation.successEvent?.type !== 'externally_edited') throw new Error('wiki-external-edit-journal-conflict')
      } catch { return { pages: catalog.pages.length, changed: 0, tombstones: [], diagnostics: [{ code: 'wiki-external-edit-journal-conflict', path: operationPath, pageId: page.pageId, message: 'External edit journal conflicts with the immutable revision record.' }] } }
    }
    await store.write(page.path, updated, source.identity)
  }
  for (const page of newlyRegisteredPages) {
    const source = files.find(file => file.path === page.path)!
    const snapshot = updatedBodies.get(page.path) ?? source.content
    const historyPath = `.wiki-service/page-history/${page.pageId}/${page.revision}.md`
    if (!(await store.identity(historyPath))) await store.writeImmutable(historyPath, Buffer.from(snapshot))
    if (snapshot !== source.content) await store.write(page.path, snapshot, source.identity)
  }
  const pages = reconciled.pages.map(page => ({
    pageId: page.pageId, path: page.path, revision: page.revision, contentHash: hashText(updatedBodies.get(page.path) ?? files.find(file => file.path === page.path)!.content), title: page.title,
    categoryId: page.categoryId, summary: page.summary, parentPageId: page.parentPageId, sourceRefs: page.sourceRefs
  }))
  const aliasMap = new Map((catalog.pathAliases ?? []).map(alias => [alias.path, alias.pageId]))
  for (const page of pages) {
    const previous = catalog.pages.find(item => item.pageId === page.pageId)
    if (previous && previous.path !== page.path) aliasMap.set(previous.path, page.pageId)
  }
  for (const [aliasPath, pageId] of aliasMap) {
    if (pages.some(page => page.pageId === pageId && page.path === aliasPath)) aliasMap.delete(aliasPath)
  }
  const pathAliases = [...aliasMap].map(([aliasPath, pageId]) => ({ path: aliasPath, pageId })).sort((a, b) => a.path.localeCompare(b.path) || a.pageId.localeCompare(b.pageId))
  const tombstoneMap = new Map<string, NonNullable<typeof catalog.tombstones>[number]>([
    ...(catalog.tombstones ?? []).map(item => [item.pageId, item] as const),
    ...reconciled.tombstones.map(item => [item.pageId, item] as const)
  ])
  const nextCatalog = { formatVersion: 1 as const, pages, tombstones: [...tombstoneMap.values()], pathAliases }
  await store.write('.wiki-service/catalog.json', `${JSON.stringify(nextCatalog, null, 2)}\n`, catalogIdentity)
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

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  if (left === null || right === null) return left === right
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink
}

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
