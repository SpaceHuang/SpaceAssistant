import type { ExecutionLane } from '../confirmation/types'

export type PolicyDomain = 'desktop' | 'im' | 'automation'

export type TrustedPolicyOrigin = {
  entry: 'desktop' | 'wechat' | 'feishu' | 'automation'
  lane: ExecutionLane
}

const DOMAIN_BY_ENTRY = {
  desktop: 'desktop',
  wechat: 'im',
  feishu: 'im',
  automation: 'automation'
} as const satisfies Record<TrustedPolicyOrigin['entry'], PolicyDomain>

const LANE_BY_ENTRY = {
  desktop: 'desktop',
  wechat: 'wechat',
  feishu: 'feishu',
  automation: 'automation'
} as const satisfies Record<TrustedPolicyOrigin['entry'], ExecutionLane>

/** Resolve a policy domain only from the entry and lane frozen by trusted ingress. */
export function policyDomainForTrustedOrigin(origin: {
  entry: unknown
  lane: unknown
}): PolicyDomain | null {
  if (typeof origin.entry !== 'string' || typeof origin.lane !== 'string') return null
  if (!Object.hasOwn(DOMAIN_BY_ENTRY, origin.entry)) return null
  const entry = origin.entry as TrustedPolicyOrigin['entry']
  if (LANE_BY_ENTRY[entry] !== origin.lane) return null
  return DOMAIN_BY_ENTRY[entry]
}
