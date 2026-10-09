import { describe, expect, it } from 'vitest'
import { isSafetyRecheckAllowed } from './safetyRecheck'

const initialFactsHash = 'facts-v1'

describe('isSafetyRecheckAllowed', () => {
  it('keeps a confirmed call executable when the same rule and facts still require confirmation', () => {
    expect(isSafetyRecheckAllowed({
      initialRuleId: 'rule-v1', initialFactsHash,
      latestDecision: { type: 'require-confirm', ruleId: 'rule-v1' }, latestFactsHash: initialFactsHash,
      previouslyConfirmed: true
    })).toBe(true)
  })

  it('rejects an unconfirmed require-confirm result', () => {
    expect(isSafetyRecheckAllowed({
      initialRuleId: 'rule-v1', initialFactsHash,
      latestDecision: { type: 'require-confirm', ruleId: 'rule-v1' }, latestFactsHash: initialFactsHash,
      previouslyConfirmed: false
    })).toBe(false)
  })

  it('rejects changed policy identity or facts after confirmation', () => {
    expect(isSafetyRecheckAllowed({
      initialRuleId: 'rule-v1', initialFactsHash,
      latestDecision: { type: 'require-confirm', ruleId: 'rule-v2' }, latestFactsHash: initialFactsHash,
      previouslyConfirmed: true
    })).toBe(false)
    expect(isSafetyRecheckAllowed({
      initialRuleId: 'rule-v1', initialFactsHash,
      latestDecision: { type: 'require-confirm', ruleId: 'rule-v1' }, latestFactsHash: 'facts-v2',
      previouslyConfirmed: true
    })).toBe(false)
  })

  it.each([
    ['locked policy', { latestLocked: true }],
    ['critical action', { latestRiskLevel: 'critical' }],
    ['changed call', { initialCallHash: 'call-v1', latestCallHash: 'call-v2' }],
    ['changed authorization epoch', { initialAuthorizationEpoch: 4, latestAuthorizationEpoch: 5 }],
    ['changed environment', { initialEnvironmentHash: 'env-v1', latestEnvironmentHash: 'env-v2' }],
    ['changed egress boundary', { initialEgressHash: 'egress-v1', latestEgressHash: 'egress-v2' }]
  ])('fails closed on %s even when latest policy says auto-allow', (_name, extra) => {
    expect(isSafetyRecheckAllowed({
      initialRuleId: 'rule-v1', initialFactsHash,
      latestDecision: { type: 'auto-allow', ruleId: 'rule-v1' }, latestFactsHash: initialFactsHash,
      previouslyConfirmed: true, ...extra
    } as never)).toBe(false)
  })

  it('allows a complete unchanged-call auto-allow recheck and rejects a deny result', () => {
    const call = {
      initialRuleId: 'rule-v1', initialFactsHash,
      latestFactsHash: initialFactsHash, previouslyConfirmed: true,
      initialCallHash: 'call-v1', latestCallHash: 'call-v1',
      initialAuthorizationEpoch: 4, latestAuthorizationEpoch: 4,
      initialEnvironmentHash: 'env-v1', latestEnvironmentHash: 'env-v1',
      initialEgressHash: 'egress-v1', latestEgressHash: 'egress-v1'
    }
    expect(isSafetyRecheckAllowed({ ...call, latestDecision: { type: 'auto-allow', ruleId: 'rule-v1' } } as never)).toBe(true)
    expect(isSafetyRecheckAllowed({ ...call, latestDecision: { type: 'deny', ruleId: 'rule-v1' } })).toBe(false)
  })
})
