import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { applyWikiRestoreForContext, importWikiSourceForContext, listWikiPageRevisionsForContext, openWikiPageForContext, prepareWikiRestoreForContext, proposeWikiSchemaChangeForContext, readWikiPageForContext, readWikiSourceForContext, searchWikiCatalog, updateWikiSchemaForContext } from './wikiDomainTools'
import { createWikiLifecycleController } from './wikiLifecycle'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { createHash } from 'node:crypto'
import { serializeWikiPageMarker } from './wikiReconciler'

const roots: string[] = []
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-domain-tools-'))
  roots.push(root)
  return root
}
async function storeReadText(root: string, relativePath: string): Promise<string> { return createWikiFileStore(root).readText(relativePath) }
async function storeWrite(root: string, relativePath: string, body: string): Promise<void> { await createWikiFileStore(root).write(relativePath, body) }
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

  it('reconciles an external edit before opening the page and pins the new immutable revision', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(path.join(wikiRoot, 'wiki', 'topics'), { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n')
    const oldText = `${serializeWikiPageMarker({ pageId: 'p-external', categoryId: 'topic', summary: '', parentPageId: null, sourceRefs: [], revision: 1 })}\n# External\n\nold body\n`
    const currentText = oldText.replace('old body', 'external edit')
    await store.write('wiki/topics/external.md', currentText)
    await store.writeImmutable('.wiki-service/page-history/p-external/1.md', Buffer.from(oldText))
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'p-external', path: 'wiki/topics/external.md', revision: 1, contentHash: createHash('sha256').update(oldText).digest('hex'), title: 'External', categoryId: 'topic', summary: '' }] })
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-ext', lane: 'desktop' }
    const opened = await openWikiPageForContext({ pageId: 'p-external' }, context)
    expect(opened).toMatchObject({ success: true, data: { pageId: 'p-external', revision: 2 } })
    expect(await store.identity('.wiki-service/page-history/p-external/2.md')).not.toBeNull()
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

  it('imports only an existing application-bound source id and rejects path-like model input', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const sourceId = '12345678-1234-4234-8234-123456789abc'
    const sourcePath = `.wiki-service/source-history/${sourceId}/1.md`
    await storeWrite(wikiRoot, sourcePath, 'trusted content')
    await storeWrite(wikiRoot, `.wiki-service/sources/${sourceId}.json`, JSON.stringify({ formatVersion: 1, sourceId, sourceRevision: 1, displayName: 'trusted.md', projectId: 'project-a', rawPath: 'raw/project-a/notes.md' }))
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-import', lane: 'desktop', remoteContext: { authOwner: 'owner-a' } }
    expect(await importWikiSourceForContext({ sourceRef: '../trusted-source.md' }, context)).toMatchObject({ success: false, error: 'source_missing' })
    const imported = await importWikiSourceForContext({ sourceRef: sourceId }, context)
    expect(imported).toMatchObject({ success: true, data: { sourceId, sourceRevision: 1, displayName: 'trusted.md', projectId: 'project-a' } })
    expect(await storeReadText(wikiRoot, sourcePath)).toBe('trusted content')
  })

  it('lists page revision metadata only after lifecycle readiness and never returns storage paths', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.writeImmutable('.wiki-service/page-history/p-1/1.md', Buffer.from('first snapshot'))
    const result = await listWikiPageRevisionsForContext({ pageId: 'p-1' }, {
      userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-a', lane: 'desktop'
    })
    expect(result).toMatchObject({ success: true, data: [{ revision: 1, externalEdit: false, deleted: false }] })
    expect(JSON.stringify(result)).not.toContain(wikiRoot)
    await createWikiLifecycleController(wikiRoot).markRecoveryRequired()
    expect(await listWikiPageRevisionsForContext({ pageId: 'p-1' }, {
      userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-a', lane: 'desktop'
    })).toMatchObject({ success: false, error: 'wiki_lifecycle_not_ready' })
  })

  it('keeps schema proposals inert and applies them only with a host confirmed matching invocation', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const initial = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Knowledge","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    const proposed = initial.replace('"name":"Topic"', '"name":"Knowledge"')
    await store.write('SCHEMA.md', initial)
    const baseContext = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-a', lane: 'desktop', requestId: 'request-a', toolUseId: 'propose-a' }
    const proposalResult = await proposeWikiSchemaChangeForContext({ content: proposed, expectedSchemaVersion: 1 }, baseContext)
    expect(proposalResult).toMatchObject({ success: true, data: { addedCategoryIds: [], removedCategoryIds: [] } })
    expect(await store.readText('SCHEMA.md')).toBe(initial)
    const proposalId = (proposalResult.data as { proposalId: string }).proposalId
    expect(await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1 }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-unconfirmed', toolUserConfirmed: false, userConfirmationAnswerer: 'user' })).toMatchObject({ success: false, error: 'confirmation_required' })
    expect(await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1 }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-agent', toolUserConfirmed: true, userConfirmationAnswerer: 'agent' })).toMatchObject({ success: false, error: 'confirmation_required' })
    expect(await store.readText('SCHEMA.md')).toBe(initial)
    const applied = await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1 }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-user', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })
    expect(applied).toMatchObject({ success: true, data: { schemaVersion: 2 } })
    expect(await store.readText('SCHEMA.md')).toBe(proposed)
  })

  it('prepares a full restore proposal and applies only the exact material after host user confirmation', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Knowledge","status":"active"}]}\n<!-- wiki-categories:end -->\n')
    const pageId = 'restore-page-1'
    const marker = serializeWikiPageMarker({ pageId: 'restore-page-1', categoryId: 'topic', summary: 'Saved summary', parentPageId: null, sourceRefs: [], revision: 1 })
    const oldText = `${marker}\n# Restored title\n\nOriginal body\n`
    await store.writeImmutable(`.wiki-service/page-history/${pageId}/1.md`, Buffer.from(oldText))
    await store.write('wiki/current.md', `${marker.replace('"revision":1', '"revision":2')}\n# Current title\n\nCurrent body\n`)
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId, path: 'wiki/current.md', revision: 2, contentHash: createHash('sha256').update(`${marker.replace('\"revision\":1', '\"revision\":2')}\n# Current title\n\nCurrent body\n`).digest('hex'), title: 'Current title', categoryId: 'topic', summary: 'Saved summary' }] })
    const base = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-restore', lane: 'desktop', requestId: 'request-restore', toolUseId: 'prepare-restore' }
    const prepared = await prepareWikiRestoreForContext({ pageId, targetRevision: 1, expectedCurrentRevision: 2 }, base)
    expect(prepared.success, JSON.stringify(prepared)).toBe(true)
    expect(prepared).toMatchObject({ success: true, data: { conflicts: [], finalPage: { title: 'Restored title', markdown: 'Original body', categoryId: 'topic' } } })
    const { proposalId, finalPage } = prepared.data as { proposalId: string; finalPage: Record<string, unknown> }
    expect(await applyWikiRestoreForContext({ proposalId, finalPage }, { ...base, toolUseId: 'unconfirmed', toolUserConfirmed: false, userConfirmationAnswerer: 'user' })).toMatchObject({ success: false, error: 'confirmation_required' })
    expect(await applyWikiRestoreForContext({ proposalId, finalPage: { ...finalPage, markdown: 'tampered' } }, { ...base, toolUseId: 'tampered', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })).toMatchObject({ success: false, error: 'restore_material_mismatch' })
    const applied = await applyWikiRestoreForContext({ proposalId, finalPage }, { ...base, toolUseId: 'apply-restore', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })
    expect(applied).toMatchObject({ success: true, data: { pageId, revision: 3 } })
    expect(await store.readText('wiki/current.md')).toContain('Original body')
  })
})
