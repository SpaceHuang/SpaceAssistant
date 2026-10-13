import { describe, expect, it } from 'vitest'
import { resolveImPolicyRulesForVersion } from './policyPackages'

const rules = [
  { id: 'im-low-risk-create', when: 'invocation' as const, action: 'ask' as const, reason: 'new file' },
  { id: 'im-low-risk-edit', when: 'invocation' as const, action: 'ask' as const, reason: 'edit file' },
  { id: 'browser-navigate-ask-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'navigation' },
  { id: 'im-mcp-public-read-review', when: 'invocation' as const, action: 'ask' as const, reason: 'public search' },
  { id: 'im-time-query-review', when: 'invocation' as const, action: 'ask' as const, reason: 'time' },
  { id: 'script-clean-certified-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'certified clean script' },
  { id: 'script-dynamic-execution-confirm', when: 'invocation' as const, action: 'confirm-every-time' as const, locked: true, reason: 'dynamic script floor' },
  { id: 'browser-act-ask-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'not a candidate' },
  { id: 'im-browser-act-review', when: 'invocation' as const, action: 'ask' as const, reason: 'low-risk browser action' },
  { id: 'lark-write-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'classified low-impact Feishu write' },
  { id: 'im-lark-low-write-review', when: 'invocation' as const, action: 'ask' as const, reason: 'classified ordinary Feishu write' },
  { id: 'lark-high-impact-ask', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'high-impact Feishu write' },
  { id: 'lark-unknown-ask', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'unknown Feishu command' },
  { id: 'im-lark-message-self-review', when: 'invocation' as const, action: 'ask' as const, reason: 'self message' },
  { id: 'im-lark-message-direct-review', when: 'invocation' as const, action: 'ask' as const, reason: 'direct message' },
  { id: 'lark-message-group-human', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'group message' },
  { id: 'lark-message-target-unknown-human', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'unknown recipient' },
  { id: 'browser-act-danger-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'dangerous browser action' },
  { id: 'path-sensitive-read-confirm', when: 'invocation' as const, action: 'confirm-every-time' as const, locked: true, reason: 'sensitive path' },
  { id: 'remote-deny-lark-write-outbound', when: 'invocation' as const, action: 'deny' as const, locked: true, reason: 'outbound disabled' },
  { id: 'mcp-tool-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'non-candidate' },
  { id: 'hard-deny', when: 'invocation' as const, action: 'deny' as const, locked: true, reason: 'floor' }
]

describe('version-pinned IM behavior candidates', () => {
  it('applies explicit candidate mappings only to im-standard-v2', () => {
    const v2 = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules })
    expect(v2.map(({ id, action }) => [id, action])).toEqual([
      ['im-low-risk-create', 'auto-evaluator'],
      ['im-low-risk-edit', 'auto-evaluator'],
      ['browser-navigate-ask-remote', 'auto-evaluator'],
      ['im-mcp-public-read-review', 'auto-evaluator'],
      ['im-time-query-review', 'auto-evaluator'],
      ['script-clean-certified-remote', 'auto-evaluator'],
      ['script-dynamic-execution-confirm', 'confirm-every-time'],
      ['browser-act-ask-remote', 'ask'],
      ['im-browser-act-review', 'auto-evaluator'],
      ['lark-write-ask', 'ask'],
      ['im-lark-low-write-review', 'auto-evaluator'],
      ['lark-high-impact-ask', 'ask'],
      ['lark-unknown-ask', 'ask'],
      ['im-lark-message-self-review', 'auto-evaluator'],
      ['im-lark-message-direct-review', 'auto-evaluator'],
      ['lark-message-group-human', 'ask'],
      ['lark-message-target-unknown-human', 'ask'],
      ['browser-act-danger-ask', 'ask'],
      ['path-sensitive-read-confirm', 'confirm-every-time'],
      ['remote-deny-lark-write-outbound', 'deny'],
      ['mcp-tool-ask', 'auto-evaluator'],
      ['hard-deny', 'deny']
    ])
  })

  it('preserves frozen legacy actions without applying current candidates', () => {
    const legacyRules = rules.map((rule) => ({ ...rule, action: rule.id === 'im-time-query-review' ? 'allow' as const : rule.action }))
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-v1.6', pkg: 'standard', rules: legacyRules }))
      .toEqual(legacyRules)
  })

  it('requires a known behavior version and retains package floors', () => {
    expect(() => resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-v99', pkg: 'standard', rules })).toThrow()
    for (const pkg of ['strict', 'custom'] as const) {
      const resolved = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg, rules })
      expect(resolved[1]?.action).toBe('ask')
      expect(resolved.find((rule) => rule.id === 'hard-deny')?.action).toBe('deny')
    }
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'strict', rules })[5]?.action).toBe('ask')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules })[6]?.action).toBe('confirm-every-time')
    const standard = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules })
    expect(standard.find((rule) => rule.id === 'lark-write-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'im-lark-low-write-review')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'lark-high-impact-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'lark-unknown-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'im-lark-message-self-review')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'im-lark-message-direct-review')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'lark-message-group-human')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'lark-message-target-unknown-human')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'browser-act-danger-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'path-sensitive-read-confirm')?.action).toBe('confirm-every-time')
    expect(standard.find((rule) => rule.id === 'remote-deny-lark-write-outbound')?.action).toBe('deny')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'loose', rules })[1]?.action).toBe('allow')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'loose', rules })[8]?.action).toBe('ask')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'loose', rules })[8]?.action).toBe('ask')
  })
})
