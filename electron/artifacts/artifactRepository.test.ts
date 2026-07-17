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
})
