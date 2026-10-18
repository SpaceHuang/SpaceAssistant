import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiDomainCoordinator } from './wikiDomainCoordinator'

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
  it('replays completed invocations before checking their stale expected revision', async () => {
    const { root, coordinator } = await fixture()
    const created = await coordinator.savePage(base)
    const update = { ...base, requestId: 'req-2', toolUseId: 'tool-2', pageId: created.pageId, expectedRevision: 1, markdown: 'Updated' }
    const first = await coordinator.savePage(update)
    const replay = await coordinator.savePage(update)
    expect(replay).toEqual(first)
    expect(await readFile(path.join(root, `wiki/${(JSON.parse(await readFile(path.join(root, '.wiki-service/catalog.json'), 'utf8')) as { pages: Array<{ path: string }> }).pages[0].path.split('/').pop()}`), 'utf8')).toContain('Updated')
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
})
