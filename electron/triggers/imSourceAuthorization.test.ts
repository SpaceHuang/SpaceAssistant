import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { PolicyRule } from '../../src/shared/confirmation/types'
import { authorizeRuntimeTriggerImSource, type RuntimeTriggerImSource } from './imSourceAuthorization'

const baseSource: RuntimeTriggerImSource = { channel: 'feishu', accountId: 'alice', conversationId: 'chat-1', senderId: 'alice', isGroup: false }
const config = { enabled: true, ready: true, remoteEnabled: true, loggedIn: true, remoteSenderAllowlist: ['alice'] }
const authorize = (source: RuntimeTriggerImSource, policyRules: PolicyRule[] = DEFAULT_POLICY_RULES) =>
  authorizeRuntimeTriggerImSource({ source, config, policyRules, policyRevision: 'policy-current', authorizationGeneration: 'generation-current' })

function overrideIngress(ruleId: string, action: PolicyRule['action']): PolicyRule[] {
  return DEFAULT_POLICY_RULES.map((rule) => rule.id === ruleId ? { ...rule, action } as PolicyRule : { ...rule })
}

describe('runtime trigger current IM authorization', () => {
  it('preserves group classification during reauthorization while leaving the same sender direct message unaffected', () => {
    const group = authorize({ ...baseSource, isGroup: true })
    expect(group).toMatchObject({ allowed: false })
    expect(authorize(baseSource)).toMatchObject({ allowed: true, policyTrace: { originKind: 'direct-owner', ruleId: 'ingress-default-allow' } })
    expect(authorize({ ...baseSource, isGroup: true }, overrideIngress('ingress-feishu-group-deny', 'allow')))
      .toMatchObject({ allowed: true, policyTrace: { originKind: 'group', ruleId: 'ingress-feishu-group-deny', action: 'allow' } })
  })

  it('lets the shared policy decide for a sender outside the allowlist, including allow, deny and ask', () => {
    const external = { ...baseSource, accountId: 'external', senderId: 'external' }
    expect(authorize(external)).toMatchObject({ allowed: false })
    expect(authorize(external, overrideIngress('ingress-direct-other-deny', 'allow')))
      .toMatchObject({ allowed: true, policyTrace: { originKind: 'direct-other', ruleId: 'ingress-direct-other-deny', action: 'allow' } })
    expect(authorize(external, overrideIngress('ingress-direct-other-deny', 'ask'))).toMatchObject({ allowed: false })
    expect(authorize(external, overrideIngress('ingress-direct-other-deny', 'deny'))).toMatchObject({ allowed: false })
  })

  it('fails closed when the source conversation type is missing or current channel authorization is unavailable', () => {
    expect(authorize({ ...baseSource, isGroup: undefined as unknown as boolean })).toMatchObject({ allowed: false })
    expect(authorizeRuntimeTriggerImSource({ source: baseSource, config: { ...config, remoteEnabled: false },
      policyRules: DEFAULT_POLICY_RULES, policyRevision: 'policy-current', authorizationGeneration: 'generation-current' }))
      .toMatchObject({ allowed: false })
  })
})
