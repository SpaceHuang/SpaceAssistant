import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'
import type { FileIdentity } from '../safeAtomicWrite'
import { createWikiWriteService } from './wikiWriteService'
import { parseWikiPageMarker, serializeWikiPageMarker } from './wikiReconciler'
import { buildWikiIndex, buildWikiLog, type WikiProjectionPage, type WikiSuccessEvent } from './wikiProjection'
import { withWikiWriteMutex } from './wikiWriteMutex'

export interface WikiDomainSchema { schemaVersion: number; categories: Array<{ id: string; name: string; status: 'active' | 'deprecated'; allowedParentCategoryIds?: string[] }> }
export interface WikiSavePageInput {
  requestId: string; toolUseId: string; callerId: string; lane: string
  pageId?: string; title: string; categoryId: string; summary: string; markdown: string
  schemaVersion: number; expectedRevision?: number; parentPageId?: string | null
  sourceRefs?: Array<{ sourceId: string; sourceRevision: number }>; operationKind?: 'saved' | 'moved' | 'restored'; crashAt?: 'after-target-write' | 'after-domain-commit' | 'after-log-write'
  moveRequestFingerprint?: string
}
export interface WikiSavePageResult { pageId: string; revision: number; projectionStatus: 'complete'; operationId: string }
export interface WikiDomainCoordinator {
  savePage(input: WikiSavePageInput): Promise<WikiSavePageResult>
  movePage(input: WikiSavePageInput & { pageId: string; expectedRevision: number; parentPageId: string | null }): Promise<WikiSavePageResult>
}

export interface PendingWikiOperationTarget { targetPath: string; stagingPath: string; newHash: string; oldHash: string | null; pageId: string; revision: number; status: 'prepared' | 'domain_committed' }

export interface WikiMoveRequestIdentity { requestId: string; toolUseId: string; callerId: string; lane: string; pageId: string; expectedRevision: number; parentPageId: string | null }

export async function replayCompletedWikiMove(store: WikiFileStore, identity: WikiMoveRequestIdentity): Promise<WikiSavePageResult | undefined> {
  const operationId = sha(`${identity.requestId}\0${identity.toolUseId}`)
  const journal = await readJournal(store, `.wiki-service/operations/${operationId}.json`)
  if (!journal?.moveRequestFingerprint) return undefined
  if (journal.formatVersion !== 1 || journal.operationId !== operationId || journal.eventMaterial?.type !== 'moved' ||
    journal.result?.operationId !== operationId || journal.moveRequestFingerprint !== wikiMoveRequestFingerprint(identity) ||
    journal.callerId !== identity.callerId || journal.lane !== identity.lane) {
    throw codedError('idempotency_conflict')
  }
  if (journal.status === 'completed') return journal.result
  if (journal.status === 'conflict') throw codedError(journal.errorCode ?? 'external_change_conflict')
  return undefined
}

export function wikiMoveRequestFingerprint(identity: Pick<WikiMoveRequestIdentity, 'pageId' | 'expectedRevision' | 'parentPageId'>): string {
  return sha(stableJson({ pageId: identity.pageId, expectedRevision: identity.expectedRevision, parentPageId: identity.parentPageId }))
}

export async function listPendingWikiOperationTargets(store: WikiFileStore): Promise<PendingWikiOperationTarget[]> {
  const directory = store.absolutePath('.wiki-service/operations')
  let names: string[]
  try { names = await readdir(directory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const targets: PendingWikiOperationTarget[] = []
  for (const name of names.sort()) {
    if (!/^[0-9a-f]{64}\.json$/i.test(name)) continue
    const operationId = name.slice(0, -5)
    const journal = await readJournal(store, `.wiki-service/operations/${name}`)
    if (journal?.formatVersion !== 1 || journal.operationId !== operationId || !['prepared', 'domain_committed'].includes(journal.status) ||
      !/^wiki\/.+\.md$/i.test(journal.targetPath) || !/^[0-9a-f]{64}$/i.test(journal.newHash) ||
      journal.stagingPath !== `.wiki-service/staging/${operationId}.payload` ||
      !(journal.oldHash === null || /^[0-9a-f]{64}$/i.test(journal.oldHash)) || journal.result?.operationId !== operationId ||
      typeof journal.result.pageId !== 'string' || !Number.isSafeInteger(journal.result.revision) || journal.result.revision < 1) continue
    targets.push({ targetPath: journal.targetPath, stagingPath: journal.stagingPath, newHash: journal.newHash, oldHash: journal.oldHash, pageId: journal.result.pageId, revision: journal.result.revision, status: journal.status as 'prepared' | 'domain_committed' })
  }
  return targets
}

interface OperationJournal {
  formatVersion: 1; operationId: string; inputFingerprint: string; callerId: string; lane: string; schemaVersion?: number; status: 'prepared' | 'domain_committed' | 'completed' | 'conflict'
  moveRequestFingerprint?: string
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
    const legacyInput = { ...input }
    delete legacyInput.moveRequestFingerprint
    const legacyFingerprint = sha(stableJson({ ...legacyInput, crashAt: undefined }))
    const existing = await readJournal(options.store, operationPath)
    if (existing) {
      const sameMoveRequest = input.moveRequestFingerprint !== undefined && existing.moveRequestFingerprint === input.moveRequestFingerprint
      const sameLegacyInput = existing.moveRequestFingerprint === undefined && existing.inputFingerprint === legacyFingerprint
      if ((!sameMoveRequest && !sameLegacyInput && existing.inputFingerprint !== fingerprint) || existing.callerId !== input.callerId || existing.lane !== input.lane) throw codedError('idempotency_conflict')
      if (existing.status === 'completed') return existing.result
      if (existing.status === 'conflict') throw codedError(existing.errorCode ?? 'external_change_conflict')
      return recover(existing, operationPath, input.crashAt)
    }
    for (const source of input.sourceRefs ?? []) {
      try { await options.store.read(`.wiki-service/source-history/${source.sourceId}/${source.sourceRevision}.md`) }
      catch { throw codedError('source_missing') }
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
    const proposedPage = { pageId, path: existingPage?.path ?? tombstone?.path ?? '', revision: (existingPage?.revision ?? tombstone?.revision ?? 0) + 1,
      title: input.title.trim(), categoryId: input.categoryId, summary: input.summary, parentPageId }
    validateActivePageSet([...catalog.pages.filter(page => page.pageId !== pageId), proposedPage], schema, pageId)
    const revision = (existingPage?.revision ?? tombstone?.revision ?? 0) + 1
    const relPath = existingPage?.path ?? tombstone?.path ?? `wiki/${slug(input.title)}-${pageId.slice(0, 8)}.md`
    const marker = serializeWikiPageMarker({ pageId, categoryId: input.categoryId, summary: input.summary, parentPageId, sourceRefs: input.sourceRefs ?? [], revision })
    const pageBody = `${marker}\n# ${input.title.trim()}\n\n${input.markdown.trimEnd()}\n`
    const bytes = Buffer.from(pageBody)
    const oldSnapshot = existingPage ? await writeService.read(existingPage.path) : undefined
    const result: WikiSavePageResult = { pageId, revision, projectionStatus: 'complete', operationId: invocationKey }
    const event: WikiSuccessEvent = { operationId: invocationKey, type: input.operationKind ?? (existingPage ? 'saved' : 'created'), title: input.title.trim(), revision, committedAt: now().toISOString(), pageId, sourceIds: (input.sourceRefs ?? []).map(source => source.sourceId), changeSummary: input.summary }
    const journal: OperationJournal = { formatVersion: 1, operationId: invocationKey, inputFingerprint: fingerprint, callerId: input.callerId, lane: input.lane, schemaVersion: schema.schemaVersion, status: 'prepared', targetPath: relPath, oldHash: oldSnapshot?.sha256 ?? null, newHash: sha(bytes), stagingPath: `.wiki-service/staging/${invocationKey}.payload`, result, eventMaterial: event, ...(input.moveRequestFingerprint ? { moveRequestFingerprint: input.moveRequestFingerprint } : {}) }
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
      try {
        await validatePreparedOperation(journal, staged)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (typeof code !== 'string') throw error
        journal.status = 'conflict'
        journal.errorCode = code
        await options.store.write(operationPath, json(journal))
        try { await rollbackPreparedTarget(journal) }
        catch {
          journal.errorCode = 'operation_pending'
          await options.store.write(operationPath, json(journal))
          throw codedError('operation_pending')
        }
        throw codedError(code)
      }
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
      const page = { pageId: journal.result.pageId, path: journal.targetPath, revision: journal.result.revision, contentHash: journal.newHash, title: decoded.title, categoryId: decoded.categoryId, summary: decoded.summary, parentPageId: decoded.parentPageId, sourceRefs: decoded.sourceRefs }
      const nextCatalog = { formatVersion: 1 as const, pages: [...catalog.pages.filter(item => item.pageId !== page.pageId), page], tombstones: (catalog.tombstones ?? []).filter(item => item.pageId !== page.pageId), pathAliases: catalog.pathAliases ?? [] }
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

  async function validatePreparedOperation(journal: OperationJournal, staged: Buffer): Promise<void> {
    const schema = options.schema()
    if (journal.schemaVersion !== undefined && journal.schemaVersion !== schema.schemaVersion) throw codedError('schema_conflict')
    const decoded = parsePage(staged.toString('utf8'))
    if (decoded.pageId !== journal.result.pageId || decoded.revision !== journal.result.revision) throw codedError('operation_pending')
    if (!schema.categories.some(category => category.id === decoded.categoryId && category.status === 'active')) throw codedError('category_invalid')

    const catalog = await options.store.readCatalog() ?? { formatVersion: 1 as const, pages: [] }
    const existing = catalog.pages.find(page => page.pageId === decoded.pageId)
    const tombstone = catalog.tombstones?.find(page => page.pageId === decoded.pageId)
    const priorRevision = existing?.revision ?? tombstone?.revision ?? 0
    if (priorRevision + 1 !== decoded.revision) throw codedError('revision_conflict')
    if (existing && existing.path !== journal.targetPath) throw codedError('revision_conflict')
    if (catalog.pages.some(page => page.pageId !== decoded.pageId && page.path === journal.targetPath)) throw codedError('external_change_conflict')
    if (existing && existing.contentHash && journal.oldHash !== existing.contentHash) throw codedError('revision_conflict')
    for (const source of decoded.sourceRefs) {
      try { await options.store.read(`.wiki-service/source-history/${source.sourceId}/${source.sourceRevision}.md`) }
      catch { throw codedError('source_missing') }
    }
    const candidate = { pageId: decoded.pageId, path: journal.targetPath, revision: decoded.revision, title: decoded.title,
      categoryId: decoded.categoryId, summary: decoded.summary, parentPageId: decoded.parentPageId }
    validateActivePageSet([...catalog.pages.filter(page => page.pageId !== decoded.pageId), candidate], schema, decoded.pageId)
  }

  async function rollbackPreparedTarget(journal: OperationJournal): Promise<void> {
    const identity = await options.store.identity(journal.targetPath)
    if (!identity) return
    const bytes = await options.store.read(journal.targetPath)
    const currentHash = sha(bytes)
    if (currentHash !== journal.newHash) return
    if (journal.oldHash === null) {
      await options.store.remove(journal.targetPath, identity)
      return
    }
    const catalog = await options.store.readCatalog()
    const existing = catalog?.pages.find(page => page.pageId === journal.result.pageId)
    if (!existing) throw codedError('operation_pending')
    const previous = await options.store.read(`.wiki-service/page-history/${existing.pageId}/${existing.revision ?? 1}.md`)
    if (sha(previous) !== journal.oldHash) throw codedError('operation_pending')
    await writeService.write(journal.targetPath, previous, identity)
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
  const parsed = parseWikiPageMarker(text)
  const title = /^#\s+(.+?)\s*#*\s*$/m.exec(parsed.body)?.[1]?.trim()
  if (!parsed.marker || !title) throw codedError('wiki-page-marker-invalid')
  return { pageId: parsed.marker.pageId, revision: parsed.marker.revision, title, categoryId: parsed.marker.categoryId,
    summary: parsed.marker.summary, parentPageId: parsed.marker.parentPageId, sourceRefs: parsed.marker.sourceRefs }
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
function validateActivePageSet(pages: Array<{ pageId: string; title?: string; categoryId?: string; parentPageId?: string | null }>, schema: WikiDomainSchema, updatedPageId: string): void {
  const byId = new Map(pages.map(page => [page.pageId, page]))
  const titleKeys = new Set<string>()
  for (const page of pages) {
    const category = schema.categories.find(item => item.id === page.categoryId)
    if (!category) throw codedError('category_invalid')
    if (page.pageId === updatedPageId && category.status !== 'active') throw codedError('category_invalid')
    const parent = page.parentPageId ? byId.get(page.parentPageId) : undefined
    if (page.parentPageId && !parent) throw codedError('parent_invalid')
    if (category.allowedParentCategoryIds && page.parentPageId && !category.allowedParentCategoryIds.includes(parent?.categoryId ?? '')) throw codedError('parent_invalid')
    const titleKey = `${page.categoryId}\0${page.parentPageId ?? ''}\0${normalizeTitle(page.title ?? '')}`
    if (titleKeys.has(titleKey)) throw codedError('title_conflict')
    titleKeys.add(titleKey)
    const visited = new Set<string>([page.pageId])
    let parentId = page.parentPageId
    while (parentId) {
      if (visited.has(parentId)) throw codedError('parent_invalid')
      visited.add(parentId)
      parentId = byId.get(parentId)?.parentPageId ?? null
    }
  }
}
function slug(value: string): string { return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page' }
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function stableJson(value: unknown): string { return JSON.stringify(canonical(value)) }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function codedError(code: string): Error { return Object.assign(new Error(code), { code }) }
