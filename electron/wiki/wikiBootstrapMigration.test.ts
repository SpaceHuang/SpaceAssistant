import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiBootstrapMigrationService } from './wikiBootstrapMigration'
import { createWikiMigrationCoordinator } from './wikiMigrationCoordinator'
import { DEFAULT_SCHEMA_MD } from './wikiTemplates'
import { serializeWikiPageMarker } from './wikiReconciler'
import { buildWikiIndex, buildWikiLog } from './wikiProjection'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function legacyRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-bootstrap-migration-'))
  roots.push(root)
  await mkdir(path.join(root, 'wiki', 'entities'), { recursive: true })
  await writeFile(path.join(root, 'SCHEMA.md'), '# Rules\n\n## 页面类型\n\n| 类型 | 目录 | 说明 |\n|------|------|------|\n| entity | wiki/entities/ | Entities |\n')
  await writeFile(path.join(root, 'wiki', 'entities', 'old.md'), '# Old\n\nBody\n')
  await createWikiLifecycleController(root).initialize()
  return root
}

describe('Wiki bootstrap migration approval service', () => {
  it('previews the exact change set without writing and applies only the matching confirmed hash', async () => {
    const root = await legacyRoot()
    const service = createWikiBootstrapMigrationService(root)
    const preview = await service.preview()
    expect(preview.changes.map(change => change.relativePath)).toEqual(expect.arrayContaining(['SCHEMA.md', 'wiki/entities/old.md']))
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).not.toContain('wiki-categories:start')
    await expect(service.apply('stale-report-hash')).rejects.toMatchObject({ code: 'wiki-migration-preflight-stale' })
    expect(await readFile(path.join(root, 'wiki/entities/old.md'), 'utf8')).not.toContain('wiki-page:start')
    const result = await service.apply(preview.manifestHash)
    expect(result.status).toBe('completed')
    expect(await readFile(path.join(root, 'wiki/entities/old.md'), 'utf8')).toContain('wiki-page:start')
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'domain_ready', preflightHash: preview.manifestHash })
  })

  it('refuses to apply a preview after the legacy source changes', async () => {
    const root = await legacyRoot()
    const service = createWikiBootstrapMigrationService(root)
    const preview = await service.preview()
    await writeFile(path.join(root, 'wiki/entities/old.md'), '# Edited externally\n')
    await expect(service.apply(preview.manifestHash)).rejects.toMatchObject({ code: 'wiki-migration-preflight-stale' })
    expect(await readFile(path.join(root, 'wiki/entities/old.md'), 'utf8')).toBe('# Edited externally\n')
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'initializing' })
  })

  it('resumes an already confirmed migration after an interrupted file write', async () => {
    const root = await legacyRoot()
    const coordinator = createWikiMigrationCoordinator(root)
    const original = await coordinator.preflight()
    await expect(coordinator.migrate({ preflightHash: original.manifestHash, confirmedPreflightHash: original.manifestHash, crashAfterWriteIndex: 0 })).rejects.toThrow('injected migration crash')

    const service = createWikiBootstrapMigrationService(root)
    const preview = await service.preview()
    expect(preview.resumeRequired).toBe(true)
    expect(preview.manifestHash).toBe(original.manifestHash)
    await expect(service.apply(preview.manifestHash)).resolves.toEqual({ status: 'completed' })
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'domain_ready' })
  })

  it('completes an existing root with a no-op preflight without creating a migration journal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-bootstrap-noop-'))
    roots.push(root)
    await mkdir(path.join(root, 'wiki', 'topics'), { recursive: true })
    await writeFile(path.join(root, 'SCHEMA.md'), DEFAULT_SCHEMA_MD)
    await writeFile(path.join(root, 'wiki', 'index.md'), buildWikiIndex([{ pageId: 'known-page', title: 'Known', categoryId: 'topic', path: 'wiki/topics/known.md', revision: 1 }]))
    await writeFile(path.join(root, 'wiki', 'log.md'), buildWikiLog([]))
    await writeFile(path.join(root, 'wiki', 'topics', 'known.md'), `${serializeWikiPageMarker({ pageId: 'known-page', categoryId: 'topic', summary: '', parentPageId: null, sourceRefs: [], revision: 1 })}\n# Known\n\nBody\n`)
    await createWikiLifecycleController(root).initialize()
    const service = createWikiBootstrapMigrationService(root)
    const preview = await service.preview()
    expect(preview.changes).toEqual([])
    expect(preview.diagnostics).toEqual([])
    await expect(service.apply(preview.manifestHash)).resolves.toEqual({ status: 'completed' })
    expect(await createWikiLifecycleController(root).read()).toMatchObject({ lifecycle: 'domain_ready' })
  })
})
