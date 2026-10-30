import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getConfigValue, getDbConnection, setConfigValue } from '../database'
import { runInTransaction } from '../database/transaction'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot, commitImPolicySnapshotFromStartupMigration, readImPolicySnapshot, readPolicyBehaviorSnapshot,
  validateImStandardV3SnapshotQualification, type ImStandardV3ReleaseGate } from './imPolicyStore'
import { LEGACY_IM_POLICY_MIGRATION_VERSION, planLegacyImPolicyMigration } from '../../src/shared/policy/legacyPolicyMigration'
import { PolicyRuleStore } from './policyRuleStore'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { readDisabledPolicyRuleIds, readPolicyPackages, DISABLED_POLICY_RULE_IDS_CONFIG_KEY } from './policyRulesRuntime'
import { isPolicyPackage, validateRuleOverride } from '../../src/shared/policy/policyPackages'

const SUPPORTED_IM_POLICY_VERSIONS = ['im-v1.6', 'im-standard-v2', 'im-standard-v3'] as const
const CHANNEL_POLICY_KEYS = [
  'remoteConfirmPolicy', 'remoteAllowLocalWrite', 'remoteDenyOutbound',
  'remoteBrowserRequiresConfirm', 'remoteBrowserNavigateRequiresConfirm', 'remoteBrowserActRequiresConfirm',
  'remoteScriptRequiresConfirm', 'remoteSecurityConfigVersion', 'remoteSecurityPresetSource',
  'larkCliWriteRequiresConfirm', 'wechatSendRequiresConfirm'
] as const

function readRawChannelConfig(db: AppDatabase, key: string): Record<string, unknown> | undefined {
  const raw = getConfigValue(db, key)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid legacy channel config JSON: ${key}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid legacy channel config: ${key}`)
  return parsed as Record<string, unknown>
}

/** Ensure legacy IM authorization settings are represented by the frozen snapshot before runtime dispatch starts. */
export function ensureImPolicySnapshotAtStartup(db: AppDatabase, releaseGate?: ImStandardV3ReleaseGate): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    // Capture the legacy shared source once. Keep it until both desktop and IM snapshots
    // are durable; the outer transaction makes partial migration retryable.
    const legacyDisabledRuleIds = readDisabledPolicyRuleIds(db)
    migrateLegacyDesktopDisabledRules(db, legacyDisabledRuleIds)
    migrateLegacyImConfigBeforeChannelWrite(db, legacyDisabledRuleIds)
    if (legacyDisabledRuleIds.length > 0) setConfigValue(db, DISABLED_POLICY_RULE_IDS_CONFIG_KEY, JSON.stringify([]))
    migrateImStandardV3IfReleaseReady(db, releaseGate)
  })
}

function migrateImStandardV3IfReleaseReady(db: AppDatabase, releaseGate?: ImStandardV3ReleaseGate): void {
  const gate = releaseGate
  if (gate?.publishedV3Ready !== true || gate.fixedRuleSetVerified !== true || gate.restrictionMappingVerified !== true) return
  const conn = getDbConnection(db)
  const existing = conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='im'").get()
  if (!existing) {
    if (readRawChannelConfig(db, 'config.wechat') || readRawChannelConfig(db, 'config.feishu')) return
    const result = commitImPolicySnapshotFromStartupMigration(conn, {
      expectedRevision: 0,
      policyBehaviorVersion: 'im-standard-v3',
      snapshot: { selectedPackage: 'standard', migrationSourceVersion: 'new-install' },
      updatedAt: Date.now(), eventId: randomUUID(), eventKind: 'legacy-policy-migrated', actor: 'migration',
      auditMetadata: { migration: 'im-standard-v3-new-install', fixedRuleSetVerified: true, restrictionMappingVerified: true }
    }, gate)
    if (result.status === 'conflict') throw new Error('IM new-install policy revision conflict')
    return
  }

  const current = readImPolicySnapshot(conn, { supportedBehaviorVersions: [...SUPPORTED_IM_POLICY_VERSIONS, 'im-standard-v3'] })
  if (current.policyBehaviorVersion === 'im-standard-v3') return
  // migration invariant: release-wide mapping approval cannot resolve conflicts in this user's
  // already migrated legacy snapshot. Keep that snapshot/version until its differences are handled.
  if (validateImStandardV3SnapshotQualification(current.snapshot)) return
  const suppressed = Array.isArray(current.snapshot.automaticMigrationSuppressedVersions)
    ? current.snapshot.automaticMigrationSuppressedVersions as string[] : []
  if (suppressed.includes('im-standard-v3')) return
  const legacyPackages = current.snapshot.legacySelectedPackages && typeof current.snapshot.legacySelectedPackages === 'object' &&
    !Array.isArray(current.snapshot.legacySelectedPackages)
    ? current.snapshot.legacySelectedPackages as Record<string, unknown> : {}
  const selectedPackage = isPolicyPackage(current.snapshot.selectedPackage) ? current.snapshot.selectedPackage
    : isPolicyPackage(legacyPackages.wechat) ? legacyPackages.wechat : readPolicyPackages(db).wechat
  const currentPackages = readPolicyPackages(db)
  const wechatPackage = isPolicyPackage(legacyPackages.wechat) ? legacyPackages.wechat : currentPackages.wechat
  const feishuPackage = isPolicyPackage(legacyPackages.feishu) ? legacyPackages.feishu : currentPackages.feishu
  // v3 stores one shared package. Preserve the old snapshot unless both channel semantics
  // and any already-shared selection can be represented losslessly as standard.
  if (selectedPackage !== 'standard' || wechatPackage !== 'standard' || feishuPackage !== 'standard') return

  const result = commitImPolicySnapshotFromStartupMigration(conn, {
    expectedRevision: current.revision,
    policyBehaviorVersion: 'im-standard-v3',
    snapshot: { ...current.snapshot, selectedPackage: 'standard', migrationSourceVersion: current.policyBehaviorVersion },
    updatedAt: Date.now(), eventId: randomUUID(), eventKind: 'legacy-policy-migrated', actor: 'migration',
    auditMetadata: { migration: 'im-standard-v3-startup-migration', sourceBehaviorVersion: current.policyBehaviorVersion,
      fixedRuleSetVerified: true, restrictionMappingVerified: true }
  }, gate)
  if (result.status === 'conflict') throw new Error('IM standard v3 migration revision conflict')
}

/**
 * policy-stage compatibility migration: initialize desktop from old package/rule tables before
 * IPC writes can create a new snapshot. Startup wraps desktop+IM migration in one transaction;
 * retry and old-deny coverage lives in legacyImConfigBoundary.startup.test.ts.
 */
export function ensureLegacyDesktopPolicySnapshot(db: AppDatabase): void {
  const conn = getDbConnection(db)
  runInTransaction(conn, () => migrateLegacyDesktopDisabledRules(db, readDisabledPolicyRuleIds(db)))
}

function migrateLegacyDesktopDisabledRules(db: AppDatabase, disabled: string[]): void {
  const conn = getDbConnection(db)
  let current: ReturnType<typeof readPolicyBehaviorSnapshot> | undefined
  try { current = readPolicyBehaviorSnapshot(conn, 'desktop', { supportedBehaviorVersions: ['desktop-v1'] }) } catch { current = undefined }
  const knownRuleIds = new Set(DEFAULT_POLICY_RULES.map((rule) => rule.id))
  const unknownRule = disabled.find((ruleId) => !knownRuleIds.has(ruleId))
  if (unknownRule) throw new Error(`unknown disabled policy rule: ${unknownRule}`)
  const currentOverrides = current?.snapshot.ruleOverrides && typeof current.snapshot.ruleOverrides === 'object' && !Array.isArray(current.snapshot.ruleOverrides)
    ? { ...(current.snapshot.ruleOverrides as Record<string, unknown>) } : {}
  const migrationComplete = current?.snapshot.legacyDesktopPolicyDataMigrated === true
  const legacyOverrides = migrationComplete ? [] : new PolicyRuleStore(conn).listOverrides().flatMap(({ ruleId, action }) => {
    const validation = validateRuleOverride(DEFAULT_POLICY_RULES, ruleId, action, 'desktop')
    return validation.ok ? [{ ruleId, action }] : []
  })
  const selectedPackage = isPolicyPackage(current?.snapshot.selectedPackage)
    ? current.snapshot.selectedPackage : readPolicyPackages(db).desktop
  const shouldCreateSnapshot = current === undefined && (disabled.length > 0 || legacyOverrides.length > 0 || selectedPackage !== 'standard')
  if ((disabled.length === 0 && migrationComplete) || (current === undefined && !shouldCreateSnapshot)) return
  const overrides: Record<string, unknown> = { ...Object.fromEntries(legacyOverrides.map(({ ruleId, action }) => [ruleId, action])), ...currentOverrides }
  // The legacy disabled bit represented an explicit allow override and wins over
  // any partial/newer override written before migration completed.
  for (const ruleId of disabled) overrides[ruleId] = 'allow'
  const migratedLegacyDisabledRuleIds = [...new Set([
    ...(Array.isArray(current?.snapshot.migratedLegacyDisabledRuleIds)
      ? current.snapshot.migratedLegacyDisabledRuleIds.filter((id): id is string => typeof id === 'string') : []),
    ...disabled
  ])]
  const snapshot = { ...(current?.snapshot ?? {}), selectedPackage,
    ruleOverrides: overrides, migratedLegacyDisabledRuleIds, legacyDesktopPolicyDataMigrated: true }
  const result = commitDesktopPolicySnapshot(conn, {
    expectedRevision: current?.revision ?? 0, policyBehaviorVersion: 'desktop-v1', snapshot, updatedAt: Date.now(),
    eventId: randomUUID(), actor: 'migration', auditMetadata: { migration: 'legacy-desktop-policy-import' }
  })
  if (result.status === 'conflict') throw new Error('desktop policy migration revision conflict')
}

/** Migrate the raw channel policy exactly once, then remove policy-owned keys from its JSON projection. */
export function migrateLegacyImConfigBeforeChannelWrite(db: AppDatabase, legacyDisabledRuleIds = readDisabledPolicyRuleIds(db)): void {
  const conn = getDbConnection(db)
  const existing = conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='im'").get()
  if (existing) {
    const current = readImPolicySnapshot(conn, { supportedBehaviorVersions: SUPPORTED_IM_POLICY_VERSIONS })
    const { snapshot: normalizedSnapshot } = migrateDisabledRulesInSnapshot(current.snapshot)
    const disabledRuleIds = Array.isArray(current.snapshot.disabledRuleIds)
      ? [...new Set(current.snapshot.disabledRuleIds.filter((id): id is string => typeof id === 'string'))] : []
    const legacyConfigDisabled = legacyDisabledRuleIds
    const disabledToMigrate = [...new Set([...disabledRuleIds, ...legacyConfigDisabled])]
    const knownRuleIds = new Set(DEFAULT_POLICY_RULES.map((rule) => rule.id))
    const unknownRule = disabledToMigrate.find((ruleId) => !knownRuleIds.has(ruleId))
    if (unknownRule) throw new Error(`unknown disabled policy rule: ${unknownRule}`)
    const needsDisabledMigration = disabledToMigrate.length > 0 ||
      (Array.isArray(current.snapshot.disabledRuleIds) && current.snapshot.disabledRuleIds.length > 0)
    const needsLegacyBackfill = current.policyBehaviorVersion === 'im-v1.6' && !isLegacyPolicyBackfillComplete(current.snapshot)
    if (needsLegacyBackfill || needsDisabledMigration) {
      const ruleOverrides = needsLegacyBackfill ? mergeLegacyRuleOverrides(db, current.snapshot) :
        (current.snapshot.ruleOverrides && typeof current.snapshot.ruleOverrides === 'object' && !Array.isArray(current.snapshot.ruleOverrides)
          ? current.snapshot.ruleOverrides as Record<string, string> : {})
      const migratedOverrides = { ...ruleOverrides }
      for (const id of disabledToMigrate) migratedOverrides[id] = 'allow'
      const migratedLegacyDisabledRuleIds = [...new Set([
        ...(Array.isArray(current.snapshot.migratedLegacyDisabledRuleIds)
          ? current.snapshot.migratedLegacyDisabledRuleIds.filter((id): id is string => typeof id === 'string') : []),
        ...disabledToMigrate
      ])]
      const legacySelectedPackages = current.snapshot.legacySelectedPackages === undefined
        ? readLegacySelectedPackages(db) : current.snapshot.legacySelectedPackages
      const snapshot: Record<string, unknown> = { ...normalizedSnapshot, ruleOverrides: migratedOverrides, disabledRuleIds: [],
        migratedLegacyDisabledRuleIds, legacySelectedPackages,
        legacyPolicyDataMigrated: true, legacyPolicyMigrationVersion: LEGACY_IM_POLICY_MIGRATION_VERSION }
      delete snapshot.legacyRuleResetIds
      const result = commitImPolicySnapshot(conn, {
        expectedRevision: current.revision,
        policyBehaviorVersion: current.policyBehaviorVersion,
        snapshot,
        updatedAt: Date.now(), eventId: randomUUID(), eventKind: 'legacy-policy-migrated', actor: 'migration',
        auditMetadata: { migration: 'legacy-custom-rules-backfill' }
      })
      if (result.status === 'conflict') throw new Error('IM policy migration revision conflict')
    }
    return
  }

  const wechat = readRawChannelConfig(db, 'config.wechat')
  const feishu = readRawChannelConfig(db, 'config.feishu')
  if (!wechat && !feishu) return
  const plan = planLegacyImPolicyMigration({ wechat, feishu })
  if (plan.status !== 'migrate') return
  const migrationData = readLegacyPolicyData(db, legacyDisabledRuleIds)
  const result = commitImPolicySnapshot(conn, {
    policyBehaviorVersion: plan.policyBehaviorVersion,
    snapshot: { ...plan.snapshot, ...migrationData },
    updatedAt: Date.now(),
    eventId: randomUUID(),
    eventKind: 'legacy-policy-migrated',
  })
  if (result.status === 'conflict') throw new Error('IM policy migration revision conflict')
}

function migrateDisabledRulesInSnapshot(snapshot: Record<string, unknown>): { snapshot: Record<string, unknown>; disabledRuleIds: string[] } {
  const disabledRuleIds = Array.isArray(snapshot.disabledRuleIds)
    ? [...new Set(snapshot.disabledRuleIds.filter((id): id is string => typeof id === 'string'))] : []
  return { snapshot: { ...snapshot }, disabledRuleIds }
}

function readLegacyRuleOverrides(db: AppDatabase): Record<string, string> {
  const knownIds = new Set(DEFAULT_POLICY_RULES.map((rule) => rule.id))
  const allowedActions = new Set(['allow', 'ask', 'deny', 'auto-evaluator'])
  return Object.fromEntries(new PolicyRuleStore(getDbConnection(db)).listOverrides()
    .filter(({ ruleId, action }) => knownIds.has(ruleId) && allowedActions.has(action))
    .map(({ ruleId, action }) => [ruleId, action]))
}

function isLegacyPolicyBackfillComplete(snapshot: Record<string, unknown>): boolean {
  return snapshot.legacyPolicyMigrationVersion === LEGACY_IM_POLICY_MIGRATION_VERSION &&
    snapshot.ruleOverrides !== undefined && snapshot.disabledRuleIds !== undefined && snapshot.legacySelectedPackages !== undefined
}

function mergeLegacyRuleOverrides(db: AppDatabase, snapshot: Record<string, unknown>): Record<string, string> {
  const legacy = readLegacyRuleOverrides(db)
  const hasCurrentOverrideMap = Object.hasOwn(snapshot, 'ruleOverrides') && snapshot.ruleOverrides !== null &&
    typeof snapshot.ruleOverrides === 'object' && !Array.isArray(snapshot.ruleOverrides)
  const existing = hasCurrentOverrideMap ? snapshot.ruleOverrides as Record<string, string> : {}
  const resetIds = new Set(Array.isArray(snapshot.legacyRuleResetIds)
    ? snapshot.legacyRuleResetIds.filter((id): id is string => typeof id === 'string') : [])
  const historicalSnapshots = getDbConnection(db).prepare(
    "SELECT snapshot_json FROM policy_behavior_snapshot_history WHERE domain='im'"
  ).all() as Array<{ snapshot_json: string }>
  for (const row of historicalSnapshots) {
    try {
      const historicSnapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>
      const historicOverrides = historicSnapshot.ruleOverrides
      if (!historicOverrides || typeof historicOverrides !== 'object' || Array.isArray(historicOverrides)) continue
      for (const ruleId of Object.keys(legacy)) {
        if (hasCurrentOverrideMap && !Object.hasOwn(existing, ruleId) && Object.hasOwn(historicOverrides, ruleId)) resetIds.add(ruleId)
      }
    } catch {
      // A corrupt archive cannot prove an explicit reset; importing a legacy deny is the safe fallback.
    }
  }
  const merged = { ...legacy, ...existing }
  for (const id of resetIds) delete merged[id]
  return merged
}

function readLegacyPolicyData(db: AppDatabase, disabledRuleIds: string[]): Record<string, unknown> {
  const knownRuleIds = new Set(DEFAULT_POLICY_RULES.map((rule) => rule.id))
  const unknownRule = disabledRuleIds.find((ruleId) => !knownRuleIds.has(ruleId))
  if (unknownRule) throw new Error(`unknown disabled policy rule: ${unknownRule}`)
  const ruleOverrides = readLegacyRuleOverrides(db)
  for (const ruleId of disabledRuleIds) ruleOverrides[ruleId] = 'allow'
  return {
    ruleOverrides,
    disabledRuleIds: [],
    migratedLegacyDisabledRuleIds: disabledRuleIds,
    legacyPolicyDataMigrated: true,
    legacyPolicyMigrationVersion: LEGACY_IM_POLICY_MIGRATION_VERSION,
    legacySelectedPackages: readLegacySelectedPackages(db)
  }
}

function readLegacySelectedPackages(db: AppDatabase): Record<string, unknown> {
  const packages = readPolicyPackages(db)
  return { wechat: packages.wechat, feishu: packages.feishu }
}

export function stripChannelPolicyFields<T extends Record<string, unknown>>(config: T): T {
  const sanitized = { ...config }
  for (const key of CHANNEL_POLICY_KEYS) delete sanitized[key]
  return sanitized
}
