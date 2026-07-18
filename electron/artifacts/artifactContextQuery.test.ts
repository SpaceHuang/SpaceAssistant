import { describe, expect, it } from 'vitest'
import { ArtifactRepository } from './artifactRepository'
import { buildArtifactContextSummaries, formatArtifactContextBlock } from './artifactContextQuery'
import { createArtifactTestFixture } from './testHelpers'

describe('artifact context query', () => {
  it('returns at most 20 recent active artifact summaries', () => {
    const fixture = createArtifactTestFixture()
    const repository = new ArtifactRepository(fixture.db)
    for (let index = 0; index < 25; index++) {
      repository.create({
        id: `ctx-${index}`,
        sessionId: fixture.session.id,
        workDirProfileId: fixture.profile.id,
        workspaceRootReal: fixture.workDir,
        container: 'scratch',
        role: 'scratch',
        title: `Draft ${index}`,
        canonicalPath: `${fixture.workDir}/run/${index}.md`,
        pathIdentityKey: `run/${index}.md`,
        pathSource: 'system-assigned'
      })
    }
    expect(buildArtifactContextSummaries(repository, fixture.session.id)).toHaveLength(20)
    fixture.teardown()
  })

  it('formats summaries for prompt injection with artifactId reuse hint', () => {
    const fixture = createArtifactTestFixture()
    const repository = new ArtifactRepository(fixture.db)
    repository.create({
      id: 'artifact-ctx-1',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'package',
      role: 'primary',
      title: 'Report',
      stage: 'draft',
      canonicalPath: `${fixture.workDir}/report.md`,
      pathIdentityKey: 'report.md',
      pathSource: 'user',
      pathEvidenceId: 'evidence-1'
    })
    const block = formatArtifactContextBlock(buildArtifactContextSummaries(repository, fixture.session.id), fixture.workDir)
    expect(block).toContain('artifact-ctx-1')
    expect(block).toContain('reuse artifactId')
    expect(block).toContain('stage=draft')
    fixture.teardown()
  })
})
