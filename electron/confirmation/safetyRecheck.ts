import type { Decision } from '../../src/shared/confirmation/types'

/** Only a still-identical user-approved decision may pass a recheck that continues to require confirmation. */
export function isSafetyRecheckAllowed(input: {
  initialRuleId: string
  initialFactsHash: string
  latestDecision: Pick<Decision, 'type' | 'ruleId'>
  latestFactsHash: string
  previouslyConfirmed: boolean
}): boolean {
  if (input.latestDecision.type === 'auto-allow') return true
  return input.previouslyConfirmed && input.latestDecision.type === 'require-confirm' &&
    input.latestDecision.ruleId === input.initialRuleId && input.latestFactsHash === input.initialFactsHash
}
