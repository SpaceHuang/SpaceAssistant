import { afterEach, describe, expect, it } from 'vitest'
import { deleteSession, getSession, getDbConnection } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'

describe('artifact operation deletion guard', () => {
  const fixtures: ArtifactTestFixture[] = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.teardown()
  })

  function createOperation(phase: string): ArtifactTestFixture {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = new ArtifactRepository(fixture.db).create({
      id: 'artifact',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'project',
      role: 'primary',
      canonicalPath: 'src/a.ts',
      pathIdentityKey: 'src/a.ts',
      pathSource: 'agent-default'
    })
    getDbConnection(fixture.db)
      .prepare(`INSERT INTO artifact_operations (
        id, artifact_id, operation, move_mode, source_path, target_path, phase, created_at, updated_at
      ) VALUES (?, ?, 'relocate', 'move', 'src/a.ts', 'src/b.ts', ?, 1, 1)`)
      .run('operation', artifact.id, phase)
    return fixture
  }

  it('refuses deletion while an operation is non-terminal', () => {
    const fixture = createOperation('prepared')

    expect(() => deleteSession(fixture.db, fixture.session.id)).toThrow(/operation/i)
    expect(getSession(fixture.db, fixture.session.id)).toBeTruthy()
  })

  it('clears terminal journals before deleting the session', () => {
    const fixture = createOperation('completed')

    expect(() => deleteSession(fixture.db, fixture.session.id)).not.toThrow()
    expect(getSession(fixture.db, fixture.session.id)).toBeUndefined()
  })
})
