import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Session } from '../../src/shared/domainTypes'
import type { WorkDirProfile } from '../../src/shared/feishuTypes'
import { createSession, openDatabase, setConfigValue, type AppDatabase } from '../database'

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

/** Builds isolated filesystem, profile, session, and SQLite state for artifact tests. */
export function createArtifactTestFixture(options: ArtifactTestFixtureOptions = {}): ArtifactTestFixture {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'sa-artifact-')))
  const workDir = path.join(rootDir, 'workspace')
  const dbPath = path.join(rootDir, 'test.db')
  fs.mkdirSync(workDir)

  const profile: WorkDirProfile = {
    id: options.profileId ?? randomUUID(),
    name: options.profileName ?? 'Artifact test workspace',
    path: workDir,
    isDefault: true
  }
  const db = openDatabase(dbPath)
  setConfigValue(db, 'config.workDirProfiles', JSON.stringify([profile]))
  setConfigValue(db, 'config.activeWorkDirProfileId', profile.id)
  setConfigValue(db, 'config.workDir', workDir)
  const session = createSession(db, {
    name: options.sessionName ?? 'Artifact test session',
    workDirProfileId: profile.id
  })
  let tornDown = false

  return {
    rootDir,
    workDir,
    dbPath,
    db,
    profile,
    session,
    teardown: () => {
      if (tornDown) return
      tornDown = true
      try {
        db.close()
      } finally {
        fs.rmSync(rootDir, { recursive: true, force: true })
      }
    }
  }
}
