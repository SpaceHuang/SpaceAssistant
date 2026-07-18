import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, getSession, setConfigValue } from '../database'
import { ARTIFACT_MANAGEMENT_CONFIG_KEY, readArtifactManagementEnabledFromConfig } from './artifactConfig'
import { isArtifactManagementEnabled, shouldUseLegacyWorkspaceRedirect } from './featureFlag'

describe('artifact management config and session freeze', () => {
  it('reads artifactManagementEnabled from app config', () => {
    const db = createMemoryAppDb()
    expect(readArtifactManagementEnabledFromConfig(db)).toBe(false)
    setConfigValue(db, ARTIFACT_MANAGEMENT_CONFIG_KEY, 'true')
    expect(readArtifactManagementEnabledFromConfig(db)).toBe(true)
  })

  it('freezes artifactManagementEnabled at session creation from config input', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, ARTIFACT_MANAGEMENT_CONFIG_KEY, 'true')
    const session = createSession(db, {
      name: 'artifact-on',
      artifactManagementEnabled: readArtifactManagementEnabledFromConfig(db)
    })
    expect(isArtifactManagementEnabled(getSession(db, session.id)!.metadata)).toBe(true)
    expect(shouldUseLegacyWorkspaceRedirect(getSession(db, session.id)!.metadata)).toBe(false)
  })

  it('keeps legacy redirect when config flag is off at session creation', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, {
      name: 'artifact-off',
      artifactManagementEnabled: readArtifactManagementEnabledFromConfig(db)
    })
    expect(shouldUseLegacyWorkspaceRedirect(getSession(db, session.id)!.metadata)).toBe(true)
  })
})
