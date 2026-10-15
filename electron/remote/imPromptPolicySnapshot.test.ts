import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot } from '../confirmation/imPolicyStore'
import { readImPromptPolicySnapshot } from './imPromptPolicySnapshot'

describe('readImPromptPolicySnapshot', () => {
  it('returns the common policy behavior version, revision, and gate snapshot', () => {
    const db = createMemoryAppDb('im-prompt-policy')
    commitImPolicySnapshot(getDbConnection(db), {
      policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'standard', enabled: false }, updatedAt: 1, eventId: 'prompt-policy'
    })
    expect(readImPromptPolicySnapshot(db)).toMatchObject({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 1,
      snapshot: { selectedPackage: 'standard', enabled: false }
    })
    db.close()
  })

  it('fails closed to an absent prompt policy when the snapshot is missing or has an unknown version', () => {
    const missing = createMemoryAppDb('im-prompt-policy-missing')
    expect(readImPromptPolicySnapshot(missing)).toBeUndefined()
    const conn = getDbConnection(missing)
    conn.prepare("INSERT INTO policy_behavior_snapshots VALUES('im','im-v99',1,'{}',1)").run()
    expect(readImPromptPolicySnapshot(missing)).toBeUndefined()
    missing.close()
  })
})
