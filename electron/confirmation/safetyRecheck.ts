import type { Decision } from '../../src/shared/confirmation/types'

/** Only a still-identical user-approved decision may pass a recheck that continues to require confirmation. */
export function isSafetyRecheckAllowed(input: {
  initialRuleId: string
  initialFactsHash: string
  latestDecision: Pick<Decision, 'type' | 'ruleId'>
  latestFactsHash: string
  previouslyConfirmed: boolean
  latestLocked?: boolean
  latestRiskLevel?: 'low' | 'medium' | 'high' | 'critical'
  initialCallHash?: string
  latestCallHash?: string
  initialAuthorizationEpoch?: string | number
  latestAuthorizationEpoch?: string | number
  initialEnvironmentHash?: string
  latestEnvironmentHash?: string
  initialEgressHash?: string
  latestEgressHash?: string
}): boolean {
  if (input.latestLocked || input.latestRiskLevel === 'critical' || input.latestDecision.type === 'deny') return false
  const completeBindingMatches = input.initialCallHash !== undefined && input.latestCallHash !== undefined &&
    input.initialCallHash === input.latestCallHash && input.initialAuthorizationEpoch !== undefined &&
    input.initialAuthorizationEpoch === input.latestAuthorizationEpoch && input.initialEnvironmentHash !== undefined &&
    input.initialEnvironmentHash === input.latestEnvironmentHash && input.initialEgressHash !== undefined &&
    input.initialEgressHash === input.latestEgressHash
  if (input.latestDecision.type === 'auto-allow') {
    return input.latestFactsHash === input.initialFactsHash && completeBindingMatches
  }
  return input.previouslyConfirmed && input.latestDecision.type === 'require-confirm' &&
    input.latestDecision.ruleId === input.initialRuleId && input.latestFactsHash === input.initialFactsHash &&
    (input.initialCallHash === undefined || input.latestCallHash === input.initialCallHash) &&
    (input.initialAuthorizationEpoch === undefined || input.latestAuthorizationEpoch === input.initialAuthorizationEpoch) &&
    (input.initialEnvironmentHash === undefined || input.latestEnvironmentHash === input.initialEnvironmentHash) &&
    (input.initialEgressHash === undefined || input.latestEgressHash === input.initialEgressHash)
}
