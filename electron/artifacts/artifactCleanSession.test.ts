import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { ArtifactRepository } from './artifactRepository'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { cleanArtifactSession } from './artifactCleanSession'

describe('cleanArtifactSession', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => { for (const f of fixtures.splice(0)) f.teardown() })
  it('deletes scratch, skips project and in-use artifacts', async () => {
    const f = createArtifactTestFixture(); fixtures.push(f)
    const repo = new ArtifactRepository(f.db); const registry = new ArtifactPathLeaseRegistry()
    const scratchPath = `${f.workDir}/scratch.txt`; const projectPath = `${f.workDir}/project.txt`; const busyPath = `${f.workDir}/busy.txt`
    await fs.writeFile(scratchPath, 'x'); await fs.writeFile(projectPath, 'x'); await fs.writeFile(busyPath, 'x')
    repo.create({ id: 's', sessionId: f.session.id, workDirProfileId: f.profile.id, workspaceRootReal: f.workDir, container: 'scratch', role: 'scratch', canonicalPath: scratchPath, pathIdentityKey: scratchPath, pathSource: 'agent-default' })
    repo.create({ id: 'p', sessionId: f.session.id, workDirProfileId: f.profile.id, workspaceRootReal: f.workDir, container: 'project', role: 'primary', canonicalPath: projectPath, pathIdentityKey: projectPath, pathSource: 'agent-default' })
    repo.create({ id: 'b', sessionId: f.session.id, workDirProfileId: f.profile.id, workspaceRootReal: f.workDir, container: 'scratch', role: 'scratch', canonicalPath: busyPath, pathIdentityKey: busyPath, pathSource: 'agent-default' })
    const lease = registry.acquireUse(busyPath)
    const result = await cleanArtifactSession({ repository: repo, registry, sessionId: f.session.id })
    lease.release()
    expect(result.deleted).toEqual(['s']); expect(result.skipped).toEqual(expect.arrayContaining([{ id: 'p', reason: 'not-scratch' }, { id: 'b', reason: 'in-use' }]))
    expect(repo.find('s')?.status).toBe('deleted')
  })
  it('keeps references unless explicitly included', async () => {
    const f = createArtifactTestFixture(); fixtures.push(f)
    const repo = new ArtifactRepository(f.db); const registry = new ArtifactPathLeaseRegistry()
    const path = `${f.workDir}/reference.txt`; await fs.writeFile(path, 'x')
    repo.create({ id: 'r', sessionId: f.session.id, workDirProfileId: f.profile.id, workspaceRootReal: f.workDir, container: 'reference', role: 'reference', canonicalPath: path, pathIdentityKey: path, pathSource: 'agent-default' })
    expect((await cleanArtifactSession({ repository: repo, registry, sessionId: f.session.id })).skipped).toEqual([{ id: 'r', reason: 'reference-opt-in-required' }])
    expect((await cleanArtifactSession({ repository: repo, registry, sessionId: f.session.id, includeReferences: true })).deleted).toEqual(['r'])
  })
})
