import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiDomainCoordinator } from './wikiDomainCoordinator'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiMigrationCoordinator } from './wikiMigrationCoordinator'
import { createWikiMigrationJournal } from './wikiMigrationJournal'
import { reconcileExternalWikiChanges } from './wikiReconciliationService'
import { createWikiSchemaProposalService } from './wikiSchemaProposal'
import { createWikiSourceService } from './wikiSourceService'
import { createWikiFileStore } from './wikiFileStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-recovery-review-'))
  roots.push(root)
  await mkdir(path.join(root, 'wiki'))
  const store = createWikiFileStore(root)
  const schemaText = '# Rules\n<!-- wiki-categories:start -->\n' + JSON.stringify({
    formatVersion: 1,
    categories: [{ id: 'topic', name: 'Topic', description: 'Topics', status: 'active' }]
  }) + '\n<!-- wiki-categories:end -->\n'
  await store.write('SCHEMA.md', schemaText)
  return { root, store }
}

const topicSchema = () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' as const }] })

describe('wiki review recovery regressions', () => {
  it('preserves immutable history when an external edit is retried after catalog commit failure', async () => {
    const { store } = await makeFixture()
    const coordinator = createWikiDomainCoordinator({ store, schema: topicSchema })
    const saved = await coordinator.savePage({
      requestId: 'external-edit', toolUseId: 'initial-save', callerId: 'review', lane: 'desktop',
      schemaVersion: 1, title: 'External edit', categoryId: 'topic', summary: '', markdown: 'original'
    })
    const page = (await store.readCatalog())!.pages[0]!
    const pageBytes = await store.readText(page.path)
    await store.write(page.path, pageBytes.replace('original', 'external first'))

    const write = store.write.bind(store)
    store.write = async (relativePath, ...args) => {
      if (relativePath === '.wiki-service/catalog.json') throw new Error('injected catalog failure')
      return write(relativePath, ...args)
    }
    await expect(reconcileExternalWikiChanges(store)).rejects.toThrow('injected catalog failure')
    store.write = write

    const firstAttemptBody = await store.readText(page.path)
    await store.write(page.path, firstAttemptBody.replace('external first', 'external second'))
    const reconciliation = await reconcileExternalWikiChanges(store)
    const current = (await store.readCatalog())!.pages.find(candidate => candidate.pageId === saved.pageId)!
    const currentBytes = await store.readText(current.path)
    const historyBytes = await store.readText(`.wiki-service/page-history/${saved.pageId}/${current.revision}.md`)

    if (reconciliation.diagnostics.length) {
      expect(current.revision).toBe(1)
      expect(currentBytes).toContain('external second')
      expect(historyBytes).toContain('original')
    } else {
      expect(historyBytes).toBe(currentBytes)
      expect(currentBytes).toContain('external second')
    }
  })

  it('recovers a raw source binding after its history snapshot was written but binding update failed', async () => {
    const { root, store } = await makeFixture()
    const sourcePath = path.join(root, 'source.md')
    await writeFile(sourcePath, 'version one')
    const serviceOptions = {
      store,
      resolveSourceRef: () => ({ path: sourcePath, displayName: 'source.md' }),
      validateSource: async () => true,
      authorize: async () => true
    }
    let service = createWikiSourceService(serviceOptions)
    const caller = { callerId: 'review', lane: 'desktop' }
    const imported = await service.importSource('fixture', caller)
    const bindingPath = `.wiki-service/sources/${imported.sourceId}.json`
    const binding = JSON.parse(await store.readText(bindingPath)) as { rawPath: string }
    await store.write(binding.rawPath, 'version two')

    const write = store.write.bind(store)
    store.write = async (relativePath, ...args) => {
      if (relativePath === bindingPath) throw new Error('injected binding failure')
      return write(relativePath, ...args)
    }
    await expect(service.readSource(imported.sourceId, caller)).rejects.toThrow('injected binding failure')
    store.write = write
    service = createWikiSourceService(serviceOptions)

    const concurrentReads = await Promise.all([
      service.readSource(imported.sourceId, caller),
      service.readSource(imported.sourceId, caller)
    ])
    expect(concurrentReads).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRevision: 2, text: 'version two' }),
      expect.objectContaining({ sourceRevision: 2, text: 'version two' })
    ]))
    await expect(service.readSource(imported.sourceId, caller, { sourceRevision: 1 })).resolves.toMatchObject({ sourceRevision: 1, text: 'version one' })
  })

  it('revalidates a prepared save against the current schema before recovering it', async () => {
    const { store } = await makeFixture()
    let schema = topicSchema()
    const coordinator = createWikiDomainCoordinator({ store, schema: () => schema })
    const pendingInput = {
      requestId: 'pending-save', toolUseId: 'pending-save', callerId: 'review', lane: 'desktop',
      schemaVersion: 1, title: 'Pending page', categoryId: 'topic', summary: '', markdown: 'pending body'
    }
    const write = store.write.bind(store)
    store.write = async (relativePath, ...args) => {
      if (relativePath.startsWith('wiki/') && relativePath !== 'wiki/index.md' && relativePath !== 'wiki/log.md') {
        throw new Error('injected target write failure')
      }
      return write(relativePath, ...args)
    }
    await expect(coordinator.savePage(pendingInput)).rejects.toThrow('injected target write failure')
    store.write = write

    const proposalService = createWikiSchemaProposalService({ store, verifyConfirmation: () => true })
    const currentSchema = await proposalService.current()
    const proposedContent = currentSchema.content.replace(/topic/g, 'other').replace(/Topic/g, 'Other')
    const proposal = await proposalService.propose(proposedContent, 1)
    await proposalService.apply(proposal.proposalId, 1, { requestId: 'schema', toolUseId: 'schema' }, proposal.diff)
    schema = { schemaVersion: 2, categories: [{ id: 'other', name: 'Other', status: 'active' }] }

    await expect(coordinator.savePage(pendingInput)).rejects.toMatchObject({ code: 'schema_conflict' })
    expect((await store.readCatalog())?.pages ?? []).toEqual([])
  })

  it('keeps the migration lifecycle blocked when a completed target drifts before resume', async () => {
    const { root, store } = await makeFixture()
    const lifecycle = createWikiLifecycleController(root)
    await lifecycle.initialize()
    await store.write('wiki/legacy.md', 'before migration')
    const journal = createWikiMigrationJournal({ store })
    const manifest = await journal.prepare([{ objectKind: 'page', relativePath: 'wiki/legacy.md', newBytes: Buffer.from('migrated') }])
    await lifecycle.beginMigration('preflight-hash', manifest.migrationId)
    await journal.apply(manifest.migrationId)
    await store.write('wiki/legacy.md', 'external drift after completion')

    const coordinator = createWikiMigrationCoordinator(root)
    await expect(coordinator.resume({ migrationId: manifest.migrationId, preflightHash: 'preflight-hash' })).rejects.toThrow()
    expect((await lifecycle.read()).lifecycle).not.toBe('domain_ready')
    await expect(store.readText('wiki/legacy.md')).resolves.toBe('external drift after completion')
  })

  it('preserves a renamed page path alias across a later unrelated save', async () => {
    const { root, store } = await makeFixture()
    const coordinator = createWikiDomainCoordinator({ store, schema: topicSchema })
    const saved = await coordinator.savePage({
      requestId: 'alias-page', toolUseId: 'alias-page', callerId: 'review', lane: 'desktop',
      schemaVersion: 1, title: 'Renamed page', categoryId: 'topic', summary: '', markdown: 'body'
    })
    const originalPath = (await store.readCatalog())!.pages[0]!.path
    const renamedPath = 'wiki/renamed-page.md'
    await rename(store.absolutePath(originalPath), store.absolutePath(renamedPath))
    await expect(reconcileExternalWikiChanges(store)).resolves.toMatchObject({ diagnostics: [] })
    await expect(store.readCatalog()).resolves.toMatchObject({ pathAliases: [{ path: originalPath, pageId: saved.pageId }] })

    await coordinator.savePage({
      requestId: 'unrelated-page', toolUseId: 'unrelated-page', callerId: 'review', lane: 'desktop',
      schemaVersion: 1, title: 'Unrelated page', categoryId: 'topic', summary: '', markdown: 'other body'
    })

    await expect(store.readCatalog()).resolves.toMatchObject({ pathAliases: [{ path: originalPath, pageId: saved.pageId }] })
    await coordinator.savePage({
      requestId: 'rename-page-update', toolUseId: 'rename-page-update', callerId: 'review', lane: 'desktop',
      pageId: saved.pageId, expectedRevision: 2, schemaVersion: 1, title: 'Renamed page', categoryId: 'topic', summary: '', markdown: 'updated body'
    })
    await expect(store.readCatalog()).resolves.toMatchObject({ pathAliases: [{ path: originalPath, pageId: saved.pageId }] })
  })
})
