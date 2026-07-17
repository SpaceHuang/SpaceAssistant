import { afterEach, describe, expect, it } from 'vitest'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { ArtifactRepository } from './artifactRepository'

describe('ArtifactRepository', () => {
  const fixtures: ArtifactTestFixture[] = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.teardown()
  })

  it('stores and reads project, package, and scratch artifacts', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)

    for (const container of ['project', 'package', 'scratch'] as const) {
      const artifact = repository.create({
        id: `${container}-artifact`,
        sessionId: fixture.session.id,
        workDirProfileId: fixture.profile.id,
        workspaceRootReal: fixture.workDir,
        container,
        role: container === 'scratch' ? 'scratch' : 'primary',
        canonicalPath: `${container}.txt`,
        pathIdentityKey: `${container}.txt`,
        pathSource: 'agent-default'
      })

      expect(repository.find(artifact.id)).toMatchObject({ id: artifact.id, container })
    }
  })

  it('rejects a second active artifact with the same session path identity', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    const base = {
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'project' as const,
      role: 'primary' as const,
      canonicalPath: 'src/auth.ts',
      pathIdentityKey: 'src/auth.ts',
      pathSource: 'agent-default' as const
    }
    repository.create({ id: 'first', ...base })

    expect(() => repository.create({ id: 'second', ...base })).toThrow(/UNIQUE constraint failed/)
  })

  it('allows a new artifact after the original path record is marked deleted', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    const base = {
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'project' as const,
      role: 'primary' as const,
      canonicalPath: 'src/auth.ts',
      pathIdentityKey: 'src/auth.ts',
      pathSource: 'agent-default' as const
    }
    repository.create({ id: 'deleted', ...base })
    repository.markDeleted('deleted')

    expect(repository.create({ id: 'replacement', ...base })).toMatchObject({ id: 'replacement', status: 'active' })
  })

  it('keeps artifact identity while moving its canonical path', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    const base = {
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'project' as const,
      role: 'primary' as const,
      canonicalPath: 'src/auth.ts',
      pathIdentityKey: 'src/auth.ts',
      pathSource: 'agent-default' as const
    }
    repository.create({ id: 'moved', ...base })
    repository.updatePath('moved', 'src/security/auth.ts', 'src/security/auth.ts')

    expect(repository.find('moved')).toMatchObject({ canonicalPath: 'src/security/auth.ts' })
    expect(repository.create({ id: 'old-path', ...base })).toMatchObject({ id: 'old-path' })
  })

  it('requires package supporting artifacts to reference a same-session package primary', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)

    expect(() => repository.create({
      id: 'orphan-support',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      packageId: 'missing-primary',
      container: 'package',
      role: 'supporting',
      canonicalPath: 'report.materials/data.csv',
      pathIdentityKey: 'report.materials/data.csv',
      pathSource: 'agent-default'
    })).toThrow(/package primary/)
  })

  it('lists records globally and by session', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    repository.create({
      id: 'listed',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'scratch',
      role: 'scratch',
      canonicalPath: '.spaceassistant/runs/a/log.txt',
      pathIdentityKey: '.spaceassistant/runs/a/log.txt',
      pathSource: 'system-assigned'
    })

    expect(repository.list()).toHaveLength(1)
    expect(repository.listBySession(fixture.session.id)).toMatchObject([{ id: 'listed' }])
  })
})
