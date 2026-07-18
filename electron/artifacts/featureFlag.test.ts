import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, getSession, updateSession } from '../database'
import { isArtifactManagementEnabled, shouldUseLegacyWorkspaceRedirect } from './featureFlag'

describe('artifact management feature flag', () => {
  it('is frozen at session creation and does not change when later metadata updates omit it', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'new', artifactManagementEnabled: true })
    updateSession(db, session.id, { metadata: { unrelated: true } })
    expect(isArtifactManagementEnabled(getSession(db, session.id)!.metadata)).toBe(true)
  })

  it('keeps legacy redirect enabled only when artifact management is disabled', () => {
    expect(shouldUseLegacyWorkspaceRedirect({ artifactManagementEnabled: false })).toBe(true)
    expect(shouldUseLegacyWorkspaceRedirect({ artifactManagementEnabled: true })).toBe(false)
  })
})
