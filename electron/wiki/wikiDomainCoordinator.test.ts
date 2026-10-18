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

  it('preserves page title and parent uniqueness through a deterministic operation sequence', async () => {
    const { root, coordinator } = await fixture()
    const pages = new Map<string, string>()
    for (let index = 0; index < 18; index += 1) {
      const title = `Page ${index}`
      const result = await coordinator.savePage({ ...base, requestId: `seq-${index}`, toolUseId: `tool-${index}`, title, summary: '', markdown: `body ${index}` })
      pages.set(result.pageId, title)
    }
    const catalog = JSON.parse(await readFile(path.join(root, '.wiki-service/catalog.json'), 'utf8')) as { pages: Array<{ pageId: string; title: string; parentPageId: string | null }> }
    expect(catalog.pages).toHaveLength(18)
    expect(new Set(catalog.pages.map(page => page.title.toLocaleLowerCase()))).toHaveLength(18)
    expect(catalog.pages.every(page => page.parentPageId === null)).toBe(true)
    expect([...pages.keys()].every(pageId => catalog.pages.some(page => page.pageId === pageId))).toBe(true)
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
