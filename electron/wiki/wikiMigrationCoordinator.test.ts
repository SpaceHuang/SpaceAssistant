import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiMigrationCoordinator } from './wikiMigrationCoordinator'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(existing: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-migration-coordinator-'))
  roots.push(root)
  if (existing) { await mkdir(path.join(root, 'wiki', 'entities'), { recursive: true }); await writeFile(path.join(root, 'SCHEMA.md'), '# Rules\n\n## 页面类型\n\n| 类型 | 目录 | 说明 |\n|------|------|------|\n| entity | wiki/entities/ | Entities |\n'); await writeFile(path.join(root, 'wiki', 'entities', 'old.md'), '# Old\n') }
  const lifecycle = createWikiLifecycleController(root)
  await lifecycle.initialize()
  return { root, lifecycle, coordinator: createWikiMigrationCoordinator(root) }
}

describe('Wiki migration coordinator', () => {
  it('keeps an empty domain_ready Wiki unchanged when no migration is needed', async () => {
    const { root, lifecycle } = await fixture(false)
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'domain_ready', initialization: 'empty' })
    await expect(readFile(path.join(root, 'SCHEMA.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('applies a confirmed file manifest behind initializing and completes domain_ready', async () => {
    const { root, lifecycle, coordinator } = await fixture(true)
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'initializing', initialization: 'existing-content' })
    const report = await coordinator.preflight()
    const manifest = await coordinator.migrate({ preflightHash: report.manifestHash, confirmedPreflightHash: report.manifestHash })
    expect(manifest.status).toBe('completed')
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toContain('wiki-categories:start')
    expect(await readFile(path.join(root, 'wiki/entities/old.md'), 'utf8')).toContain('wiki-page:start')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'domain_ready', preflightHash: report.manifestHash })
  })

  it('rebuilds service projections and preserves exact legacy index and log backups', async () => {
    const { root, coordinator } = await fixture(true)
    const oldIndex = '# Human index\n\nKeep rationale here.\n'
    const oldLog = '## old event\nKeep audit history.\n'
    await writeFile(path.join(root, 'wiki/index.md'), oldIndex)
    await writeFile(path.join(root, 'wiki/log.md'), oldLog)
    const report = await coordinator.preflight()
    const manifest = await coordinator.migrate({ preflightHash: report.manifestHash, confirmedPreflightHash: report.manifestHash })
    const index = await readFile(path.join(root, 'wiki/index.md'), 'utf8')
    const log = await readFile(path.join(root, 'wiki/log.md'), 'utf8')
    expect(index).toContain('- [Old](wiki/entities/old.md)')
    expect(index).not.toContain('Keep rationale here')
    expect(log).toBe('# Wiki Operation Log\n')
    for (const [relativePath, original] of [['wiki/index.md', oldIndex], ['wiki/log.md', oldLog]]) {
      const entry = manifest.entries.find(item => item.relativePath === relativePath)
      expect(entry?.backupPath).toBeTruthy()
      const backup = await readFile(path.join(root, entry!.backupPath!))
      expect(backup.toString('utf8')).toBe(original)
      expect(createHash('sha256').update(backup).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'))
    }
  })

  it('does not start writes when user confirmation is not bound to the preflight report', async () => {
    const { root, coordinator, lifecycle } = await fixture(true)
    const report = await coordinator.preflight()
    await expect(coordinator.migrate({ preflightHash: report.manifestHash, confirmedPreflightHash: 'report-b' })).rejects.toThrow('wiki-migration-confirmation-mismatch')
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toContain('wiki/entities/')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'initializing' })
  })

  it('resumes pending plus new_hash after a crash between active write and manifest update', async () => {
    const { root, lifecycle, coordinator } = await fixture(true)
    const report = await coordinator.preflight()
    await expect(coordinator.migrate({ preflightHash: report.manifestHash, confirmedPreflightHash: report.manifestHash, crashAfterWriteIndex: 0 })).rejects.toThrow('injected migration crash')
    const manifestFiles = await (await import('node:fs/promises')).readdir(path.join(root, '.wiki-service/migrations'))
    const migrationId = manifestFiles.find(name => name.endsWith('.json'))!.slice(0, -5)
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'initializing', preflightHash: report.manifestHash, migrationId })
    expect((await coordinator.resume({ migrationId, preflightHash: report.manifestHash })).status).toBe('completed')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'domain_ready', preflightHash: report.manifestHash })
    expect(await readFile(path.join(root, 'wiki/entities/old.md'), 'utf8')).toContain('wiki-page:start')
  })

  it('preserves an external edit and moves the lifecycle to recovery_required on conflict', async () => {
    const { root, lifecycle, coordinator } = await fixture(true)
    const report = await coordinator.preflight()
    await expect(coordinator.migrate({ preflightHash: report.manifestHash, confirmedPreflightHash: report.manifestHash, crashAfterWriteIndex: 0 })).rejects.toThrow('injected migration crash')
    const { readdir } = await import('node:fs/promises')
    const migrationId = (await readdir(path.join(root, '.wiki-service/migrations'))).find(name => name.endsWith('.json'))!.slice(0, -5)
    await writeFile(path.join(root, 'SCHEMA.md'), 'external edit')
    await expect(coordinator.resume({ migrationId, preflightHash: report.manifestHash })).rejects.toThrow('wiki-migration-conflict')
    expect(await readFile(path.join(root, 'SCHEMA.md'), 'utf8')).toBe('external edit')
    expect(await lifecycle.read()).toMatchObject({ lifecycle: 'recovery_required' })
  })
})
