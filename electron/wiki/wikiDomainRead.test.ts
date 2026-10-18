import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiDomainReadService } from './wikiDomainRead'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-domain-read-'))
  roots.push(root)
  return { root, store: createWikiFileStore(root) }
}

describe('WikiDomainReadService', () => {
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
