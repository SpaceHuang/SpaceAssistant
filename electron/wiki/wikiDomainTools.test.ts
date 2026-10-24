import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { applyWikiRestoreForContext, createWikiDomainTools, getWikiSchemaForContext, importWikiSourceForContext, listWikiPageRevisionsForContext, moveWikiPageForContext, openWikiPageForContext, prepareWikiRestoreForContext, proposeWikiSchemaChangeForContext, readWikiPageForContext, readWikiSourceForContext, saveWikiPageForContext, searchWikiCatalog, searchWikiForContext, updateWikiSchemaForContext } from './wikiDomainTools'
import { createWikiLifecycleController } from './wikiLifecycle'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { createHash } from 'node:crypto'
import { serializeWikiPageMarker } from './wikiReconciler'
import { reconcileExternalWikiChanges } from './wikiReconciliationService'

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
  it('explains that an update must include the existing pageId when expectedRevision is supplied', async () => {
    const result = await saveWikiPageForContext({
      title: 'Deprecated page', categoryId: 'topic', summary: 'deprecated', markdown: 'deprecated body',
      schemaVersion: 1, expectedRevision: 1
    }, { sessionId: 'session-update', lane: 'desktop', requestId: 'request-update', toolUseId: 'tool-update' })
    expect(result).toMatchObject({ success: false, error: 'wiki_page_id_required_for_update' })
  })

  it('saves and moves pages through the domain coordinator, including an omitted root parent', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n')
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-write', lane: 'desktop', requestId: 'request-save', toolUseId: 'tool-save' }

    const created = await saveWikiPageForContext({ title: 'Parent', categoryId: 'topic', summary: 'parent', markdown: 'parent body', schemaVersion: 1 }, context)
    expect(created).toMatchObject({ success: true, data: { revision: 1 } })
    const parentPageId = (created as { data: { pageId: string } }).data.pageId
    const child = await saveWikiPageForContext({ title: 'Child', categoryId: 'topic', summary: 'child', markdown: 'child body', schemaVersion: 1 }, { ...context, requestId: 'request-child', toolUseId: 'tool-child' })
    const childPageId = (child as { data: { pageId: string } }).data.pageId
    expect(await saveWikiPageForContext({ pageId: childPageId, expectedRevision: 1, title: 'Child', categoryId: 'topic', summary: 'child', markdown: 'child body', schemaVersion: 1, parentPageId }, { ...context, requestId: 'request-reparent', toolUseId: 'tool-reparent' })).toMatchObject({ success: false, error: 'wiki_page_input_invalid' })

    const moved = await moveWikiPageForContext({ pageId: childPageId, parentPageId, expectedRevision: 1 }, { ...context, requestId: 'request-move', toolUseId: 'tool-move' })
    expect(moved).toMatchObject({ success: true, data: { pageId: childPageId, revision: 2 } })
    expect((await store.readCatalog())?.pages.find(page => page.pageId === childPageId)?.parentPageId).toBe(parentPageId)
    const toRoot = await moveWikiPageForContext({ pageId: childPageId, expectedRevision: 2 }, { ...context, requestId: 'request-root', toolUseId: 'tool-root' })
    expect(toRoot).toMatchObject({ success: true, data: { pageId: childPageId, revision: 3 } })
    expect((await store.readCatalog())?.pages.find(page => page.pageId === childPageId)?.parentPageId).toBeNull()
  })

  it('rejects save calls with unbound source revisions and missing invocation identity', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n')
    const sourceId = '01234567-89ab-cdef-0123-456789abcdef'
    await store.write(`.wiki-service/sources/${sourceId}.json`, JSON.stringify({ formatVersion: 1, sourceId, sourceRevision: 2, displayName: 'source.md', rawPath: 'raw/project/source.md' }))
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/1.md`, Buffer.from('source revision one'))
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-write', lane: 'desktop', requestId: 'request-invalid', toolUseId: 'tool-invalid' }
    expect(await saveWikiPageForContext({ title: 'Invalid', categoryId: 'topic', summary: '', markdown: 'body', schemaVersion: 1, sourceRefs: [{ sourceId, sourceRevision: 2 }] }, context)).toMatchObject({ success: false, error: 'source_missing' })
    const valid = await saveWikiPageForContext({ title: 'Valid', categoryId: 'topic', summary: '', markdown: 'body', schemaVersion: 1, sourceRefs: [{ sourceId, sourceRevision: 1 }] }, { ...context, requestId: 'request-valid', toolUseId: 'tool-valid' })
    expect(valid).toMatchObject({ success: true, data: { revision: 1 } })
    expect(await saveWikiPageForContext({ title: 'Invalid', categoryId: 'topic', summary: '', markdown: 'body', schemaVersion: 1 }, { ...context, requestId: '' })).toMatchObject({ success: false, error: 'wiki_invocation_invalid' })
    const saved = (await store.readCatalog())?.pages[0]
    expect(saved).toMatchObject({ title: 'Valid', revision: 1 })
    expect(await store.readText(saved!.path)).toContain(`\"sourceId\":\"${sourceId}\"`)
  })

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

  it('searches authored body text and returns a line snippet, stable reference, and merged project attribution', async () => {
    const store = createWikiFileStore(tempRoot())
    const sourceA = '11111111-1111-4111-8111-111111111111'
    const sourceB = '22222222-2222-4222-8222-222222222222'
    await store.writeCatalog({ formatVersion: 1, pages: [
      { pageId: 'p-body', path: 'wiki/body.md', revision: 4, title: 'A generic title', categoryId: 'topic', summary: 'A generic summary', sourceRefs: [
        { sourceId: sourceA, sourceRevision: 2 }, { sourceId: sourceB, sourceRevision: 1 }
      ] }
    ] })
    await store.write('wiki/body.md', `${serializeWikiPageMarker({ pageId: 'p-body', categoryId: 'topic', summary: 'A generic summary', parentPageId: null, sourceRefs: [
      { sourceId: sourceA, sourceRevision: 2 }, { sourceId: sourceB, sourceRevision: 1 }
    ], revision: 4 })}\n# A generic title\n\nFirst line\nUniqueNeedle appears here\n`)
    await store.write(`.wiki-service/sources/${sourceA}.json`, JSON.stringify({ formatVersion: 1, sourceId: sourceA, sourceRevision: 2, displayName: 'a.md', projectId: 'project-a' }))
    await store.write(`.wiki-service/sources/${sourceB}.json`, JSON.stringify({ formatVersion: 1, sourceId: sourceB, sourceRevision: 1, displayName: 'b.md', projectId: 'project-b' }))

    const result = await searchWikiCatalog(store, { query: 'UniqueNeedle' })

    expect(result).toMatchObject({ totalMatches: 1, matches: [{ pageId: 'p-body', pageRef: { type: 'wiki_page', pageId: 'p-body' }, matchLine: 2,
      snippet: 'UniqueNeedle appears here', sourceAttribution: { sourceIds: [sourceA, sourceB], projectIds: ['project-a', 'project-b'] } }] })
    expect(JSON.stringify(result)).not.toContain('wiki/body.md')
  })

  it('searches current catalog data without rewriting unchanged page files', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(path.join(wikiRoot, 'wiki', 'topics'), { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const schema = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    await store.write('SCHEMA.md', schema)
    await store.write('.wiki-service/catalog.json', JSON.stringify({ formatVersion: 1, pages: [
      { pageId: 'p-catalog', path: 'wiki/topics/page.md', revision: 2, title: 'Runtime', categoryId: 'topic', summary: 'indexed summary', contentHash: 'indexed-hash' }
    ] }))
    const unchangedPage = `${serializeWikiPageMarker({ pageId: 'p-catalog', categoryId: 'topic', summary: 'indexed summary', parentPageId: null, sourceRefs: [], revision: 2 })}\n# Runtime\n\nindexed body\n`
    await store.write('wiki/topics/page.md', unchangedPage)
    const storedPage = (await store.readCatalog())!.pages[0]!
    const hash = createHash('sha256').update(unchangedPage).digest('hex')
    await store.write('.wiki-service/catalog.json', JSON.stringify({ formatVersion: 1, pages: [{ ...storedPage, contentHash: hash }] }))
    await store.write('.wiki-service/schema-state.json', JSON.stringify({ formatVersion: 1, schemaVersion: 1, contentHash: createHash('sha256').update(schema).digest('hex') }))

    const result = await searchWikiForContext({ query: 'runtime' }, { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG })

    expect(result).toMatchObject({ success: true, data: { matches: [{ pageId: 'p-catalog', title: 'Runtime', revision: 2 }] } })
    expect(await store.readText('wiki/topics/page.md')).toBe(unchangedPage)
    expect((await store.readCatalog())?.pages[0]).toMatchObject({ pageId: 'p-catalog', revision: 2, contentHash: hash })
  })

  it('discovers externally added pages before the first domain save and makes them readable', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{\"formatVersion\":1,\"categories\":[{\"id\":\"topic\",\"name\":\"Topic\",\"description\":\"Topics\",\"status\":\"active\"}]}\n<!-- wiki-categories:end -->\n')
    await store.write('wiki/external.md', `${serializeWikiPageMarker({ pageId: 'external-page', categoryId: 'topic', summary: 'External summary', parentPageId: null, sourceRefs: [], revision: 1 })}\n# External\n\nDiscovered body\n`)
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-first-discovery', lane: 'desktop' }

    const search = await searchWikiForContext({ query: 'External' }, context)
    expect(search).toMatchObject({ success: true, data: { totalMatches: 1, matches: [{ pageId: 'external-page', revision: 1 }] } })
    const opened = await openWikiPageForContext({ pageId: 'external-page' }, context)
    expect(opened).toMatchObject({ success: true, data: { pageId: 'external-page', revision: 1 } })
    const readHandle = (opened as { data: { readHandle: string } }).data.readHandle
    expect(await readWikiPageForContext({ readHandle }, context)).toMatchObject({ success: true, data: { text: 'Discovered body\n' } })
  })

  it('reconciles externally deleted pages before search returns catalog results', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{\"formatVersion\":1,\"categories\":[{\"id\":\"topic\",\"name\":\"Topic\",\"description\":\"Topics\",\"status\":\"active\"}]}\n<!-- wiki-categories:end -->\n')
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-search-delete', lane: 'desktop', requestId: 'request-search-delete', toolUseId: 'tool-search-delete' }
    const saved = await saveWikiPageForContext({ title: 'Alpha', categoryId: 'topic', summary: 'Old summary', markdown: 'Body', schemaVersion: 1 }, context)
    const pageId = (saved as { data: { pageId: string } }).data.pageId
    const page = (await store.readCatalog())!.pages.find(item => item.pageId === pageId)!
    await store.remove(page.path)

    const result = await searchWikiForContext({ query: 'Alpha' }, context)

    expect(result).toMatchObject({ success: true, data: { totalMatches: 0, matches: [] } })
    expect((await store.readCatalog())?.tombstones).toContainEqual(expect.objectContaining({ pageId, deleted: true }))
  })

  it('does not persist an externally edited parent cycle', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{\"formatVersion\":1,\"categories\":[{\"id\":\"topic\",\"name\":\"Topic\",\"description\":\"Topics\",\"status\":\"active\"}]}\n<!-- wiki-categories:end -->\n')
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-parent-cycle', lane: 'desktop', requestId: 'request-parent-cycle', toolUseId: 'tool-parent-cycle' }
    const saved = await saveWikiPageForContext({ title: 'Alpha', categoryId: 'topic', summary: 'Summary', markdown: 'Body', schemaVersion: 1 }, context)
    const pageId = (saved as { data: { pageId: string } }).data.pageId
    const page = (await store.readCatalog())!.pages.find(item => item.pageId === pageId)!
    const before = await store.readText(page.path)
    await store.write(page.path, before.replace('"parentPageId":null', `"parentPageId":"${pageId}"`))

    const result = await reconcileExternalWikiChanges(store)

    expect(result.diagnostics.map(item => item.code)).toContain('wiki-page-parent-cycle')
    expect((await store.readCatalog())?.pages).toMatchObject([{ pageId, revision: 1, parentPageId: null }])
    expect(await store.identity(`.wiki-service/page-history/${pageId}/2.md`)).toBeNull()
  })

  it('opens and reads a retained revision after external deletion', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{\"formatVersion\":1,\"categories\":[{\"id\":\"topic\",\"name\":\"Topic\",\"description\":\"Topics\",\"status\":\"active\"}]}\n<!-- wiki-categories:end -->\n')
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-open-deleted', lane: 'desktop', requestId: 'request-open-deleted', toolUseId: 'tool-open-deleted' }
    const saved = await saveWikiPageForContext({ title: 'Alpha', categoryId: 'topic', summary: 'Summary', markdown: 'Retained body', schemaVersion: 1 }, context)
    const pageId = (saved as { data: { pageId: string } }).data.pageId
    const page = (await store.readCatalog())!.pages.find(item => item.pageId === pageId)!
    await store.remove(page.path)
    expect((await reconcileExternalWikiChanges(store)).tombstones).toContainEqual(expect.objectContaining({ pageId, deleted: true }))

    expect(await listWikiPageRevisionsForContext({ pageId }, context)).toMatchObject({ success: true, data: [{ revision: 1, deleted: true }] })
    const opened = await openWikiPageForContext({ pageId, revision: 1 }, context)
    expect(opened).toMatchObject({ success: true, data: { pageId, revision: 1 } })
    const readHandle = (opened as { data: { readHandle: string } }).data.readHandle
    expect(await readWikiPageForContext({ readHandle }, context)).toMatchObject({ success: true, data: { text: 'Retained body\n' } })
    expect(await openWikiPageForContext({ pageId }, context)).toMatchObject({ success: true, data: { pageId, revision: 1, deleted: true } })
  })

  it('reconciles a valid external SCHEMA edit before returning its version', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const initial = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    await store.write('SCHEMA.md', initial)
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-external-schema', lane: 'desktop', requestId: 'request-schema-page', toolUseId: 'tool-schema-page' }
    await expect(saveWikiPageForContext({ title: 'Page', categoryId: 'topic', summary: '', markdown: 'body', schemaVersion: 1 }, context)).resolves.toMatchObject({ success: true })
    const external = initial.replace('"name":"Topic"', '"name":"Renamed"')
    await store.write('SCHEMA.md', external)

    const result = await getWikiSchemaForContext(context)

    expect(result).toMatchObject({ success: true, data: { valid: true, schemaVersion: 2, content: external, categories: [{ id: 'topic', name: 'Renamed' }] } })
    expect(JSON.parse(await store.readText('.wiki-service/schema-state.json'))).toMatchObject({ schemaVersion: 2, contentHash: createHash('sha256').update(external).digest('hex') })
    expect(await store.readText('.wiki-service/schema-history/2.md')).toBe(external)
  })

  it('preserves project attribution for historical source revisions across page surfaces', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const schema = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    await store.write('SCHEMA.md', schema)
    const sourceId = '33333333-3333-4333-8333-333333333333'
    await store.write(`.wiki-service/sources/${sourceId}.json`, JSON.stringify({ formatVersion: 1, sourceId, sourceRevision: 2, displayName: 'source.md', projectId: 'project-a', rawPath: 'raw/project-a/source.md' }))
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/1.md`, Buffer.from('source revision one'))
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/2.md`, Buffer.from('source revision two'))
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-source-attribution', lane: 'desktop', requestId: 'request-source-page', toolUseId: 'tool-source-page' }
    const saved = await saveWikiPageForContext({ title: 'Attributed page', categoryId: 'topic', summary: 'source-backed', markdown: 'attribution needle', schemaVersion: 1, sourceRefs: [{ sourceId, sourceRevision: 1 }] }, context)
    expect(saved).toMatchObject({ success: true, data: { revision: 1 } })
    const pageId = (saved as { data: { pageId: string } }).data.pageId
    const expectedAttribution = { sourceIds: [sourceId], projectIds: ['project-a'] }

    expect(await searchWikiCatalog(store, { query: 'attribution needle' })).toMatchObject({ matches: [{ pageId, sourceAttribution: expectedAttribution }] })
    expect(await openWikiPageForContext({ pageId }, context)).toMatchObject({ success: true, data: { sourceAttribution: expectedAttribution } })
    expect(await listWikiPageRevisionsForContext({ pageId }, context)).toMatchObject({ success: true, data: [{ revision: 1, sourceAttribution: expectedAttribution }] })
  })

  it('returns parser diagnostics for invalid SCHEMA instead of masking it as an external conflict', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const lastValid = '# Valid\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    await store.write('SCHEMA.md', lastValid)
    await store.writeImmutable('.wiki-service/schema-history/1.md', lastValid)
    await store.write('.wiki-service/schema-state.json', JSON.stringify({ formatVersion: 1, schemaVersion: 1, contentHash: createHash('sha256').update(lastValid).digest('hex') }))
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\nnot-json\n<!-- wiki-categories:end -->\n')
    const result = await getWikiSchemaForContext({ userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG })
    expect(result).toMatchObject({ success: true, data: { valid: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]), lastValid: { schemaVersion: 1, content: lastValid } } })
  })

  it('exposes the stable structured error envelope through the registered Wiki tool', async () => {
    const userDataDir = tempRoot()
    const tool = createWikiDomainTools().find(candidate => candidate.name === 'memory.wiki_search')!
    const requestId = 'registered-search-error'
    const toolUseId = 'registered-search-error-tool'
    const runtimeContext = { userDataDir, requestId, toolUseId }
    const handle = await tool.begin({ query: 'runtime' }, { requestId, toolUseId, executionContext: runtimeContext as never })
    const executionContext = { requestId, toolUseId, runtimeContext, signal: new AbortController().signal }
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()
    await handle.validatePrepared(executionContext)
    handle.finishValidation()
    const result = await handle.execute(executionContext)
    expect(result).toMatchObject({ success: false, error: 'wiki_lifecycle_unavailable', data: { error: { code: 'wiki_lifecycle_unavailable', message: expect.any(String), retryable: false, diagnostics: [] } } })
  })

  it('reports Wiki lifecycle unavailable from search when Wiki config is absent', async () => {
    const userDataDir = tempRoot()
    const result = await searchWikiForContext({ query: 'runtime' }, { userDataDir })
    expect(result).toMatchObject({ success: false, error: 'wiki_lifecycle_unavailable' })
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

  it('returns authored Markdown through the desktop page tools, not the storage envelope', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const body = '# Guide\n\n## Details\n\nAuthored content.\n'
    const snapshot = `${serializeWikiPageMarker({ pageId: 'p-envelope', categoryId: 'topic', summary: 'summary', parentPageId: null, sourceRefs: [], revision: 3 })}\n# Guide\n\n${body}`
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'p-envelope', path: 'wiki/guide.md', revision: 3, title: 'Guide', categoryId: 'topic', summary: 'summary' }] })
    await store.writeImmutable('.wiki-service/page-history/p-envelope/3.md', Buffer.from(snapshot))
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-envelope', lane: 'desktop' }

    const opened = await openWikiPageForContext({ pageId: 'p-envelope' }, context)
    expect(opened).toMatchObject({ success: true, data: { title: 'Guide', revision: 3, charCount: Array.from(body).length } })
    const readHandle = (opened.data as { readHandle: string }).readHandle
    const read = await readWikiPageForContext({ readHandle }, context)

    expect(read).toMatchObject({ success: true, data: { text: body, startOffset: 0, endOffset: Array.from(body).length, hasMore: false } })
    expect(JSON.stringify(read)).not.toContain('wiki-page:start')
    expect(JSON.stringify(read)).not.toContain('"pageId"')
  })

  it('saves a desktop page and reads the authored body back through the page tools', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n')
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-save-read', lane: 'desktop', requestId: 'request-save-read', toolUseId: 'tool-save-read' }

    const saved = await saveWikiPageForContext({ title: 'Desktop round trip', categoryId: 'topic', summary: 'round trip', markdown: 'Authored desktop body', schemaVersion: 1 }, context)
    expect(saved).toMatchObject({ success: true, data: { revision: 1, projectionStatus: 'complete' } })
    const pageId = (saved as { data: { pageId: string } }).data.pageId
    const opened = await openWikiPageForContext({ pageId }, context)
    expect(opened).toMatchObject({ success: true, data: { pageId, revision: 1, title: 'Desktop round trip', charCount: 22 } })
    const readHandle = (opened as { data: { readHandle: string } }).data.readHandle
    const read = await readWikiPageForContext({ readHandle }, context)

    expect(read).toMatchObject({ success: true, data: { text: 'Authored desktop body\n', startOffset: 0, hasMore: false } })
    expect(JSON.stringify(read)).not.toContain('wiki-page:start')
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

  it('reconciles changed page and schema metadata before search results', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(path.join(wikiRoot, 'wiki', 'topics'), { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const previousSchema = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Topics","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    const schema = previousSchema.replace('# Rules', '# Rules\n\nExternally clarified rule.')
    await store.write('SCHEMA.md', schema)
    await store.writeImmutable('.wiki-service/schema-history/1.md', previousSchema)
    await store.write('.wiki-service/schema-state.json', JSON.stringify({ formatVersion: 1, schemaVersion: 1, contentHash: createHash('sha256').update(previousSchema).digest('hex') }))
    const previousPage = `${serializeWikiPageMarker({ pageId: 'p-reconcile', categoryId: 'topic', summary: 'external page', parentPageId: null, sourceRefs: [], revision: 1 })}\n# External Page\n\nprevious content\n`
    const page = previousPage.replace('previous content', 'written outside the app')
    await store.write('wiki/topics/external.md', page)
    await store.writeImmutable('.wiki-service/page-history/p-reconcile/1.md', Buffer.from(previousPage))
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'p-reconcile', path: 'wiki/topics/external.md', revision: 1, contentHash: createHash('sha256').update(previousPage).digest('hex'), title: 'External Page', categoryId: 'topic', summary: 'external page' }] })
    await store.write('raw/e16-fixture/source.md', '# external raw source\n')

    const result = await searchWikiForContext({ query: '' }, { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG })

    expect(result).toMatchObject({ success: true, data: { matches: [{ pageId: 'p-reconcile', title: 'External Page', revision: 2 }] } })
    expect((await store.readText('SCHEMA.md')).trim()).toBe(schema.trim())
    expect(await store.readText('wiki/topics/external.md')).toContain('written outside the app')
    expect(await store.readText('raw/e16-fixture/source.md')).toContain('external raw source')
    expect(await store.readCatalog()).toMatchObject({ pages: [{ pageId: 'p-reconcile', path: 'wiki/topics/external.md', revision: 2 }] })
    expect(await store.identity('wiki/index.md')).not.toBeNull()
    expect(await store.identity('wiki/log.md')).not.toBeNull()
    expect(JSON.parse(await store.readText('.wiki-service/schema-state.json'))).toMatchObject({ schemaVersion: 2 })
    expect(await store.identity('.wiki-service/page-history/p-reconcile/2.md')).not.toBeNull()
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
    const { proposalId, diff } = proposalResult.data as { proposalId: string; diff: { before: string; after: string } }
    expect(await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1, proposalDiff: diff }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-unconfirmed', toolUserConfirmed: false, userConfirmationAnswerer: 'user' })).toMatchObject({ success: false, error: 'confirmation_required' })
    expect(await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1, proposalDiff: diff }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-agent', toolUserConfirmed: true, userConfirmationAnswerer: 'agent' })).toMatchObject({ success: false, error: 'confirmation_required' })
    expect(await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1, proposalDiff: { ...diff, after: initial }, }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-tampered', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })).toMatchObject({ success: false, error: 'schema_material_mismatch' })
    expect(await store.readText('SCHEMA.md')).toBe(initial)
    const applied = await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1, proposalDiff: diff }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-user', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })
    expect(applied).toMatchObject({ success: true, data: { schemaVersion: 2 } })
    expect(await store.readText('SCHEMA.md')).toBe(proposed)
  })

  it('requires the exact proposal diff in the host-confirmed schema tool call', async () => {
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
    const { proposalId, diff } = proposalResult.data as { proposalId: string; diff: { before: string; after: string } }
    expect(await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1 }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-missing-diff', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })).toMatchObject({ success: false, error: 'schema_material_mismatch' })
    const applied = await updateWikiSchemaForContext({ proposalId, expectedSchemaVersion: 1, proposalDiff: diff }, { ...baseContext, requestId: 'request-b', toolUseId: 'apply-user-stored', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })
    expect(applied).toMatchObject({ success: true, data: { schemaVersion: 2 } })
    expect(await store.readText('SCHEMA.md')).toBe(proposed)
  })

  it('keeps existing pages readable while their category is deprecated and allows reactivation', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const activeSchema = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Knowledge","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    const deprecatedSchema = activeSchema.replace('"status":"active"', '"status":"deprecated"')
    await store.write('SCHEMA.md', activeSchema)
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-deprecated', lane: 'desktop', requestId: 'request-deprecate', toolUseId: 'tool-deprecate' }
    const saved = await saveWikiPageForContext({ title: 'Existing page', categoryId: 'topic', summary: 'kept', markdown: 'Existing body', schemaVersion: 1 }, context)
    expect(saved).toMatchObject({ success: true, data: { revision: 1 } })
    const pageId = (saved as { data: { pageId: string } }).data.pageId

    const deprecateProposal = await proposeWikiSchemaChangeForContext({ content: deprecatedSchema, expectedSchemaVersion: 1 }, context)
    expect(deprecateProposal).toMatchObject({ success: true })
    const deprecate = (deprecateProposal as { success: true; data: { proposalId: string; diff: { before: string; after: string } } }).data
    expect(await updateWikiSchemaForContext({ proposalId: deprecate.proposalId, expectedSchemaVersion: 1, proposalDiff: deprecate.diff }, {
      ...context, requestId: 'request-apply-deprecate', toolUseId: 'tool-apply-deprecate', toolUserConfirmed: true, userConfirmationAnswerer: 'user'
    })).toMatchObject({ success: true, data: { schemaVersion: 2 } })

    const opened = await openWikiPageForContext({ pageId }, context)
    expect(opened).toMatchObject({ success: true, data: { pageId, revision: 1 } })
    expect(await getWikiSchemaForContext(context)).toMatchObject({ success: true, data: { schemaVersion: 2, categories: [{ id: 'topic', status: 'deprecated' }] } })
    expect(await readWikiPageForContext({ readHandle: (opened as { data: { readHandle: string } }).data.readHandle }, context)).toMatchObject({ success: true, data: { text: 'Existing body\n' } })

    const reactivateProposal = await proposeWikiSchemaChangeForContext({ content: activeSchema, expectedSchemaVersion: 2 }, { ...context, requestId: 'request-propose-reactivate', toolUseId: 'tool-propose-reactivate' })
    expect(reactivateProposal).toMatchObject({ success: true })
    const reactivate = (reactivateProposal as { success: true; data: { proposalId: string; diff: { before: string; after: string } } }).data
    expect(await updateWikiSchemaForContext({ proposalId: reactivate.proposalId, expectedSchemaVersion: 2, proposalDiff: reactivate.diff }, {
      ...context, requestId: 'request-apply-reactivate', toolUseId: 'tool-apply-reactivate', toolUserConfirmed: true, userConfirmationAnswerer: 'user'
    })).toMatchObject({ success: true, data: { schemaVersion: 3 } })
    expect(await openWikiPageForContext({ pageId }, context)).toMatchObject({ success: true, data: { pageId, revision: 1 } })
  })

  it('passes host user confirmation provenance through the registered schema update tool', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    const initial = '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Knowledge","status":"active"}]}\n<!-- wiki-categories:end -->\n'
    const proposed = initial.replace('"name":"Topic"', '"name":"Updated"')
    await store.write('SCHEMA.md', initial)
    const proposalResult = await proposeWikiSchemaChangeForContext({ content: proposed, expectedSchemaVersion: 1 }, {
      userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-registered', lane: 'desktop', requestId: 'request-propose', toolUseId: 'tool-propose'
    })
    expect(proposalResult).toMatchObject({ success: true })
    const proposal = (proposalResult as { success: true; data: { proposalId: string; diff: { before: string; after: string } } }).data
    const requestId = 'request-registered-apply'
    const toolUseId = 'tool-registered-apply'
    const runtimeContext = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-registered', lane: 'desktop', requestId, toolUseId }
    const tool = createWikiDomainTools().find(candidate => candidate.name === 'memory.wiki_update_schema')!
    const handle = await tool.begin({ proposalId: proposal.proposalId, expectedSchemaVersion: 1, proposalDiff: proposal.diff }, { requestId, toolUseId, executionContext: runtimeContext })
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()
    const confirmationContext = {
      requestId, toolUseId, runtimeContext, userConfirmationReceipt: 'host:user-approved', userConfirmationAnswerer: 'user' as const,
      signal: new AbortController().signal
    }
    await handle.validatePrepared(confirmationContext)
    handle.finishValidation()
    const applied = await handle.execute(confirmationContext)

    expect(applied, JSON.stringify(applied)).toMatchObject({ success: true, data: { schemaVersion: 2 } })
    expect(await store.readText('SCHEMA.md')).toBe(proposed)
  })

  it('preserves the complete restore conflict set in the tool failure result', async () => {
    const userDataDir = tempRoot()
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    const store = createWikiFileStore(wikiRoot)
    await store.write('SCHEMA.md', '# Rules\n\n<!-- wiki-categories:start -->\n{"formatVersion":1,"categories":[{"id":"topic","name":"Topic","description":"Knowledge","status":"active"}]}\n<!-- wiki-categories:end -->\n')
    const base = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG, sessionId: 'session-restore-conflict', lane: 'desktop', requestId: 'request-restore-conflict', toolUseId: 'save-a' }
    const first = await saveWikiPageForContext({ title: 'Alpha', categoryId: 'topic', summary: 'A', markdown: 'Original', schemaVersion: 1 }, base)
    const pageId = (first as { data: { pageId: string } }).data.pageId
    await saveWikiPageForContext({ pageId, expectedRevision: 1, title: 'Alpha', categoryId: 'topic', summary: 'A', markdown: 'Current', schemaVersion: 1 }, { ...base, requestId: 'update-a', toolUseId: 'update-a' })
    await saveWikiPageForContext({ title: 'Beta', categoryId: 'topic', summary: 'B', markdown: 'Other', schemaVersion: 1 }, { ...base, requestId: 'save-b', toolUseId: 'save-b' })
    const prepared = await prepareWikiRestoreForContext({ pageId, targetRevision: 1, expectedCurrentRevision: 2, title: 'Beta' }, { ...base, requestId: 'prepare-restore', toolUseId: 'prepare-restore' })
    const proposal = (prepared as { data: { proposalId: string; finalPage: Record<string, unknown> } }).data

    const applied = await applyWikiRestoreForContext({ proposalId: proposal.proposalId, finalPage: proposal.finalPage }, { ...base, requestId: 'apply-restore', toolUseId: 'apply-restore', toolUserConfirmed: true, userConfirmationAnswerer: 'user' })

    expect(applied).toMatchObject({ success: false, error: 'restore_conflict', data: { error: { code: 'restore_conflict', retryable: false, diagnostics: [expect.objectContaining({ code: 'title_conflict' })] } } })
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
