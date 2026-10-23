import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection, setConfigValue } from '../database'
import { registerPolicyIpc } from './policyIpc'
import { commitImPolicySnapshot, readImPolicySnapshot } from '../confirmation/imPolicyStore'
import { resolveEffectivePolicyRulesWithOrigin } from '../confirmation/policyRulesRuntime'
import { decide } from '../../src/shared/policy/policyEngine'

function registeredHandlers(db = createMemoryAppDb('policy-ipc-contract')) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerPolicyIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never, db as never)
  return { db, handlers }
}

describe('policy domain read IPC contract', () => {
  it('maps desktop, WeChat, and Feishu views to their trusted domains and returns one shared IM snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    conn.prepare("INSERT INTO policy_behavior_snapshots VALUES('desktop','desktop-v1',3,'{\"package\":\"standard\"}',1)").run()
    conn.prepare("INSERT INTO policy_behavior_snapshots VALUES('im','im-standard-v2',7,'{\"package\":\"standard\"}',1)").run()
    const read = handlers.get('policy:read-for-lane')!
    const desktop = await read({}, { lane: 'desktop' })
    const wechat = await read({}, { lane: 'wechat' })
    const feishu = await read({}, { lane: 'feishu' })
    expect(desktop).toMatchObject({ domain: 'desktop', revision: 3 })
    expect(wechat).toMatchObject({ domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 7 })
    expect(wechat.snapshot).not.toHaveProperty('enabled')
    expect(feishu).toEqual(wechat)
    db.close()
  })

  it('rejects unknown lanes and caller-selected or unknown domains', async () => {
    const { db, handlers } = registeredHandlers()
    const read = handlers.get('policy:read-for-lane')!
    await expect(read({}, { lane: 'automation' })).rejects.toThrow('POLICY_LANE_UNSUPPORTED')
    await expect(read({}, { lane: 'wechat', domain: 'desktop' })).rejects.toThrow('POLICY_DOMAIN_MUST_NOT_BE_SPECIFIED')
    await expect(read({}, { lane: 'desktop', domain: 'unknown' })).rejects.toThrow('POLICY_DOMAIN_MUST_NOT_BE_SPECIFIED')
    db.close()
  })

  it('executes the unified IM snapshot overrides and package selection written through policy IPC', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    setConfigValue(db, 'config.policyPackages', JSON.stringify({ desktop: 'standard', wechat: 'custom', feishu: 'custom', automation: 'standard' }))
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'custom' }, updatedAt: 1, eventId: 'runtime-snapshot-seed' })
    const write = handlers.get('policy:write')!
    await expect(write({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'rule-enabled', ruleId: 'remote-shell-disabled', enabled: false } }))
      .rejects.toThrow('POLICY_CHANGE_KIND_INVALID')
    let snapshot = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })
    await write({}, { lane: 'wechat', expectedRevision: snapshot.revision,
      change: { kind: 'rule-override', ruleId: 'mcp-tool-ask', action: 'deny' } })
    let rules = resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat')
    expect(rules.rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')
    expect(rules.origins['mcp-tool-ask']?.source).toBe('user-override')
    expect(rules.rules.find((rule) => rule.id === 'im-low-risk-create')?.action).toBe('ask')

    snapshot = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })
    await write({}, { lane: 'wechat', expectedRevision: snapshot.revision,
      change: { kind: 'package', package: 'custom' } })
    expect(resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')

    await write({}, { lane: 'wechat', expectedRevision: 3,
      change: { kind: 'rule-override', ruleId: 'remote-shell-disabled', action: 'allow' } })
    let effective = resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat')
    expect(effective.rules.find((rule) => rule.id === 'remote-shell-disabled')).toMatchObject({ action: 'allow', userOverride: true })
    expect(effective.disabledRuleIds).not.toContain('remote-shell-disabled')
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] }).snapshot.ruleOverrides)
      .toMatchObject({ 'remote-shell-disabled': 'allow' })

    await write({}, { lane: 'wechat', expectedRevision: 4,
      change: { kind: 'rule-reset', ruleId: 'remote-shell-disabled' } })
    effective = resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat')
    expect(effective.rules.find((rule) => rule.id === 'remote-shell-disabled')?.action).toBe('deny')
    expect(effective.disabledRuleIds).not.toContain('remote-shell-disabled')
    db.close()
  })

  it('applies the same explicit IM deny override to a legacy behavior snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'custom' }, updatedAt: 1, eventId: 'legacy-runtime-seed' })
    const write = handlers.get('policy:write')!
    await write({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'rule-override', ruleId: 'mcp-tool-ask', action: 'deny' } })

    const rules = resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat')
    expect(rules.rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')
    expect(rules.rules.find((rule) => rule.id === 'scope-loose-browser-navigate-ask-remote')?.action).toBeUndefined()
    expect(rules.origins['mcp-tool-ask']?.source).toBe('user-override')
    db.close()
  })

  it('explicit deny override removes the original browser confirmation condition', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'custom' }, updatedAt: 1, eventId: 'custom-condition-seed' })
    await handlers.get('policy:write')!({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'rule-override', ruleId: 'browser-act-allow-unconfigured', action: 'deny' } })

    const rule = resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat').rules.find((entry) => entry.id === 'browser-act-allow-unconfigured')
    expect(rule).toMatchObject({ action: 'deny' })
    expect(rule?.configRequires).toBeUndefined()
    expect(rule?.askUnless).toBeUndefined()
    expect(rule?.requiresContext).toBeUndefined()
    expect(decide({ toolName: 'browser', actionClass: 'write', baseRiskLevel: 'medium',
      signals: [{ kind: 'browser-action', action: 'act', dangerous: false, sideEffect: 'read', completeness: 'complete' }],
      summary: { text: 'ordinary browser action' } },
    { lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 'custom-deny-session' },
    resolveEffectivePolicyRulesWithOrigin(db as never, 'wechat').rules,
    { cache: { lookup: () => null }, config: { actRequiresConfirm: true, remoteActSkipConfirm: false }, migrationComplete: false }))
      .toMatchObject({ type: 'deny', ruleId: 'browser-act-allow-unconfigured' })
    db.close()
  })

  it('rejects invalid package/action enums while allowing an explicit locked-rule override', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { package: 'standard', ruleOverrides: {} }, updatedAt: 1, eventId: 'seed-write' })
    const write = handlers.get('policy:write')!
    const before = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })
    await expect(write({}, { lane: 'wechat', expectedRevision: before.revision, change: { kind: 'package', package: 'turbo' } })).rejects.toThrow('POLICY_PACKAGE_INVALID')
    const overridden = await write({}, { lane: 'wechat', expectedRevision: before.revision, change: { kind: 'rule-override', ruleId: 'remote-outside-write-deny', action: 'allow' } })
    expect(overridden).toMatchObject({ status: 'committed', revision: 2 })
    const afterOverride = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })
    expect(afterOverride.snapshot.ruleOverrides).toMatchObject({ 'remote-outside-write-deny': 'allow' })
    await expect(write({}, { lane: 'wechat', expectedRevision: afterOverride.revision, change: { kind: 'rule-override', ruleId: 'script-unmodeled-path-ask', action: 'maybe' } })).rejects.toThrow('POLICY_ACTION_INVALID')
    await expect(write({}, { lane: 'wechat', expectedRevision: afterOverride.revision, change: { kind: 'capability-permission', capabilityId: 'env.system', permission: 'superuser' } })).rejects.toThrow('POLICY_PERMISSION_INVALID')
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toEqual(afterOverride)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 2 })
    db.close()
  })

  it('clears a migrated-source badge when the user explicitly edits that rule', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: {
      package: 'custom', ruleOverrides: { 'remote-outside-write-deny': 'allow' },
      migratedLegacyDisabledRuleIds: ['remote-outside-write-deny']
    }, updatedAt: 1, eventId: 'seed-migrated-source' })
    const before = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })
    await handlers.get('policy:write')!({}, { lane: 'wechat', expectedRevision: before.revision,
      change: { kind: 'rule-override', ruleId: 'remote-outside-write-deny', action: 'ask' } })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] }).snapshot.migratedLegacyDisabledRuleIds).toEqual([])
    db.close()
  })

  it('returns a revision conflict without changing snapshot, authorization epoch, or audit', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { package: 'standard' }, updatedAt: 1, eventId: 'seed-cas' })
    const write = handlers.get('policy:write')!
    const result = await write({}, { lane: 'wechat', expectedRevision: 0, change: { kind: 'package', package: 'strict' } })
    expect(result).toMatchObject({ status: 'conflict', currentRevision: 1 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({ revision: 1, snapshot: { package: 'standard' } })
    expect(conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 1 })
    db.close()
  })

  it('commits a valid shared IM policy change with revision, epoch invalidation, and audit', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'seed-valid' })
    const result = await handlers.get('policy:write')!({}, {
      lane: 'feishu', expectedRevision: 1, change: { kind: 'package', package: 'strict' }
    })
    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      revision: 2, snapshot: { selectedPackage: 'strict' }
    })
    expect(conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='im'").get()).toEqual({ epoch: 2 })
    expect(conn.prepare("SELECT COUNT(*) AS count FROM policy_audit_events WHERE domain='im'").get()).toEqual({ count: 2 })
    db.close()
  })

  it('stores a validated declared capability permission in the same shared policy snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: {}, updatedAt: 1, eventId: 'seed-capability' })
    const result = await handlers.get('policy:write')!({}, {
      lane: 'wechat', expectedRevision: 1,
      change: { kind: 'capability-permission', capabilityId: 'env.system', permission: 'ask' }
    })
    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      snapshot: { capabilityPermissions: { 'env.system': 'ask' } }
    })
    db.close()
  })

  it('switches a legacy IM snapshot to the current standard only after explicit confirmation of all displayed differences', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: 'im-v1.6',
      snapshot: { legacyBehavior: { packages: { standard: { pkg: 'standard', rules: [] } } } },
      updatedAt: 1, eventId: 'seed-legacy-switch'
    })
    const change = handlers.get('policy:write')!
    const displayedDiffs = [
      'mcp-public-read-auto',
      'low-risk-browser-and-feishu-auto',
      'sensitive-write-and-external-outbound-manual'
    ]
    await expect(change({}, {
      lane: 'wechat', expectedRevision: 1, change: { kind: 'switch-to-standard', userChoiceConfirmed: false, displayedDiffs }
    })).rejects.toThrow('POLICY_BEHAVIOR_SWITCH_CONFIRMATION_REQUIRED')
    const result = await change({}, {
      lane: 'wechat', expectedRevision: 1, change: { kind: 'switch-to-standard', userChoiceConfirmed: true, displayedDiffs }
    })
    expect(result).toMatchObject({ status: 'committed', revision: 2 })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      policyBehaviorVersion: 'im-standard-v2', revision: 2,
      snapshot: { selectedPackage: 'standard', explicitBehaviorSwitch: true, displayedBehaviorDiffs: displayedDiffs }
    })
    db.close()
  })

  it('resets both ordinary and locked rules to their defaults in the common snapshot', async () => {
    const { db, handlers } = registeredHandlers()
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, {
      policyBehaviorVersion: 'im-standard-v2',
      snapshot: { ruleOverrides: { 'im-write-ask': 'allow' }, disabledRuleIds: [] },
      updatedAt: 1, eventId: 'seed-reset-toggle'
    })
    const write = handlers.get('policy:write')!
    await write({}, { lane: 'wechat', expectedRevision: 1, change: { kind: 'rule-reset', ruleId: 'im-write-ask' } })
    await write({}, { lane: 'feishu', expectedRevision: 2, change: { kind: 'rule-override', ruleId: 'remote-shell-disabled', action: 'allow' } })
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] })).toMatchObject({
      revision: 3, snapshot: { ruleOverrides: { 'remote-shell-disabled': 'allow' }, disabledRuleIds: [] }
    })
    const lockedOverride = await write({}, {
      lane: 'wechat', expectedRevision: 3, change: { kind: 'rule-override', ruleId: 'im-write-ask', action: 'allow' }
    }) as { status: string }
    expect(lockedOverride.status).toBe('committed')
    db.close()
  })
})
