import { describe, expect, it, afterEach } from 'vitest'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { getConfigValue } from '../database'
import {
  readScratchGitPolicyPreference,
  scratchGitPolicyConfigKey,
  writeScratchGitPolicyPreference
} from './scratchGitPolicyStore'

describe('scratchGitPolicyStore', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => { for (const f of fixtures.splice(0)) f.teardown() })

  it('reads and writes workspace-level artifact.scratchGitPolicy.<profileId>', () => {
    const f = createArtifactTestFixture(); fixtures.push(f)
    expect(scratchGitPolicyConfigKey(f.profile.id)).toBe(`artifact.scratchGitPolicy.${f.profile.id}`)
    expect(readScratchGitPolicyPreference(f.db, f.profile.id)).toBeUndefined()
    writeScratchGitPolicyPreference(f.db, f.profile.id, 'keep-visible')
    expect(getConfigValue(f.db, scratchGitPolicyConfigKey(f.profile.id))).toBe('keep-visible')
    expect(readScratchGitPolicyPreference(f.db, f.profile.id)).toBe('keep-visible')
    writeScratchGitPolicyPreference(f.db, f.profile.id, undefined)
    expect(readScratchGitPolicyPreference(f.db, f.profile.id)).toBeUndefined()
  })
})
