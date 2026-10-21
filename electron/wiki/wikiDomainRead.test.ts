import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiDomainReadService } from './wikiDomainRead'
import { serializeWikiPageMarker } from './wikiReconciler'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-domain-read-'))
  roots.push(root)
  return { root, store: createWikiFileStore(root) }
}

describe('WikiDomainReadService', () => {
  it('returns authored Markdown body without the storage marker or generated title heading', async () => {
    const { store } = await fixture()
    const body = '# Guide\n\n## Details\n\nAuthored content.\n'
    const snapshot = `${serializeWikiPageMarker({ pageId: 'p-1', categoryId: 'topic', summary: 'summary', parentPageId: null, sourceRefs: [], revision: 3 })}\n# Guide\n\n${body}`
    await store.writeImmutable('.wiki-service/page-history/p-1/3.md', snapshot)
    const service = createWikiDomainReadService({ store, pages: [{ pageId: 'p-1', title: 'Guide', categoryId: 'topic', path: 'wiki/guide.md', revision: 3 }] })

    const opened = await service.openPage('p-1', { callerId: 'caller', lane: 'desktop' })
    const read = await service.readPage(opened.readHandle, { callerId: 'caller', lane: 'desktop' })

    expect(opened.charCount).toBe(Array.from(body).length)
    expect(read.text).toBe(body)
    expect(read.text).not.toContain('wiki-page:start')
    expect(read.text).not.toContain('"pageId"')
  })

  it('returns metadata from the requested historical revision', async () => {
    const { store } = await fixture()
    const snapshot = `${serializeWikiPageMarker({ pageId: 'p-history', categoryId: 'concept', summary: 'old summary', parentPageId: 'parent-old', sourceRefs: [{ sourceId: 'source-old', sourceRevision: 2 }], revision: 2 })}\n# Old title\n\nOld body\n`
    await store.writeImmutable('.wiki-service/page-history/p-history/2.md', snapshot)
    const service = createWikiDomainReadService({ store, pages: [{ pageId: 'p-history', title: 'Current title', categoryId: 'topic', summary: 'current summary', parentPageId: 'parent-current', sourceRefs: [{ sourceId: 'source-current', sourceRevision: 5 }], path: 'wiki/page.md', revision: 3 }] })

    const opened = await service.openPage('p-history', { callerId: 'caller', lane: 'desktop' }, 2)
    const read = await service.readPage(opened.readHandle, { callerId: 'caller', lane: 'desktop' })

    expect(opened).toMatchObject({ revision: 2, title: 'Old title', categoryId: 'concept', summary: 'old summary', parentPageId: 'parent-old', sourceRefs: [{ sourceId: 'source-old', sourceRevision: 2 }] })
    expect(read.text).toBe('Old body\n')
  })

  it('reads immutable page snapshots with bounded, Unicode-safe cursors', async () => {
    const { store } = await fixture()
    await store.writeImmutable('.wiki-service/page-history/p-1/1.md', `${'😀'.repeat(8)}\nsecond line\n`)
    const service = createWikiDomainReadService({ store, pages: [{ pageId: 'p-1', title: 'A', categoryId: 'topic', path: 'wiki/a.md', revision: 1 }], maxChars: 5 })
    const opened = await service.openPage('p-1', { callerId: 'caller', lane: 'chat' })
    const first = await service.readPage(opened.readHandle, { callerId: 'caller', lane: 'chat' }, { maxChars: 5 })
    expect(first.text).toBe('😀😀😀😀😀')
    expect(first.hasMore).toBe(true)
    const second = await service.readPage(opened.readHandle, { callerId: 'caller', lane: 'chat' }, { cursor: first.nextCursor })
    expect(second.text).toBe('😀😀😀\ns')
    expect(second.startOffset).toBe(5)
  })

  it('pins a handle to a revision and rechecks authorization on every read', async () => {
    const { store } = await fixture()
    await store.writeImmutable('.wiki-service/page-history/p-1/2.md', 'snapshot')
    const authorize = vi.fn().mockResolvedValue(true)
    const service = createWikiDomainReadService({ store, pages: [{ pageId: 'p-1', title: 'A', categoryId: 'topic', path: 'wiki/a.md', revision: 3 }], authorize })
    const opened = await service.openPage('p-1', { callerId: 'c', lane: 'project' }, 2)
    authorize.mockResolvedValue(false)
    await expect(service.readPage(opened.readHandle, { callerId: 'c', lane: 'project' })).rejects.toMatchObject({ code: 'wiki-access-denied' })
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('returns the same unavailable error for unknown and unauthorized sources', async () => {
    const { root, store } = await fixture()
    const service = createWikiDomainReadService({ store, pages: [], sourceBindings: [{ sourceId: 's-1', sourceRevision: 1, displayName: 'source', path: path.join(root, 'private.txt'), projectId: 'project-2' }], authorizeSource: async () => false })
    await expect(service.readSource('missing', { callerId: 'c', lane: 'chat' })).rejects.toMatchObject({ code: 'wiki-source-unavailable' })
    await expect(service.readSource('s-1', { callerId: 'c', lane: 'chat' })).rejects.toMatchObject({ code: 'wiki-source-unavailable' })
  })
})
