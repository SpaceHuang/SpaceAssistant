import { afterEach, describe, expect, it } from 'vitest'
import { createSession, getSession } from '../database'
import { resolveArtifactWorkspaceStrict } from './workspaceResolver'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'

describe('resolveArtifactWorkspaceStrict', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.teardown()))

  it('explicitly binds a legacy unbound session to its resolved profile once', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const legacy = createSession(fixture.db, { name: 'legacy' })

    const result = resolveArtifactWorkspaceStrict({
      db: fixture.db,
      sessionId: legacy.id,
      profiles: [fixture.profile],
      legacyResolved: { profileId: fixture.profile.id, workDir: fixture.workDir }
    })

    expect(result).toMatchObject({ ok: true, profileId: fixture.profile.id, workDir: fixture.workDir })
    expect(getSession(fixture.db, legacy.id)?.workDirProfileId).toBe(fixture.profile.id)
  })

  it('returns unavailable when the bound profile no longer exists', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)

    expect(resolveArtifactWorkspaceStrict({ db: fixture.db, sessionId: fixture.session.id, profiles: [] })).toEqual({
      ok: false,
      errorCode: 'ARTIFACT_WORKSPACE_UNAVAILABLE'
    })
  })
})
