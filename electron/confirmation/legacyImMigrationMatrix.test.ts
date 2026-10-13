import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot, readImPolicySnapshot } from './imPolicyStore'
import { planLegacyImPolicyMigration } from '../../src/shared/policy/legacyPolicyMigration'
import { resolveFrozenLegacyPolicyBehavior } from '../../src/shared/policy/legacyPolicyBehavior'

describe('legacy IM migration matrix', () => {
  it.each(['wechat', 'feishu'] as const)('keeps %s legacy standard ask behavior after migration, gate enable, and restart', (channel) => {
    const db = createMemoryAppDb(`legacy-im-matrix-${channel}`)
    const legacy = {
      policyBehaviorVersion: 'im-v1.6',
      selectedPackage: 'standard',
      standard: { pkg: 'standard', rules: [{ id: 'sensitive-write', action: 'ask' }] },
      remoteAllowLocalWrite: true,
      remoteDenyOutbound: false,
      remoteScriptRequiresConfirm: true,
      remoteBrowserRequiresConfirm: true
    }
    const plan = planLegacyImPolicyMigration({ [channel]: legacy, remoteAsyncApprovalEnabled: false })
    expect(plan).toMatchObject({ status: 'migrate', domain: 'im', policyBehaviorVersion: 'im-v1.6' })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: plan.policyBehaviorVersion,
      snapshot: { ...plan.snapshot, selectedPackage: legacy.selectedPackage },
      updatedAt: 1,
      eventId: `matrix-${channel}`
    })

    // Restart uses persisted common state while the async approval gate has been enabled.
    const persisted = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    const restarted = planLegacyImPolicyMigration({ [channel]: { ...legacy, policyBehaviorVersion: 'unexpected-new-config-version' }, currentSnapshot: persisted.snapshot, remoteAsyncApprovalEnabled: true })
    expect(restarted).toMatchObject({ status: 'already-migrated', policyBehaviorVersion: 'im-v1.6' })
    const frozen = resolveFrozenLegacyPolicyBehavior(restarted.snapshot)
    expect(frozen.sourcePolicyBehaviorVersion).toBe('im-v1.6')
    expect(frozen.packages.standard.rules).toEqual([{ id: 'sensitive-write', action: 'ask' }])
    expect(restarted.snapshot.humanRequired).toBe(false)
    db.close()
  })
})
