export const FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION = 'im-v1.6' as const

export interface FrozenLegacyPolicyBehavior {
  sourcePolicyBehaviorVersion: typeof FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION
  packages: {
    standard: Record<string, unknown>
    strict: Record<string, unknown>
    loose: Record<string, unknown>
    custom: Record<string, unknown>
  }
  capabilities: unknown[]
  disabledRuleIds: string[]
  remoteConfirmPolicy: { remoteReadOnly: boolean; denyWrite: boolean; denyOutbound: boolean }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Frozen v1.6 migration interpreter. This deliberately does not import current package or rule
 * resolvers: it copies persisted old semantics into a version-tagged snapshot without remapping.
 */
export function parseFrozenLegacyPolicyBehavior(input: unknown): FrozenLegacyPolicyBehavior {
  if (!isRecord(input) || input.policyBehaviorVersion !== FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION) {
    throw new Error('Unknown or missing frozen policy behavior version')
  }
  if (!isRecord(input.fixtures)) throw new Error('Frozen legacy policy fixtures are missing')
  const fixtures = input.fixtures
  for (const key of ['standard', 'strict', 'loose', 'custom']) {
    if (!isRecord(fixtures[key])) throw new Error(`Frozen legacy ${key} package is invalid`)
  }
  const readOnly = isRecord(fixtures.readOnly) ? fixtures.readOnly : {}
  const packages = {
    standard: structuredClone(fixtures.standard) as Record<string, unknown>,
    strict: structuredClone(fixtures.strict) as Record<string, unknown>,
    loose: structuredClone(fixtures.loose) as Record<string, unknown>,
    custom: structuredClone(fixtures.custom) as Record<string, unknown>
  }
  const disabledRuleIds = Array.isArray(readOnly.disabledRuleIds)
    ? readOnly.disabledRuleIds.filter((id): id is string => typeof id === 'string')
    : []
  const capabilities = Array.isArray(readOnly.capabilities) ? structuredClone(readOnly.capabilities) : []
  const remoteReadOnly = readOnly.remoteConfirmPolicy === 'remote_read_only'
  return {
    sourcePolicyBehaviorVersion: FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION,
    packages,
    capabilities,
    disabledRuleIds,
    remoteConfirmPolicy: {
      remoteReadOnly,
      denyWrite: remoteReadOnly || readOnly.remoteAllowLocalWrite === false,
      denyOutbound: remoteReadOnly || readOnly.remoteDenyOutbound === true
    }
  }
}

/** Restore only a previously persisted frozen behavior snapshot; never infer from DB/config schema. */
export function resolveFrozenLegacyPolicyBehavior(input: unknown): FrozenLegacyPolicyBehavior {
  if (!isRecord(input) || input.policyBehaviorVersion !== FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION || !isRecord(input.legacyBehavior)) {
    throw new Error('Unknown or missing persisted frozen policy behavior version')
  }
  const behavior = input.legacyBehavior
  if (behavior.sourcePolicyBehaviorVersion !== FROZEN_LEGACY_POLICY_BEHAVIOR_VERSION || !isRecord(behavior.packages)) {
    throw new Error('Invalid persisted frozen policy behavior')
  }
  const packages = behavior.packages
  for (const key of ['standard', 'strict', 'loose', 'custom']) {
    if (!isRecord(packages[key])) throw new Error(`Persisted frozen ${key} package is invalid`)
  }
  if (!Array.isArray(behavior.capabilities) || !Array.isArray(behavior.disabledRuleIds) || !isRecord(behavior.remoteConfirmPolicy)) {
    throw new Error('Invalid persisted frozen policy behavior fields')
  }
  const remote = behavior.remoteConfirmPolicy
  if (typeof remote.remoteReadOnly !== 'boolean' || typeof remote.denyWrite !== 'boolean' || typeof remote.denyOutbound !== 'boolean') {
    throw new Error('Invalid persisted frozen remote policy behavior')
  }
  return structuredClone(behavior) as unknown as FrozenLegacyPolicyBehavior
}
