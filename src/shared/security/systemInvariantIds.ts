/** Runtime-safe IDs for system invariants; full rationale and ownership stay in the source-only registry. */
export const SYSTEM_INVARIANT_ID_BY_GATE_RULE: Readonly<Record<string, string>> = Object.freeze({
  'recursion-guard': 'SYS-RECURSION-001',
  'recheck-requires-confirm': 'SYS-APPROVAL-001',
  'automation-output-binding-required': 'SYS-AUTOOUTPUT-001'
})
