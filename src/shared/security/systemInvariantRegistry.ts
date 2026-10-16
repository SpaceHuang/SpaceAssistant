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

/** The single source-level registry. These entries trace mechanisms, never policy verdicts. */
export const SYSTEM_INVARIANT_REGISTRY: readonly SystemInvariantRegistration[] = Object.freeze([
  {
    id: 'SYS-RECURSION-001', owner: 'electron/confirmation', stage: 'admission', category: 'integrity',
    rationale: 'Approval agents cannot recursively request approval for their own internal tools.',
    effect: 'block', scope: 'electron/confirmation/toolCallGate.ts:recursion-guard',
    audit: 'policy.decision cause recursion-guard; retain the triggering decision context',
    tests: ['electron/confirmation/recursionGuard.test.ts', 'electron/confirmation/toolCallGate.test.ts'],
    overrideability: 'none'
  },
  {
    id: 'SYS-PERMIT-001', owner: 'electron/confirmation', stage: 'final-check', category: 'integrity',
    rationale: 'A consumed authorization permit must match its immutable approved subject and remain unexpired.',
    effect: 'validate', scope: 'electron/confirmation/confirmationAuthorizationRegistry.ts',
    audit: 'policy.execution-veto with permit mismatch or expiry failure class',
    tests: ['electron/confirmation/readReadIntegration.test.ts', 'electron/confirmation/confirmationAuthorizationRegistry.test.ts'],
    overrideability: 'none'
  },
  {
    id: 'SYS-CAPABILITY-001', owner: 'agent-sdk', stage: 'admission', category: 'capability',
    rationale: 'A tool without a host granted SDK capability cannot enter the execution port.',
    effect: 'block', scope: 'packages/agent-sdk/src/safetyGate.ts',
    audit: 'tool execution rejection reason and original invocation identity',
    tests: ['packages/agent-sdk/test/safetyGate.test.ts'],
    overrideability: 'none'
  },
  {
    id: 'SYS-REVOCATION-001', owner: 'agent-sdk', stage: 'lifecycle', category: 'lifecycle',
    rationale: 'Revocation during an active tool call aborts the lease and prevents remaining work.',
    effect: 'revoke', scope: 'packages/agent-sdk/src/toolExecutionPort.ts;packages/agent-sdk/src/runtime/components.ts',
    audit: 'tool execution rejection lifecycleInvalidation=revoked',
    tests: ['packages/agent-sdk/test/toolExecutionPort.test.ts', 'packages/agent-sdk/test/runtimeComponents.test.ts'],
    overrideability: 'none'
  },
  {
    id: 'SYS-APPROVAL-001', owner: 'electron/confirmation', stage: 'final-check', category: 'integrity',
    rationale: 'A policy recheck that newly requires approval cannot silently inherit an earlier approval.',
    effect: 'block', scope: 'electron/confirmation/toolCallGate.ts:recheck-requires-confirm',
    audit: 'policy.execution-veto cause recheck-requires-confirm with decision linkage',
    tests: ['electron/confirmation/toolCallGate.test.ts', 'electron/confirmation/agentSdkSafetyPolicy.test.ts'],
    overrideability: 'none'
  }
])
