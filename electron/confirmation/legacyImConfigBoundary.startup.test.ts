import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, getDbConnection, setConfigValue } from '../database'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot, readImPolicySnapshot, readPolicyBehaviorSnapshot } from './imPolicyStore'
import { ensureImPolicySnapshotAtStartup } from './legacyImConfigBoundary'
import { PolicyRuleStore } from './policyRuleStore'
import { resolveEffectivePolicyRulesWithOrigin, writePolicyPackages } from './policyRulesRuntime'
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
    expect(resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')
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
    expect(resolveEffectivePolicyRulesWithOrigin(db, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')?.action).toBe('deny')
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
