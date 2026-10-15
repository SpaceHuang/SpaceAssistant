import type { PolicyRule } from '../confirmation/types'

export interface PolicyBehaviorResolverInput {
  rules: PolicyRule[]
}

export type PolicyBehaviorResolver = (input: PolicyBehaviorResolverInput) => PolicyRule[]
export type PolicyBehaviorResolvers = Readonly<Record<string, PolicyBehaviorResolver>>

export interface ResolvePolicyBehaviorInput {
  policyBehaviorVersion?: unknown
  rules: PolicyRule[]
  resolvers: PolicyBehaviorResolvers
}

/** Resolve only through the explicitly pinned behavior version; never infer it from storage metadata. */
export function resolvePolicyBehavior(input: ResolvePolicyBehaviorInput): PolicyRule[] {
  const version = input.policyBehaviorVersion
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('A valid policyBehaviorVersion is required')
  }
  if (!Object.hasOwn(input.resolvers, version)) {
    throw new Error(`Unknown policyBehaviorVersion: ${version}`)
  }
  const resolver = input.resolvers[version]
  if (typeof resolver !== 'function') {
    throw new Error(`No policy behavior resolver registered for version: ${version}`)
  }
  return resolver({ rules: input.rules })
}
