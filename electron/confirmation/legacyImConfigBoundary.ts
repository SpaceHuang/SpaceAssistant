import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getConfigValue } from '../database'
import { getDbConnection } from '../database'
import { commitImPolicySnapshot, readImPolicySnapshot } from './imPolicyStore'
import { LEGACY_IM_POLICY_MIGRATION_VERSION, planLegacyImPolicyMigration } from '../../src/shared/policy/legacyPolicyMigration'
import { PolicyRuleStore } from './policyRuleStore'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { readDisabledPolicyRuleIds, readPolicyPackages } from './policyRulesRuntime'

const SUPPORTED_IM_POLICY_VERSIONS = ['im-v1.6', 'im-standard-v2'] as const
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
export function ensureImPolicySnapshotAtStartup(db: AppDatabase): void {
  migrateLegacyImConfigBeforeChannelWrite(db)
}

/** Migrate the raw channel policy exactly once, then remove policy-owned keys from its JSON projection. */
export function migrateLegacyImConfigBeforeChannelWrite(db: AppDatabase): void {
  const conn = getDbConnection(db)
  const existing = conn.prepare("SELECT 1 FROM policy_behavior_snapshots WHERE domain='im'").get()
  if (existing) {
    const current = readImPolicySnapshot(conn, { supportedBehaviorVersions: SUPPORTED_IM_POLICY_VERSIONS })
    if (current.policyBehaviorVersion === 'im-v1.6' && !isLegacyPolicyBackfillComplete(current.snapshot)) {
      const ruleOverrides = mergeLegacyRuleOverrides(db, current.snapshot)
      const disabledRuleIds = current.snapshot.disabledRuleIds === undefined ? readDisabledPolicyRuleIds(db) : current.snapshot.disabledRuleIds
      const legacySelectedPackages = current.snapshot.legacySelectedPackages === undefined
        ? readLegacySelectedPackages(db) : current.snapshot.legacySelectedPackages
      const snapshot: Record<string, unknown> = { ...current.snapshot, ruleOverrides, disabledRuleIds, legacySelectedPackages,
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
  const migrationData = readLegacyPolicyData(db)
  const result = commitImPolicySnapshot(conn, {
    policyBehaviorVersion: plan.policyBehaviorVersion,
    snapshot: { ...plan.snapshot, ...migrationData },
    updatedAt: Date.now(),
    eventId: randomUUID(),
    eventKind: 'legacy-policy-migrated'
  })
  if (result.status === 'conflict') throw new Error('IM policy migration revision conflict')
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

function readLegacyPolicyData(db: AppDatabase): Record<string, unknown> {
  return {
    ruleOverrides: readLegacyRuleOverrides(db),
    disabledRuleIds: readDisabledPolicyRuleIds(db),
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
