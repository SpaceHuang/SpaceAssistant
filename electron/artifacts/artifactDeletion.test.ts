import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { deleteArtifactFile } from './artifactDeletion'

describe('deleteArtifactFile', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

  it('refuses deletion while a use lease exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-delete-'))
    roots.push(root)
    const target = path.join(root, 'report.md')
    await fs.writeFile(target, 'x')
    const registry = new ArtifactPathLeaseRegistry()
    registry.acquireUse('report')
    await expect(deleteArtifactFile({ registry, identity: 'report', targetPath: target })).rejects.toThrow(/lease/i)
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('x')
  })

  it('treats a missing file as an idempotent successful deletion', async () => {
    const registry = new ArtifactPathLeaseRegistry()
    await expect(deleteArtifactFile({ registry, identity: 'missing', targetPath: '/tmp/does-not-exist-spaceassistant' })).resolves.toEqual({ deleted: false })
  })

  it('marks the artifact deleted after a successful or idempotent file deletion', async () => {
    const marked: string[] = []
    await expect(deleteArtifactFile({
      registry: new ArtifactPathLeaseRegistry(), identity: 'missing-marked', targetPath: '/tmp/does-not-exist-spaceassistant-marked',
      artifactId: 'artifact-1', repository: { markDeleted: (id: string) => marked.push(id) }
    })).resolves.toEqual({ deleted: false })
    expect(marked).toEqual(['artifact-1'])
  })
})
