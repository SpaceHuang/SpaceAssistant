import { parseFrozenLegacyPolicyBehavior, FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION } from './legacyPolicyBehavior'

/** Bump when the startup backfill learns to import additional snapshot-owned legacy policy data. */
export const LEGACY_IM_POLICY_MIGRATION_VERSION = 2 as const

interface LegacyChannelConfig {
  remoteConfirmPolicy?: string
  remoteAllowLocalWrite?: boolean
  remoteDenyOutbound?: boolean
  remoteBrowserRequiresConfirm?: boolean
  remoteScriptRequiresConfirm?: boolean
  policyBehaviorVersion?: string
  [key: string]: unknown
}

export interface LegacyImPolicyMigrationInput {
  wechat?: LegacyChannelConfig
  feishu?: LegacyChannelConfig
  currentSnapshot?: Record<string, unknown>
  remoteAsyncApprovalEnabled?: boolean
}

export type LegacyImPolicyMigrationPlan =
  | { status: 'already-migrated'; domain: 'im'; policyBehaviorVersion: string; snapshot: Record<string, unknown> }
  | { status: 'migrate'; domain: 'im'; policyBehaviorVersion: typeof FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION; snapshot: Record<string, unknown> }

export function createNewImPolicySelection(input: { selectedPackage: 'standard'; gatePassed: boolean }): {
  domain: 'im'
  policyBehaviorVersion: 'im-standard-v2'
  selectedPackage: 'standard'
  enabled: boolean
} {
  return {
    domain: 'im',
    policyBehaviorVersion: 'im-standard-v2',
    selectedPackage: input.selectedPackage,
    enabled: input.gatePassed === true
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Plan a one-time migration from identical channel settings; the async gate is deliberately ignored. */
export function planLegacyImPolicyMigration(input: LegacyImPolicyMigrationInput): LegacyImPolicyMigrationPlan {
  if (input.currentSnapshot) {
    const version = input.currentSnapshot.policyBehaviorVersion
    if (typeof version !== 'string' || !version) throw new Error('Current policy snapshot has no behavior version')
    return { status: 'already-migrated', domain: 'im', policyBehaviorVersion: version, snapshot: structuredClone(input.currentSnapshot) }
  }
  if (!input.wechat && !input.feishu) throw new Error('At least one legacy channel configuration is required')
  const left = input.wechat ?? {}
  const right = input.feishu ?? {}
  const leftVersion = left.policyBehaviorVersion
  const rightVersion = right.policyBehaviorVersion
  if (leftVersion && rightVersion && leftVersion !== rightVersion) throw new Error('Conflicting legacy behavior versions cannot be merged')
  const requestedBehaviorVersion = leftVersion ?? rightVersion ?? FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION
  const unresolvedDifferences: string[] = []
  const pickBoolean = (key: keyof LegacyChannelConfig, strict: (values: boolean[]) => boolean, fallback: boolean): boolean => {
    const values: boolean[] = []
    for (const config of [left, right]) {
      const value = config[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') {
        unresolvedDifferences.push(String(key))
        values.push(fallback)
      } else values.push(value)
    }
    return values.length ? strict(values) : fallback
  }
  const readOnly = left.remoteConfirmPolicy === 'remote_read_only' || right.remoteConfirmPolicy === 'remote_read_only'
  const customLeft = left.customRules
  const customRight = right.customRules
  if (customLeft !== undefined && customRight !== undefined && stableJson(customLeft) !== stableJson(customRight)) unresolvedDifferences.push('customRules')
  const mergedConfig: LegacyChannelConfig = {
    remoteConfirmPolicy: readOnly ? 'remote_read_only' : undefined,
    remoteAllowLocalWrite: readOnly || !pickBoolean('remoteAllowLocalWrite', (values) => values.every(Boolean), false) ? false : true,
    remoteDenyOutbound: readOnly || pickBoolean('remoteDenyOutbound', (values) => values.some(Boolean), true),
    remoteBrowserRequiresConfirm: pickBoolean('remoteBrowserRequiresConfirm', (values) => values.some(Boolean), true),
    remoteScriptRequiresConfirm: pickBoolean('remoteScriptRequiresConfirm', (values) => values.some(Boolean), true),
    policyBehaviorVersion: requestedBehaviorVersion
  }
  const frozen = parseFrozenLegacyPolicyBehavior({
    policyBehaviorVersion: requestedBehaviorVersion,
    fixtures: {
      readOnly: { ...mergedConfig, capabilities: left.capabilities ?? right.capabilities, disabledRuleIds: left.disabledRuleIds ?? right.disabledRuleIds },
      standard: left.standard ?? right.standard ?? { pkg: 'standard', rules: [] },
      strict: left.strict ?? right.strict ?? { pkg: 'strict', scope: [] },
      loose: left.loose ?? right.loose ?? { pkg: 'loose', scope: [] },
      custom: customLeft && customRight && stableJson(customLeft) !== stableJson(customRight)
        ? { pkg: 'custom', rules: [{ action: 'ask', reason: 'unresolved conflicting legacy custom rules' }] }
        : customLeft ?? customRight ?? { pkg: 'custom', rules: [] }
    }
  })
  const policyBehaviorVersion = frozen.sourcePolicyBehaviorVersion
  const snapshot: Record<string, unknown> = {
    policyBehaviorVersion,
    legacyBehavior: frozen,
    denyWrite: frozen.remoteConfirmPolicy.denyWrite,
    denyOutbound: frozen.remoteConfirmPolicy.denyOutbound,
    browserActRequiresConfirm: mergedConfig.remoteBrowserRequiresConfirm === true,
    remoteScriptRequiresConfirm: mergedConfig.remoteScriptRequiresConfirm === true,
    humanRequired: unresolvedDifferences.length > 0
  }
  if (unresolvedDifferences.length) snapshot.unresolvedDifferences = [...new Set(unresolvedDifferences)].sort()
  return { status: 'migrate', domain: 'im', policyBehaviorVersion, snapshot }
}
