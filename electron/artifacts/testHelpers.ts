import type { Session } from '../../src/shared/domainTypes'
import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import type { AppDatabase } from '../database'

export type ArtifactTestFixture = {
  rootDir: string
  workDir: string
  dbPath: string
  db: AppDatabase
  profile: WorkDirProfile
  session: Session
  teardown: () => void
}

export type ArtifactTestFixtureOptions = {
  prefix?: string
  profileId?: string
  profileName?: string
  sessionName?: string
}

/**
 * Builds the filesystem, profile, session, and SQLite state shared by artifact tests.
 * The implementation is introduced after its teardown contract is covered by a RED test.
 */
export function createArtifactTestFixture(_options: ArtifactTestFixtureOptions = {}): ArtifactTestFixture {
  throw new Error('Artifact test fixture is not implemented')
}
