import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot, readImPolicySnapshot } from './imPolicyStore'
import { planLegacyImPolicyMigration } from '../../src/shared/policy/legacyPolicyMigration'
import { resolveFrozenLegacyPolicyBehavior } from '../../src/shared/policy/legacyPolicyBehavior'

describe('legacy IM migration matrix', () => {
  it('dry-runs unready release, incomplete legacy fields, and unresolvable channel conflicts without writing a database', () => {
    const releaseReady = false
    const legacy = { policyBehaviorVersion: 'im-v1.6', standard: { pkg: 'standard', rules: [] } }

    // This is a test-only migration gate model. It never calls the production startup migrator.
    const dryRun = (input: Parameters<typeof planLegacyImPolicyMigration>[0]) => {
      if (!releaseReady) return { status: 'blocked' as const, reason: 'release-not-ready' }
      try {
        const plan = planLegacyImPolicyMigration(input)
        if (!plan.snapshot.legacyBehavior) return { status: 'blocked' as const, reason: 'mapping-incomplete' }
        return { status: 'planned' as const, plan }
      } catch {
        return { status: 'blocked' as const, reason: 'mapping-incomplete' }
      }
    }

    expect(dryRun({ wechat: legacy })).toEqual({ status: 'blocked', reason: 'release-not-ready' })
    expect(dryRun({ wechat: { ...legacy, policyBehaviorVersion: 'im-v99' } }))
      .toEqual({ status: 'blocked', reason: 'release-not-ready' })
    expect(dryRun({ wechat: legacy, feishu: { ...legacy, policyBehaviorVersion: 'im-standard-v2' } }))
      .toEqual({ status: 'blocked', reason: 'release-not-ready' })

    // A ready gate still fails closed for unknown/missing legacy data and version conflicts.
    const readyDryRun = (input: Parameters<typeof planLegacyImPolicyMigration>[0]) => {
      try {
        const plan = planLegacyImPolicyMigration(input)
        return plan.snapshot.legacyBehavior
          ? { status: 'planned' as const, plan }
          : { status: 'blocked' as const, reason: 'mapping-incomplete' }
      } catch {
        return { status: 'blocked' as const, reason: 'mapping-incomplete' }
      }
    }
    expect(readyDryRun({ wechat: { ...legacy, policyBehaviorVersion: 'im-v99' } }))
      .toEqual({ status: 'blocked', reason: 'mapping-incomplete' })
    expect(readyDryRun({ wechat: legacy, feishu: { ...legacy, policyBehaviorVersion: 'im-standard-v2' } }))
      .toEqual({ status: 'blocked', reason: 'mapping-incomplete' })
    expect(readyDryRun({ wechat: { ...legacy, standard: undefined } })).toMatchObject({ status: 'planned' })
  })

  it.each(['wechat', 'feishu'] as const)('keeps %s legacy standard ask behavior after migration and restart', (channel) => {
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
    const plan = planLegacyImPolicyMigration({ [channel]: legacy })
    expect(plan).toMatchObject({ status: 'migrate', domain: 'im', policyBehaviorVersion: 'im-v1.6' })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: plan.policyBehaviorVersion,
      snapshot: { ...plan.snapshot, selectedPackage: legacy.selectedPackage },
      updatedAt: 1,
      eventId: `matrix-${channel}`
    })

    // Restart uses persisted common state, independent of runtime async approval availability.
    const persisted = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    const restarted = planLegacyImPolicyMigration({ [channel]: { ...legacy, policyBehaviorVersion: 'unexpected-new-config-version' }, currentSnapshot: persisted.snapshot })
    expect(restarted).toMatchObject({ status: 'already-migrated', policyBehaviorVersion: 'im-v1.6' })
    const frozen = resolveFrozenLegacyPolicyBehavior(restarted.snapshot)
    expect(frozen.sourcePolicyBehaviorVersion).toBe('im-v1.6')
    expect(frozen.packages.standard.rules).toEqual([{ id: 'sensitive-write', action: 'ask' }])
    expect(restarted.snapshot.humanRequired).toBe(false)
    db.close()
  })
})
