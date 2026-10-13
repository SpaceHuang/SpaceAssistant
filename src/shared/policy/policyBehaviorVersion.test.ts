import { describe, expect, it } from 'vitest'
import { resolvePolicyBehavior, type PolicyBehaviorResolver } from './policyPackages'

const behaviorV1: PolicyBehaviorResolver = ({ rules }) => rules.map((rule) => ({ ...rule, action: 'allow' }))
const behaviorV2: PolicyBehaviorResolver = ({ rules }) => rules.map((rule) => ({ ...rule, action: 'deny' }))

describe('versioned policy behavior resolution', () => {
  it('uses the pinned policy behavior version', () => {
    const rules = [{ id: 'r1', when: 'invocation' as const, action: 'ask' as const, reason: 'test' }]
    const result = resolvePolicyBehavior({
      policyBehaviorVersion: 'v1',
      rules,
      resolvers: { v1: behaviorV1, v2: behaviorV2 }
    })
    expect(result).toEqual([{ id: 'r1', when: 'invocation', action: 'allow', reason: 'test' }])
  })

  it('rejects missing or unknown behavior versions', () => {
    const resolvers = { v1: behaviorV1 }
    expect(() => resolvePolicyBehavior({ policyBehaviorVersion: undefined, rules: [], resolvers })).toThrow()
    expect(() => resolvePolicyBehavior({ policyBehaviorVersion: '', rules: [], resolvers })).toThrow()
    expect(() => resolvePolicyBehavior({ policyBehaviorVersion: 42, rules: [], resolvers })).toThrow()
    expect(() => resolvePolicyBehavior({ policyBehaviorVersion: 'v9', rules: [], resolvers })).toThrow()
  })

  it('does not treat schema version or revision as behavior version', () => {
    const resolvers = { v1: behaviorV1 }
    const schemaOnly: unknown = { schemaVersion: 'v1', rules: [], resolvers }
    const revisionOnly: unknown = { revision: 'v1', rules: [], resolvers }
    expect(() => resolvePolicyBehavior(schemaOnly as Parameters<typeof resolvePolicyBehavior>[0])).toThrow()
    expect(() => resolvePolicyBehavior(revisionOnly as Parameters<typeof resolvePolicyBehavior>[0])).toThrow()
  })

  it('keeps repeated resolution pinned and deterministic', () => {
    const args = { policyBehaviorVersion: 'v2', rules: [{ id: 'r1', when: 'invocation' as const, action: 'ask' as const, reason: 'test' }], resolvers: { v1: behaviorV1, v2: behaviorV2 } }
    expect(resolvePolicyBehavior(args)).toEqual(resolvePolicyBehavior(args))
    expect(resolvePolicyBehavior(args)[0].action).toBe('deny')
  })
})
