import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { serializeWikiPageMarker, parseWikiPageMarker } from './wikiReconciler'
import { reconcileExternalWikiChanges } from './wikiReconciliationService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-reconciler-service-'))
  roots.push(root)
  await mkdir(path.join(root, 'wiki', 'topics'), { recursive: true })
  const store = createWikiFileStore(root)
  await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n')
  return { root, store }
}
function page(pageId: string, revision: number, title: string, body: string) {
  return `${serializeWikiPageMarker({ pageId, categoryId: 'topic', summary: '', parentPageId: null, sourceRefs: [], revision })}\n# ${title}\n\n${body}\n`
}
function sha(value: string) { return createHash('sha256').update(value).digest('hex') }

describe('reconcileExternalWikiChanges', () => {
  it('snapshots external edits, advances marker and catalog revisions, and records deletions as tombstones', async () => {
    const { root, store } = await fixture()
    const previous = page('page-a', 1, 'A', 'before')
    const edited = page('page-a', 1, 'A', 'after')
    await store.write('wiki/topics/a.md', edited)
    await store.writeImmutable('.wiki-service/page-history/page-a/1.md', previous)
    await store.writeCatalog({ formatVersion: 1, pages: [
      { pageId: 'page-a', path: 'wiki/topics/a.md', revision: 1, contentHash: sha(previous), title: 'A', categoryId: 'topic', summary: '', parentPageId: null },
      { pageId: 'page-gone', path: 'wiki/topics/gone.md', revision: 3, contentHash: 'old', title: 'Gone', categoryId: 'topic', summary: '' }
    ] })
    const result = await reconcileExternalWikiChanges(store)
    expect(result).toMatchObject({ pages: 1, changed: 1, tombstones: [{ pageId: 'page-gone', revision: 3, deleted: true }], diagnostics: [] })
    const saved = await store.readText('wiki/topics/a.md')
    expect(parseWikiPageMarker(saved).marker?.revision).toBe(2)
    const catalog = await store.readCatalog()
    expect(catalog?.pages[0]).toMatchObject({ pageId: 'page-a', revision: 2, contentHash: sha(saved) })
    expect(catalog?.tombstones).toEqual([{ pageId: 'page-gone', path: 'wiki/topics/gone.md', revision: 3, deleted: true }])
  })

  it('preserves all files when a changed page has no previous immutable snapshot', async () => {
    const { store } = await fixture()
    const edited = page('page-a', 1, 'A', 'external')
    await store.write('wiki/topics/a.md', edited)
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'page-a', path: 'wiki/topics/a.md', revision: 1, contentHash: 'previous', title: 'A', categoryId: 'topic', summary: '' }] })
    const result = await reconcileExternalWikiChanges(store)
    expect(result.diagnostics.map(item => item.code)).toContain('wiki-history-missing')
    expect(await store.readText('wiki/topics/a.md')).toBe(edited)
    expect((await store.readCatalog())?.pages[0].revision).toBe(1)
  })

  it('recognizes a moved path by pageId and advances the same page history', async () => {
    const { store } = await fixture()
    const previous = page('page-a', 2, 'A', 'before')
    const moved = page('page-a', 2, 'A', 'moved externally')
    await store.write('wiki/topics/new-name.md', moved)
    await store.writeImmutable('.wiki-service/page-history/page-a/2.md', previous)
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'page-a', path: 'wiki/topics/old-name.md', revision: 2, contentHash: sha(previous), title: 'A', categoryId: 'topic', summary: '' }] })
    const result = await reconcileExternalWikiChanges(store)
    expect(result).toMatchObject({ changed: 1, diagnostics: [] })
    const catalog = await store.readCatalog()
    expect(catalog?.pages[0]).toMatchObject({ pageId: 'page-a', path: 'wiki/topics/new-name.md', revision: 3 })
  })

  it('backs up drifted index and log views before rebuilding them from catalog and successful operations', async () => {
    const { store } = await fixture()
    const content = page('page-a', 1, 'A', 'body')
    await store.write('wiki/topics/a.md', content)
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'page-a', path: 'wiki/topics/a.md', revision: 1, contentHash: sha(content), title: 'A', categoryId: 'topic', summary: '' }] })
    await store.write('wiki/index.md', '# Hand edited index\nnotes\n')
    await store.write('wiki/log.md', '# Legacy log\nold history\n')
    await store.write('.wiki-service/operations/op-a.json', JSON.stringify({ status: 'completed', successEvent: { operationId: 'op-a', type: 'created', title: 'A', revision: 1, committedAt: '2026-01-01T00:00:00.000Z' } }))
    const result = await reconcileExternalWikiChanges(store)
    expect(result.diagnostics).toEqual([])
    expect(await store.readText('wiki/index.md')).toContain('[A](wiki/topics/a.md)')
    expect(await store.readText('wiki/log.md')).toContain('created A')
    const backups = (await (await import('node:fs/promises')).readdir(store.absolutePath('.wiki-service/projection-backups'))).sort()
    expect(backups).toHaveLength(2)
    expect(await store.readText(`.wiki-service/projection-backups/${backups.find(name => name.endsWith('-index.md'))}`)).toBe('# Hand edited index\nnotes\n')
    expect(await store.readText(`.wiki-service/projection-backups/${backups.find(name => name.endsWith('-log.md'))}`)).toBe('# Legacy log\nold history\n')
  })
})
