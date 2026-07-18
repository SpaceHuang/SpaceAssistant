import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRepository } from './artifactRepository'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { registerResolvedArtifactWrite } from './writeRegistration'

describe('registerResolvedArtifactWrite', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.teardown()))

  it('creates a new artifact only after a successful resolved write', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const record = registerResolvedArtifactWrite({
      repository: new ArtifactRepository(fixture.db), sessionId: fixture.session.id, workDirProfileId: fixture.profile.id, workspaceRootReal: fixture.workDir,
      intent: { container: 'project', role: 'primary', title: 'auth', pathSource: 'agent-default' },
      resolved: { finalPath: 'src/auth.ts', canonicalPath: `${fixture.workDir}/src/auth.ts`, provenance: { pathSource: 'agent-default' } }
    })
    expect(record).toMatchObject({ container: 'project', canonicalPath: `${fixture.workDir}/src/auth.ts` })
  })

  it('creates a new record when intent carries a pre-assigned artifactId', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const record = registerResolvedArtifactWrite({
      repository: new ArtifactRepository(fixture.db),
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      intent: {
        artifactId: 'artifact-preassigned',
        container: 'project',
        role: 'primary',
        title: 'auth',
        pathSource: 'agent-default'
      },
      resolved: {
        finalPath: 'src/auth.ts',
        canonicalPath: `${fixture.workDir}/src/auth.ts`,
        provenance: { pathSource: 'agent-default' }
      }
    })
    expect(record.id).toBe('artifact-preassigned')
  })

  it('updates stage when continuing an existing artifactId write', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    registerResolvedArtifactWrite({
      repository,
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      intent: {
        artifactId: 'artifact-stage',
        container: 'project',
        role: 'primary',
        title: 'report',
        stage: 'working',
        pathSource: 'agent-default'
      },
      resolved: {
        finalPath: 'report.md',
        canonicalPath: `${fixture.workDir}/report.md`,
        provenance: { pathSource: 'agent-default' }
      }
    })
    const updated = registerResolvedArtifactWrite({
      repository,
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      intent: {
        artifactId: 'artifact-stage',
        container: 'project',
        role: 'primary',
        title: 'report',
        stage: 'final',
        pathSource: 'agent-default'
      },
      resolved: {
        finalPath: 'report.md',
        canonicalPath: `${fixture.workDir}/report.md`,
        provenance: { pathSource: 'agent-default' }
      }
    })
    expect(updated.stage).toBe('final')
    expect(repository.find('artifact-stage')?.stage).toBe('final')
  })
})
