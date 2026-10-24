import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWikiFileStore } from './wiki/wikiFileStore'
import { createWikiDomainCoordinator } from './wiki/wikiDomainCoordinator'
import { createWikiLifecycleController } from './wiki/wikiLifecycle'
import { saveWikiPageForContext, moveWikiPageForContext } from './wiki/wikiDomainTools'
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
