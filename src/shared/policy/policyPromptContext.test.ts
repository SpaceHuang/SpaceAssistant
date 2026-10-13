import { describe, expect, it } from 'vitest'
import { formatImPolicyPromptContext } from './policyPromptContext'

describe('formatImPolicyPromptContext', () => {
  it('reports policy-driven low-risk auto-review separately from async human approvals', () => {
    const enabled = formatImPolicyPromptContext({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 2,
      snapshot: { selectedPackage: 'standard', enabled: true }
    })
    expect(enabled).toContain('自动审核规则已配置')
    expect(enabled).toContain('异步人工审批通知由独立安全门禁控制')
    const disabled = formatImPolicyPromptContext({
      domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 2,
      snapshot: { selectedPackage: 'standard', enabled: false }
    })
    expect(disabled).toContain('自动审核规则已配置')
    expect(disabled).toContain('异步人工审批通知由独立安全门禁控制')
  })

  it('never claims enablement for missing, unknown, or legacy policy snapshots', () => {
    for (const policy of [
      undefined,
      { domain: 'im', policyBehaviorVersion: 'im-v99', revision: 1, snapshot: { enabled: true } },
      { domain: 'im', policyBehaviorVersion: 'im-v1.6', revision: 1, snapshot: { enabled: true } }
    ] as const) {
      expect(formatImPolicyPromptContext(policy as never)).not.toContain('自动审核规则已配置')
    }
  })
})
