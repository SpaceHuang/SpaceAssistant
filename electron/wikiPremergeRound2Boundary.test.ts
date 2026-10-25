import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createWikiFileStore } from './wiki/wikiFileStore'
import { createWikiDomainCoordinator } from './wiki/wikiDomainCoordinator'
import { createWikiLifecycleController } from './wiki/wikiLifecycle'
import { saveWikiPageForContext, moveWikiPageForContext, searchWikiForContext, getWikiSchemaForContext, proposeWikiSchemaChangeForContext, updateWikiSchemaForContext, openWikiPageForContext, readWikiPageForContext } from './wiki/wikiDomainTools'
import { DEFAULT_WIKI_CONFIG } from '../src/shared/domainTypes'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-round2-boundary-'))
  roots.push(root)
  await mkdir(path.join(root, 'wiki'))
  await createWikiLifecycleController(root).initialize({ fresh: true })
  const store = createWikiFileStore(root)
  await store.write('SCHEMA.md', '# Rules\n<!-- wiki-categories:start -->\n' + JSON.stringify({ formatVersion: 1, categories: [{ id: 'topic', name: 'Topic', description: 'Topics', status: 'active' }] }) + '\n<!-- wiki-categories:end -->\n')
  const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' }] }) })
  const context = { userDataDir: path.dirname(root), wikiConfig: { ...DEFAULT_WIKI_CONFIG, rootPath: path.basename(root) }, sessionId: 'review', lane: 'desktop', requestId: 'r', toolUseId: 't' }
  return { root, store, coordinator, context }
}

const material = { title: 'A', categoryId: 'topic', summary: '', markdown: 'body', schemaVersion: 1 }

it('recovers an interrupted creation through the real save tool without deleting its landed page', async () => {
  const { store, coordinator, context } = await fixture()
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-target-write' })).rejects.toThrow('injected crash')
  const result = await saveWikiPageForContext(material, context)
  expect(result).toMatchObject({ success: true, data: { revision: 1 } })
  const pages = (await store.readCatalog())?.pages ?? []
  expect(pages).toHaveLength(1)
  await expect(store.readText(pages[0]!.path)).resolves.toContain('body')
})

it('recovers an interrupted update through the real save tool', async () => {
  const { store, coordinator, context } = await fixture()
  const first = await coordinator.savePage({ ...material, requestId: 'initial', toolUseId: 'initial', callerId: 'review:local', lane: 'desktop' })
  const update = { ...material, pageId: first.pageId, expectedRevision: 1, markdown: 'new body' }
  await expect(coordinator.savePage({ ...update, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-target-write' })).rejects.toThrow('injected crash')
  expect((await searchWikiForContext({ query: 'A' }, context)).success).toBe(true)
  expect(await saveWikiPageForContext(update, context)).toMatchObject({ success: true, data: { revision: 2 } })
  const page = (await store.readCatalog())!.pages[0]!
  await expect(store.readText(page.path)).resolves.toContain('new body')
})

it('finishes a domain-committed save through the real tool entry', async () => {
  const { coordinator, context } = await fixture()
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-domain-commit' })).rejects.toThrow('injected crash')
  expect(await saveWikiPageForContext(material, context)).toMatchObject({ success: true, data: { revision: 1 } })
})

it('replays a save interrupted after projection writes through the real tool entry', async () => {
  const { coordinator, context } = await fixture()
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-log-write' })).rejects.toThrow('injected crash')
  expect(await saveWikiPageForContext(material, context)).toMatchObject({ success: true, data: { revision: 1 } })
})

it('replays a successful move at the real tool entry', async () => {
  const { coordinator, context } = await fixture()
  const first = await coordinator.savePage({ ...material, requestId: 'initial', toolUseId: 'initial', callerId: 'review:local', lane: 'desktop' })
  const parent = await coordinator.savePage({ ...material, title: 'Parent', requestId: 'parent', toolUseId: 'parent', callerId: 'review:local', lane: 'desktop' })
  const input = { pageId: first.pageId, expectedRevision: 1, parentPageId: parent.pageId }
  const result = await moveWikiPageForContext(input, context)
  expect(result.success).toBe(true)
  expect(await moveWikiPageForContext(input, context)).toEqual(result)
})

it('recovers a pending create after another real read has scanned the wiki', async () => {
  const { store, coordinator, context } = await fixture()
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-target-write' })).rejects.toThrow('injected crash')
  expect((await searchWikiForContext({ query: 'A' }, context)).success).toBe(true)
  const result = await saveWikiPageForContext(material, context)
  expect(result).toMatchObject({ success: true, data: { revision: 1 } })
})

it('preserves a domain-committed page when a read lands after catalog write but before completion', async () => {
  const { store, coordinator, context } = await fixture()
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-target-write' })).rejects.toThrow('injected crash')
  const operationId = createHash('sha256').update('r\0t').digest('hex')
  const operationPath = `.wiki-service/operations/${operationId}.json`
  const journal = JSON.parse(await store.readText(operationPath)) as { status: string; successEvent?: unknown; eventMaterial: unknown; targetPath: string; newHash: string; result: { pageId: string; revision: number } }
  journal.status = 'domain_committed'
  journal.successEvent = journal.eventMaterial
  await store.write(operationPath, `${JSON.stringify(journal)}\n`)
  await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: journal.result.pageId, path: journal.targetPath, revision: journal.result.revision, contentHash: journal.newHash, title: material.title, categoryId: material.categoryId, summary: material.summary, parentPageId: null }], tombstones: [], pathAliases: [] })
  expect((await searchWikiForContext({ query: 'A' }, context)).success).toBe(true)
  expect(await saveWikiPageForContext(material, context)).toMatchObject({ success: true, data: { revision: 1 } })
  await expect(store.readText(journal.targetPath)).resolves.toContain('body')
})

it('rejects a pending save after a valid external schema change that preserves its category', async () => {
  const { store, coordinator, context } = await fixture()
  expect((await getWikiSchemaForContext(context)).success).toBe(true)
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-target-write' })).rejects.toThrow('injected crash')
  await store.write('SCHEMA.md', (await store.readText('SCHEMA.md')).replace('Topic', 'Renamed Topic'))
  expect(await saveWikiPageForContext(material, context)).toMatchObject({ success: false, error: 'schema_conflict' })
  expect((await store.readCatalog())?.pages).toEqual([])
  expect(JSON.parse(await store.readText('.wiki-service/schema-state.json'))).toMatchObject({ schemaVersion: 2 })
})

it('replays a completed move after a later ordinary content edit', async () => {
  const { coordinator, context } = await fixture()
  const first = await coordinator.savePage({ ...material, requestId: 'initial', toolUseId: 'initial', callerId: 'review:local', lane: 'desktop' })
  const parent = await coordinator.savePage({ ...material, title: 'Parent', requestId: 'parent', toolUseId: 'parent', callerId: 'review:local', lane: 'desktop' })
  const input = { pageId: first.pageId, expectedRevision: 1, parentPageId: parent.pageId }
  const moved = await moveWikiPageForContext(input, context)
  expect(moved.success).toBe(true)
  expect((await saveWikiPageForContext({ ...material, pageId: first.pageId, expectedRevision: 2, title: 'Edited', markdown: 'new content' }, { ...context, requestId: 'edit', toolUseId: 'edit' })).success).toBe(true)
  expect(await moveWikiPageForContext(input, context)).toEqual(moved)
})

it('returns search text from the same committed revision that open and read use', async () => {
  const { store, coordinator, context } = await fixture()
  const first = await coordinator.savePage({ ...material, requestId: 'initial', toolUseId: 'initial', callerId: 'review:local', lane: 'desktop' })
  const update = { ...material, pageId: first.pageId, expectedRevision: 1, markdown: 'pending-exclusive-marker' }
  await expect(coordinator.savePage({ ...update, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-target-write' })).rejects.toThrow('injected crash')

  const uncommittedSearch = await searchWikiForContext({ query: 'pending-exclusive-marker' }, context)
  expect(uncommittedSearch).toMatchObject({ success: true, data: { matches: [] } })
  const committedSearch = await searchWikiForContext({ query: 'body' }, context)
  expect(committedSearch).toMatchObject({ success: true, data: { matches: [{ pageId: first.pageId, revision: 1, snippet: 'body' }] } })
  const opened = await openWikiPageForContext({ pageId: first.pageId, revision: 1 }, context)
  expect(opened).toMatchObject({ success: true, data: { revision: 1 } })
  const readHandle = (opened as { data: { readHandle: string } }).data.readHandle
  expect(await readWikiPageForContext({ readHandle }, context)).toMatchObject({ success: true, data: { text: 'body\n' } })
  await expect(store.readText(`.wiki-service/page-history/${first.pageId}/1.md`)).resolves.toContain('body')
})

it('includes a domain-committed pending page when applying a schema proposal', async () => {
  const { store, coordinator, context } = await fixture()
  expect((await getWikiSchemaForContext(context)).success).toBe(true)
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-domain-commit' })).rejects.toThrow('injected crash')
  const content = (await store.readText('SCHEMA.md')).replace(/topic/g, 'other')
  const proposed = await proposeWikiSchemaChangeForContext({ content, expectedSchemaVersion: 1 }, { ...context, requestId: 'schema-proposal', toolUseId: 'schema-proposal' })
  expect(proposed.success).toBe(true)
  const data = proposed.data as { proposalId: string; diff: { before: string; after: string } }
  const applied = await updateWikiSchemaForContext({ proposalId: data.proposalId, proposalDiff: data.diff, expectedSchemaVersion: 1 }, {
    ...context, requestId: 'schema-apply', toolUseId: 'schema-apply', toolUserConfirmed: true, userConfirmationAnswerer: 'user'
  })
  expect(applied.success).toBe(false)
  expect(await getWikiSchemaForContext(context)).toMatchObject({ success: true, data: { schemaVersion: 1 } })
})

it('does not complete a domain-committed page under an incompatible external schema', async () => {
  const { store, coordinator, context } = await fixture()
  expect((await getWikiSchemaForContext(context)).success).toBe(true)
  await expect(coordinator.savePage({ ...material, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-domain-commit' })).rejects.toThrow('injected crash')
  await store.write('SCHEMA.md', (await store.readText('SCHEMA.md')).replace(/topic/g, 'other'))
  const result = await saveWikiPageForContext(material, context)
  expect(result.success).toBe(false)
})

for (const existingPage of [false, true]) {
  it(`preserves the committed snapshot before reconciling a later external edit (existing=${existingPage})`, async () => {
    const { store, coordinator, context } = await fixture()
    const first = existingPage
      ? await coordinator.savePage({ ...material, requestId: 'initial', toolUseId: 'initial', callerId: 'review:local', lane: 'desktop' })
      : undefined
    const input = { ...material, markdown: 'committed-before-external', ...(first ? { pageId: first.pageId, expectedRevision: 1 } : {}) }
    await expect(coordinator.savePage({ ...input, requestId: 'r', toolUseId: 't', callerId: 'review:local', lane: 'desktop', crashAt: 'after-domain-commit' })).rejects.toThrow('injected crash')
    const operationId = createHash('sha256').update('r\0t').digest('hex')
    const operation = JSON.parse(await store.readText(`.wiki-service/operations/${operationId}.json`)) as { targetPath: string; result: { pageId: string; revision: number } }
    await store.write(operation.targetPath, (await store.readText(operation.targetPath)).replace('committed-before-external', 'external-after-commit'))

    const search = await searchWikiForContext({ query: 'external-after-commit' }, context)

    expect(search).toMatchObject({ success: true, data: { matches: [{ pageId: operation.result.pageId }] } })
    const catalogPage = (await store.readCatalog())!.pages.find(page => page.pageId === operation.result.pageId)!
    expect(catalogPage.revision).toBeGreaterThan(operation.result.revision)
    await expect(store.readText(`.wiki-service/page-history/${operation.result.pageId}/${operation.result.revision}.md`)).resolves.toContain('committed-before-external')
    await expect(store.readText(`.wiki-service/page-history/${operation.result.pageId}/${catalogPage.revision}.md`)).resolves.toContain('external-after-commit')
  })
}
