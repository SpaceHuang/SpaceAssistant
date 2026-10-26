import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiWriteService } from './wikiWriteService'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-write-service-'))
  roots.push(root)
  const store = createWikiFileStore(root)
  return { root, store, service: createWikiWriteService(store) }
}

describe('WikiWriteService', () => {
  it('serializes writes per normalized file path and commits atomically', async () => {
    const { root, service } = await fixture()
    await Promise.all([service.write('wiki/page.md', '# A'), service.write('wiki\\page.md', '# B')])
    expect(['# A', '# B']).toContain(await readFile(path.join(root, 'wiki/page.md'), 'utf8'))
  })

  it('rejects a stale identity and preserves external content', async () => {
    const { root, service } = await fixture()
    await service.write('wiki/page.md', 'original')
    const snapshot = await service.read('wiki/page.md')
    await writeFile(path.join(root, 'wiki/page.md'), 'external')
    await expect(service.write('wiki/page.md', 'replacement', snapshot.identity)).rejects.toMatchObject({ code: 'wiki-write-conflict' })
    expect(await readFile(path.join(root, 'wiki/page.md'), 'utf8')).toBe('external')
  })

  it('creates a missing file without replacing a concurrently claimed target', async () => {
    const { root, service } = await fixture()
    await expect(service.write('wiki/new.md', 'created', null, async target => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, 'racer') })).rejects.toMatchObject({ code: 'wiki-write-conflict' })
    expect(await readFile(path.join(root, 'wiki/new.md'), 'utf8')).toBe('racer')
  })
})
