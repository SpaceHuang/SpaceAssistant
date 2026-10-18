import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-file-store-'))
  roots.push(root)
  return { root, store: createWikiFileStore(root) }
}

describe('WikiFileStore', () => {
  it('rejects absolute, traversal, and empty paths', async () => {
    const { store } = await fixture()
    await expect(store.read('../outside')).rejects.toThrow()
    await expect(store.read(path.resolve('/tmp/outside'))).rejects.toThrow()
    await expect(store.read('')).rejects.toThrow()
  })

  it('creates files only under the Wiki root using the atomic writer', async () => {
    const { root, store } = await fixture()
    await store.write('nested/page.md', '# Wiki page\n')
    expect(await readFile(path.join(root, 'nested/page.md'), 'utf8')).toBe('# Wiki page\n')
  })

  it('refuses a symlink in an intermediate path for reads and writes', async () => {
    const { root, store } = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'wiki-file-store-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'secret.md'), 'outside data')
    await symlink(outside, path.join(root, 'linked'))
    await expect(store.write('linked/page.md', 'unsafe')).rejects.toThrow()
    await expect(store.readText('linked/secret.md')).rejects.toThrow()
    await expect(store.identity('linked/secret.md')).rejects.toThrow()
    await expect(store.remove('linked/secret.md')).rejects.toThrow()
  })

  it('writes and reads rebuildable catalog data separately from authority files', async () => {
    const { root, store } = await fixture()
    await store.write('wiki/page.md', '# Page')
    await store.writeCatalog({ formatVersion: 1, pages: [{ pageId: 'page-1', path: 'wiki/page.md' }] })
    expect(await store.readCatalog()).toEqual({ formatVersion: 1, pages: [{ pageId: 'page-1', path: 'wiki/page.md' }] })
    expect(await readFile(path.join(root, 'wiki/page.md'), 'utf8')).toBe('# Page')
  })

  it('does not overwrite an immutable snapshot and rejects malformed catalog data', async () => {
    const { store } = await fixture()
    await store.writeImmutable('.wiki-service/page-history/page-1/1.md', '# Original')
    await expect(store.writeImmutable('.wiki-service/page-history/page-1/1.md', '# Replacement')).rejects.toThrow()
    await store.write('.wiki-service/catalog.json', '{broken')
    await expect(store.readCatalog()).rejects.toThrow()
  })
})
