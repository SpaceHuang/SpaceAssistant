import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRepository } from './artifactRepository'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { registerReferenceMetadata } from './referenceMetadata'

describe('registerReferenceMetadata', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.teardown()))

  it('persists title, URL, fetchedAt, and license note after a successful download', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = new ArtifactRepository(fixture.db).create({
      id: 'reference-1', sessionId: fixture.session.id, workDirProfileId: fixture.profile.id, workspaceRootReal: fixture.workDir,
      container: 'project', role: 'reference', title: 'source', canonicalPath: `${fixture.workDir}/source.md`, pathIdentityKey: 'source', pathSource: 'agent-default'
    })
    expect(registerReferenceMetadata(fixture.db, { artifactId: artifact.id, title: 'Example', url: 'https://example.test', fetchedAt: 123, licenseNote: 'CC-BY' })).toEqual({ complete: true })
  })

  it('keeps the downloaded file and reports missing metadata instead of deleting it', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = new ArtifactRepository(fixture.db).create({
      id: 'reference-2', sessionId: fixture.session.id, workDirProfileId: fixture.profile.id, workspaceRootReal: fixture.workDir,
      container: 'project', role: 'reference', title: 'source', canonicalPath: `${fixture.workDir}/source-2.md`, pathIdentityKey: 'source-2', pathSource: 'agent-default'
    })
    expect(registerReferenceMetadata(fixture.db, { artifactId: artifact.id, fetchedAt: 123 })).toEqual({ complete: false, missing: ['title', 'url'] })
    expect(new ArtifactRepository(fixture.db).find(artifact.id)?.status).toBe('active')
  })
})
