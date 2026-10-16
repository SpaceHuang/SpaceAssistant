import { describe, expect, it } from 'vitest'
import { createPolicyDecision, fingerprintPolicyDependencies, selectPolicyDependencyRules, type PolicyDecision } from './policyDecision'
import type { ContentFacts, Decision, PolicyRule } from '../confirmation/types'

const facts: ContentFacts = { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'write private content' } }
const decision: Decision = { type: 'require-confirm', ruleId: 'human-write', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: null, reason: 'human approval required' }
const rules: PolicyRule[] = [
  { id: 'block-secret', when: 'invocation', match: { signals: ['sensitive-content'] }, action: 'deny', locked: true, reason: 'sensitive evidence' },
  { id: 'human-write', when: 'invocation', match: { actionClass: 'write' }, action: 'ask', reason: 'confirm write' }
]

const input = { decision, invocationId: 'inv-1', toolUseId: 'call-1', factsId: 'fact-0123456789abcdef01234567', factsDigest: 'a'.repeat(64), extractorVersion: 'facts-v1', factsRevision: 2, policyDomain: 'desktop' as const, tier: 'standard', policyVersion: 'desktop-standard-v1', policyRevision: 7, policyLane: 'desktop', policyConfig: {}, migrationComplete: false, rules, disabledRuleIds: [] as string[] }

describe('PolicyDecision contract', () => {
  it('binds the final decision, facts snapshot, domain/tier/version, and replayable dependency fingerprint', () => {
    const result = createPolicyDecision(input)
    expect(result).toMatchObject({
      decisionId: expect.stringMatching(/^decision-[0-9a-f]{24}$/), invocationId: 'inv-1', toolUseId: 'call-1',
      factsId: input.factsId, factsDigest: input.factsDigest, extractorVersion: 'facts-v1', factsRevision: 2,
      policyDomain: 'desktop', tier: 'standard', policyVersion: 'desktop-standard-v1', policyRevision: 7,
      verdict: 'require-confirm', ruleIds: ['human-write'], answerer: 'user', reasonCode: 'human-write',
      causes: [{ ruleId: 'human-write', relation: 'matched' }],
      dependencyFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    } satisfies Partial<PolicyDecision>)
    expect(JSON.stringify(result)).not.toContain('write private content')
    expect(result).not.toHaveProperty('allow')
    expect(createPolicyDecision({ ...input, factsRevision: input.factsRevision + 1 }).decisionId).not.toBe(result.decisionId)
  })

  it('fingerprints ordered rules and all rule conditions, actions, and disabled state', () => {
    const base = fingerprintPolicyDependencies({ ...input, policyVersion: 'v1', policyRevision: 1, rules, disabledRuleIds: [] })
    const reordered = fingerprintPolicyDependencies({ ...input, policyVersion: 'v1', policyRevision: 1, rules: [...rules].reverse(), disabledRuleIds: [] })
    const disabled = fingerprintPolicyDependencies({ ...input, policyVersion: 'v1', policyRevision: 1, rules, disabledRuleIds: ['block-secret'] })
    const changedCondition = fingerprintPolicyDependencies({ ...input, policyVersion: 'v1', policyRevision: 1, rules: [{ ...rules[0]!, match: { signals: ['different'] } }, rules[1]!], disabledRuleIds: [] })
    const changedConfig = fingerprintPolicyDependencies({ ...input, policyVersion: 'v1', policyRevision: 1, policyConfig: { confirmation: false }, rules, disabledRuleIds: [] })
    expect(reordered).not.toBe(base)
    expect(disabled).not.toBe(base)
    expect(changedCondition).not.toBe(base)
    expect(changedConfig).not.toBe(base)
    expect(fingerprintPolicyDependencies({ ...input, policyVersion: 'v1', policyRevision: 1, rules, disabledRuleIds: [] })).toBe(base)
  })

  it('selects only the ordered matched rule chain through the final decision', () => {
    const unrelated: PolicyRule = { id: 'unrelated-tool', when: 'invocation', match: { toolName: 'browser' }, action: 'ask', reason: 'browser' }
    const selected = selectPolicyDependencyRules({ rules: [rules[0]!, unrelated, rules[1]!], matchingRuleIds: ['human-write'], decisionRuleIds: ['human-write'] })
    expect(selected.map((rule) => rule.id)).toEqual(['human-write'])
    const protective = selectPolicyDependencyRules({ rules: [unrelated, rules[1]!, rules[0]!], matchingRuleIds: ['block-secret', 'human-write'], decisionRuleIds: ['human-write'] })
    expect(protective.map((rule) => rule.id)).toEqual(['human-write', 'block-secret'])
  })

  it('supports every verdict while preserving rule attribution and agent result references', () => {
    const auto = createPolicyDecision({ ...input, decision: { type: 'auto-allow', ruleId: 'allow-rule', reason: 'allowed' }, agentResultRef: undefined })
    const denied = createPolicyDecision({ ...input, decision: { type: 'deny', ruleId: 'deny-rule', reason: 'forbidden' }, agentResultRef: undefined })
    const agentApproved = createPolicyDecision({ ...input, decision: { ...decision, answerer: 'agent' }, agentResultRef: 'approval-42' })
    expect(auto).toMatchObject({ verdict: 'allow', ruleIds: ['allow-rule'] })
    expect(auto).not.toHaveProperty('answerer')
    expect(denied).toMatchObject({ verdict: 'deny', ruleIds: ['deny-rule'] })
    expect(agentApproved).toMatchObject({ verdict: 'require-confirm', answerer: 'agent', agentResultRef: 'approval-42' })
  })

  it('records a matched rule together with an independent constraint cause', () => {
    const constrained = createPolicyDecision({ ...input,
      decision: { type: 'require-confirm', ruleId: 'generic-write-review', cause: 'locked-human-floor', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: null } })
    expect(constrained.ruleIds).toEqual(['generic-write-review', 'locked-human-floor'])
    expect(constrained.causes).toEqual([
      { ruleId: 'generic-write-review', relation: 'matched' },
      { ruleId: 'locked-human-floor', relation: 'constraint' }
    ])
  })
})
