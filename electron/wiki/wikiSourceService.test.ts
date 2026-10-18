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
})
