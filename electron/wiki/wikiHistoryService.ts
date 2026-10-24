import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'
import type { WikiDomainCoordinator, WikiSavePageResult } from './wikiDomainCoordinator'
import type { WikiDomainSchema } from './wikiDomainCoordinator'
import { parseWikiPageMarker } from './wikiReconciler'

export interface WikiRestoreConflict { code: string; message: string; pageId?: string }
interface RestoreInput { pageId: string; targetRevision: number; expectedCurrentRevision: number; callerId: string; lane: string; overrides?: { title?: string; categoryId?: string; parentPageId?: string | null } }
interface PreparedRestore { proposalId: string; expiresAt: number; input: RestoreInput; baseSchemaVersion: number; finalPage: { title: string; categoryId: string; summary: string; markdown: string; parentPageId: string | null; sourceRefs: Array<{ sourceId: string; sourceRevision: number }> }; conflicts: WikiRestoreConflict[] }

export function createWikiHistoryService(options: {
  store: WikiFileStore
  coordinator: Pick<WikiDomainCoordinator, 'savePage'>
  schema: () => WikiDomainSchema
  verifyConfirmation: (receipt: unknown, proposalId: string) => boolean | Promise<boolean>
  now?: () => number
  proposalTtlMs?: number
}) {
  const proposals = new Map<string, PreparedRestore>()
  const completedRestores = new Map<string, { proposalId: string; callerId: string; lane: string; result: WikiSavePageResult }>()
  const now = options.now ?? Date.now
  const ttl = options.proposalTtlMs ?? 10 * 60_000

  async function prepare(input: RestoreInput, proposalId: string = randomUUID()): Promise<PreparedRestore> {
    const catalog = await options.store.readCatalog()
    const page = catalog?.pages.find(item => item.pageId === input.pageId)
    const tombstone = catalog?.tombstones?.find(item => item.pageId === input.pageId)
    const schema = options.schema()
    const conflicts: WikiRestoreConflict[] = []
    if (!page && !tombstone) conflicts.push({ code: 'page_not_found', message: 'Page is not active and has no tombstone.', pageId: input.pageId })
    else if ((page?.revision ?? tombstone?.revision) !== input.expectedCurrentRevision) conflicts.push({ code: 'revision_conflict', message: 'Current page revision changed.', pageId: input.pageId })
    let snapshotText = ''
    try { snapshotText = await options.store.readText(`.wiki-service/page-history/${input.pageId}/${input.targetRevision}.md`) }
    catch { conflicts.push({ code: 'revision_not_found', message: 'Target revision is unavailable.', pageId: input.pageId }) }
    const parsed = parseWikiPageMarker(snapshotText)
    const title = /^#\s+(.+?)\s*#*\s*$/m.exec(parsed.body)?.[1]?.trim() ?? ''
    const markdown = parsed.body.replace(/^#\s+.+?\s*#*\s*\r?\n(?:\r?\n)?/m, '').trimEnd()
    const marker = parsed.marker
    if (!marker) conflicts.push({ code: 'revision_invalid', message: 'Target revision metadata is invalid.', pageId: input.pageId })
    const finalPage = {
      title: input.overrides?.title ?? title,
      categoryId: input.overrides?.categoryId ?? marker?.categoryId ?? '',
      summary: marker?.summary ?? '',
      markdown,
      parentPageId: input.overrides?.parentPageId !== undefined ? input.overrides.parentPageId : marker?.parentPageId ?? null,
      sourceRefs: marker?.sourceRefs ?? [],
    }
    const category = schema.categories.find(item => item.id === finalPage.categoryId && item.status === 'active')
    if (!category) conflicts.push({ code: 'category_invalid', message: 'Target category is not active in the current SCHEMA.' })
    conflicts.push(...validateRestoreActivitySet(catalog?.pages ?? [], input.pageId, finalPage, schema))
    for (const source of finalPage.sourceRefs) {
      try { await options.store.read(`.wiki-service/source-history/${source.sourceId}/${source.sourceRevision}.md`) }
      catch { conflicts.push({ code: 'source_revision_missing', message: `Source revision ${source.sourceId} is unavailable.` }) }
    }
    const result: PreparedRestore = { proposalId, expiresAt: now() + ttl, input, baseSchemaVersion: schema.schemaVersion, finalPage, conflicts }
    proposals.set(proposalId, result)
    return result
  }

  return {
    async listPageRevisions(pageId: string) {
      return listWikiPageRevisions(options.store, pageId)
    },
    async prepareRestore(input: RestoreInput) {
      const proposal = await prepare(input)
      if (!proposal.conflicts.length && (!proposal.finalPage.title || !proposal.finalPage.markdown)) proposal.conflicts.push({ code: 'revision_invalid', message: 'Target revision content is incomplete.' })
      return { proposalId: proposal.proposalId, conflicts: proposal.conflicts, finalPage: proposal.finalPage }
    },
    async applyRestore(proposalId: string, invocation: { requestId: string; toolUseId: string; callerId: string; lane: string; receipt: unknown; expectedFinalPage?: PreparedRestore['finalPage'] }): Promise<WikiSavePageResult> {
      const proposal = proposals.get(proposalId)
      if (!proposal || !/^[0-9a-f-]{36}$/i.test(proposalId)) throw codedError('restore_proposal_expired')
      if (proposal.input.callerId !== invocation.callerId || proposal.input.lane !== invocation.lane) throw codedError('restore_conflict')
      const invocationKey = `${invocation.requestId}\0${invocation.toolUseId}`
      const completed = completedRestores.get(invocationKey)
      if (completed) {
        if (completed.proposalId !== proposalId || completed.callerId !== invocation.callerId || completed.lane !== invocation.lane) throw codedError('idempotency_conflict')
        if (invocation.expectedFinalPage && stableJson(invocation.expectedFinalPage) !== stableJson(proposal.finalPage)) throw codedError('restore_material_mismatch')
        return completed.result
      }
      if (proposal.expiresAt <= now()) throw codedError('restore_proposal_expired')
      if (invocation.lane === 'automation' || !await options.verifyConfirmation(invocation.receipt, proposalId)) throw codedError('confirmation_required')
      if (proposal.conflicts.length) throw Object.assign(codedError('restore_conflict'), { conflicts: proposal.conflicts })
      if (invocation.expectedFinalPage && stableJson(invocation.expectedFinalPage) !== stableJson(proposal.finalPage)) throw codedError('restore_material_mismatch')
      try {
        const result = await options.coordinator.savePage({
          requestId: invocation.requestId, toolUseId: invocation.toolUseId, callerId: invocation.callerId, lane: invocation.lane,
          pageId: proposal.input.pageId, expectedRevision: proposal.input.expectedCurrentRevision, schemaVersion: proposal.baseSchemaVersion,
          title: proposal.finalPage.title, categoryId: proposal.finalPage.categoryId, summary: proposal.finalPage.summary,
          markdown: proposal.finalPage.markdown, parentPageId: proposal.finalPage.parentPageId, sourceRefs: proposal.finalPage.sourceRefs,
          operationKind: 'restored',
        })
        completedRestores.set(invocationKey, { proposalId, callerId: invocation.callerId, lane: invocation.lane, result })
        return result
      } catch (error) {
        if (['revision_conflict', 'title_conflict', 'schema_conflict', 'parent_invalid'].includes((error as { code?: string }).code ?? '')) throw Object.assign(codedError('restore_conflict'), { cause: error })
        throw error
      }
    },
  }
}

export async function listWikiPageRevisions(store: WikiFileStore, pageId: string) {
  if (!pageId || pageId.includes('/') || pageId.includes('\\') || pageId.includes('\0') || pageId === '.' || pageId === '..') return []
  const dir = store.absolutePath(`.wiki-service/page-history/${pageId}`)
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const revisions = []
  const catalog = await store.readCatalog()
  const deleted = catalog?.tombstones?.some(page => page.pageId === pageId) ?? false
  for (const name of names) {
    if (!/^\d+\.md$/.test(name)) continue
    const revision = Number(name.slice(0, -3))
    const filePath = path.join(dir, name)
    const timestamp = (await stat(filePath)).mtime.toISOString()
    let body = ''
    try { body = await store.readText(`.wiki-service/page-history/${pageId}/${name}`) } catch { continue }
    const parsed = parseWikiPageMarker(body)
    let revisionMetadata: { pageId?: unknown; revision?: unknown; externalEdit?: unknown; changeSummary?: unknown } | undefined
    try { revisionMetadata = JSON.parse(await store.readText(`.wiki-service/page-revision-metadata/${pageId}/${revision}.json`)) } catch { /* older revisions have no supplemental metadata */ }
    const externalEdit = revisionMetadata?.pageId === pageId && revisionMetadata.revision === revision && revisionMetadata.externalEdit === true
    const changeSummary = externalEdit && typeof revisionMetadata?.changeSummary === 'string' ? revisionMetadata.changeSummary : parsed.marker?.summary ?? ''
    revisions.push({ revision, timestamp, changeSummary, externalEdit, deleted })
  }
  return revisions.sort((a, b) => b.revision - a.revision)
}

function normalizeTitle(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') }
function validateRestoreActivitySet(
  pages: Array<{ pageId: string; path: string; revision?: number; title?: string; categoryId?: string; parentPageId?: string | null }>,
  pageId: string,
  finalPage: PreparedRestore['finalPage'],
  schema: WikiDomainSchema
): WikiRestoreConflict[] {
  const active = [...pages.filter(page => page.pageId !== pageId), { pageId, path: '', title: finalPage.title, categoryId: finalPage.categoryId, parentPageId: finalPage.parentPageId }]
  const byId = new Map(active.map(page => [page.pageId, page]))
  const conflicts: WikiRestoreConflict[] = []
  const categoryById = new Map(schema.categories.map(category => [category.id, category]))
  const seenTitles = new Set<string>()
  for (const page of active) {
    const category = categoryById.get(page.categoryId ?? '')
    if (!category) {
      conflicts.push({ code: 'category_invalid', message: page.pageId === pageId ? 'Target category is not active in the current SCHEMA.' : 'An active page category is missing from the current SCHEMA.', pageId: page.pageId })
      continue
    }
    if (page.pageId === pageId && category.status !== 'active') conflicts.push({ code: 'category_invalid', message: 'Target category is not active in the current SCHEMA.', pageId })
    const parent = page.parentPageId ? byId.get(page.parentPageId) : undefined
    if (page.parentPageId && (!parent || category.allowedParentCategoryIds && !category.allowedParentCategoryIds.includes(parent.categoryId ?? ''))) {
      conflicts.push({ code: 'parent_invalid', message: 'A page parent is unavailable or disallowed by its category.', pageId: page.pageId })
    }
    const titleKey = `${page.categoryId}\0${page.parentPageId ?? ''}\0${normalizeTitle(page.title ?? '')}`
    if (seenTitles.has(titleKey)) conflicts.push({ code: 'title_conflict', message: 'Another page already uses this title in the same category and parent.', pageId: page.pageId })
    seenTitles.add(titleKey)
    const visited = new Set<string>([page.pageId])
    let parentId = page.parentPageId
    while (parentId) {
      if (visited.has(parentId)) {
        conflicts.push({ code: 'parent_invalid', message: 'The restored page would create a parent cycle.', pageId: page.pageId })
        break
      }
      visited.add(parentId)
      parentId = byId.get(parentId)?.parentPageId ?? null
    }
  }
  return dedupeRestoreConflicts(conflicts)
}
function dedupeRestoreConflicts(conflicts: WikiRestoreConflict[]): WikiRestoreConflict[] {
  const seen = new Set<string>()
  return conflicts.filter(conflict => {
    const key = `${conflict.code}\0${conflict.pageId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}
function codedError(code: string): Error { return Object.assign(new Error(code), { code }) }
