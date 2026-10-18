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
})
