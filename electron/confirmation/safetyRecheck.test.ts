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
})
