/**
 * Source-only registry of non-configurable security invariants.
 * This metadata is for review/architecture checks; policy execution must never load it.
 */
export type SystemInvariantStage = 'admission' | 'policy' | 'final-check' | 'lifecycle'
export type SystemInvariantCategory = 'identity' | 'integrity' | 'capability' | 'platform' | 'lifecycle' | 'decision-floor'
export type SystemInvariantEffect = 'block' | 'validate' | 'revoke' | 'limit'
export type SystemInvariantOverrideability = 'none' | 'trusted-admin-control'

export interface SystemInvariantRegistration {
  readonly id: string
  readonly owner: string
  readonly stage: SystemInvariantStage
  readonly category: SystemInvariantCategory
  readonly rationale: string
  readonly nonConfigurableReason?: string
  readonly effect: SystemInvariantEffect
  readonly scope: string
  readonly audit: string
  readonly tests: readonly string[]
  readonly overrideability: SystemInvariantOverrideability
}

export type RegistryValidationIssue = Readonly<{ id?: string; field: string; reason: string }>

export function validateSystemInvariantRegistry(entries: readonly SystemInvariantRegistration[]): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : undefined
    const add = (field: string, reason: string) => issues.push({ ...(id ? { id } : {}), field, reason })
    if (!id || !/^SYS-[A-Z0-9]+-[0-9]{3}$/.test(id)) add('id', 'invalid-format')
    else if (seen.has(id)) add('id', 'duplicate')
    else seen.add(id)
    for (const field of ['owner', 'rationale', 'scope', 'audit'] as const) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length < 8) add(field, 'required')
    }
    if (!['admission', 'policy', 'final-check', 'lifecycle'].includes(entry.stage)) add('stage', 'invalid-value')
    if (!['identity', 'integrity', 'capability', 'platform', 'lifecycle', 'decision-floor'].includes(entry.category)) add('category', 'invalid-value')
    if (!['block', 'validate', 'revoke', 'limit'].includes(entry.effect)) add('effect', 'invalid-value')
    if (!['none', 'trusted-admin-control'].includes(entry.overrideability)) add('overrideability', 'invalid-value')
    if (!Array.isArray(entry.tests) || entry.tests.length === 0 || entry.tests.some((test) => typeof test !== 'string' || !/^([\w.-]+\/)+[\w.-]+\.test\.[jt]sx?$/.test(test))) add('tests', 'test-reference-required')
    if (entry.category === 'decision-floor' && (typeof entry.nonConfigurableReason !== 'string' || entry.nonConfigurableReason.trim().length < 20)) {
      add('nonConfigurableReason', 'decision-floor-requires-justification')
    }
  }
  return issues
}

/** The single source-level registry. P3-03 populates audited baseline invariants. */
export const SYSTEM_INVARIANT_REGISTRY: readonly SystemInvariantRegistration[] = Object.freeze([])
