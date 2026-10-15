import type { PolicyRule } from '../confirmation/types'
import type { ImPolicyPackage } from './imPolicyBehavior'
import { imEffectiveActionFor } from './imPolicyBehavior'
import { resolvePolicyBehavior } from './policyBehaviorVersion'

export interface ResolveImPolicyRulesForVersionInput {
  policyBehaviorVersion: unknown
  pkg: ImPolicyPackage
  rules: PolicyRule[]
}

/**
 * Resolve IM rules using only the explicitly pinned behavior version.
 * Legacy inputs are already frozen effective rules; v2 applies the current explicit candidate map.
 */
export function resolveImPolicyRulesForVersion(input: ResolveImPolicyRulesForVersionInput): PolicyRule[] {
  return resolvePolicyBehavior({
    policyBehaviorVersion: input.policyBehaviorVersion,
    rules: input.rules,
    resolvers: {
      'im-v1.6': ({ rules }) => structuredClone(rules),
      'im-standard-v2': ({ rules }) => rules.map((rule) => ({
        ...rule,
        action: imEffectiveActionFor('im', input.pkg, rule)
      }))
    }
  })
}
