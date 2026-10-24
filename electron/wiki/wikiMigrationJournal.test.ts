import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWikiFileStore } from './wikiFileStore'
import { createWikiMigrationJournal } from './wikiMigrationJournal'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-migration-journal-'))
  roots.push(root)
  const store = createWikiFileStore(root)
  return { root, store }
}

describe('WikiMigrationJournal', () => {
  it('backs up every old file and stages the complete plan before active writes', async () => {
    const { root, store } = await fixture()
    await store.write('SCHEMA.md', 'old schema')
    await store.write('wiki/index.md', 'legacy index')
    const journal = createWikiMigrationJournal({ store })
    const prepared = await journal.prepare([
      { objectKind: 'schema', relativePath: 'SCHEMA.md', newBytes: Buffer.from('new schema') },
      { objectKind: 'index', relativePath: 'wiki/index.md', newBytes: Buffer.from('new index') },
      { objectKind: 'page', relativePath: 'wiki/new.md', newBytes: Buffer.from('# New') },
    ])
    expect(await store.readText('SCHEMA.md')).toBe('old schema')
    expect(await store.readText('wiki/index.md')).toBe('legacy index')
    const manifest = await journal.read(prepared.migrationId)
    expect(manifest.entries).toHaveLength(3)
    expect(manifest.entries.map(entry => entry.step)).toEqual(['pending', 'pending', 'pending'])
    expect(await readFile(path.join(root, manifest.entries[0]!.backupPath!), 'utf8')).toBe('old schema')
    expect(await readFile(path.join(root, manifest.entries[2]!.stagingPath), 'utf8')).toBe('# New')
  })

  it('recovers pending plus new hash after a crash between file write and manifest update', async () => {
    const { store } = await fixture()
    await store.write('wiki/page.md', 'old')
    const journal = createWikiMigrationJournal({ store })
    const prepared = await journal.prepare([{ objectKind: 'page', relativePath: 'wiki/page.md', newBytes: Buffer.from('new') }])
    await expect(journal.apply(prepared.migrationId, { crashAfterWriteIndex: 0 })).rejects.toThrow('injected migration crash')
    expect((await journal.read(prepared.migrationId)).entries[0]!.step).toBe('pending')
    await expect(journal.apply(prepared.migrationId)).resolves.toMatchObject({ status: 'completed' })
    expect(await store.readText('wiki/page.md')).toBe('new')
    expect((await journal.read(prepared.migrationId)).entries[0]!.step).toBe('verified')
  })

  it('recovers a newly created target written before manifest progress without rewriting it', async () => {
    const { store } = await fixture()
    const journal = createWikiMigrationJournal({ store })
    const prepared = await journal.prepare([{ objectKind: 'index-note', relativePath: 'wiki/migrated-notes/new.md', newBytes: Buffer.from('# New note') }])
    expect(prepared.entries[0]).toMatchObject({ oldExists: false, oldHash: null, step: 'pending' })
    await expect(journal.apply(prepared.migrationId, { crashAfterWriteIndex: 0 })).rejects.toThrow('injected migration crash')
    const write = vi.spyOn(store, 'write')
    await expect(journal.apply(prepared.migrationId)).resolves.toMatchObject({ status: 'completed' })
    expect(write).not.toHaveBeenCalledWith('wiki/migrated-notes/new.md', expect.anything(), expect.anything())
    expect(await store.readText('wiki/migrated-notes/new.md')).toBe('# New note')
  })

  it('rechecks verified targets on resume and preserves an external edit as a conflict', async () => {
    const { store } = await fixture()
    await store.write('wiki/first.md', 'first-old')
    await store.write('wiki/second.md', 'second-old')
    const recovery = vi.fn()
    const journal = createWikiMigrationJournal({ store, markRecoveryRequired: recovery })
    const prepared = await journal.prepare([
      { objectKind: 'page', relativePath: 'wiki/first.md', newBytes: Buffer.from('first-new') },
      { objectKind: 'page', relativePath: 'wiki/second.md', newBytes: Buffer.from('second-new') },
    ])
    await expect(journal.apply(prepared.migrationId, { crashAfterWriteIndex: 1 })).rejects.toThrow('injected migration crash')
    expect((await journal.read(prepared.migrationId)).entries[0]!.step).toBe('verified')
    await writeFile(store.absolutePath('wiki/first.md'), 'external-first')

    await expect(journal.apply(prepared.migrationId)).rejects.toMatchObject({ code: 'wiki-migration-conflict' })

    expect(await store.readText('wiki/first.md')).toBe('external-first')
    expect((await journal.read(prepared.migrationId)).status).toBe('conflict')
    expect(recovery).toHaveBeenCalledOnce()
  })

  it('stops on an external change and marks lifecycle recovery without overwriting it', async () => {
    const { store } = await fixture()
    await store.write('wiki/page.md', 'old')
    const recovery = vi.fn()
    const journal = createWikiMigrationJournal({ store, markRecoveryRequired: recovery })
    const prepared = await journal.prepare([{ objectKind: 'page', relativePath: 'wiki/page.md', newBytes: Buffer.from('new') }])
    await writeFile(store.absolutePath('wiki/page.md'), 'external')
    await expect(journal.apply(prepared.migrationId)).rejects.toMatchObject({ code: 'wiki-migration-conflict' })
    expect(await store.readText('wiki/page.md')).toBe('external')
    expect(recovery).toHaveBeenCalledOnce()
    expect((await journal.read(prepared.migrationId)).status).toBe('conflict')
  })

  it('rolls back verified replacements and only deletes created files that still match this migration', async () => {
    const { store } = await fixture()
    await store.write('SCHEMA.md', 'old')
    const journal = createWikiMigrationJournal({ store })
    const prepared = await journal.prepare([
      { objectKind: 'schema', relativePath: 'SCHEMA.md', newBytes: Buffer.from('new') },
      { objectKind: 'page', relativePath: 'wiki/new.md', newBytes: Buffer.from('# New') },
    ])
    await journal.apply(prepared.migrationId)
    await expect(journal.rollback(prepared.migrationId)).resolves.toMatchObject({ status: 'rolled_back' })
    expect(await store.readText('SCHEMA.md')).toBe('old')
    await expect(store.read('wiki/new.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete a created target during rollback after an external edit', async () => {
    const { store } = await fixture()
    const recovery = vi.fn()
    const journal = createWikiMigrationJournal({ store, markRecoveryRequired: recovery })
    const prepared = await journal.prepare([{ objectKind: 'page', relativePath: 'wiki/new.md', newBytes: Buffer.from('# New') }])
    await journal.apply(prepared.migrationId)
    await writeFile(store.absolutePath('wiki/new.md'), '# External')
    await expect(journal.rollback(prepared.migrationId)).rejects.toMatchObject({ code: 'wiki-migration-conflict' })
    expect(await store.readText('wiki/new.md')).toBe('# External')
    expect(recovery).toHaveBeenCalledOnce()
  })

  it('does not roll back over a file changed externally after migration', async () => {
    const { store } = await fixture()
    await store.write('wiki/page.md', 'old')
    const recovery = vi.fn()
    const journal = createWikiMigrationJournal({ store, markRecoveryRequired: recovery })
    const prepared = await journal.prepare([{ objectKind: 'page', relativePath: 'wiki/page.md', newBytes: Buffer.from('new') }])
    await journal.apply(prepared.migrationId)
    await writeFile(store.absolutePath('wiki/page.md'), 'external')
    await expect(journal.rollback(prepared.migrationId)).rejects.toMatchObject({ code: 'wiki-migration-conflict' })
    expect(await store.readText('wiki/page.md')).toBe('external')
    expect(recovery).toHaveBeenCalledOnce()
  })

  it.each(['stagingPath', 'backupPath'] as const)('does not apply a file when its %s bytes were changed', async field => {
    const { store } = await fixture()
    await store.write('SCHEMA.md', 'old')
    const recovery = vi.fn()
    const journal = createWikiMigrationJournal({ store, markRecoveryRequired: recovery })
    const prepared = await journal.prepare([{ objectKind: 'schema', relativePath: 'SCHEMA.md', newBytes: Buffer.from('new') }])
    const manifest = await journal.read(prepared.migrationId)
    const targetPath = manifest.entries[0]![field]
    if (!targetPath) throw new Error(`Missing ${field}`)
    await store.write(targetPath, 'tampered migration material')
    await expect(journal.apply(prepared.migrationId)).rejects.toMatchObject({ code: 'wiki-migration-conflict' })
    expect(await store.readText('SCHEMA.md')).toBe('old')
    expect(recovery).toHaveBeenCalledOnce()
  })
})
