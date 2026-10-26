import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiDomainCoordinator } from './wikiDomainCoordinator'
import { createWikiHistoryService } from './wikiHistoryService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-history-'))
  roots.push(root)
  const store = createWikiFileStore(root)
  const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' }] }) })
  const service = createWikiHistoryService({ store, coordinator, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', status: 'active' }] }), verifyConfirmation: receipt => receipt === 'approved' })
  return { root, store, coordinator, service }
}
const input = { requestId: 'create', toolUseId: 'create', callerId: 'assistant', lane: 'chat', title: 'Alpha', categoryId: 'topic', summary: 'Summary', markdown: 'Original body', schemaVersion: 1 }

describe('WikiHistoryService', () => {
  it('reports externally reconciled revisions as external edits', async () => {
    const { store, coordinator, service } = await fixture()
    const page = await coordinator.savePage(input)
    await coordinator.savePage({ ...input, requestId: 'update', toolUseId: 'update', pageId: page.pageId, expectedRevision: 1, markdown: 'Changed body' })
    await store.write('.wiki-service/page-revision-metadata/' + page.pageId + '/2.json', JSON.stringify({ formatVersion: 1, pageId: page.pageId, revision: 2, externalEdit: true, changeSummary: 'External edit' }))
    const revisions = await service.listPageRevisions(page.pageId)
    expect(revisions.find(item => item.revision === 2)).toMatchObject({ externalEdit: true, changeSummary: 'External edit' })
    expect(revisions.find(item => item.revision === 1)?.externalEdit).toBe(false)
  })
  it('lists immutable revisions and confirms the final full restored page before writing', async () => {
    const { root, coordinator, service } = await fixture()
    const created = await coordinator.savePage(input)
    await coordinator.savePage({ ...input, requestId: 'update', toolUseId: 'update', pageId: created.pageId, expectedRevision: 1, markdown: 'Changed body' })
    const revisions = await service.listPageRevisions(created.pageId)
    expect(revisions.map(item => item.revision)).toEqual([2, 1])
    const proposal = await service.prepareRestore({ pageId: created.pageId, targetRevision: 1, expectedCurrentRevision: 2, callerId: 'assistant', lane: 'chat' })
    expect(proposal.finalPage).toMatchObject({ title: 'Alpha', categoryId: 'topic', summary: 'Summary', markdown: 'Original body' })
    await expect(service.applyRestore(proposal.proposalId, { requestId: 'restore', toolUseId: 'restore', callerId: 'assistant', lane: 'chat', receipt: 'approved' })).resolves.toMatchObject({ revision: 3 })
    expect(await readFile(path.join(root, '.wiki-service/page-history', created.pageId, '3.md'), 'utf8')).toContain('Original body')
  })

  it('returns every conflict and performs no writes when current constraints reject restore', async () => {
    const { root, coordinator, service } = await fixture()
    const first = await coordinator.savePage(input)
    const second = await coordinator.savePage({ ...input, requestId: 'second', toolUseId: 'second', title: 'Beta', markdown: 'Other' })
    await coordinator.savePage({ ...input, requestId: 'update', toolUseId: 'update', pageId: first.pageId, expectedRevision: 1, title: 'Alpha', markdown: 'New' })
    const proposal = await service.prepareRestore({ pageId: first.pageId, targetRevision: 1, expectedCurrentRevision: 2, callerId: 'assistant', lane: 'chat', overrides: { title: 'Beta' } })
    expect(proposal.conflicts.map(item => item.code)).toContain('title_conflict')
    await expect(service.applyRestore(proposal.proposalId, { requestId: 'restore', toolUseId: 'restore', callerId: 'assistant', lane: 'chat', receipt: 'approved' })).rejects.toMatchObject({ code: 'restore_conflict' })
    expect(await readFile(path.join(root, '.wiki-service/page-history', second.pageId, '1.md'), 'utf8')).toContain('Other')
  })

  it('expires an unapplied restore proposal at its TTL', async () => {
    const { store, coordinator } = await fixture()
    const page = await coordinator.savePage(input)
    let clock = 1_000
    const service = createWikiHistoryService({ store, coordinator, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', status: 'active' }] }), verifyConfirmation: receipt => receipt === 'approved', now: () => clock, proposalTtlMs: 100 })
    const proposal = await service.prepareRestore({ pageId: page.pageId, targetRevision: 1, expectedCurrentRevision: 1, callerId: 'assistant', lane: 'chat' })
    clock += 101
    await expect(service.applyRestore(proposal.proposalId, { requestId: 'expired-restore', toolUseId: 'expired-restore', callerId: 'assistant', lane: 'chat', receipt: 'approved' })).rejects.toMatchObject({ code: 'restore_proposal_expired' })
    expect((await store.readCatalog())?.pages[0]).toMatchObject({ revision: 1 })
  })

  it('rejects automation and model supplied approval claims', async () => {
    const { coordinator, service } = await fixture()
    const page = await coordinator.savePage(input)
    const proposal = await service.prepareRestore({ pageId: page.pageId, targetRevision: 1, expectedCurrentRevision: 1, callerId: 'bot', lane: 'automation' })
    await expect(service.applyRestore(proposal.proposalId, { requestId: 'auto', toolUseId: 'auto', callerId: 'bot', lane: 'automation', receipt: 'approved' })).rejects.toMatchObject({ code: 'confirmation_required' })
  })

  it('restores a tombstoned page as the same pageId with a higher revision', async () => {
    const { root, store, coordinator, service } = await fixture()
    const page = await coordinator.savePage(input)
    const catalog = await store.readCatalog()
    await store.remove(catalog!.pages[0]!.path)
    await store.writeCatalog({ formatVersion: 1, pages: [], tombstones: [{ pageId: page.pageId, path: catalog!.pages[0]!.path, revision: 1, deleted: true }] })
    const proposal = await service.prepareRestore({ pageId: page.pageId, targetRevision: 1, expectedCurrentRevision: 1, callerId: 'assistant', lane: 'chat' })
    expect(proposal.conflicts).toEqual([])
    await expect(service.applyRestore(proposal.proposalId, { requestId: 'restore-tombstone', toolUseId: 'restore-tombstone', callerId: 'assistant', lane: 'chat', receipt: 'approved' })).resolves.toMatchObject({ pageId: page.pageId, revision: 2 })
    expect((await store.readCatalog())?.tombstones).toEqual([])
    expect((await store.readCatalog())?.pages).toMatchObject([{ pageId: page.pageId, revision: 2 }])
    expect(await readFile(path.join(root, 'wiki', 'alpha-' + page.pageId.slice(0, 8) + '.md'), 'utf8').catch(() => '')).not.toBe('')
  })

  it('lists self-parent, descendant-cycle, and parent-category conflicts before restore confirmation', async () => {
    const categories = [
      { id: 'parent-a', name: 'Parent A', status: 'active' as const },
      { id: 'parent-b', name: 'Parent B', status: 'active' as const },
      { id: 'child-c', name: 'Child C', status: 'active' as const, allowedParentCategoryIds: ['parent-a'] },
    ]
    const { coordinator, service } = await fixtureWithCategories(categories)
    const parentA = await coordinator.savePage({ ...input, categoryId: 'parent-a', title: 'Parent A' })
    const parentB = await coordinator.savePage({ ...input, requestId: 'parent-b', toolUseId: 'parent-b', categoryId: 'parent-b', title: 'Parent B' })
    const child = await coordinator.savePage({ ...input, requestId: 'child', toolUseId: 'child', categoryId: 'child-c', title: 'Child', parentPageId: parentA.pageId })

    const self = await service.prepareRestore({ pageId: parentA.pageId, targetRevision: 1, expectedCurrentRevision: 1, callerId: 'assistant', lane: 'chat', overrides: { parentPageId: parentA.pageId } })
    const cycle = await service.prepareRestore({ pageId: parentA.pageId, targetRevision: 1, expectedCurrentRevision: 1, callerId: 'assistant', lane: 'chat', overrides: { parentPageId: child.pageId } })
    const disallowedCategory = await service.prepareRestore({ pageId: child.pageId, targetRevision: 1, expectedCurrentRevision: 1, callerId: 'assistant', lane: 'chat', overrides: { parentPageId: parentB.pageId } })

    expect(self.conflicts.map(item => item.code)).toContain('parent_invalid')
    expect(cycle.conflicts.map(item => item.code)).toContain('parent_invalid')
    expect(disallowedCategory.conflicts.map(item => item.code)).toContain('parent_invalid')
  })

  it('replays a successful restore tool invocation with its original stale baseline', async () => {
    const { coordinator, service } = await fixture()
    const page = await coordinator.savePage(input)
    await coordinator.savePage({ ...input, requestId: 'update', toolUseId: 'update', pageId: page.pageId, expectedRevision: 1, markdown: 'Changed body' })
    const proposal = await service.prepareRestore({ pageId: page.pageId, targetRevision: 1, expectedCurrentRevision: 2, callerId: 'assistant', lane: 'chat' })
    const invocation = { requestId: 'restore-idempotent', toolUseId: 'restore-idempotent', callerId: 'assistant', lane: 'chat', receipt: 'approved' }

    const first = await service.applyRestore(proposal.proposalId, invocation)
    const retry = await service.applyRestore(proposal.proposalId, invocation)

    expect(retry).toEqual(first)
    expect((await service.listPageRevisions(page.pageId)).map(item => item.revision)).toEqual([3, 2, 1])
  })

  it('replays a completed restore after rebuilding the history service', async () => {
    const { store, coordinator } = await fixture()
    const page = await coordinator.savePage(input)
    await coordinator.savePage({ ...input, requestId: 'update-rebuild', toolUseId: 'update-rebuild', pageId: page.pageId, expectedRevision: 1, markdown: 'Changed body' })
    const service = createWikiHistoryService({ store, coordinator, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', status: 'active' }] }), verifyConfirmation: receipt => receipt === 'approved' })
    const proposal = await service.prepareRestore({ pageId: page.pageId, targetRevision: 1, expectedCurrentRevision: 2, callerId: 'assistant', lane: 'chat' })
    const invocation = { requestId: 'restore-rebuild', toolUseId: 'restore-rebuild', callerId: 'assistant', lane: 'chat', receipt: 'approved' }
    const first = await service.applyRestore(proposal.proposalId, invocation)
    const rebuilt = createWikiHistoryService({ store, coordinator, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', status: 'active' }] }), verifyConfirmation: receipt => receipt === 'approved' })

    await expect(rebuilt.applyRestore(proposal.proposalId, invocation)).resolves.toEqual(first)
  })

  it('resumes a committed restore after projection failure and rebuilding both services', async () => {
    const { store } = await fixture()
    let failProjection = false
    const schema = () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' as const }] })
    let coordinator = createWikiDomainCoordinator({ store, schema, beforeProjection: projection => { if (projection === 'log' && failProjection) { failProjection = false; throw new Error('projection unavailable') } } })
    let service = createWikiHistoryService({ store, coordinator, schema, verifyConfirmation: receipt => receipt === 'approved' })
    const page = await coordinator.savePage(input)
    await coordinator.savePage({ ...input, requestId: 'update-resume', toolUseId: 'update-resume', pageId: page.pageId, expectedRevision: 1, markdown: 'Changed body' })
    const proposal = await service.prepareRestore({ pageId: page.pageId, targetRevision: 1, expectedCurrentRevision: 2, callerId: 'assistant', lane: 'chat' })
    const invocation = { requestId: 'restore-resume', toolUseId: 'restore-resume', callerId: 'assistant', lane: 'chat', receipt: 'approved', expectedFinalPage: proposal.finalPage }

    failProjection = true
    await expect(service.applyRestore(proposal.proposalId, invocation)).rejects.toMatchObject({ code: 'projection_pending' })
    coordinator = createWikiDomainCoordinator({ store, schema, beforeProjection: projection => { if (projection === 'log' && failProjection) throw new Error('projection unavailable') } })
    service = createWikiHistoryService({ store, coordinator, schema, verifyConfirmation: receipt => receipt === 'approved' })

    await expect(service.applyRestore(proposal.proposalId, invocation)).resolves.toMatchObject({ pageId: page.pageId, revision: 3 })
    expect((await store.readCatalog())?.pages).toMatchObject([{ pageId: page.pageId, revision: 3 }])
  })
})

async function fixtureWithCategories(categories: Array<{ id: string; name: string; status: 'active'; allowedParentCategoryIds?: string[] }>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-history-categories-'))
  roots.push(root)
  const store = createWikiFileStore(root)
  const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories }) })
  const service = createWikiHistoryService({ store, coordinator, schema: () => ({ schemaVersion: 1, categories }), verifyConfirmation: receipt => receipt === 'approved' })
  return { root, store, coordinator, service }
}
