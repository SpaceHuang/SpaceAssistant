import { describe, expect, it } from 'vitest'
import { SYSTEM_INVARIANT_REGISTRY, validateSystemInvariantRegistry, type SystemInvariantRegistration } from './systemInvariantRegistry'

const valid: SystemInvariantRegistration = {
  id: 'SYS-LIFECYCLE-001', owner: 'agent-sdk', stage: 'lifecycle', category: 'lifecycle',
  rationale: 'Revoked calls must not continue executing.', effect: 'revoke', scope: 'packages/agent-sdk/src/**',
  audit: 'record the original decision and revocation result', tests: ['packages/agent-sdk/src/safetyGate.test.ts'],
  overrideability: 'none'
}

describe('source-only system invariant registry', () => {
  it('accepts a fully justified registration without producing a runtime policy result', () => {
    expect(validateSystemInvariantRegistry([valid])).toEqual([])
    expect(SYSTEM_INVARIANT_REGISTRY).toEqual([])
  })

  it('rejects missing owner, rationale, scope, audit, and test reference', () => {
    const invalid = { ...valid, owner: '', rationale: '', scope: '', audit: '', tests: [] } as SystemInvariantRegistration
    expect(validateSystemInvariantRegistry([invalid]).map((issue) => issue.field)).toEqual(expect.arrayContaining([
      'owner', 'rationale', 'scope', 'audit', 'tests'
    ]))
  })

  it('requires an explicit non-configurable explanation for decision floors', () => {
    const decisionFloor = { ...valid, category: 'decision-floor' as const, nonConfigurableReason: '' }
    expect(validateSystemInvariantRegistry([decisionFloor])).toContainEqual(expect.objectContaining({ field: 'nonConfigurableReason', reason: 'decision-floor-requires-justification' }))
  })

  it('rejects duplicate IDs', () => {
    expect(validateSystemInvariantRegistry([valid, valid])).toContainEqual(expect.objectContaining({ id: valid.id, field: 'id', reason: 'duplicate' }))
  })
})
