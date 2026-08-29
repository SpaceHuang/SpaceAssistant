import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { setConfigValue } from '../database'
import { ARTIFACT_MANAGEMENT_CONFIG_KEY, readArtifactManagementEnabledFromConfig } from './artifactConfig'

describe('artifact management config and session freeze', () => {
  it('reads artifactManagementEnabled from app config', () => {
    const db = createMemoryAppDb()
    expect(readArtifactManagementEnabledFromConfig(db)).toBe(false)
    setConfigValue(db, ARTIFACT_MANAGEMENT_CONFIG_KEY, 'true')
    expect(readArtifactManagementEnabledFromConfig(db)).toBe(true)
  })
})
