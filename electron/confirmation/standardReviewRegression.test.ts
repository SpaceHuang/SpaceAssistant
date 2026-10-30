import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot, readImPolicySnapshot, reenableImStandardV3, rollbackImPolicyToVersion, restoreImPolicySnapshot } from './imPolicyStore'
import { ensureImPolicySnapshotAtStartup } from './legacyImConfigBoundary'

const gate = { publishedV3Ready: true, fixedRuleSetVerified: true, restrictionMappingVerified: true }

describe('IM standard re-review blockers', () => {
  it('binds an automatically allowed browser act to the URL from the gate', async () => {
    const { createHash } = await import('node:crypto')
    const { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff } = await import('./agentSdkSafetyPolicy')
    const { evaluateToolCallGate } = await import('./toolCallGate')
    const { DEFAULT_POLICY_RULES } = await import('../../src/shared/policy/defaultRules')
    const { resolveImPolicyRulesForVersion } = await import('../../src/shared/policy/policyPackages')
    const { DEFAULT_TOOLS_CONFIG } = await import('../../src/shared/domainTypes')
    const input = { action: 'act', instruction: 'click search' }
    const pageUrl = 'https://example.com/docs/a'
    const runtime: Record<string, unknown> = {}
    const imPolicySnapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard', remoteBrowserActRequiresConfirm: false } }
    const args: any = { toolName: 'browser', toolInput: input, sessionId: 's', requestId: 'r', toolUseId: 't', lane: 'feishu', lanePackage: 'standard', remoteContext: { source: 'feishu' }, workDir: '/tmp', userDataDir: '/tmp', toolsConfig: DEFAULT_TOOLS_CONFIG, effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v3', pkg: 'standard', rules: DEFAULT_POLICY_RULES }), decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }, shellPrecheck: { touchTrustedCommand() {} }, browserConfig: { enabled: true, allowRemoteSessions: true, actRequiresConfirm: false, actSessionTrustEnabled: false }, imPolicySnapshot, currentPageUrl: pageUrl, audit: { record() {} } }
    const binding: any = { requestId: 'r', turnId: 'turn', invocationId: 'inv', toolCallId: 't', capabilityId: 'browser', inputSnapshotHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'a', phase: 'initial-compat', capability: { state: 'known-authorized', id: 'browser' } }
    const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: (_call, update) => update(runtime) })
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => args, ...handoff, evaluateGate: evaluateToolCallGate })
    expect(await policy.evaluate(binding)).toMatchObject({ kind: 'allow' })
    expect(runtime.approvedBrowserPageIdentity).toBe(createHash('sha256').update(pageUrl).digest('hex'))
    expect(await policy.evaluate({ ...binding, phase: 'recheck' })).toMatchObject({ kind: 'allow' })
    expect(runtime.approvedBrowserPageIdentity).toBe(createHash('sha256').update(pageUrl).digest('hex'))
  })

  it('does not re-register a consumed initial user read approval at recheck', async () => {
    const { createHash } = await import('node:crypto')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff, markAgentSdkSafetyDecisionConfirmed } = await import('./agentSdkSafetyPolicy')
    const { ReadConfirmationRegistry } = await import('./readConfirmationRegistry')
    const { evaluateToolCallGate } = await import('./toolCallGate')
    const { DEFAULT_POLICY_RULES } = await import('../../src/shared/policy/defaultRules')
    const { resolvePolicyRules } = await import('../../src/shared/policy/policyPackages')
    const { DEFAULT_TOOLS_CONFIG } = await import('../../src/shared/domainTypes')
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rereview-read-')))
    const work = path.join(root, 'work'), outside = path.join(root, 'outside')
    await fs.mkdir(work); await fs.mkdir(outside)
    const file = path.join(outside, 'a.txt'); await fs.writeFile(file, 'ok')
    const input = { path: file }, registry = new ReadConfirmationRegistry(), runtime: Record<string, any> = {}
    const args: any = { workDir: work, userDataDir: path.join(root, 'ud'), sessionId: 's', requestId: 'r', toolUseId: 't', lane: 'desktop', lanePackage: 'strict', toolName: 'read_file', toolInput: input, toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, readConfirmationRegistry: registry, effectiveRules: resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'strict' }, rules: DEFAULT_POLICY_RULES }), decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }, shellPrecheck: { touchTrustedCommand() {} } }
    const handoff = createAgentSdkStructuralPermitHandoff({ readConfirmationRegistry: registry, updateExecutionContext: (_call: any, update: any) => update(runtime) })
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => args, ...handoff, evaluateGate: evaluateToolCallGate as any })
    const binding: any = { requestId: 'r', turnId: 'turn', invocationId: 'inv', toolCallId: 't', capabilityId: 'read_file', inputSnapshotHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'a', phase: 'initial-compat', capability: { state: 'known-authorized', id: 'read_file' } }
    try {
      expect(await policy.evaluate(binding)).toMatchObject({ kind: 'ask', answerer: 'user' })
      markAgentSdkSafetyDecisionConfirmed(policy, binding, 'user')
      expect(runtime.readExecutionPermit).toBeDefined()
      expect(await policy.evaluate({ ...binding, phase: 'recheck' })).toMatchObject({ kind: 'allow' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('rejects re-enable while the restored snapshot still has unresolved restrictions', () => {
    const db = createMemoryAppDb('rereview-reenable')
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'standard', humanRequired: true, unresolvedDifferences: ['customRules'] }, updatedAt: 1, eventId: 'seed' })
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 2, eventId: 'v2' })
    ensureImPolicySnapshotAtStartup(db, gate)
    rollbackImPolicyToVersion(conn, { expectedRevision: 3, policyBehaviorVersion: 'im-standard-v2', supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'], updatedAt: 3, eventId: 'rollback' })
    restoreImPolicySnapshot(conn, { historyId: 'im:1', supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'], updatedAt: 4, eventId: 'restore' })
    const before = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(() => reenableImStandardV3(conn, { expectedRevision: before.revision, releaseGate: gate, updatedAt: 5, eventId: 'reenable' })).toThrow(/unresolved|qualification|snapshot/i)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })).toMatchObject({ policyBehaviorVersion: 'im-v1.6', revision: before.revision })
    db.close()
  })

  it.each([
    { selectedPackage: 'unrecognized' },
    { legacySelectedPackages: 'broken' },
    { legacySelectedPackages: { wechat: 'unrecognized', feishu: 'standard' } }
  ])('does not migrate invalid explicit package data: %o', (snapshot) => {
    const db = createMemoryAppDb('rereview-corrupt-package')
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot, updatedAt: 1, eventId: 'seed' })
    ensureImPolicySnapshotAtStartup(db, gate)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2', 'im-standard-v3'] })).toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 1 })
    db.close()
  })

  it.each([
    { selectedPackage: 'bad-value' },
    { selectedPackage: 'standard', legacySelectedPackages: { wechat: 'bad-value', feishu: 'standard' } }
  ])('rejects explicit re-enable after restoring an invalid package snapshot: %o', (snapshot) => {
    const db = createMemoryAppDb('rereview-invalid-reenable')
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot, updatedAt: 1, eventId: 'invalid-v1' })
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' }, updatedAt: 2, eventId: 'clean-v2' })
    ensureImPolicySnapshotAtStartup(db, gate)
    rollbackImPolicyToVersion(conn, { expectedRevision: 3, policyBehaviorVersion: 'im-standard-v2', supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'], updatedAt: 3, eventId: 'rollback' })
    restoreImPolicySnapshot(conn, { historyId: 'im:1', supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'], updatedAt: 4, eventId: 'restore' })
    const before = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(() => reenableImStandardV3(conn, { expectedRevision: before.revision, releaseGate: gate, updatedAt: 5, eventId: 'reenable-invalid' })).toThrow(/qualification|package/i)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })).toEqual(before)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 5 })
    db.close()
  })
})
