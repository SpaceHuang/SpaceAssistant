import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, getDbConnection, setConfigValue } from '../database'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot, readImPolicySnapshot, readPolicyBehaviorSnapshot, rollbackImPolicyToVersion } from './imPolicyStore'
import { ensureImPolicySnapshotAtStartup } from './legacyImConfigBoundary'
import { PolicyRuleStore } from './policyRuleStore'
import { loadEffectivePolicyRules, readPolicyPackages, resolveEffectivePolicyRulesWithOrigin, writePolicyPackages } from './policyRulesRuntime'
import { registerPolicyIpc } from '../ipc/policyIpc'
import { DEFAULT_POLICY_PACKAGES } from '../../src/shared/policy/policyPackages'
import { decide } from '../../src/shared/policy/policyEngine'
import type { ContentFacts, PolicyEngineDeps } from '../../src/shared/confirmation/types'

function registerPolicyHandlers(db: ReturnType<typeof createMemoryAppDb>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerPolicyIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never,
    db as never)
  return handlers
}

describe('legacy IM policy migration at startup', () => {
  const releasedV3Gate = { publishedV3Ready: true as const, fixedRuleSetVerified: true, restrictionMappingVerified: true }

  it('migrates only standard snapshots under the complete release gate and records one atomic migration', () => {
    const db = createMemoryAppDb('im-v3-startup-migration')
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2',
      snapshot: { selectedPackage: 'standard', remoteDenyOutbound: true, remoteScriptRequiresConfirm: true,
        ruleOverrides: { 'mcp-tool-ask': 'deny' } }, updatedAt: 1, eventId: 'v2-seed' })

    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)

    const migrated = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2', 'im-standard-v3'] })
    expect(migrated).toMatchObject({ policyBehaviorVersion: 'im-standard-v3', revision: 2, snapshot: {
      selectedPackage: 'standard', remoteDenyOutbound: true, remoteScriptRequiresConfirm: true,
      ruleOverrides: { 'mcp-tool-ask': 'deny' }, migrationSourceVersion: 'im-standard-v2'
    } })
    expect(conn.prepare("SELECT COUNT(*) AS count FROM policy_audit_events WHERE event_json LIKE '%im-standard-v3-startup-migration%' AND domain='im'").get())
      .toEqual({ count: 1 })
    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v3'] }).revision).toBe(2)
    expect(conn.prepare("SELECT COUNT(*) AS count FROM policy_audit_events WHERE event_json LIKE '%im-standard-v3-startup-migration%' AND domain='im'").get())
      .toEqual({ count: 1 })
    db.close()
  })

  it('keeps development startup and fresh installs on the old default without the full release gate', () => {
    const developmentDb = createMemoryAppDb('im-v3-unpublished-startup')
    const developmentConn = getDbConnection(developmentDb)
    commitImPolicySnapshot(developmentConn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'v2-dev-seed' })
    ensureImPolicySnapshotAtStartup(developmentDb)
    expect(readImPolicySnapshot(developmentConn, { supportedBehaviorVersions: ['im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 1 })
    const freshDb = createMemoryAppDb('im-v3-unpublished-install')
    ensureImPolicySnapshotAtStartup(freshDb)
    expect(() => readImPolicySnapshot(getDbConnection(freshDb), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }))
      .toThrow(/snapshot is missing/)
    developmentDb.close()
    freshDb.close()
  })

  it.each([
    { publishedV3Ready: false, fixedRuleSetVerified: true, restrictionMappingVerified: true },
    { publishedV3Ready: true, fixedRuleSetVerified: false, restrictionMappingVerified: true },
    { publishedV3Ready: true, fixedRuleSetVerified: true, restrictionMappingVerified: false }
  ])('does not migrate when any single v3 release gate fact is missing: %o', (incompleteGate) => {
    const db = createMemoryAppDb('im-v3-incomplete-gate')
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'incomplete-gate-seed' })
    ensureImPolicySnapshotAtStartup(db, incompleteGate)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 1 })
    db.close()
  })

  it('does not automatically migrate custom packages or a snapshot suppressed after rollback', () => {
    const customDb = createMemoryAppDb('im-v3-custom-not-migrated')
    const customConn = getDbConnection(customDb)
    commitImPolicySnapshot(customConn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'custom' },
      updatedAt: 1, eventId: 'custom-seed' })
    ensureImPolicySnapshotAtStartup(customDb, releasedV3Gate)
    expect(readImPolicySnapshot(customConn, { supportedBehaviorVersions: ['im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 1 })

    const suppressedDb = createMemoryAppDb('im-v3-suppressed-not-migrated')
    const suppressedConn = getDbConnection(suppressedDb)
    commitImPolicySnapshot(suppressedConn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'v2-seed' })
    ensureImPolicySnapshotAtStartup(suppressedDb, releasedV3Gate)
    rollbackImPolicyToVersion(suppressedConn, { expectedRevision: 2, policyBehaviorVersion: 'im-standard-v2',
      supportedBehaviorVersions: ['im-standard-v2'], updatedAt: 2, eventId: 'rollback-v3' })
    ensureImPolicySnapshotAtStartup(suppressedDb, releasedV3Gate)
    expect(readImPolicySnapshot(suppressedConn, { supportedBehaviorVersions: ['im-standard-v2'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v2', revision: 3,
        snapshot: { automaticMigrationSuppressedVersions: ['im-standard-v3'] } })
    customDb.close()
    suppressedDb.close()
  })

  it('fails closed instead of treating a corrupt suppression field as empty during startup migration', () => {
    const db = createMemoryAppDb('im-v3-corrupt-suppression')
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'corrupt-suppression-seed' })
    conn.prepare("UPDATE policy_behavior_snapshots SET snapshot_json=? WHERE domain='im'")
      .run(JSON.stringify({ selectedPackage: 'standard', automaticMigrationSuppressedVersions: ['unknown-version'] }))
    expect(() => ensureImPolicySnapshotAtStartup(db, releasedV3Gate))
      .toThrow('Invalid IM automatic migration suppression field')
    expect(conn.prepare("SELECT policy_behavior_version,revision FROM policy_behavior_snapshots WHERE domain='im'").get())
      .toEqual({ policy_behavior_version: 'im-standard-v2', revision: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM policy_audit_events').get()).toEqual({ count: 1 })
    db.close()
  })

  it('initializes a fresh standard snapshot as v3 only when every release gate is explicitly true', () => {
    const db = createMemoryAppDb('im-v3-fresh-install-release-gated')
    ensureImPolicySnapshotAtStartup(db, releasedV3Gate)
    expect(readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-standard-v3'] }))
      .toMatchObject({ policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } })
    db.close()
  })

  it('creates a frozen policy snapshot from existing channel config without rewriting channel config', () => {
    const db = createMemoryAppDb('legacy-im-startup')
    const legacyConfig = {
      enabled: true,
      remoteEnabled: true,
      remoteConfirmPolicy: 'ask',
      remoteAllowLocalWrite: true,
      remoteDenyOutbound: false,
      remoteScriptRequiresConfirm: true,
      remoteBrowserRequiresConfirm: true
    }
    setConfigValue(db, 'config.wechat', JSON.stringify(legacyConfig))

    ensureImPolicySnapshotAtStartup(db)

    const snapshot = readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(snapshot.policyBehaviorVersion).toBe('im-v1.6')
    expect(snapshot.snapshot).toBeTruthy()
    expect(JSON.parse(getConfigValue(db, 'config.wechat')!)).toEqual(legacyConfig)
    db.close()
  })

  it('does nothing when a fresh installation has no legacy channel config', () => {
    const db = createMemoryAppDb('legacy-im-startup-empty')

    expect(() => ensureImPolicySnapshotAtStartup(db)).not.toThrow()
    expect(() => readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })).toThrow(/IM policy snapshot is missing/)
    db.close()
  })

  it('preserves an existing custom deny from the legacy rule table through startup migration and runtime decision', () => {
    const db = createMemoryAppDb('legacy-im-custom-deny')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })

    ensureImPolicySnapshotAtStartup(db)

    const effective = resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules
    const facts: ContentFacts = { toolName: 'mcp_tool', actionClass: 'execute', baseRiskLevel: 'medium',
      signals: [{ kind: 'mcp-tool', toolName: 'server_tool' }], summary: { text: 'MCP tool' } }
    const deps: PolicyEngineDeps = { cache: { lookup: () => null }, config: {}, migrationComplete: true }
    expect(decide(facts, { lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 'legacy-session' }, effective, deps))
      .toMatchObject({ type: 'deny', ruleId: 'mcp-tool-ask' })
    expect(readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }).snapshot)
      .toMatchObject({ ruleOverrides: { 'mcp-tool-ask': 'deny' }, legacyPolicyDataMigrated: true })
    // Once imported, the runtime uses the snapshot as its source of truth, not the stale legacy table.
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'allow', params: {} })
    expect(resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')
    db.close()
  })

  it('audibly backfills custom rules missing from a preexisting legacy snapshot exactly once', () => {
    const db = createMemoryAppDb('legacy-im-snapshot-backfill')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    // Simulate a prior release snapshot written before custom rule data was copied.
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: { denyWrite: true }, updatedAt: 1, eventId: 'old-im-snapshot' })

    ensureImPolicySnapshotAtStartup(db)
    const migrated = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(migrated.snapshot).toMatchObject({ ruleOverrides: { 'mcp-tool-ask': 'deny' }, legacyPolicyDataMigrated: true })
    expect(conn.prepare("SELECT event_json FROM policy_audit_events WHERE event_id != 'old-im-snapshot'").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ event_json: expect.stringContaining('legacy-custom-rules-backfill') })]))
    const revision = migrated.revision
    ensureImPolicySnapshotAtStartup(db)
    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }).revision).toBe(revision)
    db.close()
  })

  it('merges legacy denies into a partially edited snapshot without replacing its newer rule', async () => {
    const db = createMemoryAppDb('legacy-im-partial-snapshot-backfill')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'custom' }, updatedAt: 1, eventId: 'partial-seed' })
    const handlers = registerPolicyHandlers(db)

    await handlers.get('policy:write')!({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'rule-override', ruleId: 'browser-act-ask-remote', action: 'ask' } })
    ensureImPolicySnapshotAtStartup(db)

    const migrated = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(migrated.snapshot).toMatchObject({
      ruleOverrides: { 'mcp-tool-ask': 'deny', 'browser-act-ask-remote': 'ask' },
      legacyPolicyDataMigrated: true,
      legacyPolicyMigrationVersion: 2
    })
    const effective = resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules
    const facts: ContentFacts = { toolName: 'mcp_tool', actionClass: 'execute', baseRiskLevel: 'medium',
      signals: [{ kind: 'mcp-tool', toolName: 'server_tool' }], summary: { text: 'MCP tool' } }
    const deps: PolicyEngineDeps = { cache: { lookup: () => null }, config: {}, migrationComplete: true }
    expect(decide(facts, { lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 'partial-backfill' }, effective, deps))
      .toMatchObject({ type: 'deny', ruleId: 'mcp-tool-ask' })
    db.close()
  })

  it('repairs a partially imported snapshot already marked complete by the previous migration', () => {
    const db = createMemoryAppDb('legacy-im-partial-already-marked')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: {
      selectedPackage: 'custom', ruleOverrides: { 'browser-act-ask-remote': 'ask' }, disabledRuleIds: [],
      legacySelectedPackages: { wechat: 'custom', feishu: 'custom' }, legacyPolicyDataMigrated: true
    }, updatedAt: 1, eventId: 'previously-marked-partial-seed' })

    ensureImPolicySnapshotAtStartup(db)

    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }).snapshot).toMatchObject({
      ruleOverrides: { 'mcp-tool-ask': 'deny', 'browser-act-ask-remote': 'ask' },
      legacyPolicyDataMigrated: true,
      legacyPolicyMigrationVersion: 2
    })
    db.close()
  })

  it('migrates legacy IM disabled IDs to allow overrides and atomically clears their legacy storage', () => {
    const db = createMemoryAppDb('legacy-im-disabled-action-migration')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: {
      selectedPackage: 'custom', ruleOverrides: { 'remote-shell-disabled': 'ask' }, disabledRuleIds: ['remote-shell-disabled', 'script-network-deny-remote']
    }, updatedAt: 1, eventId: 'disabled-migration-seed' })

    ensureImPolicySnapshotAtStartup(db)

    const snapshot = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(snapshot.snapshot.ruleOverrides).toMatchObject({
      'remote-shell-disabled': 'allow', 'script-network-deny-remote': 'allow'
    })
    expect(snapshot.snapshot.migratedLegacyDisabledRuleIds).toEqual(['remote-shell-disabled', 'script-network-deny-remote'])
    expect(snapshot.snapshot.disabledRuleIds).toEqual([])
    expect(JSON.parse(getConfigValue(db, 'config.disabledPolicyRuleIds') ?? '[]')).toEqual([])
    db.close()
  })

  it('rejects unknown legacy desktop disabled IDs without clearing the source value', () => {
    const db = createMemoryAppDb('legacy-desktop-disabled-unknown')
    setConfigValue(db, 'config.disabledPolicyRuleIds', JSON.stringify(['future-rule-id']))
    expect(() => ensureImPolicySnapshotAtStartup(db)).toThrow('unknown disabled policy rule')
    expect(JSON.parse(getConfigValue(db, 'config.disabledPolicyRuleIds') ?? '[]')).toEqual(['future-rule-id'])
    expect(getDbConnection(db).prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='desktop'").get()).toBeUndefined()
    db.close()
  })

  it('gives a legacy desktop disabled ID precedence over a partial rule override', () => {
    const db = createMemoryAppDb('legacy-desktop-disabled-precedence')
    setConfigValue(db, 'config.disabledPolicyRuleIds', JSON.stringify(['remote-shell-disabled']))
    const conn = getDbConnection(db)
    commitDesktopPolicySnapshot(conn, { expectedRevision: 0, policyBehaviorVersion: 'desktop-v1', snapshot: {
      selectedPackage: 'custom', ruleOverrides: { 'remote-shell-disabled': 'ask' }
    }, updatedAt: 1, eventId: 'desktop-partial-seed' })

    ensureImPolicySnapshotAtStartup(db)

    expect(readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }).snapshot.ruleOverrides)
      .toEqual({ 'remote-shell-disabled': 'allow' })
    expect(readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }).snapshot.migratedLegacyDisabledRuleIds)
      .toEqual(['remote-shell-disabled'])
    expect(JSON.parse(getConfigValue(db, 'config.disabledPolicyRuleIds') ?? '[]')).toEqual([])
    db.close()
  })

  it('imports old desktop overrides and package before creating the first snapshot', () => {
    const db = createMemoryAppDb('legacy-desktop-first-snapshot-import')
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, desktop: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })

    ensureImPolicySnapshotAtStartup(db)

    const snapshot = readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] })
    expect(snapshot.snapshot).toMatchObject({ selectedPackage: 'custom', ruleOverrides: { 'mcp-tool-ask': 'deny' } })
    expect(loadEffectivePolicyRules(db, 'desktop').find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')
    db.close()
  })

  it('keeps shared disabled migration material until IM migration commits and retries atomically', () => {
    const db = createMemoryAppDb('legacy-shared-disabled-retry')
    const conn = getDbConnection(db)
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    setConfigValue(db, 'config.disabledPolicyRuleIds', JSON.stringify(['remote-shell-disabled']))
    conn.exec(`CREATE TRIGGER fail_im_snapshot BEFORE INSERT ON policy_behavior_snapshots
      WHEN NEW.domain='im' BEGIN SELECT RAISE(ABORT, 'IM snapshot failure'); END`)

    expect(() => ensureImPolicySnapshotAtStartup(db)).toThrow('IM snapshot failure')
    expect(JSON.parse(getConfigValue(db, 'config.disabledPolicyRuleIds') ?? '[]')).toEqual(['remote-shell-disabled'])
    expect(conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='desktop'").get()).toBeUndefined()
    expect(conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='im'").get()).toBeUndefined()

    conn.exec('DROP TRIGGER fail_im_snapshot')
    ensureImPolicySnapshotAtStartup(db)
    const desktop = readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] })
    const im = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(desktop.snapshot).toMatchObject({ ruleOverrides: { 'remote-shell-disabled': 'allow' }, migratedLegacyDisabledRuleIds: ['remote-shell-disabled'] })
    expect(im.snapshot).toMatchObject({ ruleOverrides: { 'remote-shell-disabled': 'allow' }, migratedLegacyDisabledRuleIds: ['remote-shell-disabled'] })
    expect(JSON.parse(getConfigValue(db, 'config.disabledPolicyRuleIds') ?? '[]')).toEqual([])
    db.close()
  })

  it('keeps migrated actions dormant outside custom and restores them when switching back', () => {
    const db = createMemoryAppDb('legacy-desktop-disabled-standard')
    setConfigValue(db, 'config.disabledPolicyRuleIds', JSON.stringify(['remote-shell-disabled']))

    ensureImPolicySnapshotAtStartup(db)

    const snapshot = readPolicyBehaviorSnapshot(getDbConnection(db), 'desktop', { supportedBehaviorVersions: ['desktop-v1'] })
    expect(snapshot.snapshot.selectedPackage).toBe('standard')
    expect(snapshot.snapshot.ruleOverrides).toMatchObject({ 'remote-shell-disabled': 'allow' })
    expect(readPolicyPackages(db).desktop).toBe('standard')
    expect(loadEffectivePolicyRules(db, 'desktop').find((rule) => rule.id === 'remote-shell-disabled'))
      .toMatchObject({ action: 'deny' })

    commitDesktopPolicySnapshot(getDbConnection(db), {
      expectedRevision: snapshot.revision,
      policyBehaviorVersion: 'desktop-v1',
      snapshot: { ...snapshot.snapshot, selectedPackage: 'custom' },
      updatedAt: 2,
      eventId: 'legacy-disabled-return-to-custom'
    })
    expect(loadEffectivePolicyRules(db, 'desktop').find((rule) => rule.id === 'remote-shell-disabled'))
      .toMatchObject({ action: 'allow', userOverride: true })
    db.close()
  })

  it('rolls back legacy desktop disabled IDs when snapshot persistence fails', () => {
    const db = createMemoryAppDb('legacy-desktop-disabled-rollback')
    setConfigValue(db, 'config.disabledPolicyRuleIds', JSON.stringify(['remote-shell-disabled']))
    const conn = getDbConnection(db)
    conn.exec(`CREATE TRIGGER fail_desktop_snapshot BEFORE INSERT ON policy_behavior_snapshots
      WHEN NEW.domain='desktop' BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END`)
    expect(() => ensureImPolicySnapshotAtStartup(db)).toThrow('snapshot failure')
    expect(JSON.parse(getConfigValue(db, 'config.disabledPolicyRuleIds') ?? '[]')).toEqual(['remote-shell-disabled'])
    expect(conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='desktop'").get()).toBeUndefined()
    db.close()
  })

  it('keeps an explicit new override for the same rule when importing the old deny', async () => {
    const db = createMemoryAppDb('legacy-im-partial-same-rule-override')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'custom' }, updatedAt: 1, eventId: 'same-rule-seed' })
    const handlers = registerPolicyHandlers(db)

    await handlers.get('policy:write')!({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'rule-override', ruleId: 'mcp-tool-ask', action: 'ask' } })
    ensureImPolicySnapshotAtStartup(db)

    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }).snapshot.ruleOverrides)
      .toEqual({ 'mcp-tool-ask': 'ask' })
    db.close()
  })

  it('does not restore a legacy rule that the user explicitly reset before backfill', async () => {
    const db = createMemoryAppDb('legacy-im-partial-explicit-reset')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: {
      selectedPackage: 'custom', ruleOverrides: { 'mcp-tool-ask': 'allow' }
    }, updatedAt: 1, eventId: 'reset-seed' })
    const handlers = registerPolicyHandlers(db)

    await handlers.get('policy:write')!({}, { lane: 'wechat', expectedRevision: 1,
      change: { kind: 'rule-reset', ruleId: 'mcp-tool-ask' } })
    ensureImPolicySnapshotAtStartup(db)

    const migrated = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(migrated.snapshot.ruleOverrides).toEqual({})
    expect(migrated.snapshot.legacyPolicyMigrationVersion).toBe(2)
    expect(resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('ask')
    db.close()
  })

  it('recognizes a pre-fix explicit reset from policy snapshot history', () => {
    const db = createMemoryAppDb('legacy-im-partial-historical-reset')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: {
      selectedPackage: 'custom', ruleOverrides: {}
    }, updatedAt: 2, eventId: 'historical-reset-current' })
    conn.prepare(`INSERT INTO policy_behavior_snapshot_history(history_id,domain,policy_behavior_version,snapshot_json,archived_at)
      VALUES(?,?,?,?,?)`).run('im:0', 'im', 'im-v1.6', JSON.stringify({ ruleOverrides: { 'mcp-tool-ask': 'allow' } }), 1)

    ensureImPolicySnapshotAtStartup(db)

    const migrated = readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(migrated.snapshot.ruleOverrides).toEqual({})
    expect(resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('ask')
    db.close()
  })

  it('does not infer a reset from history when the current snapshot has no override field', () => {
    const db = createMemoryAppDb('legacy-im-partial-history-without-current-field')
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, remoteEnabled: true }))
    writePolicyPackages(db, { ...DEFAULT_POLICY_PACKAGES, wechat: 'custom' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action: 'deny', params: {} })
    const conn = getDbConnection(db)
    commitImPolicySnapshot(conn, { policyBehaviorVersion: 'im-v1.6', snapshot: {
      selectedPackage: 'custom'
    }, updatedAt: 2, eventId: 'history-without-current-field' })
    conn.prepare(`INSERT INTO policy_behavior_snapshot_history(history_id,domain,policy_behavior_version,snapshot_json,archived_at)
      VALUES(?,?,?,?,?)`).run('im:0', 'im', 'im-v1.6', JSON.stringify({ ruleOverrides: { 'mcp-tool-ask': 'allow' } }), 1)

    ensureImPolicySnapshotAtStartup(db)

    expect(readImPolicySnapshot(conn, { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] }).snapshot.ruleOverrides)
      .toEqual({ 'mcp-tool-ask': 'deny' })
    db.close()
  })
})
