import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { openWikiPageForContext, readWikiPageForContext, readWikiSourceForContext, searchWikiCatalog } from './wikiDomainTools'
import { createWikiLifecycleController } from './wikiLifecycle'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'

const roots: string[] = []
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-domain-tools-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('Wiki domain search tool', () => {
  it('searches only catalog metadata, returns page IDs and bounded summaries, and never returns paths', async () => {
    const store = createWikiFileStore(tempRoot())
    await store.writeCatalog({ formatVersion: 1, pages: [
      { pageId: 'p-a', path: 'wiki/secrets.md', revision: 2, title: 'Space Assistant', categoryId: 'topic', summary: 'A'.repeat(1200) },
      { pageId: 'p-b', path: 'wiki/other.md', revision: 1, title: 'Unrelated', categoryId: 'topic', summary: 'No match' }
    ] })
    const result = await searchWikiCatalog(store, { query: 'space assistant', limit: 5 })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ pageId: 'p-a', title: 'Space Assistant', revision: 2 })
    expect(result.matches[0]!.summary).toHaveLength(1000)
    expect(JSON.stringify(result)).not.toContain('wiki/secrets.md')
  })

  it('binds cursors to the catalog snapshot and rejects stale or malformed cursors', async () => {
    const store = createWikiFileStore(tempRoot())
    await store.writeCatalog({ formatVersion: 1, pages: [
      { pageId: 'p-a', path: 'wiki/a.md', revision: 1, title: 'Alpha', categoryId: 'topic', summary: 'match' },
      { pageId: 'p-b', path: 'wiki/b.md', revision: 1, title: 'Beta', categoryId: 'topic', summary: 'match' }
    ] })
    const first = await searchWikiCatalog(store, { query: 'match', limit: 1 })
    expect(first.nextCursor).toBeTruthy()
    const second = await searchWikiCatalog(store, { query: 'match', limit: 1, cursor: first.nextCursor })
    expect(second.matches.map(({ pageId }) => pageId)).toEqual(['p-b'])
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'p-c', path: 'wiki/c.md', revision: 1, title: 'Gamma', categoryId: 'topic', summary: 'match' }] })
    await expect(searchWikiCatalog(store, { query: 'match', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'wiki-search-cursor-invalid' })
    await expect(searchWikiCatalog(store, { query: 'match', cursor: '!' })).rejects.toMatchObject({ code: 'wiki-search-cursor-invalid' })
  })

  it('opens an immutable revision and binds bounded read handles to caller and lane', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'p-1', path: 'wiki/a.md', revision: 2, title: 'Alpha', categoryId: 'topic', summary: 'Summary' }] })
    await store.writeImmutable('.wiki-service/page-history/p-1/2.md', Buffer.from('# Alpha\nfirst line\nsecond line\n', 'utf8'))
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-a', lane: 'desktop' }
    const opened = await openWikiPageForContext({ pageId: 'p-1' }, context)
    expect(opened).toMatchObject({ success: true, data: { pageId: 'p-1', revision: 2 } })
    const readHandle = (opened.data as { readHandle: string }).readHandle
    const first = await readWikiPageForContext({ readHandle, startLine: 2, maxChars: 11 }, context)
    expect(first).toMatchObject({ success: true, data: { text: 'first line\n', startLine: 2, hasMore: true } })
    const denied = await readWikiPageForContext({ readHandle }, { ...context, sessionId: 'session-b' })
    expect(denied).toMatchObject({ success: false, error: 'page_read_handle_expired' })
    await store.writeCatalog({ formatVersion: 1, pages: [] })
    expect(await readWikiPageForContext({ readHandle }, context)).toMatchObject({ success: false, error: 'wiki-access-denied' })
  })

  it('reads only a bound source snapshot and binds continuation cursors to caller and lane', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const sourceId = '01234567-89ab-cdef-0123-456789abcdef'
    await store.write('.wiki-service/sources/' + sourceId + '.json', JSON.stringify({ formatVersion: 1, sourceId, sourceRevision: 1, displayName: 'notes.md', projectId: 'project-a' }))
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/1.md`, Buffer.from('甲乙丙丁戊己', 'utf8'))
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-a', lane: 'desktop' }
    const first = await readWikiSourceForContext({ sourceId, maxChars: 2 }, context)
    expect(first).toMatchObject({ success: true, data: { sourceId, sourceRevision: 1, displayName: 'notes.md', text: '甲乙', startOffset: 0, endOffset: 2, hasMore: true } })
    expect(JSON.stringify(first)).not.toContain('.wiki-service')
    const cursor = (first.data as { nextCursor: string }).nextCursor
    const second = await readWikiSourceForContext({ sourceId, cursor, maxChars: 2 }, context)
    expect(second).toMatchObject({ success: true, data: { text: '丙丁', startOffset: 2, endOffset: 4, hasMore: true } })
    expect(await readWikiSourceForContext({ sourceId, cursor, maxChars: 2 }, { ...context, lane: 'lark' })).toMatchObject({ success: false, error: 'source_cursor_invalid' })
  })
})
