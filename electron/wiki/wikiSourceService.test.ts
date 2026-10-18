import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiSourceService } from './wikiSourceService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('WikiSourceService', () => {
  it('imports only a host bound sourceRef and reads the immutable sourceId snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-source-service-'))
    roots.push(root)
    await mkdir(path.join(root, 'wiki'))
    const outside = path.join(root, 'notes.md')
    await writeFile(outside, 'source contents')
    const service = createWikiSourceService({ store: createWikiFileStore(path.join(root, 'wiki')), resolveSourceRef: ref => ref === 'bound-1' ? { path: outside, displayName: 'notes.md', projectId: 'p-1' } : undefined, validateSource: async () => true, authorize: async () => true })
    await expect(service.importSource('../notes.md', { callerId: 'c', lane: 'chat' })).rejects.toMatchObject({ code: 'source_missing' })
    const imported = await service.importSource('bound-1', { callerId: 'c', lane: 'chat' })
    await writeFile(outside, 'changed externally')
    const read = await service.readSource(imported.sourceId, { callerId: 'c', lane: 'chat' })
    expect(read.text).toBe('source contents')
    expect(JSON.stringify(imported)).not.toContain(outside)
    expect(await readFile(path.join(root, 'wiki', '.wiki-service', 'sources', `${imported.sourceId}.json`), 'utf8')).not.toContain(outside)
  })

  it('creates a raw mirror and advances immutable source revisions after an external raw edit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-source-reconcile-'))
    roots.push(root)
    await mkdir(path.join(root, 'wiki'))
    const outside = path.join(root, 'source.md')
    await writeFile(outside, 'revision one')
    const store = createWikiFileStore(path.join(root, 'wiki'))
    const service = createWikiSourceService({ store, resolveSourceRef: () => ({ path: outside, displayName: 'source.md', projectId: 'p-a' }), validateSource: async () => true, authorize: async () => true })
    const imported = await service.importSource('app-bound-ref', { callerId: 'c', lane: 'chat' })
    const binding = JSON.parse(await store.readText(`.wiki-service/sources/${imported.sourceId}.json`)) as { rawPath: string }
    expect(binding.rawPath).toBe(`raw/p-a/${imported.sourceId}/source.md`)
    expect(await store.readText(binding.rawPath)).toBe('revision one')
    await store.write(binding.rawPath, 'revision two')
    const latest = await service.readSource(imported.sourceId, { callerId: 'c', lane: 'chat' })
    const old = await service.readSource(imported.sourceId, { callerId: 'c', lane: 'chat' }, { sourceRevision: 1 })
    expect(latest).toMatchObject({ sourceRevision: 2, text: 'revision two' })
    expect(old).toMatchObject({ sourceRevision: 1, text: 'revision one' })
  })

  it('returns the same error for unknown and unauthorized ids and rejects unsafe sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-source-deny-'))
    roots.push(root)
    await mkdir(path.join(root, 'wiki'))
    const unsafe = path.join(root, 'unsafe.md')
    await writeFile(unsafe, 'unsafe')
    const service = createWikiSourceService({ store: createWikiFileStore(path.join(root, 'wiki')), resolveSourceRef: ref => ref === 'unsafe' ? { path: unsafe, displayName: 'unsafe.md' } : undefined, validateSource: async () => false, authorize: async () => false })
    await expect(service.importSource('unsafe', { callerId: 'c', lane: 'chat' })).rejects.toMatchObject({ code: 'source_missing' })
    await expect(service.readSource('unknown', { callerId: 'c', lane: 'chat' })).rejects.toMatchObject({ code: 'source_missing' })
  })

  it.each([
    { formatVersion: 1, sourceId: '01234567-89ab-cdef-0123-456789abcdef', sourceRevision: '2', displayName: 'notes.md' },
    { formatVersion: 1, sourceId: 'different-id', sourceRevision: 1, displayName: 'notes.md' },
    { formatVersion: 2, sourceId: '01234567-89ab-cdef-0123-456789abcdef', sourceRevision: 1, displayName: 'notes.md' },
  ])('fails closed for malformed source binding metadata', async binding => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-source-corrupt-'))
    roots.push(root)
    const wikiRoot = path.join(root, 'wiki')
    await mkdir(wikiRoot)
    const store = createWikiFileStore(wikiRoot)
    const sourceId = '01234567-89ab-cdef-0123-456789abcdef'
    await store.write('.wiki-service/sources/' + sourceId + '.json', JSON.stringify(binding))
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/1.md`, Buffer.from('current snapshot'))
    await store.writeImmutable(`.wiki-service/source-history/${sourceId}/2.md`, Buffer.from('forged snapshot'))
    const service = createWikiSourceService({ store, resolveSourceRef: () => undefined, validateSource: async () => false, authorize: async () => true })
    await expect(service.readSource(sourceId, { callerId: 'c', lane: 'chat' })).rejects.toMatchObject({ code: 'source_missing' })
  })
})
