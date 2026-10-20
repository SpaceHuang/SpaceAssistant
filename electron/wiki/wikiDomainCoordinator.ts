import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'
import type { FileIdentity } from '../safeAtomicWrite'
import { createWikiWriteService } from './wikiWriteService'
import { serializeWikiPageMarker } from './wikiReconciler'
import { buildWikiIndex, buildWikiLog, type WikiProjectionPage, type WikiSuccessEvent } from './wikiProjection'
import { withWikiWriteMutex } from './wikiWriteMutex'

export interface WikiDomainSchema { schemaVersion: number; categories: Array<{ id: string; name: string; status: 'active' | 'deprecated'; allowedParentCategoryIds?: string[] }> }
export interface WikiSavePageInput {
  requestId: string; toolUseId: string; callerId: string; lane: string
  pageId?: string; title: string; categoryId: string; summary: string; markdown: string
  schemaVersion: number; expectedRevision?: number; parentPageId?: string | null
  sourceRefs?: Array<{ sourceId: string; sourceRevision: number }>; operationKind?: 'saved' | 'moved' | 'restored'; crashAt?: 'after-target-write' | 'after-domain-commit' | 'after-log-write'
}
export interface WikiSavePageResult { pageId: string; revision: number; projectionStatus: 'complete'; operationId: string }
export interface WikiDomainCoordinator {
  savePage(input: WikiSavePageInput): Promise<WikiSavePageResult>
  movePage(input: WikiSavePageInput & { pageId: string; expectedRevision: number; parentPageId: string | null }): Promise<WikiSavePageResult>
}
interface OperationJournal {
  formatVersion: 1; operationId: string; inputFingerprint: string; callerId: string; lane: string; status: 'prepared' | 'domain_committed' | 'completed' | 'conflict'
  targetPath: string; oldHash: string | null; newHash: string; stagingPath: string; result: WikiSavePageResult; eventMaterial: WikiSuccessEvent; successEvent?: WikiSuccessEvent; errorCode?: string
}

export function createWikiDomainCoordinator(options: { store: WikiFileStore; schema: () => WikiDomainSchema; now?: () => Date; beforeProjection?: (projection: 'index' | 'log') => void | Promise<void> }): WikiDomainCoordinator {
  const writeService = createWikiWriteService(options.store)
  const now = options.now ?? (() => new Date())
  return { savePage(input: WikiSavePageInput): Promise<WikiSavePageResult> {
    return withWikiWriteMutex(path.join(options.store.root, '.wiki-domain-lock'), () => savePage(input))
  }, movePage(input: WikiSavePageInput & { pageId: string; expectedRevision: number; parentPageId: string | null }): Promise<WikiSavePageResult> {
    return withWikiWriteMutex(path.join(options.store.root, '.wiki-domain-lock'), () => savePage({ ...input, operationKind: 'moved' }))
  } }

  async function savePage(input: WikiSavePageInput): Promise<WikiSavePageResult> {
    const invocationKey = sha(`${input.requestId}\0${input.toolUseId}`)
    const operationPath = `.wiki-service/operations/${invocationKey}.json`
    const fingerprint = sha(stableJson({ ...input, crashAt: undefined }))
    const existing = await readJournal(options.store, operationPath)
    if (existing) {
      if (existing.inputFingerprint !== fingerprint || existing.callerId !== input.callerId || existing.lane !== input.lane) throw codedError('idempotency_conflict')
      if (existing.status === 'completed') return existing.result
      if (existing.status === 'conflict') throw codedError(existing.errorCode ?? 'external_change_conflict')
      return recover(existing, operationPath, input.crashAt)
    }

    const catalog = await options.store.readCatalog() ?? { formatVersion: 1 as const, pages: [] }
    const schema = options.schema()
    if (schema.schemaVersion !== input.schemaVersion) throw codedError('schema_conflict')
    const category = schema.categories.find(item => item.id === input.categoryId && item.status === 'active')
    if (!category) throw codedError('category_invalid')
    const existingPage = input.pageId ? catalog.pages.find(page => page.pageId === input.pageId) : undefined
    const tombstone = input.operationKind === 'restored' && input.pageId ? catalog.tombstones?.find(page => page.pageId === input.pageId) : undefined
    if (input.pageId && !existingPage && !tombstone) throw codedError('page_not_found')
    if (existingPage && existingPage.revision !== input.expectedRevision) throw codedError('revision_conflict')
    if (!existingPage && input.expectedRevision !== undefined && (!tombstone || tombstone.revision !== input.expectedRevision)) throw codedError('revision_conflict')
    const parentPageId = input.parentPageId !== undefined ? input.parentPageId : existingPage?.parentPageId ?? null
    if (parentPageId && !catalog.pages.some(page => page.pageId === parentPageId)) throw codedError('parent_invalid')
    if (category.allowedParentCategoryIds && parentPageId) {
      const parent = catalog.pages.find(page => page.pageId === parentPageId)
      if (!category.allowedParentCategoryIds.includes(parent?.categoryId ?? '')) throw codedError('parent_invalid')
    }
    if (parentPageId && existingPage?.pageId === parentPageId) throw codedError('parent_invalid')
    if (parentPageId && isDescendant(catalog.pages, parentPageId, existingPage?.pageId ?? '')) throw codedError('parent_invalid')
    const titleKey = normalizeTitle(input.title)
    if (catalog.pages.some(page => page.pageId !== existingPage?.pageId && page.categoryId === input.categoryId && (page.parentPageId ?? null) === parentPageId && normalizeTitle(page.title ?? '') === titleKey)) throw codedError('title_conflict')
    const pageId = existingPage?.pageId ?? input.pageId ?? randomUUID()
    const revision = (existingPage?.revision ?? tombstone?.revision ?? 0) + 1
    const relPath = existingPage?.path ?? tombstone?.path ?? `wiki/${slug(input.title)}-${pageId.slice(0, 8)}.md`
    const marker = serializeWikiPageMarker({ pageId, categoryId: input.categoryId, summary: input.summary, parentPageId, sourceRefs: input.sourceRefs ?? [], revision })
    const pageBody = `${marker}\n# ${input.title.trim()}\n\n${input.markdown.trimEnd()}\n`
    const bytes = Buffer.from(pageBody)
    const oldSnapshot = existingPage ? await writeService.read(existingPage.path) : undefined
    const result: WikiSavePageResult = { pageId, revision, projectionStatus: 'complete', operationId: invocationKey }
    const event: WikiSuccessEvent = { operationId: invocationKey, type: input.operationKind ?? (existingPage ? 'saved' : 'created'), title: input.title.trim(), revision, committedAt: now().toISOString() }
    const journal: OperationJournal = { formatVersion: 1, operationId: invocationKey, inputFingerprint: fingerprint, callerId: input.callerId, lane: input.lane, status: 'prepared', targetPath: relPath, oldHash: oldSnapshot?.sha256 ?? null, newHash: sha(bytes), stagingPath: `.wiki-service/staging/${invocationKey}.payload`, result, eventMaterial: event }
    await options.store.write(journal.stagingPath, bytes)
    await options.store.write(operationPath, json(journal))
    if (oldSnapshot) await writeSnapshotIfMissing(options.store, `.wiki-service/page-history/${pageId}/${existingPage!.revision}.md`, oldSnapshot.bytes)
    await writeService.write(relPath, bytes, oldSnapshot?.identity ?? null)
    if (input.crashAt === 'after-target-write') throw new Error('injected crash after target write')
    return finishDomainCommit(journal, operationPath, catalog, input, input.crashAt)
  }

  async function recover(journal: OperationJournal, operationPath: string, crashAt?: WikiSavePageInput['crashAt']): Promise<WikiSavePageResult> {
    if (journal.status === 'prepared') {
      const staged = await options.store.read(journal.stagingPath)
      if (sha(staged) !== journal.newHash) throw codedError('operation_pending')
      const current = await options.store.identity(journal.targetPath)
      const currentBytes = current ? await options.store.read(journal.targetPath) : null
      const currentHash = currentBytes ? sha(currentBytes) : null
      if (currentHash === journal.oldHash) {
        await writeService.write(journal.targetPath, staged, current)
      } else if (currentHash !== journal.newHash) {
        journal.status = 'conflict'; journal.errorCode = 'external_change_conflict'
        await options.store.write(operationPath, json(journal))
        throw codedError('external_change_conflict')
      }
      if (crashAt === 'after-target-write') throw new Error('injected crash after target write')
    }
    journal.status = 'domain_committed'
    journal.successEvent ??= journal.eventMaterial
    await options.store.write(operationPath, json(journal))
    if (crashAt === 'after-domain-commit') throw new Error('injected crash after domain commit')
    const catalog = await options.store.readCatalog() ?? { formatVersion: 1 as const, pages: [] }
    const staged = await options.store.read(journal.stagingPath)
    const decoded = parsePage(staged.toString('utf8'))
    const existing = catalog.pages.find(page => page.pageId === journal.result.pageId)
    const hasInvalidParent = decoded.parentPageId === journal.result.pageId || Boolean(decoded.parentPageId &&
      (existing?.revision ?? 0) <= journal.result.revision && isDescendant(catalog.pages, decoded.parentPageId, journal.result.pageId))
    if (hasInvalidParent && existing) {
      const current = await options.store.read(journal.targetPath)
      if (sha(current) === journal.newHash) {
        const previous = await options.store.read(`.wiki-service/page-history/${existing.pageId}/${existing.revision ?? 1}.md`)
        const identity = await options.store.identity(journal.targetPath)
        if (!identity) throw codedError('external_change_conflict')
        await writeService.write(journal.targetPath, previous, identity)
      }
      journal.status = 'conflict'
      journal.errorCode = 'parent_invalid'
      await options.store.write(operationPath, json(journal))
      throw codedError('parent_invalid')
    }
    if (existing && (existing.revision ?? 1) > journal.result.revision) {
      const current = await options.store.read(existing.path)
      if (sha(current) !== existing.contentHash) throw codedError('external_change_conflict')
    } else {
      const target = await options.store.read(journal.targetPath)
      if (sha(target) !== journal.newHash) throw codedError('external_change_conflict')
      if (existing && (existing.revision ?? 1) === journal.result.revision && existing.contentHash !== journal.newHash) throw codedError('external_change_conflict')
      const page = { pageId: journal.result.pageId, path: journal.targetPath, revision: journal.result.revision, contentHash: journal.newHash, title: decoded.title, categoryId: decoded.categoryId, summary: decoded.summary, parentPageId: decoded.parentPageId }
      const nextCatalog = { formatVersion: 1 as const, pages: [...catalog.pages.filter(item => item.pageId !== page.pageId), page], tombstones: (catalog.tombstones ?? []).filter(item => item.pageId !== page.pageId) }
      await options.store.writeCatalog(nextCatalog)
    }
    await writeSnapshotIfMissing(options.store, `.wiki-service/page-history/${journal.result.pageId}/${journal.result.revision}.md`, staged)
    const projectionCatalog = await options.store.readCatalog() ?? catalog
    const ops = await listOperations(options.store)
    const events = ops.filter(op => op.status === 'domain_committed' || op.status === 'completed').flatMap(op => op.successEvent ? [op.successEvent] : [])
    const index = buildWikiIndex(projectionCatalog.pages.filter(item => item.title && item.categoryId) as WikiProjectionPage[])
    const log = buildWikiLog(events)
    try {
      await options.beforeProjection?.('index')
      await options.store.write('wiki/index.md', index)
      await options.beforeProjection?.('log')
      await options.store.write('wiki/log.md', log)
    } catch {
      throw Object.assign(codedError('projection_pending'), { operationId: journal.operationId })
    }
    if (crashAt === 'after-log-write') throw new Error('injected crash after log write')
    journal.status = 'completed'
    await options.store.write(operationPath, json(journal))
    await options.store.remove(journal.stagingPath)
    return { ...journal.result, projectionStatus: 'complete' }
  }

  async function finishDomainCommit(journal: OperationJournal, operationPath: string, catalog: NonNullable<Awaited<ReturnType<typeof options.store.readCatalog>>>, input: WikiSavePageInput, crashAt?: WikiSavePageInput['crashAt']) {
    journal.status = 'domain_committed'
    journal.successEvent ??= journal.eventMaterial
    await options.store.write(operationPath, json(journal))
    if (crashAt === 'after-domain-commit') throw new Error('injected crash after domain commit')
    return recover(journal, operationPath, crashAt)
  }
}

async function readJournal(store: WikiFileStore, relPath: string): Promise<OperationJournal | undefined> {
  try { return JSON.parse(await store.readText(relPath)) as OperationJournal }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
async function writeSnapshotIfMissing(store: WikiFileStore, relPath: string, body: Buffer): Promise<void> {
  try {
    const existing = await store.read(relPath)
    if (sha(existing) !== sha(body)) throw codedError('external_change_conflict')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await store.writeImmutable(relPath, body)
  }
}
async function listOperations(store: WikiFileStore): Promise<OperationJournal[]> {
  const dir = store.absolutePath('.wiki-service/operations')
  let names: string[]
  try { names = await readdir(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const results: OperationJournal[] = []
  for (const name of names.sort()) if (name.endsWith('.json')) { try { results.push(JSON.parse(await readFile(path.join(dir, name), 'utf8')) as OperationJournal) } catch { /* corrupt operation is excluded from success projection */ } }
  return results
}
function parsePage(text: string) {
  const match = /<!-- wiki-page:start -->\n(.*?)\n<!-- wiki-page:end -->\n# (.+?)\n\n/s.exec(text)
  if (!match) throw codedError('wiki-page-marker-invalid')
  const marker = JSON.parse(match[1]) as { categoryId: string; summary: string; parentPageId: string | null }
  return { title: match[2], categoryId: marker.categoryId, summary: marker.summary, parentPageId: marker.parentPageId }
}
function normalizeTitle(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') }
function isDescendant(pages: Array<{ pageId: string; parentPageId?: string | null }>, candidateId: string, ancestorId: string): boolean {
  if (!ancestorId) return false
  if (candidateId === ancestorId) return true
  let current = pages.find(page => page.pageId === candidateId)
  const visited = new Set<string>()
  while (current?.parentPageId) {
    if (current.parentPageId === ancestorId) return true
    if (visited.has(current.pageId)) return true
    visited.add(current.pageId)
    current = pages.find(page => page.pageId === current!.parentPageId)
  }
  return false
}
function slug(value: string): string { return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page' }
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function stableJson(value: unknown): string { return JSON.stringify(canonical(value)) }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function codedError(code: string): Error { return Object.assign(new Error(code), { code }) }
