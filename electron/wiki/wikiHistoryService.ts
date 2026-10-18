import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { WikiFileStore } from './wikiFileStore'
import type { WikiDomainCoordinator, WikiSavePageResult } from './wikiDomainCoordinator'
import type { WikiDomainSchema } from './wikiDomainCoordinator'
import { parseWikiPageMarker } from './wikiReconciler'

export interface WikiRestoreConflict { code: string; message: string; pageId?: string }
interface RestoreInput { pageId: string; targetRevision: number; expectedCurrentRevision: number; callerId: string; lane: string; overrides?: { title?: string; categoryId?: string; parentPageId?: string | null } }
interface PreparedRestore { proposalId: string; input: RestoreInput; baseSchemaVersion: number; finalPage: { title: string; categoryId: string; summary: string; markdown: string; parentPageId: string | null; sourceRefs: Array<{ sourceId: string; sourceRevision: number }> }; conflicts: WikiRestoreConflict[] }

export function createWikiHistoryService(options: {
  store: WikiFileStore
  coordinator: Pick<WikiDomainCoordinator, 'savePage'>
  schema: () => WikiDomainSchema
  verifyConfirmation: (receipt: unknown, proposalId: string) => boolean | Promise<boolean>
  now?: () => number
  proposalTtlMs?: number
}) {
  const proposals = new Map<string, PreparedRestore>()
  const now = options.now ?? Date.now
  const ttl = options.proposalTtlMs ?? 10 * 60_000

  async function prepare(input: RestoreInput, proposalId: string = randomUUID()): Promise<PreparedRestore> {
    const catalog = await options.store.readCatalog()
    const page = catalog?.pages.find(item => item.pageId === input.pageId)
    const schema = options.schema()
    const conflicts: WikiRestoreConflict[] = []
    if (!page) conflicts.push({ code: 'page_not_found', message: 'Page is not active.', pageId: input.pageId })
    else if (page.revision !== input.expectedCurrentRevision) conflicts.push({ code: 'revision_conflict', message: 'Current page revision changed.', pageId: input.pageId })
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
    if (finalPage.parentPageId && !catalog?.pages.some(item => item.pageId === finalPage.parentPageId)) conflicts.push({ code: 'parent_invalid', message: 'Target parent page is unavailable.' })
    if (page && catalog?.pages.some(item => item.pageId !== page.pageId && item.categoryId === finalPage.categoryId && (item.parentPageId ?? null) === finalPage.parentPageId && normalizeTitle(item.title ?? '') === normalizeTitle(finalPage.title))) conflicts.push({ code: 'title_conflict', message: 'Another page already uses this title in the same category and parent.' })
    for (const source of finalPage.sourceRefs) {
      try { await options.store.read(`.wiki-service/source-history/${source.sourceId}/${source.sourceRevision}.md`) }
      catch { conflicts.push({ code: 'source_revision_missing', message: `Source revision ${source.sourceId} is unavailable.` }) }
    }
    const result: PreparedRestore = { proposalId, input, baseSchemaVersion: schema.schemaVersion, finalPage, conflicts }
    proposals.set(proposalId, result)
    return result
  }

  return {
    async listPageRevisions(pageId: string) {
      const dir = options.store.absolutePath(`.wiki-service/page-history/${pageId}`)
      let names: string[]
      try { names = await readdir(dir) } catch { return [] }
      const revisions = []
      for (const name of names) {
        if (!/^\d+\.md$/.test(name)) continue
        const revision = Number(name.slice(0, -3))
        const filePath = path.join(dir, name)
        const timestamp = (await stat(filePath)).mtime.toISOString()
        let body = ''
        try { body = await options.store.readText(`.wiki-service/page-history/${pageId}/${name}`) } catch { continue }
        const parsed = parseWikiPageMarker(body)
        revisions.push({ revision, timestamp, changeSummary: parsed.marker?.summary ?? '', externalEdit: false, deleted: false })
      }
      return revisions.sort((a, b) => b.revision - a.revision)
    },
    async prepareRestore(input: RestoreInput) {
      const proposal = await prepare(input)
      if (!proposal.conflicts.length && (!proposal.finalPage.title || !proposal.finalPage.markdown)) proposal.conflicts.push({ code: 'revision_invalid', message: 'Target revision content is incomplete.' })
      return { proposalId: proposal.proposalId, conflicts: proposal.conflicts, finalPage: proposal.finalPage }
    },
    async applyRestore(proposalId: string, invocation: { requestId: string; toolUseId: string; callerId: string; lane: string; receipt: unknown }): Promise<WikiSavePageResult> {
      const proposal = proposals.get(proposalId)
      if (!proposal || !/^[0-9a-f-]{36}$/i.test(proposalId)) throw codedError('restore_proposal_expired')
      if (proposal.input.callerId !== invocation.callerId || proposal.input.lane !== invocation.lane) throw codedError('restore_conflict')
      if (invocation.lane === 'automation' || !await options.verifyConfirmation(invocation.receipt, proposalId)) throw codedError('confirmation_required')
      if (proposal.conflicts.length) throw Object.assign(codedError('restore_conflict'), { conflicts: proposal.conflicts })
      const current = await prepare({ ...proposal.input }, proposalId)
      if (current.conflicts.length || current.baseSchemaVersion !== proposal.baseSchemaVersion || JSON.stringify(current.finalPage) !== JSON.stringify(proposal.finalPage)) throw Object.assign(codedError('restore_conflict'), { conflicts: current.conflicts })
      try {
        return await options.coordinator.savePage({
          requestId: invocation.requestId, toolUseId: invocation.toolUseId, callerId: invocation.callerId, lane: invocation.lane,
          pageId: proposal.input.pageId, expectedRevision: proposal.input.expectedCurrentRevision, schemaVersion: proposal.baseSchemaVersion,
          title: proposal.finalPage.title, categoryId: proposal.finalPage.categoryId, summary: proposal.finalPage.summary,
          markdown: proposal.finalPage.markdown, parentPageId: proposal.finalPage.parentPageId, sourceRefs: proposal.finalPage.sourceRefs,
          operationKind: 'restored',
        })
      } catch (error) {
        if (['revision_conflict', 'title_conflict', 'schema_conflict', 'parent_invalid'].includes((error as { code?: string }).code ?? '')) throw Object.assign(codedError('restore_conflict'), { cause: error })
        throw error
      }
    },
  }
}

function normalizeTitle(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') }
function codedError(code: string): Error { return Object.assign(new Error(code), { code }) }
