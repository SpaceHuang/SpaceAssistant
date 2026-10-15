import { describe, expect, it } from 'vitest'
import { planLegacyImPolicyMigration } from './legacyPolicyMigration'

const sameLegacyConfig = {
  remoteConfirmPolicy: 'remote_read_only',
  remoteAllowLocalWrite: false,
  remoteDenyOutbound: true,
  remoteBrowserRequiresConfirm: true,
  remoteScriptRequiresConfirm: true,
  policyBehaviorVersion: 'im-v1.6'
}

describe('frozen legacy IM migration planning', () => {
  it('maps identical channel legacy inputs to the same frozen common snapshot', () => {
    const plan = planLegacyImPolicyMigration({ wechat: sameLegacyConfig, feishu: sameLegacyConfig })
    expect(plan).toMatchObject({ status: 'migrate', domain: 'im', policyBehaviorVersion: 'im-v1.6' })
    expect(plan.snapshot).toEqual(expect.objectContaining({ denyWrite: true, denyOutbound: true, browserActRequiresConfirm: true }))
  })

  it('keeps the old manual behavior on restart until explicit version change', () => {
    const first = planLegacyImPolicyMigration({ wechat: sameLegacyConfig, feishu: sameLegacyConfig })
    const restarted = planLegacyImPolicyMigration({ wechat: sameLegacyConfig, feishu: sameLegacyConfig, currentSnapshot: first.snapshot })
    expect(restarted).toMatchObject({ status: 'already-migrated', policyBehaviorVersion: 'im-v1.6' })
    expect(restarted.snapshot).toEqual(first.snapshot)
  })

  it('merges comparable conflicting booleans toward stricter behavior and surfaces incomparable rules', () => {
    const plan = planLegacyImPolicyMigration({
      wechat: { policyBehaviorVersion: 'im-v1.6', remoteAllowLocalWrite: true, remoteDenyOutbound: false, remoteScriptRequiresConfirm: false, remoteBrowserRequiresConfirm: false, customRules: [{ id: 'x', action: 'allow' }] },
      feishu: { policyBehaviorVersion: 'im-v1.6', remoteAllowLocalWrite: false, remoteDenyOutbound: true, remoteScriptRequiresConfirm: true, remoteBrowserRequiresConfirm: true, customRules: [{ id: 'x', action: 'ask' }] }
    })
    expect(plan).toMatchObject({ status: 'migrate', snapshot: {
      denyWrite: true, denyOutbound: true, remoteScriptRequiresConfirm: true,
      browserActRequiresConfirm: true, unresolvedDifferences: expect.arrayContaining(['customRules'])
    } })
  })

  it('keeps one-sided explicit legacy safety fields and malformed or unknown fields fail closed', () => {
    const oneSided = planLegacyImPolicyMigration({ wechat: { remoteConfirmPolicy: 'remote_read_only' } })
    expect(oneSided).toMatchObject({ status: 'migrate', snapshot: { denyWrite: true, denyOutbound: true } })
    const malformed = planLegacyImPolicyMigration({
      wechat: { remoteAllowLocalWrite: 'unknown', remoteDenyOutbound: 'unknown', unknownConditions: { mode: 'maybe' } } as never,
      feishu: {}
    })
    expect(malformed).toMatchObject({ status: 'migrate', snapshot: { denyWrite: true, denyOutbound: true, unresolvedDifferences: expect.any(Array) } })
  })
})
