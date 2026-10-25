import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiDomainCoordinator } from './wikiDomainCoordinator'
import { serializeWikiPageMarker } from './wikiReconciler'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-domain-coordinator-'))
  roots.push(root)
  const store = createWikiFileStore(root)
  const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' }] }) })
  return { root, store, coordinator }
}
const base = { requestId: 'req-1', toolUseId: 'tool-1', callerId: 'assistant', lane: 'chat', title: 'Alpha', categoryId: 'topic', summary: 'A', markdown: 'Body', schemaVersion: 1 }

describe('WikiDomainCoordinator', () => {
  it('projects categories in Schema order and includes complete page navigation and provenance metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-domain-index-'))
    roots.push(root)
    const store = createWikiFileStore(root)
    const sourceId = '01234567-89ab-cdef-0123-456789abcdef'
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/1.md`, Buffer.from('source snapshot'))
    const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [
      { id: 'z-first', name: 'First', status: 'active' }, { id: 'a-second', name: 'Second', status: 'active' }
    ] }) })
    const first = await coordinator.savePage({ ...base, requestId: 'index-z', toolUseId: 'index-z', title: 'First item', categoryId: 'z-first', sourceRefs: [{ sourceId, sourceRevision: 1 }] })
    const second = await coordinator.savePage({ ...base, requestId: 'index-a', toolUseId: 'index-a', title: 'Second item', categoryId: 'a-second' })
    const index = await store.readText('wiki/index.md')

    expect(index.indexOf('## z-first')).toBeLessThan(index.indexOf('## a-second'))
    expect(index).toContain(`pageId: ${first.pageId}`)
    expect(index).toContain('parentPageId: null')
    expect(index).toContain('updatedAt: ')
    expect(index).toContain(`sourceRefs: ${sourceId}@1`)
    expect(index).toContain(`pageId: ${second.pageId}`)
  })

  it('replays completed invocations before checking their stale expected revision', async () => {
    const { root, coordinator } = await fixture()
    const created = await coordinator.savePage(base)
    const update = { ...base, requestId: 'req-2', toolUseId: 'tool-2', pageId: created.pageId, expectedRevision: 1, markdown: 'Updated' }
    const first = await coordinator.savePage(update)
    const replay = await coordinator.savePage(update)
    expect(replay).toEqual(first)
    expect(await readFile(path.join(root, `wiki/${(JSON.parse(await readFile(path.join(root, '.wiki-service/catalog.json'), 'utf8')) as { pages: Array<{ path: string }> }).pages[0].path.split('/').pop()}`), 'utf8')).toContain('Updated')
  })

  it('records stable page, source, and change summary metadata in operation events', async () => {
    const { root, store, coordinator } = await fixture()
    const sourceId = '01234567-89ab-cdef-0123-456789abcdef'
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/1.md`, Buffer.from('source snapshot'))
    const result = await coordinator.savePage({ ...base, sourceRefs: [{ sourceId, sourceRevision: 1 }] })
    const operation = JSON.parse(await readFile(path.join(root, '.wiki-service/operations', `${result.operationId}.json`), 'utf8')) as { successEvent?: Record<string, unknown> }
    expect(operation.successEvent).toMatchObject({ pageId: result.pageId, sourceIds: [sourceId], changeSummary: 'A' })
    const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8')
    expect(log).toContain(`page ${result.pageId}`)
    expect(log).toContain(`sources ${sourceId}`)
    expect(log).toContain('summary A')
  })

  it('rejects invocation key reuse with different input', async () => {
    const { coordinator } = await fixture()
    await coordinator.savePage(base)
    await expect(coordinator.savePage({ ...base, markdown: 'different' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('recovers a crash after page write without duplicating revision or log event', async () => {
    const { root, coordinator } = await fixture()
    await expect(coordinator.savePage({ ...base, crashAt: 'after-target-write' })).rejects.toThrow('injected crash')
    const operations = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, '.wiki-service/operations')))
    const pending = JSON.parse(await readFile(path.join(root, '.wiki-service/operations', operations[0]), 'utf8')) as { status: string; successEvent?: unknown; targetPath: string }
    expect(await readFile(path.join(root, pending.targetPath), 'utf8')).toContain('Body')
    expect(pending).toMatchObject({ status: 'prepared' })
    expect(pending.successEvent).toBeUndefined()
    const result = await coordinator.savePage(base)
    expect(result.revision).toBe(1)
    const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8')
    expect(log.match(/created Alpha/g)).toHaveLength(1)
  })

  it('rejects duplicate title in the same category and parent without writing', async () => {
    const { root, coordinator } = await fixture()
    await coordinator.savePage(base)
    await expect(coordinator.savePage({ ...base, requestId: 'req-2', toolUseId: 'tool-2', title: ' alpha ' })).rejects.toMatchObject({ code: 'title_conflict' })
    const catalog = JSON.parse(await readFile(path.join(root, '.wiki-service/catalog.json'), 'utf8')) as { pages: Array<{ path: string }> }
    await expect(readFile(path.join(root, catalog.pages[0].path), 'utf8')).resolves.toContain('Body')
  })

  it('recovers domain_committed and log-written crashes idempotently', async () => {
    const { root, coordinator } = await fixture()
    await expect(coordinator.savePage({ ...base, crashAt: 'after-domain-commit' })).rejects.toThrow('injected crash')
    const result = await coordinator.savePage(base)
    expect(result.revision).toBe(1)
    const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8')
    expect(log.match(/created Alpha/g)).toHaveLength(1)
  })

  it('reports projection_pending and retries the same committed operation', async () => {
    const { root, store } = await fixture()
    let fail = true
    const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' }] }), beforeProjection: projection => { if (projection === 'log' && fail) { fail = false; throw new Error('projection unavailable') } } })
    await expect(coordinator.savePage(base)).rejects.toMatchObject({ code: 'projection_pending', operationId: expect.any(String) })
    const journals = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, '.wiki-service/operations')))
    const journal = JSON.parse(await readFile(path.join(root, '.wiki-service/operations', journals[0]), 'utf8')) as { status: string }
    expect(journal.status).toBe('domain_committed')
    expect((await coordinator.savePage(base)).revision).toBe(1)
  })

  it('does not let an old projection retry roll the catalog back over a newer revision', async () => {
    const { store } = await fixture()
    let fail = false
    const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [{ id: 'topic', name: 'Topic', status: 'active' }] }), beforeProjection: projection => { if (projection === 'log' && fail) { fail = false; throw new Error('projection unavailable') } } })
    const created = await coordinator.savePage(base)
    const oldUpdate = { ...base, requestId: 'req-old', toolUseId: 'tool-old', pageId: created.pageId, expectedRevision: 1, markdown: 'revision two' }
    fail = true
    await expect(coordinator.savePage(oldUpdate)).rejects.toMatchObject({ code: 'projection_pending' })
    await coordinator.savePage({ ...base, requestId: 'req-new', toolUseId: 'tool-new', pageId: created.pageId, expectedRevision: 2, markdown: 'revision three' })

    await coordinator.savePage(oldUpdate)

    const catalog = await store.readCatalog()
    expect(catalog?.pages[0]?.revision).toBe(3)
    expect(catalog?.pages[0]?.contentHash).toBeTruthy()
    expect(await store.readText(catalog!.pages[0]!.path)).toContain('revision three')
    expect(await store.readText('wiki/index.md')).toContain('Alpha')
  })

  it('rejects moving a page under itself without changing its persisted revision', async () => {
    const { store, coordinator } = await fixture()
    const created = await coordinator.savePage(base)

    await expect(coordinator.movePage({ ...base, requestId: 'req-self-parent', toolUseId: 'tool-self-parent', pageId: created.pageId,
      expectedRevision: 1, parentPageId: created.pageId })).rejects.toMatchObject({ code: 'parent_invalid' })

    expect((await store.readCatalog())?.pages[0]).toMatchObject({ pageId: created.pageId, revision: 1, parentPageId: null })
    expect(parseParent(await store.readText((await store.readCatalog())!.pages[0]!.path))).toBeNull()
    expect(await store.readText('wiki/log.md')).not.toContain('moved Alpha')
  })

  it('restores the prior body when recovering a legacy self-parent move journal', async () => {
    const { store, coordinator } = await fixture()
    const created = await coordinator.savePage(base)
    const catalog = await store.readCatalog()
    const page = catalog!.pages[0]!
    const oldBody = await store.read(page.path)
    const input = { ...base, requestId: 'legacy-self-parent', toolUseId: 'legacy-self-parent-tool', pageId: created.pageId,
      expectedRevision: 1, parentPageId: created.pageId, operationKind: 'moved' as const }
    const operationId = createHash('sha256').update(`${input.requestId}\0${input.toolUseId}`).digest('hex')
    const operationPath = `.wiki-service/operations/${operationId}.json`
    const stagingPath = `.wiki-service/staging/${operationId}.payload`
    const staged = Buffer.from(`${serializeWikiPageMarker({ pageId: created.pageId, categoryId: 'topic', summary: 'A', parentPageId: created.pageId, sourceRefs: [], revision: 2 })}\n# Alpha\n\nBody\n`)
    const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
    const fingerprint = hash(JSON.stringify(canonical({ ...input, crashAt: undefined })))
    await store.write(stagingPath, staged)
    await store.write(page.path, staged)
    await store.write(operationPath, JSON.stringify({ formatVersion: 1, operationId, inputFingerprint: fingerprint, callerId: input.callerId, lane: input.lane,
      status: 'prepared', targetPath: page.path, oldHash: hash(oldBody), newHash: hash(staged), stagingPath,
      result: { pageId: created.pageId, revision: 2, projectionStatus: 'complete', operationId },
      eventMaterial: { operationId, type: 'moved', title: 'Alpha', revision: 2, committedAt: new Date().toISOString() } }))

    await expect(coordinator.movePage(input)).rejects.toMatchObject({ code: 'parent_invalid' })

    expect(await store.read(page.path)).toEqual(oldBody)
    expect((await store.readCatalog())?.pages[0]).toMatchObject({ pageId: created.pageId, revision: 1, parentPageId: null })
    expect(await store.read('.wiki-service/page-history/' + created.pageId + '/1.md')).toEqual(oldBody)
    expect(await store.readText('wiki/log.md')).not.toContain('moved Alpha')
  })

  it('preserves tree, title, and schema invariants through a seeded operation sequence', async () => {
    const { root, coordinator } = await fixture()
    let seed = 0x51a7
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000 }
    const ids: string[] = []
    for (let step = 0; step < 16; step += 1) {
      const shouldCreate = ids.length < 2 || random() < 0.35
      if (shouldCreate) {
        const index = ids.length
        const parentIndex = index > 0 && random() < 0.65 ? Math.floor(random() * index) : undefined
        const result = await coordinator.savePage({ ...base, requestId: `seeded-${step}`, toolUseId: `tool-${step}`, title: `Page ${index}`, summary: '', markdown: `body ${index}`, ...(parentIndex === undefined ? {} : { parentPageId: ids[parentIndex] }) })
        ids.push(result.pageId)
      } else {
        const index = Math.floor(random() * ids.length)
        const pageId = ids[index]!
        const catalogBefore = JSON.parse(await readFile(path.join(root, '.wiki-service/catalog.json'), 'utf8')) as { pages: Array<{ pageId: string; revision: number }> }
        const current = catalogBefore.pages.find(page => page.pageId === pageId)!
        if (random() < 0.5) {
          await coordinator.savePage({ ...base, requestId: `seeded-${step}`, toolUseId: `tool-${step}`, pageId, expectedRevision: current.revision, title: `Page ${index}`, summary: '', markdown: `updated ${step}` })
        } else {
          const parentCandidates = ids.slice(0, index)
          const parentPageId = parentCandidates.length && random() < 0.6 ? parentCandidates[Math.floor(random() * parentCandidates.length)]! : null
          await coordinator.movePage({ ...base, requestId: `seeded-${step}`, toolUseId: `tool-${step}`, pageId, expectedRevision: current.revision, title: `Page ${index}`, summary: '', markdown: `moved ${step}`, parentPageId })
        }
      }
      const catalog = JSON.parse(await readFile(path.join(root, '.wiki-service/catalog.json'), 'utf8')) as { pages: Array<{ pageId: string; title: string; categoryId: string; parentPageId: string | null }> }
      const byId = new Map(catalog.pages.map(page => [page.pageId, page]))
      const siblingTitles = catalog.pages.map(page => `${page.categoryId}\0${page.parentPageId ?? ''}\0${page.title.normalize('NFKC').trim().toLocaleLowerCase()}`)
      expect(new Set(siblingTitles).size).toBe(siblingTitles.length)
      expect(catalog.pages.every(page => page.categoryId === 'topic' && (!page.parentPageId || byId.has(page.parentPageId)))).toBe(true)
      for (const page of catalog.pages) {
        const visited = new Set<string>([page.pageId])
        let parentId = page.parentPageId
        while (parentId) {
          expect(visited.has(parentId)).toBe(false)
          visited.add(parentId)
          parentId = byId.get(parentId)?.parentPageId ?? null
        }
      }
    }
  })

  it('allows equal titles across categories without sharing an activity path', async () => {
    const { coordinator } = await fixture()
    await coordinator.savePage(base)
    const categoryCoordinator = createWikiDomainCoordinator({
      store: (await fixture()).store,
      schema: () => ({ schemaVersion: 1, categories: [{ id: 'other', name: 'Other', status: 'active' }] }),
    })
    const second = await categoryCoordinator.savePage({ ...base, requestId: 'other', toolUseId: 'other', categoryId: 'other' })
    expect(second.pageId).toBeTruthy()
  })

  it('rejects a move that would make the page its own ancestor', async () => {
    const { coordinator } = await fixture()
    const parent = await coordinator.savePage(base)
    const child = await coordinator.savePage({ ...base, requestId: 'child', toolUseId: 'child', title: 'Child', parentPageId: parent.pageId })
    await expect(coordinator.movePage({ ...base, requestId: 'move', toolUseId: 'move', pageId: parent.pageId, expectedRevision: 1, parentPageId: child.pageId })).rejects.toMatchObject({ code: 'parent_invalid' })
  })

  it('rejects changing a parent category when that would invalidate an existing child', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-domain-coordinator-parent-category-'))
    roots.push(root)
    const store = createWikiFileStore(root)
    const coordinator = createWikiDomainCoordinator({ store, schema: () => ({ schemaVersion: 1, categories: [
      { id: 'parent-a', name: 'Parent A', status: 'active' },
      { id: 'parent-b', name: 'Parent B', status: 'active' },
      { id: 'child-c', name: 'Child C', status: 'active', allowedParentCategoryIds: ['parent-a'] },
    ] }) })
    const parent = await coordinator.savePage({ ...base, categoryId: 'parent-a', title: 'Parent' })
    const child = await coordinator.savePage({ ...base, requestId: 'child-create', toolUseId: 'child-create', categoryId: 'child-c', title: 'Child', parentPageId: parent.pageId })

    await expect(coordinator.savePage({ ...base, requestId: 'parent-update', toolUseId: 'parent-update', pageId: parent.pageId,
      expectedRevision: 1, categoryId: 'parent-b', title: 'Parent' })).rejects.toMatchObject({ code: 'parent_invalid' })

    const catalog = await store.readCatalog()
    expect(catalog?.pages.find(page => page.pageId === parent.pageId)).toMatchObject({ categoryId: 'parent-a', revision: 1 })
    expect(catalog?.pages.find(page => page.pageId === child.pageId)).toMatchObject({ categoryId: 'child-c', parentPageId: parent.pageId })
  })
})

function parseParent(text: string): string | null {
  const marker = /<!-- wiki-page:start -->\n(.*?)\n<!-- wiki-page:end -->/s.exec(text)
  return marker ? (JSON.parse(marker[1]!) as { parentPageId: string | null }).parentPageId : null
}
